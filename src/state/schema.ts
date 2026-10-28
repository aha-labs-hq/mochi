import type { Database } from "bun:sqlite";
import { SCHEDULE_SCHEMA } from "../schedules/store.ts";

/**
 * The one supported schema. Development data from before 0.2.0 (schemas 5 to 8)
 * was migrated and the migrations removed; a later schema adds its own step.
 */
export const CURRENT_SCHEMA_VERSION = 9;

const ISSUE_ACTION_SCHEMA = `
  CREATE TABLE issue_actions (
    id TEXT PRIMARY KEY,
    repository_scope_json TEXT NOT NULL,
    repository_full_name TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    proposed_by TEXT NOT NULL,
    proposal_message_id TEXT NOT NULL,
    mutation_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
      'awaiting_choice', 'executing', 'completed', 'failed', 'cancelled'
    )),
    result_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(proposal_message_id, fingerprint)
  );
  CREATE INDEX issue_actions_thread_idx
    ON issue_actions(chat_id, thread_key, status, created_at DESC);
`;

/**
 * One Bot's selected connector resources, across every provider.
 *
 * A resource is identified by the provider's own stable token, never by the URL
 * an owner pasted: providers redirect and rename, so the resolved token is the
 * only fact a later read may depend on. Rows exist only after the adapter proved
 * it can read them, so this records a durable Mochi range choice rather than a
 * wish list. It is not a provider grant and must be re-proved before use.
 */
const CONNECTOR_RESOURCE_SELECTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS connector_resource_selections (
    connection_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    display_name TEXT NOT NULL,
    address TEXT NOT NULL,
    selection_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(connection_id, resource_id)
  );
`;

/**
 * The connector write ledger: idempotency and provenance in one record.
 *
 * A provider adapter cannot prove it did not already act, so the Broker keeps
 * the decision here — the first caller claims the key and a replay is answered
 * from the stored result without reaching the adapter. The source message, topic
 * and requester live with it because "was this authorized, by whom, from which
 * message, and has it already happened" is one question with one lifecycle.
 *
 * The primary key is the capability invocation, not the catalog revision: a
 * revision bump must not orphan a key. A `pending` row is an in-flight claim and
 * is never evicted; only an `applied` row may be, so a retry after a transient
 * failure is still possible.
 */
const CONNECTOR_WRITE_LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS connector_write_ledger (
    connection_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    catalog_revision TEXT NOT NULL,
    capability_revision TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied')),
    source_message_id TEXT NOT NULL,
    topic_key TEXT NOT NULL,
    requester_id TEXT NOT NULL,
    authorization_digest TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(connection_id, capability_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS connector_write_ledger_recency_idx
    ON connector_write_ledger(connection_id, updated_at DESC);
`;

/**
 * Opens a Bot's state at the current schema.
 *
 * A current database is used as it is, without rewriting anything; an empty one
 * is created in one transaction. Anything else fails closed and unmodified:
 * replacing an active Session database is never a way past an unknown schema.
 */
export function prepareStateDatabase(database: Database): void {
  const schemaVersion = database.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version ?? 0;
  if (schemaVersion === CURRENT_SCHEMA_VERSION) return;
  if (schemaVersion !== 0) {
    throw new Error(
      `State database schema ${schemaVersion} is unsupported (current: ${CURRENT_SCHEMA_VERSION}); the database was not modified and must never be replaced while it holds a Session`,
    );
  }
  if (database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) {
    throw new Error("Unversioned state requires an explicit offline audit; the database was not modified");
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE disabled_feishu_groups (
        app_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(app_id, chat_id)
      );

      CREATE TABLE processed_events (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE active_topics (
        chat_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        activated_by_message_id TEXT NOT NULL,
        activated_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, thread_key)
      );

      CREATE TABLE topic_aliases (
        chat_id TEXT NOT NULL,
        alias_key TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, alias_key)
      );
      CREATE INDEX topic_aliases_topic_idx
        ON topic_aliases(chat_id, topic_key);

      CREATE TABLE runtime_session_binding (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        session_id TEXT NOT NULL UNIQUE,
        capability_abi TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        last_source_message_id TEXT,
        context_turn_id TEXT,
        context_used_tokens INTEGER,
        context_window_tokens INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX rate_limit_scope_idx
        ON rate_limit_events(scope_key, created_at);

      CREATE TABLE runtime_session_migration (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        source_session_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL UNIQUE,
        capability_abi TEXT NOT NULL,
        transcript_sha256 TEXT NOT NULL,
        source_turn_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE runtime_session_history (
        session_id TEXT PRIMARY KEY,
        capability_abi TEXT,
        turn_count INTEGER NOT NULL,
        last_source_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        retired_at INTEGER NOT NULL,
        successor_session_id TEXT NOT NULL UNIQUE
      );

      CREATE TABLE runtime_initial_setup (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        session_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
    `);
    database.exec(CONNECTOR_RESOURCE_SELECTION_SCHEMA);
    database.exec(CONNECTOR_WRITE_LEDGER_SCHEMA);
    database.exec(ISSUE_ACTION_SCHEMA);
    database.exec(SCHEDULE_SCHEMA);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  }).immediate();
}
