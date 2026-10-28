import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { MochiControlManifest } from "../../../src/control/manifest.ts";
import { PRODUCT_PROBLEM_VERSION } from "../../../src/control/productProblem.ts";
import { log } from "../../../src/log.ts";
import { githubProblemOf, githubStatusOf } from "../shared/connectorView.ts";
import type { Activity, DesktopSnapshot } from "../shared/model.ts";

const events: Record<string, string> = {
  "bot.starting": "伙伴醒来了",
  "lark.event.connection_ready": "飞书连接好了",
  "lark.message.hydrated": "收到一条新消息",
  "runtime.turn.queued": "有一条消息在等候",
  "runtime.turn.started": "开始认真处理",
  "runtime.turn.steered": "收到了新的补充",
  "runtime.turn.completed": "回复已经送达",
  "runtime.turn.recovery_started": "正在恢复工作上下文",
  "runtime.turn.recovery_completed": "工作上下文已恢复",
  "runtime.context.organization_started": "开始整理记忆",
  "runtime.context.organization_completed": "记忆整理好了",
  "runtime.context.organization_failed": "记忆没有整理完",
  "bot.event.completed": "飞书消息已处理",
  "bot.reaction.create_failed": "状态表情没有送达",
  "bot.fatal": "暂时无法工作",
};
/** The Bridge events the activity list can show. */
export const ACTIVITY_EVENTS: readonly string[] = Object.keys(events);

/** How much of a log's end the App reads; a record never spans more. */
const LOG_TAIL_BYTES = 512 * 1024;

type LogRecord = Record<string, unknown> & { event: string; timestamp: string };

function recordsFrom(text: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of text.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    } // A log tail may end mid-record.
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as LogRecord).event !== "string" ||
      typeof (value as LogRecord).timestamp !== "string" ||
      !Number.isFinite(Date.parse((value as LogRecord).timestamp))
    )
      continue;
    records.push(value as LogRecord);
  }
  return records;
}

export function activityFrom(text: string): Activity[] {
  const activity: Activity[] = [];
  for (const value of recordsFrom(text)) {
    const title = Object.hasOwn(events, value.event)
      ? events[value.event]
      : undefined;
    if (!title) continue;
    if (value.event === "bot.starting") activity.length = 0;
    activity.push({
      id: `${value.timestamp}:${value.event}:${activity.length}`,
      time: value.timestamp,
      title,
      kind:
        value.level === "warn" || value.level === "error"
          ? "warning"
          : "normal",
    });
  }
  return activity.slice(-12).reverse();
}

/**
 * The end of one owner-private log, or null when it does not exist yet.
 * A symlink, a foreign owner or a non-file throws instead of being read.
 */
function readLogTail(
  path: string,
): { text: string; fingerprint: string } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid!())
      throw new Error("Invalid log owner");
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES),
      buffer = Buffer.alloc(stat.size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start) text = text.slice(text.indexOf("\n") + 1);
    return { text, fingerprint: `${stat.ino}:${stat.size}:${stat.mtimeMs}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Optional activity is a bounded, allowlisted projection. It never overrides authoritative status. */
export class ActivityReader {
  private fingerprint = "";
  private activity: Activity[] = [];
  private unavailable = false;
  read(path: string): Activity[] {
    let tail: ReturnType<typeof readLogTail>;
    try {
      tail = readLogTail(path);
    } catch {
      if (!this.unavailable) log.warn("activity.unavailable");
      this.unavailable = true;
      return [];
    }
    this.unavailable = false;
    if (!tail) return [];
    if (this.fingerprint === tail.fingerprint) return this.activity;
    this.activity = activityFrom(tail.text);
    this.fingerprint = tail.fingerprint;
    return this.activity;
  }
}

/**
 * Events a diagnostics export may carry, from the Bridge and from this App:
 * lifecycle markers and failures, never message traffic.
 */
export const DIAGNOSTIC_EVENTS: ReadonlySet<string> = new Set([
  "bot.starting",
  "bot.started",
  "bot.fatal",
  "bot.load_failed",
  "bot.start_failed",
  "bot.cleanup_failed",
  "bot.status_projection_failed",
  "bridge.shutdown_failed",
  "bot.event.failed",
  "bot.events.interrupted_recovered",
  "bot.control.action_failed",
  "bot.control.connection_failed",
  "bot.projects.unavailable_at_start",
  "connectors.catalog.refresh_failed",
  "feishu.connection_unavailable",
  "feishu.candidate_unavailable",
  "lark.event.connection_ready",
  "lark.event.connection_unavailable",
  "lark.event.stderr_unrecognized",
  "lark.event.process_exited",
  "lark.event.bus_stop_failed",
  "lark.event.handler_failed",
  "lark.event.runtime_failed",
  "lark.groups.unavailable",
  "github.request.failed",
  "github.registration.unavailable",
  "runtime.account.unavailable",
  "runtime.activation_failed",
  "runtime.transport.failed",
  "runtime.worker.stderr",
  "runtime.turn.recovery_failed",
  "runtime.context.recovery_failed",
  "runtime.context.organization_failed",
  "runtime.queue.start_failed",
  "schedule.execution.failed",
  "schedule.clock.failed",
  "host.starting",
  "action.failed",
  "connections.recheck_failed",
  "renderer.startup-failed",
  "settings.startup-failed",
  "rpc.rejected",
]);

/** Fields an exported event may keep. Message, chat and resource identities never qualify. */
const DIAGNOSTIC_FIELDS: ReadonlySet<string> = new Set([
  "botId",
  "reason",
  "code",
  "problem",
  "problemCode",
  "errorCode",
  "errorName",
  "cause",
  "action",
  "command",
  "phase",
  "httpStatus",
  "exitCode",
  "timedOut",
  "subscriptionReady",
  "connectionReady",
  "count",
  "bytes",
  "interruptedCount",
  "unrecognizedStderrLines",
]);
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const BOT_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const RECENT_EVENT_LIMIT = 50;

export interface DiagnosticEvent {
  timestamp: string;
  level: string;
  event: string;
  [field: string]: string | number | boolean;
}

function diagnosticEvent(record: LogRecord): DiagnosticEvent | null {
  if (!DIAGNOSTIC_EVENTS.has(record.event)) return null;
  const projected: DiagnosticEvent = {
    timestamp: record.timestamp,
    level: typeof record.level === "string" ? record.level : "info",
    event: record.event,
  };
  for (const [key, value] of Object.entries(record)) {
    if (!DIAGNOSTIC_FIELDS.has(key)) continue;
    if (key === "botId" && !(typeof value === "string" && BOT_ID.test(value)))
      continue;
    if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && CODE.test(value))
    )
      projected[key] = value;
  }
  return projected;
}

/**
 * The newest allowlisted events across the Bridge and App logs: stable codes and
 * counts only. An unreadable log contributes nothing rather than failing the export.
 */
export function recentDiagnosticEvents(
  paths: readonly string[],
): DiagnosticEvent[] {
  const recent: DiagnosticEvent[] = [];
  for (const path of paths) {
    let tail: ReturnType<typeof readLogTail>;
    try {
      tail = readLogTail(path);
    } catch {
      log.warn("diagnostics.log_unavailable");
      continue;
    }
    for (const record of tail ? recordsFrom(tail.text) : []) {
      const event = diagnosticEvent(record);
      if (event) recent.push(event);
    }
  }
  return recent
    .sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    )
    .slice(-RECENT_EVENT_LIMIT);
}

export function diagnosticsReport(
  snapshot: DesktopSnapshot,
  manifest: MochiControlManifest,
  recentEvents: readonly DiagnosticEvent[],
  now = new Date(),
): object {
  const capabilities = [
    snapshot.installed && "installation.present",
    snapshot.loaded && "service.loaded",
    snapshot.account.status === "signedIn" && "account.connected",
    snapshot.eventStreamReady && "messages.listening",
    snapshot.canOrganize && "context.organization.available",
  ].filter((value): value is string => typeof value === "string");
  return {
    schemaVersion: 4,
    generatedAt: now.toISOString(),
    components: {
      appProductVersion: manifest.productVersion,
      bridgeContractVersion: manifest.bridgeVersion,
      statusContractVersion: manifest.statusVersion,
      controlContractVersion: manifest.controlProtocolVersion,
      problemContractVersion: PRODUCT_PROBLEM_VERSION,
    },
    capabilityCodes: capabilities.sort(),
    problemCodes: snapshot.problem ? [snapshot.problem.code] : [],
    health: {
      phase: snapshot.phase,
      installed: snapshot.installed,
      serviceLoaded: snapshot.loaded,
      accountState: snapshot.account.status,
      feishuState: snapshot.feishu.active?.state ?? "disconnected",
      githubState: githubStatusOf(snapshot.connectorCatalog),
      githubProblem: githubProblemOf(snapshot.connectorCatalog),
      queueDepth: snapshot.queueDepth,
      contextUsagePercent: snapshot.contextPercent,
    },
    // Every Bot, not only the one on screen; no names, models or memberships.
    bots: snapshot.bots.map((bot) => ({
      botId: bot.botId,
      selected: bot.botId === snapshot.selectedBotId,
      enabled: bot.enabled,
      lifecycle: bot.lifecycle,
      phase: bot.phase,
      problemCode: bot.problemCode,
      groupCount: bot.groupCount,
      projectCount: bot.projectCount,
    })),
    recentEvents,
  };
}
