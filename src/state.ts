import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IssueAction, IssueActionStatus, IssueMutation, MessageContext } from "./domain.ts";
import { prepareStateDatabase } from "./state/schema.ts";
import { ScheduleStore, type ScheduleRecord } from "./schedules/store.ts";
import { isGitHubFullName, parseGitHubScope } from "./github/repository.ts";
import {
  isConnectorResourceSelection,
  MAXIMUM_CONNECTOR_RESOURCES,
  type ConnectorResourceSelection,
} from "./connectors/selectionStore.ts";
import {
  CONNECTOR_MAX_WRITE_RECORDS_PER_CONNECTION,
  type ConnectorWriteRecord,
  type ConnectorWriteStatus,
} from "./connectors/ledger.ts";

interface IssueActionRow {
  id: string;
  repository_scope_json: string;
  repository_full_name: string;
  chat_id: string;
  thread_key: string;
  proposed_by: string;
  proposal_message_id: string;
  mutation_json: string;
  fingerprint: string;
  status: IssueActionStatus;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface TopicIdentity {
  threadKey: string;
  active: boolean;
}

export interface RuntimeSessionBinding {
  sessionId: string;
  capabilityAbi?: string;
  turnCount: number;
  lastSourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeSessionMigration {
  sourceSessionId: string;
  targetSessionId: string;
  capabilityAbi: string;
  transcriptSha256: string;
  sourceTurnCount: number;
  createdAt: number;
}

export interface PersistedRuntimeContextUsage {
  sessionId: string;
  turnId: string;
  usedTokens: number;
  modelContextWindow: number;
}

export interface RetiredRuntimeSession extends RuntimeSessionBinding {
  retiredAt: number;
  successorSessionId: string;
}

export type RuntimeSessionCandidateStatus = "active" | "prepared";

/**
 * How long a message's idempotency record outlives its first claim.
 *
 * Feishu retries a push its receiver did not acknowledge at most four times,
 * 15 s, 5 min, 1 h and 6 h apart, about 7 h 5 min in all, on long connections
 * as on webhooks; its at-least-once transport duplicates only within that chain
 * (open.feishu.cn, 事件订阅概述). A week is more than twenty times that window,
 * and still bounds the table to one week of messages.
 */
export const PROCESSED_EVENT_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export class StateStore {
  readonly schedules: ScheduleStore;
  readonly #db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    this.#db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    prepareStateDatabase(this.#db);
    this.schedules = new ScheduleStore(this.#db);
  }

  groupEnabled(appId: string, chatId: string): boolean {
    return !this.#db.query("SELECT 1 FROM disabled_feishu_groups WHERE app_id = ? AND chat_id = ?").get(appId, chatId);
  }

  /**
   * One connection's selected resources.
   *
   * Every row was proven readable before it was stored, so this is a durable
   * Mochi range choice, not a new provider grant or a promise of current
   * reachability. The connector re-proves it before use.
   */
  connectorSelections(connectionId: string): ConnectorResourceSelection[] {
    return this.#db.query<{
      connection_id: string; resource_id: string; resource_type: string;
      display_name: string; address: string; selection_id: string;
    }, [string]>(`
      SELECT connection_id, resource_id, resource_type, display_name, address, selection_id
      FROM connector_resource_selections WHERE connection_id = ? ORDER BY updated_at, resource_id
    `).all(connectionId).map((row) => {
      const selection = {
        connectionId: row.connection_id,
        resourceId: row.resource_id,
        resourceType: row.resource_type,
        displayName: row.display_name,
        address: row.address,
        selectionId: row.selection_id,
      };
      if (!isConnectorResourceSelection(selection)) {
        throw new Error("Connector resource selection row is invalid");
      }
      return selection;
    });
  }

  connectorSelectionConnectionIds(): readonly string[] {
    return this.#db.query<{ connection_id: string }, []>(`
      SELECT DISTINCT connection_id
      FROM connector_resource_selections ORDER BY connection_id
    `).all().map((row) => row.connection_id);
  }

  /**
   * Replaces one connection's selection with exactly these resources.
   *
   * Scoped by connection — unlike the GitHub selection, which has exactly one
   * connection per Bot — because two providers' selections must stay independent.
   * Identity is preserved by the caller so re-selecting a resource cannot
   * invalidate work already in flight against it.
   */
  replaceConnectorSelections(
    connectionId: string,
    selections: readonly ConnectorResourceSelection[],
  ): void {
    if (selections.length > MAXIMUM_CONNECTOR_RESOURCES
      || selections.some((selection) => !isConnectorResourceSelection(selection)
        || selection.connectionId !== connectionId)) {
      throw new Error("Connector resource selection is invalid");
    }
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db.query("DELETE FROM connector_resource_selections WHERE connection_id = ?").run(connectionId);
      const insert = this.#db.query(`
        INSERT INTO connector_resource_selections
          (connection_id, resource_id, resource_type, display_name, address, selection_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const selection of selections) {
        insert.run(selection.connectionId, selection.resourceId, selection.resourceType,
          selection.displayName, selection.address, selection.selectionId, now);
      }
    })();
  }

  connectorWriteRecord(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
  ): ConnectorWriteRecord | undefined {
    const row = this.#db.query<{
      connection_id: string; capability_id: string; idempotency_key: string; resource_id: string;
      catalog_revision: string; capability_revision: string; input_digest: string;
      status: ConnectorWriteStatus;
      source_message_id: string; topic_key: string; requester_id: string;
      authorization_digest: string | null; result_json: string | null;
      created_at: number; updated_at: number;
    }, [string, string, string]>(`
      SELECT connection_id, capability_id, idempotency_key, resource_id,
             catalog_revision, capability_revision, input_digest, status,
             source_message_id, topic_key, requester_id, authorization_digest,
             result_json, created_at, updated_at
      FROM connector_write_ledger
      WHERE connection_id = ? AND capability_id = ? AND idempotency_key = ?
    `).get(connectionId, capabilityId, idempotencyKey);
    if (!row) return undefined;
    return {
      connectionId: row.connection_id,
      capabilityId: row.capability_id,
      idempotencyKey: row.idempotency_key,
      resourceId: row.resource_id,
      catalogRevision: row.catalog_revision,
      capabilityRevision: row.capability_revision,
      inputDigest: row.input_digest,
      status: row.status,
      sourceMessageId: row.source_message_id,
      topicKey: row.topic_key,
      requesterId: row.requester_id,
      authorizationDigest: row.authorization_digest,
      resultJson: row.result_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Claims a write key, reporting whether this caller won the claim.
   *
   * The primary-key insert is the concurrency answer: two concurrent writers with
   * the same key produce exactly one claim, and the loser is told the write is in
   * flight rather than being allowed to issue a second side effect.
   */
  claimConnectorWrite(record: Omit<ConnectorWriteRecord, "status" | "resultJson">): boolean {
    const now = Date.now();
    return this.#db.transaction(() => {
      const claimed = this.#db.query(`
        INSERT INTO connector_write_ledger
          (connection_id, capability_id, idempotency_key, resource_id,
           catalog_revision, capability_revision, input_digest, status,
           source_message_id, topic_key, requester_id, authorization_digest,
           result_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(connection_id, capability_id, idempotency_key) DO NOTHING
      `).run(record.connectionId, record.capabilityId, record.idempotencyKey,
        record.resourceId, record.catalogRevision, record.capabilityRevision,
        record.inputDigest, record.sourceMessageId, record.topicKey,
        record.requesterId, record.authorizationDigest, now, now).changes > 0;
      if (claimed) this.#evictConnectorWrites(record.connectionId);
      return claimed;
    })();
  }

  completeConnectorWrite(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
    resultJson: string,
  ): void {
    this.#db.query(`
      UPDATE connector_write_ledger SET status = 'applied', result_json = ?, updated_at = ?
      WHERE connection_id = ? AND capability_id = ? AND idempotency_key = ?
    `).run(resultJson, Date.now(), connectionId, capabilityId, idempotencyKey);
  }

  /** Releases a claim after a failure, so a legitimate retry is still possible. */
  abandonConnectorWrite(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
  ): void {
    this.#db.query(`
      DELETE FROM connector_write_ledger
      WHERE connection_id = ? AND capability_id = ? AND idempotency_key = ? AND status = 'pending'
    `).run(connectionId, capabilityId, idempotencyKey);
  }

  /** Bounds one connection's ledger by dropping its oldest applied rows. */
  #evictConnectorWrites(connectionId: string): void {
    this.#db.query(`
      DELETE FROM connector_write_ledger
      WHERE connection_id = ? AND status = 'applied' AND idempotency_key NOT IN (
        SELECT idempotency_key FROM connector_write_ledger
        WHERE connection_id = ? AND status = 'applied'
        ORDER BY updated_at DESC LIMIT ?
      )
    `).run(connectionId, connectionId, CONNECTOR_MAX_WRITE_RECORDS_PER_CONNECTION);
  }

  setGroupEnabled(appId: string, chatId: string, enabled: boolean): void {
    if (enabled) {
      this.#db.query("DELETE FROM disabled_feishu_groups WHERE app_id = ? AND chat_id = ?").run(appId, chatId);
    } else {
      this.#db.query(`INSERT INTO disabled_feishu_groups (app_id, chat_id, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(app_id, chat_id) DO UPDATE SET updated_at = excluded.updated_at`).run(appId, chatId, Date.now());
    }
  }

  resolveTopicIdentity(chatId: string, preferredKey: string, aliases: readonly string[]): TopicIdentity {
    const candidates = [...new Set([preferredKey, ...aliases].filter(Boolean))];
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const mappedKeys = candidates.flatMap((alias) => {
        const row = this.#db.query<{ topic_key: string }, [string, string]>(`
          SELECT topic_key FROM topic_aliases WHERE chat_id = ? AND alias_key = ?
        `).get(chatId, alias);
        return row ? [row.topic_key] : [];
      });
      const activeKeys = candidates.filter((key) => this.#topicIsActive(chatId, key));
      const canonical = preferredKey.startsWith("omt_")
        ? preferredKey
        : mappedKeys[0] ?? activeKeys[0] ?? preferredKey;

      for (const oldKey of new Set([...mappedKeys, ...activeKeys])) {
        if (oldKey !== canonical) this.#rekeyTopic(chatId, oldKey, canonical, now);
      }
      const upsert = this.#db.query(`
        INSERT INTO topic_aliases (chat_id, alias_key, topic_key, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id, alias_key) DO UPDATE SET
          topic_key = excluded.topic_key,
          updated_at = excluded.updated_at
      `);
      for (const alias of new Set([canonical, ...candidates])) upsert.run(chatId, alias, canonical, now);
      const active = this.#topicIsActive(chatId, canonical);
      this.#db.exec("COMMIT");
      return { threadKey: canonical, active };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #rekeyTopic(chatId: string, oldKey: string, canonicalKey: string, now: number): void {
    if (oldKey === canonicalKey) return;
    this.schedules.rekeyTopic(chatId, oldKey, canonicalKey);
    const active = this.#db.query<{
      activated_by_message_id: string;
      activated_by_user_id: string;
      created_at: number;
      updated_at: number;
    }, [string, string]>(`
      SELECT activated_by_message_id, activated_by_user_id, created_at, updated_at
      FROM active_topics WHERE chat_id = ? AND thread_key = ?
    `).get(chatId, oldKey);
    if (active) {
      this.#db.query(`
        INSERT OR IGNORE INTO active_topics (
          chat_id, thread_key, activated_by_message_id, activated_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        chatId,
        canonicalKey,
        active.activated_by_message_id,
        active.activated_by_user_id,
        active.created_at,
        Math.max(active.updated_at, now),
      );
      this.#db.query("DELETE FROM active_topics WHERE chat_id = ? AND thread_key = ?")
        .run(chatId, oldKey);
    }
    this.#db.query("UPDATE issue_actions SET thread_key = ?, updated_at = ? WHERE chat_id = ? AND thread_key = ?")
      .run(canonicalKey, now, chatId, oldKey);
    this.#db.query("UPDATE processed_events SET thread_key = ?, updated_at = ? WHERE chat_id = ? AND thread_key = ?")
      .run(canonicalKey, now, chatId, oldKey);
    this.#db.query("UPDATE topic_aliases SET topic_key = ?, updated_at = ? WHERE chat_id = ? AND topic_key = ?")
      .run(canonicalKey, now, chatId, oldKey);
  }

  activeTopicKey(chatId: string, threadKeys: string | readonly string[]): string | undefined {
    const keys = typeof threadKeys === "string" ? [threadKeys] : threadKeys;
    const alias = this.#db.query<{ topic_key: string }, [string, string]>(`
      SELECT topic_key FROM topic_aliases WHERE chat_id = ? AND alias_key = ?
    `);
    for (const key of keys) {
      const canonical = alias.get(chatId, key)?.topic_key ?? key;
      if (this.#topicIsActive(chatId, canonical)) return canonical;
    }
    return undefined;
  }

  topicIsActive(chatId: string, threadKeys: string | readonly string[]): boolean {
    return this.activeTopicKey(chatId, threadKeys) !== undefined;
  }
  /** The human-created arrangement authorizes this Bot result's discussion.
   * This records a delivery, never a fabricated human event or write grant. */
  recordScheduleDelivery(schedule: ScheduleRecord, dueAt: number,
    receipt: { chatId: string; messageId: string; threadKey: string }): void {
    if (receipt.chatId !== schedule.chatId) throw new Error("Schedule receipt belongs to another chat");
    this.#db.transaction(() => {
      this.schedules.recordDelivery(schedule.id, dueAt, receipt);
      this.#db.query(`INSERT OR IGNORE INTO active_topics
        (chat_id, thread_key, activated_by_message_id, activated_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(receipt.chatId, receipt.threadKey, schedule.replyMessageId, schedule.requesterId, Date.now(), Date.now());
      this.#db.query(`INSERT INTO topic_aliases (chat_id, alias_key, topic_key, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id, alias_key) DO UPDATE SET topic_key = excluded.topic_key, updated_at = excluded.updated_at`)
        .run(receipt.chatId, receipt.messageId, receipt.threadKey, Date.now());
      this.#db.query(`INSERT OR IGNORE INTO topic_aliases VALUES (?, ?, ?, ?)`)
        .run(receipt.chatId, receipt.threadKey, receipt.threadKey, Date.now());
    }).immediate();
  }

  #topicIsActive(chatId: string, threadKey: string): boolean {
    return Boolean(this.#db.query<{ found: number }, [string, string]>(`
      SELECT 1 AS found FROM active_topics WHERE chat_id = ? AND thread_key = ?
    `).get(chatId, threadKey));
  }

  claimEvent(messageId: string, context: MessageContext, activateTopic = false): boolean {
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      // Retire records past Feishu's redelivery window. An in-flight claim is
      // never evicted, however old: only a terminal record may be forgotten.
      this.#db.query("DELETE FROM processed_events WHERE created_at < ? AND status != 'processing'")
        .run(now - PROCESSED_EVENT_RETENTION_MILLISECONDS);
      const result = this.#db.query(`
        INSERT OR IGNORE INTO processed_events
          (message_id, chat_id, thread_key, sender_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'processing', ?, ?)
      `).run(messageId, context.chatId, context.threadKey, context.requesterId, now, now);
      const claimed = result.changes === 1;
      if (claimed && activateTopic) {
        this.#db.query(`
          INSERT OR IGNORE INTO active_topics (
            chat_id, thread_key, activated_by_message_id, activated_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(context.chatId, context.threadKey, messageId, context.requesterId, now, now);
      }
      this.#db.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverInterruptedEvents(): string[] {
    const rows = this.#db.query<{ message_id: string }, []>(`
      SELECT message_id FROM processed_events
      WHERE status = 'processing'
      ORDER BY created_at ASC
    `).all();
    if (rows.length === 0) return [];
    this.#db.query(`
      UPDATE processed_events
      SET status = 'failed',
          error = 'Bridge restarted before processing reached a terminal boundary',
          updated_at = ?
      WHERE status = 'processing'
    `).run(Date.now());
    return rows.map((row) => row.message_id);
  }

  completeEvent(messageId: string): void {
    this.#db.query("UPDATE processed_events SET status = 'completed', updated_at = ? WHERE message_id = ?")
      .run(Date.now(), messageId);
  }

  failEvent(messageId: string, error: string): void {
    this.#db.query("UPDATE processed_events SET status = 'failed', error = ?, updated_at = ? WHERE message_id = ?")
      .run(error.slice(0, 2_000), Date.now(), messageId);
  }

  saveIssueAction(action: IssueAction): IssueAction {
    parseGitHubScope(action.repositoryScope);
    if (!isGitHubFullName(action.repositoryFullName)) throw new Error("Invalid Issue repository identity");
    this.#db.query(`
      INSERT OR IGNORE INTO issue_actions (
        id, repository_scope_json, repository_full_name, chat_id, thread_key, proposed_by, proposal_message_id,
        mutation_json, fingerprint,
        status, result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action.id,
      JSON.stringify(action.repositoryScope),
      action.repositoryFullName,
      action.chatId,
      action.threadKey,
      action.proposedBy,
      action.proposalMessageId,
      JSON.stringify(action.mutation),
      action.fingerprint,
      action.status,
      action.result ? JSON.stringify(action.result) : null,
      action.error ?? null,
      action.createdAt,
      action.updatedAt,
    );
    const saved = this.#db.query<IssueActionRow, [string, string]>(`
      SELECT * FROM issue_actions WHERE proposal_message_id = ? AND fingerprint = ?
    `).get(action.proposalMessageId, action.fingerprint);
    if (!saved) throw new Error("Issue action was not persisted");
    return mapIssueAction(saved);
  }

  getIssueAction(id: string): IssueAction | undefined {
    const row = this.#db.query<IssueActionRow, [string]>("SELECT * FROM issue_actions WHERE id = ?").get(id);
    return row ? mapIssueAction(row) : undefined;
  }

  awaitingIssueActions(chatId: string, threadKey: string): IssueAction[] {
    return this.#db.query<IssueActionRow, [string, string]>(`
      SELECT * FROM issue_actions
      WHERE chat_id = ? AND thread_key = ? AND status = 'awaiting_choice'
      ORDER BY created_at DESC
    `).all(chatId, threadKey).map(mapIssueAction);
  }

  beginIssueActionForDuplicate(id: string): boolean {
    const result = this.#db.query(`
      UPDATE issue_actions
      SET status = 'executing', error = NULL, updated_at = ?
      WHERE id = ? AND status = 'awaiting_choice'
    `).run(Date.now(), id);
    return result.changes === 1;
  }

  markIssueActionAwaitingChoice(id: string, result: Record<string, unknown>): void {
    this.#db.query(`
      UPDATE issue_actions
      SET status = 'awaiting_choice', result_json = ?, error = NULL, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(result), Date.now(), id);
  }

  updateIssueActionResult(id: string, result: Record<string, unknown>): void {
    this.#db.query(`
      UPDATE issue_actions SET result_json = ?, updated_at = ?
      WHERE id = ? AND status = 'executing'
    `).run(JSON.stringify(result), Date.now(), id);
  }

  completeIssueAction(id: string, result: Record<string, unknown>): void {
    this.#db.query(`
      UPDATE issue_actions
      SET status = 'completed', result_json = ?, error = NULL, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(result), Date.now(), id);
  }

  failIssueAction(id: string, error: string): void {
    this.#db.query(`
      UPDATE issue_actions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
    `).run(error.slice(0, 2_000), Date.now(), id);
  }

  cancelIssueActionForDuplicate(id: string, result: Record<string, unknown>): void {
    this.#db.query(`
      UPDATE issue_actions
      SET status = 'cancelled', result_json = ?, error = NULL, updated_at = ?
      WHERE id = ? AND status = 'awaiting_choice'
    `).run(JSON.stringify(result), Date.now(), id);
  }

  initializeRuntimeSession(sessionId: string, capabilityAbi: string): RuntimeSessionBinding {
    if (this.runtimeSession() || this.runtimeSessionMigration() || this.runtimeSetupSessionId()) {
      throw new Error("Runtime Session state is already initialized");
    }
    assertSessionId(sessionId);
    assertCapabilityAbi(capabilityAbi);
    const now = Date.now();
    this.#db.query(`
      INSERT INTO runtime_session_binding
        (singleton, session_id, capability_abi, turn_count, created_at, updated_at)
      VALUES (1, ?, ?, 0, ?, ?)
    `).run(sessionId, capabilityAbi, now, now);
    return this.runtimeSession() as RuntimeSessionBinding;
  }

  prepareRuntimeSetupSession(sessionId: string): string {
    assertSessionId(sessionId);
    if (this.runtimeSession() || this.runtimeSessionMigration()) {
      throw new Error("Runtime setup cannot start while another Runtime identity exists");
    }
    const existing = this.runtimeSetupSessionId();
    if (existing) {
      if (existing !== sessionId) throw new Error("A different Runtime setup is already prepared");
      return existing;
    }
    this.#db.query(`
      INSERT INTO runtime_initial_setup (singleton, session_id, created_at)
      VALUES (1, ?, ?)
    `).run(sessionId, Date.now());
    return sessionId;
  }

  runtimeSetupSessionId(): string | undefined {
    return this.#db.query<{ session_id: string }, []>(`
      SELECT session_id FROM runtime_initial_setup WHERE singleton = 1
    `).get()?.session_id;
  }

  activateRuntimeSetupSession(sessionId: string, capabilityAbi: string): RuntimeSessionBinding {
    assertSessionId(sessionId);
    assertCapabilityAbi(capabilityAbi);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.runtimeSession() || this.runtimeSessionMigration()) {
        throw new Error("Runtime identity changed while first-run setup was active");
      }
      if (this.runtimeSetupSessionId() !== sessionId) {
        throw new Error("Prepared Runtime setup identity changed before activation");
      }
      const now = Date.now();
      this.#db.query(`
        INSERT INTO runtime_session_binding
          (singleton, session_id, capability_abi, turn_count, created_at, updated_at)
        VALUES (1, ?, ?, 0, ?, ?)
      `).run(sessionId, capabilityAbi, now, now);
      this.#db.query("DELETE FROM runtime_initial_setup WHERE singleton = 1").run();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.runtimeSession() as RuntimeSessionBinding;
  }

  assertRuntimeSessionCandidate(
    sessionId: string,
    capabilityAbi: string,
  ): RuntimeSessionCandidateStatus {
    assertSessionId(sessionId);
    assertCapabilityAbi(capabilityAbi);
    const binding = this.runtimeSession();
    if (!binding) {
      throw new Error("Permanent Runtime Session is not initialized; run bun run runtime:session:init");
    }
    if (binding.sessionId === sessionId) {
      if (binding.capabilityAbi !== capabilityAbi) {
        throw capabilityMismatch(binding.capabilityAbi, capabilityAbi);
      }
      return "active";
    }
    const migration = this.runtimeSessionMigration();
    if (
      migration?.sourceSessionId === binding.sessionId
      && migration.targetSessionId === sessionId
      && migration.capabilityAbi === capabilityAbi
    ) return "prepared";
    throw new Error(
      `Runtime Session identity mismatch: active ${binding.sessionId}, configured ${sessionId}`,
    );
  }

  activateRuntimeSession(sessionId: string, capabilityAbi: string): RuntimeSessionBinding {
    const candidate = this.assertRuntimeSessionCandidate(sessionId, capabilityAbi);
    if (candidate === "active") return this.runtimeSession() as RuntimeSessionBinding;
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.runtimeSession();
      const migration = this.runtimeSessionMigration();
      if (
        !binding
        || !migration
        || migration.sourceSessionId !== binding.sessionId
        || migration.targetSessionId !== sessionId
        || migration.capabilityAbi !== capabilityAbi
      ) throw new Error("Prepared Runtime Session migration changed before activation");
      this.#db.query(`
        INSERT INTO runtime_session_history (
          session_id, capability_abi, turn_count, last_source_message_id,
          created_at, updated_at, retired_at, successor_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        binding.sessionId,
        binding.capabilityAbi ?? null,
        binding.turnCount,
        binding.lastSourceMessageId ?? null,
        binding.createdAt,
        binding.updatedAt,
        now,
        sessionId,
      );
      this.#db.query(`
        UPDATE runtime_session_binding
        SET session_id = ?, capability_abi = ?, turn_count = 0,
            last_source_message_id = NULL, context_turn_id = NULL,
            context_used_tokens = NULL, context_window_tokens = NULL,
            created_at = ?, updated_at = ?
        WHERE singleton = 1 AND session_id = ?
      `).run(sessionId, capabilityAbi, now, now, binding.sessionId);
      this.#db.query("DELETE FROM runtime_session_migration WHERE singleton = 1").run();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.runtimeSession() as RuntimeSessionBinding;
  }

  prepareRuntimeSessionMigration(
    input: Omit<RuntimeSessionMigration, "createdAt">,
  ): RuntimeSessionMigration {
    assertSessionId(input.sourceSessionId);
    assertSessionId(input.targetSessionId);
    if (input.sourceSessionId === input.targetSessionId) {
      throw new Error("Runtime Session migration must create a distinct Session");
    }
    assertCapabilityAbi(input.capabilityAbi);
    assertTranscriptDigest(input.transcriptSha256);
    assertTurnCount(input.sourceTurnCount);
    const binding = this.runtimeSession();
    if (!binding || binding.sessionId !== input.sourceSessionId) {
      throw new Error("Migration source is not the active Runtime Session");
    }
    const existing = this.runtimeSessionMigration();
    if (existing) {
      const same = existing.sourceSessionId === input.sourceSessionId
        && existing.targetSessionId === input.targetSessionId
        && existing.capabilityAbi === input.capabilityAbi
        && existing.transcriptSha256 === input.transcriptSha256
        && existing.sourceTurnCount === input.sourceTurnCount;
      if (!same) throw new Error("A different Runtime Session migration is already prepared");
      return existing;
    }
    const now = Date.now();
    this.#db.query(`
      INSERT INTO runtime_session_migration (
        singleton, source_session_id, target_session_id,
        capability_abi, transcript_sha256, source_turn_count, created_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceSessionId,
      input.targetSessionId,
      input.capabilityAbi,
      input.transcriptSha256,
      input.sourceTurnCount,
      now,
    );
    return this.runtimeSessionMigration() as RuntimeSessionMigration;
  }

  runtimeSessionMigration(): RuntimeSessionMigration | undefined {
    const row = this.#db.query<{
      source_session_id: string;
      target_session_id: string;
      capability_abi: string;
      transcript_sha256: string;
      source_turn_count: number;
      created_at: number;
    }, []>("SELECT * FROM runtime_session_migration WHERE singleton = 1").get();
    if (!row) return undefined;
    return {
      sourceSessionId: row.source_session_id,
      targetSessionId: row.target_session_id,
      capabilityAbi: row.capability_abi,
      transcriptSha256: row.transcript_sha256,
      sourceTurnCount: row.source_turn_count,
      createdAt: row.created_at,
    };
  }

  runtimeSessionHistory(): RetiredRuntimeSession[] {
    return this.#db.query<{
      session_id: string;
      capability_abi: string | null;
      turn_count: number;
      last_source_message_id: string | null;
      created_at: number;
      updated_at: number;
      retired_at: number;
      successor_session_id: string;
    }, []>("SELECT * FROM runtime_session_history ORDER BY retired_at ASC").all().map((row) => ({
      sessionId: row.session_id,
      ...(row.capability_abi ? { capabilityAbi: row.capability_abi } : {}),
      turnCount: row.turn_count,
      ...(row.last_source_message_id ? { lastSourceMessageId: row.last_source_message_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      retiredAt: row.retired_at,
      successorSessionId: row.successor_session_id,
    }));
  }

  runtimeSession(): RuntimeSessionBinding | undefined {
    const row = this.#db.query<{
      session_id: string;
      capability_abi: string | null;
      turn_count: number;
      last_source_message_id: string | null;
      created_at: number;
      updated_at: number;
    }, []>(`
      SELECT session_id, capability_abi, turn_count, last_source_message_id, created_at, updated_at
      FROM runtime_session_binding WHERE singleton = 1
    `).get();
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      ...(row.capability_abi ? { capabilityAbi: row.capability_abi } : {}),
      turnCount: row.turn_count,
      ...(row.last_source_message_id ? { lastSourceMessageId: row.last_source_message_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  completeRuntimeTurn(sessionId: string, sourceMessageId: string): void {
    const result = this.#db.query(`
      UPDATE runtime_session_binding
      SET turn_count = turn_count + 1, last_source_message_id = ?, updated_at = ?
      WHERE singleton = 1 AND session_id = ?
    `).run(sourceMessageId, Date.now(), sessionId);
    if (result.changes !== 1) throw new Error("Runtime Session binding is missing or changed");
  }

  saveRuntimeContextUsage(usage: PersistedRuntimeContextUsage): void {
    if (!usage.sessionId || !usage.turnId) throw new Error("Runtime context usage identity is missing");
    if (!Number.isInteger(usage.usedTokens) || usage.usedTokens < 0) {
      throw new Error("Runtime context usage must contain a non-negative token count");
    }
    if (!Number.isInteger(usage.modelContextWindow) || usage.modelContextWindow <= 0) {
      throw new Error("Runtime context usage must contain a positive context window");
    }
    const result = this.#db.query(`
      UPDATE runtime_session_binding
      SET context_turn_id = ?, context_used_tokens = ?, context_window_tokens = ?, updated_at = ?
      WHERE singleton = 1 AND session_id = ?
    `).run(
      usage.turnId,
      usage.usedTokens,
      usage.modelContextWindow,
      Date.now(),
      usage.sessionId,
    );
    if (result.changes !== 1) throw new Error("Runtime Session binding is missing or changed");
  }

  clearRuntimeContextUsage(sessionId: string): void {
    const result = this.#db.query(`
      UPDATE runtime_session_binding
      SET context_turn_id = NULL, context_used_tokens = NULL,
          context_window_tokens = NULL, updated_at = ?
      WHERE singleton = 1 AND session_id = ?
    `).run(Date.now(), sessionId);
    if (result.changes !== 1) throw new Error("Runtime Session binding is missing or changed");
  }

  runtimeContextUsage(sessionId: string): PersistedRuntimeContextUsage | undefined {
    const row = this.#db.query<{
      session_id: string;
      context_turn_id: string | null;
      context_used_tokens: number | null;
      context_window_tokens: number | null;
    }, [string]>(`
      SELECT session_id, context_turn_id, context_used_tokens, context_window_tokens
      FROM runtime_session_binding
      WHERE singleton = 1 AND session_id = ?
    `).get(sessionId);
    if (
      !row
      || row.context_turn_id === null
      || row.context_used_tokens === null
      || row.context_window_tokens === null
    ) return undefined;
    return {
      sessionId: row.session_id,
      turnId: row.context_turn_id,
      usedTokens: row.context_used_tokens,
      modelContextWindow: row.context_window_tokens,
    };
  }

  allowRequest(scopeKey: string, limit: number, windowMilliseconds: number): boolean {
    const now = Date.now();
    const cutoff = now - windowMilliseconds;
    this.#db.query("DELETE FROM rate_limit_events WHERE created_at < ?").run(cutoff);
    const row = this.#db.query<{ count: number }, [string, number]>(`
      SELECT COUNT(*) AS count FROM rate_limit_events WHERE scope_key = ? AND created_at >= ?
    `).get(scopeKey, cutoff);
    if ((row?.count ?? 0) >= limit) return false;
    this.#db.query("INSERT INTO rate_limit_events (scope_key, created_at) VALUES (?, ?)").run(scopeKey, now);
    return true;
  }

  close(): void {
    this.#db.close();
  }
}

function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 128) throw new Error("Permanent Runtime Session ID is invalid");
}

function assertCapabilityAbi(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error("Invalid Runtime capability ABI");
}

function assertTranscriptDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error("Migration transcript digest must be SHA-256");
}

function assertTurnCount(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Migration source turn count must be a non-negative integer");
  }
}

function capabilityMismatch(stored: string | undefined, current: string): Error {
  return new Error(
    `Permanent Runtime Session capability ABI mismatch: stored ${stored ?? "unbound"}, current ${current}; stop the Bot and run bun run runtime:session:migrate`,
  );
}

function mapIssueAction(row: IssueActionRow): IssueAction {
  if (!isGitHubFullName(row.repository_full_name)) throw new Error("Issue audit repository name is invalid");
  const mutation = JSON.parse(row.mutation_json) as IssueMutation;
  const result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : undefined;
  return {
    id: row.id,
    repositoryScope: parseGitHubScope(JSON.parse(row.repository_scope_json)),
    repositoryFullName: row.repository_full_name,
    chatId: row.chat_id,
    threadKey: row.thread_key,
    proposedBy: row.proposed_by,
    proposalMessageId: row.proposal_message_id,
    mutation,
    fingerprint: row.fingerprint,
    status: row.status,
    ...(result ? { result } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
