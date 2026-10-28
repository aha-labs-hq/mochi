import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state.ts";
import { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, prepareStateDatabase } from "../src/state/schema.ts";
import { PROCESSED_EVENT_RETENTION_MILLISECONDS } from "../src/state.ts";

const ABI_ONE = `sha256:${"1".repeat(64)}`;
const ABI_TWO = `sha256:${"2".repeat(64)}`;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("state store", () => {
  test("pre-release schemas fail closed without being upgraded, cleared or rebound", () => {
    for (const version of [5, 7, 8]) {
      const database = new Database(":memory:");
      database.exec(`PRAGMA user_version = ${version}; CREATE TABLE runtime_session_binding (session_id TEXT); INSERT INTO runtime_session_binding VALUES ('existing-session')`);
      expect(() => prepareStateDatabase(database)).toThrow(`schema ${version} is unsupported`);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: version });
      expect(database.query("SELECT * FROM runtime_session_binding").all()).toEqual([{ session_id: "existing-session" }]);
      expect(database.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "runtime_session_binding" }]);
      database.close();
    }
  });
  test("atomically claims a Feishu message and activates its topic exactly once", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    const context = {
      chatId: "oc_chat",
      threadKey: "om_thread",
      requesterId: "ou_user",
      sourceMessageId: "om_message",
    };
    expect(state.topicIsActive("oc_chat", "om_thread")).toBeFalse();
    expect(state.claimEvent("om_message", context, true)).toBeTrue();
    expect(state.topicIsActive("oc_chat", "om_thread")).toBeTrue();
    expect(state.claimEvent("om_message", context, true)).toBeFalse();
    state.completeEvent("om_message");
    state.close();

    const restored = new StateStore(join(directory, "state.sqlite"));
    expect(restored.topicIsActive("oc_chat", "om_thread")).toBeTrue();
    restored.close();
  });

  test("does not activate a topic for an ordinary claimed event", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    const context = {
      chatId: "oc_chat",
      threadKey: "omt_inactive",
      requesterId: "ou_user",
      sourceMessageId: "om_message",
    };
    expect(state.claimEvent("om_message", context)).toBeTrue();
    expect(state.topicIsActive("oc_chat", "omt_inactive")).toBeFalse();
    state.close();
  });

  test("marks interrupted message claims failed instead of leaving invisible processing rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const state = new StateStore(path);
    expect(state.claimEvent("om_interrupted", {
      chatId: "oc_chat",
      threadKey: "omt_thread",
      requesterId: "ou_user",
      sourceMessageId: "om_interrupted",
    })).toBeTrue();
    state.close();

    const restored = new StateStore(path);
    expect(restored.recoverInterruptedEvents()).toEqual(["om_interrupted"]);
    expect(restored.recoverInterruptedEvents()).toEqual([]);
    expect(restored.claimEvent("om_interrupted", {
      chatId: "oc_chat",
      threadKey: "omt_thread",
      requesterId: "ou_user",
      sourceMessageId: "om_interrupted",
    })).toBeFalse();
    restored.close();
  });

  test("records the explicit database schema version", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const state = new StateStore(path);
    state.close();
    const database = new Database(path);
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
      .toBe(CURRENT_SCHEMA_VERSION);
    database.close();
  });

  test("opening a current database rewrites nothing, so an unactivated claim stays unactivated", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const state = new StateStore(path);
    expect(state.claimEvent("om_message", {
      chatId: "oc_chat", threadKey: "omt_quiet", requesterId: "ou_user", sourceMessageId: "om_message",
    })).toBeTrue();
    state.close();
    const schema = () => {
      const database = new Database(path);
      try { return database.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(); }
      finally { database.close(); }
    };
    const before = schema();
    const reopened = new StateStore(path);
    expect(reopened.topicIsActive("oc_chat", "omt_quiet")).toBeFalse();
    reopened.close();
    expect(schema()).toEqual(before);
    expect(JSON.stringify(before)).not.toContain("github_project_selections");
  });

  test("forgets finished message claims after the redelivery window, never an in-flight one", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const claim = (state: StateStore, messageId: string) => state.claimEvent(messageId, {
      chatId: "oc_chat", threadKey: "omt_thread", requesterId: "ou_user", sourceMessageId: messageId,
    });
    const state = new StateStore(path);
    expect(claim(state, "om_old_completed")).toBeTrue();
    state.completeEvent("om_old_completed");
    expect(claim(state, "om_old_failed")).toBeTrue();
    state.failEvent("om_old_failed", "delivery failed");
    expect(claim(state, "om_old_processing")).toBeTrue();
    expect(claim(state, "om_recent")).toBeTrue();
    state.completeEvent("om_recent");
    state.close();
    // Feishu's last retry comes about 7 h after the first push; a week is far past it.
    expect(PROCESSED_EVENT_RETENTION_MILLISECONDS).toBeGreaterThan(20 * 7 * 60 * 60 * 1_000);
    const database = new Database(path);
    database.query("UPDATE processed_events SET created_at = ? WHERE message_id LIKE 'om_old_%'")
      .run(Date.now() - PROCESSED_EVENT_RETENTION_MILLISECONDS - 1);
    database.close();

    const reopened = new StateStore(path);
    expect(claim(reopened, "om_new")).toBeTrue();
    // A retired id could be claimed again, but only a redelivery inside the window is possible.
    expect(claim(reopened, "om_recent")).toBeFalse();
    expect(claim(reopened, "om_old_processing")).toBeFalse();
    reopened.close();
    const remaining = new Database(path);
    expect(remaining.query("SELECT message_id FROM processed_events ORDER BY message_id").all().map((row) => (row as { message_id: string }).message_id))
      .toEqual(["om_new", "om_old_processing", "om_recent"]);
    remaining.close();
  });

  test("recognizes a legacy thread_id activation among current event aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    const legacyContext = {
      chatId: "oc_chat",
      threadKey: "omt_existing",
      requesterId: "ou_user",
      sourceMessageId: "om_legacy",
    };
    expect(state.claimEvent("om_legacy", legacyContext, true)).toBeTrue();
    expect(state.topicIsActive("oc_chat", ["om_root", "omt_existing"])).toBeTrue();
    expect(state.activeTopicKey("oc_chat", ["om_root", "omt_existing"]))
      .toBe("omt_existing");
    state.close();
  });

  test("canonicalizes changing roots to one stable native thread and migrates active state", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    const initial = state.resolveTopicIdentity("oc_chat", "om_root_one", ["om_root_one", "om_message_one"]);
    expect(initial).toEqual({ threadKey: "om_root_one", active: false });
    expect(state.claimEvent("om_message_one", {
      chatId: "oc_chat",
      threadKey: initial.threadKey,
      requesterId: "ou_user",
      sourceMessageId: "om_message_one",
    }, true)).toBeTrue();

    const reply = state.resolveTopicIdentity(
      "oc_chat",
      "omt_stable",
      ["omt_stable", "om_root_one", "om_root_two", "om_reply"],
    );
    expect(reply).toEqual({ threadKey: "omt_stable", active: true });
    expect(state.topicIsActive("oc_chat", ["om_root_one", "om_root_two", "omt_stable"])).toBeTrue();
    expect(state.activeTopicKey("oc_chat", ["om_root_two"])).toBe("omt_stable");
    state.close();
  });

  test("binds one permanent Runtime Session to its immutable capability ABI", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    expect(state.runtimeSession()).toBeUndefined();
    state.initializeRuntimeSession("session-permanent", ABI_ONE);
    expect(state.assertRuntimeSessionCandidate("session-permanent", ABI_ONE)).toBe("active");
    state.completeRuntimeTurn("session-permanent", "om_one");
    expect(state.runtimeSession()).toMatchObject({
      sessionId: "session-permanent",
      capabilityAbi: ABI_ONE,
      turnCount: 1,
      lastSourceMessageId: "om_one",
    });
    state.saveRuntimeContextUsage({
      sessionId: "session-permanent",
      turnId: "turn-usage",
      usedTokens: 76_000,
      modelContextWindow: 100_000,
    });
    expect(state.runtimeContextUsage("session-permanent")).toEqual({
      sessionId: "session-permanent",
      turnId: "turn-usage",
      usedTokens: 76_000,
      modelContextWindow: 100_000,
    });
    expect(() => state.assertRuntimeSessionCandidate("session-permanent", ABI_TWO))
      .toThrow("capability ABI mismatch");
    expect(() => state.initializeRuntimeSession("session-replacement", ABI_TWO))
      .toThrow("already initialized");
    state.close();

    const restored = new StateStore(join(directory, "state.sqlite"));
    expect(restored.runtimeContextUsage("session-permanent")).toEqual({
      sessionId: "session-permanent",
      turnId: "turn-usage",
      usedTokens: 76_000,
      modelContextWindow: 100_000,
    });
    restored.close();
  });

  test("persists one first-run Session candidate and promotes it atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const state = new StateStore(path);
    expect(state.prepareRuntimeSetupSession("session-first-run"))
      .toBe("session-first-run");
    state.close();

    const restored = new StateStore(path);
    expect(restored.runtimeSetupSessionId()).toBe("session-first-run");
    expect(restored.prepareRuntimeSetupSession("session-first-run"))
      .toBe("session-first-run");
    expect(() => restored.prepareRuntimeSetupSession("session-other"))
      .toThrow("different Runtime setup");
    expect(restored.activateRuntimeSetupSession("session-first-run", ABI_ONE)).toMatchObject({
      sessionId: "session-first-run",
      capabilityAbi: ABI_ONE,
      turnCount: 0,
    });
    expect(restored.runtimeSetupSessionId()).toBeUndefined();
    expect(() => restored.activateRuntimeSetupSession("session-first-run", ABI_ONE))
      .toThrow("Runtime identity changed");
    restored.close();
  });

  test("promotes only a verified prepared migration and preserves retired lineage", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    state.initializeRuntimeSession("session-old", ABI_ONE);
    state.completeRuntimeTurn("session-old", "om_last");
    state.saveRuntimeContextUsage({
      sessionId: "session-old",
      turnId: "turn-old-usage",
      usedTokens: 88_000,
      modelContextWindow: 100_000,
    });
    state.prepareRuntimeSessionMigration({
      sourceSessionId: "session-old",
      targetSessionId: "session-new",
      capabilityAbi: ABI_TWO,
      transcriptSha256: `sha256:${"a".repeat(64)}`,
      sourceTurnCount: 12,
    });
    expect(state.assertRuntimeSessionCandidate("session-new", ABI_TWO)).toBe("prepared");
    expect(() => state.activateRuntimeSession("session-other", ABI_TWO))
      .toThrow("identity mismatch");
    expect(state.activateRuntimeSession("session-new", ABI_TWO)).toMatchObject({
      sessionId: "session-new",
      capabilityAbi: ABI_TWO,
      turnCount: 0,
    });
    expect(state.runtimeContextUsage("session-new")).toBeUndefined();
    expect(state.runtimeSessionMigration()).toBeUndefined();
    expect(state.runtimeSessionHistory()).toEqual([
      expect.objectContaining({
        sessionId: "session-old",
        capabilityAbi: ABI_ONE,
        turnCount: 1,
        lastSourceMessageId: "om_last",
        successorSessionId: "session-new",
      }),
    ]);
    state.close();
  });

  test("rejects historical database schemas instead of carrying compatibility code", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const database = new Database(path);
    database.exec("PRAGMA user_version = 4");
    database.close();
    expect(() => new StateStore(path)).toThrow("schema 4 is unsupported");
  });

  test("enforces a local per-scope rate limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-state-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    expect(state.allowRequest("user:ou_test", 2, 60_000)).toBeTrue();
    expect(state.allowRequest("user:ou_test", 2, 60_000)).toBeTrue();
    expect(state.allowRequest("user:ou_test", 2, 60_000)).toBeFalse();
    expect(state.allowRequest("user:ou_other", 2, 60_000)).toBeTrue();
    state.close();
  });
});
