import type { Database } from "bun:sqlite";
import {
  latestDueOccurrence,
  nextOccurrence,
  parseScheduleRule,
  type ScheduleRule,
} from "./time.ts";

export const MAXIMUM_SCHEDULES = 50;
export class ScheduleConflictError extends Error {
  constructor() {
    super("安排已变化，请重新查看。");
  }
}
export class ScheduleExpiredError extends Error {
  constructor() {
    super("这个一次性安排已经过期，请在飞书修改时间。");
  }
}
export const SCHEDULE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    next_due_at INTEGER,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedule_runs (
    schedule_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'delivered', 'failed', 'interrupted', 'blocked')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    problem TEXT,
    PRIMARY KEY(schedule_id, due_at),
    FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS schedule_deliveries (
    schedule_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    PRIMARY KEY(schedule_id, due_at),
    FOREIGN KEY(schedule_id, due_at) REFERENCES schedule_runs(schedule_id, due_at) ON DELETE CASCADE
  );
`;

export interface ScheduleResource {
  connectionId: string;
  resourceId: string;
  selectionId: string;
}
export interface ScheduleDefinition {
  title: string;
  task: string;
  rule: ScheduleRule;
  appId: string;
  chatId: string;
  threadKey: string;
  replyMessageId: string;
  requesterId: string;
  delivery: "group" | "thread";
  sourceMessageLink: string | null;
  threadTarget: {
    threadKey: string;
    replyMessageId: string;
    sourceMessageLink: string | null;
  } | null;
  resources: ScheduleResource[];
}
export type ScheduleRunStatus =
  | "running"
  | "delivered"
  | "failed"
  | "interrupted"
  | "blocked";
export const SCHEDULE_PROBLEMS = [
  "channel_changed",
  "group_unavailable",
  "source_unavailable",
  "resources_changed",
  "execution_failed",
  "delivery_failed",
  "interrupted",
] as const;
export type ScheduleProblem = (typeof SCHEDULE_PROBLEMS)[number];
export interface ScheduleRun {
  dueAt: number;
  status: ScheduleRunStatus;
  startedAt: number;
  finishedAt: number | null;
  problem: ScheduleProblem | null;
}
export interface ScheduleRecord extends ScheduleDefinition {
  id: string;
  enabled: boolean;
  nextDueAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastRun: ScheduleRun | null;
}
interface ScheduleRow {
  id: string;
  definition_json: string;
  enabled: number;
  next_due_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

/** Owned by one Bot's existing StateStore and its already-held state lock. */
export class ScheduleStore {
  constructor(private readonly database: Database) {}

  list(): ScheduleRecord[] {
    return this.database
      .query<ScheduleRow, []>("SELECT * FROM schedules ORDER BY created_at, id")
      .all()
      .map((row) => this.#decode(row));
  }
  get(id: string): ScheduleRecord {
    const row = this.database
      .query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE id = ?")
      .get(id);
    if (!row) throw new Error("没有找到这个安排。");
    return this.#decode(row);
  }
  inTopic(appId: string, chatId: string, threadKey: string): ScheduleRecord[] {
    return this.list().filter(
      (schedule) =>
        schedule.appId === appId &&
        schedule.chatId === chatId &&
        (schedule.threadKey === threadKey ||
          schedule.threadTarget?.threadKey === threadKey ||
          this.database
            .query(
              "SELECT 1 FROM schedule_deliveries WHERE schedule_id = ? AND chat_id = ? AND thread_key = ?",
            )
            .get(schedule.id, chatId, threadKey) !== null),
    );
  }
  /** A result is a new discussion, linked to the same arrangement rather than
   * merged into the original topic or given the original human's authority. */
  recordDelivery(
    id: string,
    dueAt: number,
    receipt: { chatId: string; messageId: string; threadKey: string },
  ): void {
    if (
      !identifier(receipt.chatId) ||
      !identifier(receipt.messageId) ||
      !identifier(receipt.threadKey)
    )
      throw new Error("安排交付凭据无效。");
    const row = this.database
      .query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE id = ?")
      .get(id);
    if (!row) return; // An accepted occurrence may finish after cancellation.
    if (this.#decode(row).chatId !== receipt.chatId)
      throw new Error("安排交付到了其他群。");
    this.database
      .query("INSERT INTO schedule_deliveries VALUES (?, ?, ?, ?, ?)")
      .run(id, dueAt, receipt.chatId, receipt.messageId, receipt.threadKey);
  }
  rekeyTopic(chatId: string, oldKey: string, canonicalKey: string): void {
    for (const schedule of this.list()) {
      if (
        schedule.chatId !== chatId ||
        (schedule.threadKey !== oldKey &&
          schedule.threadTarget?.threadKey !== oldKey)
      )
        continue;
      const {
        id,
        enabled: _enabled,
        nextDueAt: _next,
        revision: _revision,
        createdAt: _created,
        updatedAt: _updated,
        lastRun: _last,
        ...definition
      } = schedule;
      this.database
        .query(
          "UPDATE schedules SET definition_json = ?, revision = revision + 1 WHERE id = ?",
        )
        .run(
          JSON.stringify({
            ...definition,
            threadKey:
              definition.threadKey === oldKey
                ? canonicalKey
                : definition.threadKey,
            threadTarget: definition.threadTarget
              ? {
                  ...definition.threadTarget,
                  threadKey:
                    definition.threadTarget.threadKey === oldKey
                      ? canonicalKey
                      : definition.threadTarget.threadKey,
                }
              : null,
          }),
          id,
        );
    }
    this.database
      .query(
        "UPDATE schedule_deliveries SET thread_key = ? WHERE chat_id = ? AND thread_key = ?",
      )
      .run(canonicalKey, chatId, oldKey);
  }
  create(id: string, input: ScheduleDefinition, now: number): ScheduleRecord {
    assertId(id);
    const definition = parseDefinition(input);
    return this.database
      .transaction(() => {
        // The operation identity also closes the crash gap between this local
        // transaction and the connector Broker recording its readback.
        const existing = this.database
          .query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE id = ?")
          .get(id);
        if (existing) {
          if (existing.definition_json !== JSON.stringify(definition))
            throw new Error("安排操作身份冲突。");
          return this.#decode(existing);
        }
        const nextDueAt = nextOccurrence(definition.rule, now);
        if (nextDueAt === null) throw new Error("请为一次性安排选择未来时间。");
        if (this.list().length >= MAXIMUM_SCHEDULES)
          throw new Error(`每位分身最多保留 ${MAXIMUM_SCHEDULES} 个安排。`);
        this.database
          .query("INSERT INTO schedules VALUES (?, ?, 1, ?, 1, ?, ?)")
          .run(id, JSON.stringify(definition), nextDueAt, now, now);
        return this.get(id);
      })
      .immediate();
  }
  update(
    id: string,
    revision: number,
    input: ScheduleDefinition,
    now: number,
  ): ScheduleRecord {
    const definition = parseDefinition(input);
    const nextDueAt = nextOccurrence(definition.rule, now);
    if (nextDueAt === null) throw new Error("请为一次性安排选择未来时间。");
    this.#assertRevision(id, revision);
    const result = this.database
      .query(
        "UPDATE schedules SET definition_json = ?, next_due_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      )
      .run(JSON.stringify(definition), nextDueAt, now, id, revision);
    if (result.changes !== 1) throw new Error("安排已变化，请重新查看。");
    return this.get(id);
  }
  setEnabled(
    id: string,
    revision: number,
    enabled: boolean,
    now: number,
  ): ScheduleRecord {
    const current = this.#assertRevision(id, revision);
    if (current.enabled === enabled) return current;
    const nextDueAt = enabled
      ? nextOccurrence(current.rule, now)
      : current.nextDueAt;
    if (enabled && nextDueAt === null) throw new ScheduleExpiredError();
    this.database
      .query(
        "UPDATE schedules SET enabled = ?, next_due_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      )
      .run(enabled ? 1 : 0, nextDueAt, now, id, revision);
    return this.get(id);
  }
  cancel(id: string, revision: number): void {
    this.#assertRevision(id, revision);
    this.database
      .query("DELETE FROM schedules WHERE id = ? AND revision = ?")
      .run(id, revision);
  }
  due(now: number): ScheduleRecord | null {
    const row = this.database
      .query<ScheduleRow, [number]>(`
      SELECT * FROM schedules WHERE enabled = 1 AND next_due_at <= ?
      ORDER BY next_due_at, created_at, id LIMIT 1
    `)
      .get(now);
    return row ? this.#decode(row) : null;
  }
  /** Claim and advance together; a restart can never repeat this occurrence. */
  claim(
    id: string,
    revision: number,
    now: number,
  ): { schedule: ScheduleRecord; dueAt: number; coalesced: boolean } | null {
    return this.database
      .transaction(() => {
        const current = this.get(id);
        if (
          current.revision !== revision ||
          !current.enabled ||
          current.nextDueAt === null ||
          current.nextDueAt > now
        )
          return null;
        const dueAt = latestDueOccurrence(current.rule, current.nextDueAt, now);
        if (dueAt === null) throw new Error("安排的发生时间与持久记录不一致。");
        const next = nextOccurrence(current.rule, now);
        const inserted = this.database
          .query(
            "INSERT OR IGNORE INTO schedule_runs VALUES (?, ?, 'running', ?, NULL, NULL)",
          )
          .run(id, dueAt, now);
        if (inserted.changes !== 1)
          throw new Error("安排的发生时点已经被领取。");
        this.database
          .query(
            "UPDATE schedules SET next_due_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
          )
          .run(next, now, id);
        // Bound metadata, preserving the active claim and newest completed runs.
        this.database
          .query(`DELETE FROM schedule_runs WHERE schedule_id = ? AND status != 'running'
        AND due_at NOT IN (SELECT due_at FROM schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC LIMIT 20)`)
          .run(id, id);
        return {
          schedule: current,
          dueAt,
          coalesced: dueAt !== current.nextDueAt,
        };
      })
      .immediate();
  }
  finish(
    id: string,
    dueAt: number,
    status: Exclude<ScheduleRunStatus, "running">,
    now: number,
    problem: ScheduleProblem | null = null,
  ): void {
    this.database
      .query(
        "UPDATE schedule_runs SET status = ?, finished_at = ?, problem = ? WHERE schedule_id = ? AND due_at = ? AND status = 'running'",
      )
      .run(status, now, problem, id, dueAt);
  }
  recoverInterrupted(now: number): number {
    return this.database
      .query(
        "UPDATE schedule_runs SET status = 'interrupted', finished_at = ?, problem = 'interrupted' WHERE status = 'running'",
      )
      .run(now).changes;
  }
  #assertRevision(id: string, revision: number): ScheduleRecord {
    const current = this.get(id);
    if (!Number.isSafeInteger(revision) || current.revision !== revision)
      throw new ScheduleConflictError();
    return current;
  }
  #decode(row: ScheduleRow): ScheduleRecord {
    const definition = parseDefinition(JSON.parse(row.definition_json));
    assertId(row.id);
    if (
      (row.enabled !== 0 && row.enabled !== 1) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !timestamp(row.created_at) ||
      !timestamp(row.updated_at) ||
      (row.next_due_at !== null &&
        (!timestamp(row.next_due_at) ||
          latestDueOccurrence(
            definition.rule,
            row.next_due_at,
            row.next_due_at,
          ) !== row.next_due_at))
    ) {
      throw new Error("安排的持久记录无效。");
    }
    const last = this.database
      .query<
        {
          due_at: number;
          status: ScheduleRunStatus;
          started_at: number;
          finished_at: number | null;
          problem: ScheduleProblem | null;
        },
        [string]
      >(
        "SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC LIMIT 1",
      )
      .get(row.id);
    if (
      last &&
      (!timestamp(last.due_at) ||
        !timestamp(last.started_at) ||
        (last.finished_at !== null && !timestamp(last.finished_at)) ||
        (last.status === "running"
          ? last.finished_at !== null
          : last.finished_at === null) ||
        (last.problem !== null && !SCHEDULE_PROBLEMS.includes(last.problem)))
    ) {
      throw new Error("安排的执行记录无效。");
    }
    return {
      ...definition,
      id: row.id,
      enabled: row.enabled === 1,
      nextDueAt: row.next_due_at,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRun: last
        ? {
            dueAt: last.due_at,
            status: last.status,
            startedAt: last.started_at,
            finishedAt: last.finished_at,
            problem: last.problem,
          }
        : null,
    };
  }
}

function parseDefinition(value: unknown): ScheduleDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("安排定义无效。");
  const input = value as ScheduleDefinition;
  if (
    Object.keys(input).sort().join(",") !==
      "appId,chatId,delivery,replyMessageId,requesterId,resources,rule,sourceMessageLink,task,threadKey,threadTarget,title" ||
    !isScheduleText(input.title, 120) ||
    !isScheduleText(input.task, 4_000, true) ||
    !identifier(input.appId) ||
    !identifier(input.chatId) ||
    !identifier(input.threadKey) ||
    !identifier(input.replyMessageId) ||
    !identifier(input.requesterId) ||
    (input.delivery !== "group" && input.delivery !== "thread") ||
    (input.sourceMessageLink !== null &&
      !isScheduleSourceLink(input.sourceMessageLink)) ||
    !Array.isArray(input.resources) ||
    input.resources.length > 20
  )
    throw new Error("安排定义无效。");
  const target = input.threadTarget;
  if (
    input.delivery === "group"
      ? target !== null
      : !target ||
        Object.keys(target).sort().join(",") !==
          "replyMessageId,sourceMessageLink,threadKey" ||
        !identifier(target.replyMessageId) ||
        !identifier(target.threadKey) ||
        (target.sourceMessageLink !== null &&
          !isScheduleSourceLink(target.sourceMessageLink))
  )
    throw new Error("安排话题去向无效。");
  const seen = new Set<string>();
  for (const resource of input.resources) {
    if (
      !resource ||
      Object.keys(resource).sort().join(",") !==
        "connectionId,resourceId,selectionId" ||
      !identifier(resource.connectionId) ||
      !identifier(resource.resourceId) ||
      !/^[0-9a-f]{32}$/.test(resource.selectionId) ||
      seen.has(`${resource.connectionId}/${resource.resourceId}`)
    )
      throw new Error("安排资源无效。");
    seen.add(`${resource.connectionId}/${resource.resourceId}`);
  }
  return {
    title: input.title,
    task: input.task,
    rule: parseScheduleRule(input.rule),
    appId: input.appId,
    chatId: input.chatId,
    threadKey: input.threadKey,
    replyMessageId: input.replyMessageId,
    requesterId: input.requesterId,
    delivery: input.delivery,
    sourceMessageLink: input.sourceMessageLink,
    threadTarget: target ? { ...target } : null,
    resources: input.resources.map((resource) => ({ ...resource })),
  };
}
export function isScheduleText(
  value: unknown,
  maximum: number,
  multiline = false,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(multiline ? value.replace(/[\t\n]/g, "") : value)
  );
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}
export function isScheduleId(id: unknown): id is string {
  return typeof id === "string" && /^schedule:[a-f0-9]{64}$/.test(id);
}
function assertId(id: string): void {
  if (!isScheduleId(id)) throw new Error("安排身份无效。");
}
export function isScheduleSourceLink(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s()<>]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "applink.feishu.cn" ||
        url.hostname === "applink.larksuite.com")
    );
  } catch {
    return false;
  }
}
function timestamp(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799_999
  );
}
