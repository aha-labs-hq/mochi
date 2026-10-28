import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FleetStatusProjection,
  MAXIMUM_STATUS_BYTES,
  readFleetStatusSnapshot,
  STATUS_VERSION,
  type FleetStatusSnapshot,
  type RuntimeAccountSnapshot,
} from "../src/control/statusSnapshot.ts";
import { MOCHI_CONTROL_PROTOCOL_VERSION } from "../src/control/protocol.ts";
import { productVersion } from "../src/product/version.ts";

const directories: string[] = [];
const BOT_ID = "11111111-2222-4333-8444-555555555555";
const SECOND_BOT_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fleet(bots: readonly { id: string; label: string; characterId: string; enabled: boolean }[] = [
  { id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true },
]) {
  const directory = mkdtempSync(join(tmpdir(), "mochi-status-"));
  directories.push(directory);
  const path = join(directory, "private", "status.json");
  const projection = new FleetStatusProjection(path);
  projection.roster(bots.map((bot) => ({ ...bot, characterId: "mochi" })));
  return { directory, path, projection, bot: projection.bot(bots[0]!.id) };
}

function read(path: string): FleetStatusSnapshot {
  const result = readFleetStatusSnapshot(path, process.pid);
  if (result.kind !== "current") throw new Error(`Status is ${result.kind}`);
  return result.snapshot;
}

import type { ConnectorCatalogProjection } from "../src/control/connectorSnapshot.ts";

const CONNECTION: ConnectorCatalogProjection["connections"][number] = {
  connectionId: "github:1",
  providerId: "github",
  providerDisplayName: "GitHub",
  status: "ready" as const,
  accountDisplayName: "customer",
  problem: null,
  grantedScopes: [],
  resourceScope: { status: "ready", selectedCount: 1 },
  resources: [
    {
      resourceId: "repository:20",
      resourceType: "repository",
      displayName: "customer/alpha",
      selectionId: "a".repeat(32),
      selected: true,
            ownerId: "1",
            visibility: "public",
            writable: true,
    },
  ],
  capabilities: [
    { id: "list.issues", displayName: "列出 Issue", description: "List issues.", operation: "read" as const, resourceSelection: "required" as const, availability: "ready" as const },
  ],
};

const CATALOG: ConnectorCatalogProjection = {
  revision: `sha256:${"b".repeat(64)}`,
  connections: [CONNECTION],
};

describe("fleet status projection", () => {
  test("one writer publishes the whole deployment, and a Bot can only change its own entry", () => {
    const f = fleet([
      { id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true },
      { id: SECOND_BOT_ID, label: "工作", characterId: "mochi", enabled: false },
    ]);
    f.projection.controlReady();
    f.projection.accountChanged({
      status: "signedIn",
      account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
    });
    f.bot.starting();
    f.projection.bot(SECOND_BOT_ID).starting();

    expect(f.projection.snapshot()).toMatchObject({
      version: STATUS_VERSION,
      productVersion: productVersion(),
      bridgeVersion: 1,
      controlProtocolVersion: MOCHI_CONTROL_PROTOCOL_VERSION,
      processId: process.pid,
      controlAvailable: true,

    });
    expect(f.projection.snapshot().bots.map((bot) => [bot.botId, bot.label, bot.enabled, bot.lifecycle]))
      .toEqual([[BOT_ID, "麻薯", true, "starting"], [SECOND_BOT_ID, "工作", false, "starting"]]);

    expect(f.projection.snapshot()).toMatchObject({
      runtimeAccount: {
        status: "signedIn",
        account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
      },
    });
    // One Bot publishing never rewrites another Bot's row.
    f.bot.eventStreamReady();
    const after = f.projection.snapshot().bots;
    expect(after[0]!.lifecycle).toBe("listening");
    expect(after[1]!.lifecycle).toBe("starting");
    expect(readdirSync(join(f.directory, "private"))).toEqual(["status.json"]);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.directory, "private")).mode & 0o777).toBe(0o700);
    // A Bot that is on the roster but was never handed out cannot publish at all.
    expect(() => f.projection.bot("99999999-9999-4999-8999-999999999999"))
      .toThrow("is not in the published roster");
    f.projection.stopping();
  });

  test("the shared file bound fits one Bot's full group catalog and rejects oversized status", () => {
    const f = fleet();
    const prefix = "https://s1-imfile.feishucdn.com/";
    f.bot.groupsChanged(Array.from({ length: 1_000 }, (_, group) => ({
      id: `oc_${group}`, name: "群".repeat(512),
      avatarUrl: prefix + "a".repeat(4_096 - prefix.length), enabled: true,
    })));
    expect(statSync(f.path).size).toBeGreaterThan(65_536);
    expect(statSync(f.path).size).toBeLessThan(MAXIMUM_STATUS_BYTES);
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");
    writeFileSync(f.path, " ".repeat(MAXIMUM_STATUS_BYTES + 1));
    expect(readFleetStatusSnapshot(f.path, process.pid))
      .toMatchObject({ kind: "invalid", reason: "status exceeds size limit" });
  });

  test("group inventory is bounded and independent of connection health", () => {
    const f = fleet();
    expect(f.bot.snapshot().feishuGroups).toBeNull();
    f.bot.groupsChanged([{ id: "oc_test", name: "Mochi 测试群", avatarUrl: null, enabled: true }]);
    expect(f.bot.snapshot().feishuGroups).toEqual([{ id: "oc_test", name: "Mochi 测试群", avatarUrl: null, enabled: true }]);
    expect(f.bot.snapshot().eventStreamReady).toBe(false);
    for (const feishuGroups of [
      { name: "Group", chatId: "oc_private" },
      { name: "Group", avatar: "https://private" },
      { name: "" }, { name: "a\nforged" }, { name: "x".repeat(513) },
      { name: "‮Group" }, "Group", {},
    ]) {
      writeFileSync(f.path, JSON.stringify(withBot(f.projection.snapshot(), { feishuGroups })));
      expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    }
    f.bot.groupsChanged([{ id: "oc_test", name: null, avatarUrl: null, enabled: false }]);
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");
    f.bot.groupsChanged(null);
    expect(f.bot.snapshot().feishuGroups).toBeNull();
    writeFileSync(f.path, JSON.stringify({ ...f.projection.snapshot(), version: 12 }));
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.stopping();
  });

  test("a Bot's own connector catalog is published per Bot and validated on read", () => {
    const f = fleet();
    expect(f.bot.snapshot().connectorCatalog).toBeNull();
    f.bot.connectorCatalogChanged(CATALOG);
    expect(f.bot.snapshot().connectorCatalog).toEqual(CATALOG);
    expect(read(f.path).bots[0]!.connectorCatalog).toEqual(CATALOG);

    // Every malformed catalog below is rejected on read rather than rendered: a
    // provider address in a display name, an empty selection identity, an
    // unbounded status, and a value that is not a catalog at all.
    for (const connectorCatalog of [
      { ...CATALOG, revision: "not-a-revision" },
      { ...CATALOG, connections: [{ ...CONNECTION, resources: [{}] }] },
      {
        ...CATALOG,
        connections: [{
          ...CONNECTION,
          resources: [{ ...CONNECTION.resources[0]!, selectionId: "" }],
        }],
      },
      // A display name is provider text, so its content is not this layer's
      // business — but its bounds are, and an unbounded one is refused.
      {
        ...CATALOG,
        connections: [{ ...CONNECTION, resources: [{ ...CONNECTION.resources[0]!, displayName: "x".repeat(300) }] }],
      },
      {
        ...CATALOG,
        connections: [{ ...CONNECTION, resources: [{ ...CONNECTION.resources[0]!, displayName: `bad\u0000name` }] }],
      },
      { ...CATALOG, connections: [{ ...CONNECTION, status: "unknown" }] },
      // The retired boolean cannot sneak through as a second fact owner.
      { ...CATALOG, connections: [{ ...CONNECTION, capabilities: [{ id: "list.issues", displayName: "列出 Issue", description: "List issues.", operation: "read", ready: true }] }] },
      { ...CATALOG, connections: [{ ...CONNECTION, capabilities: [{ ...CONNECTION.capabilities[0]!, availability: "authorized" }] }] },
      { ...CATALOG, connections: [{ ...CONNECTION, capabilities: [{ ...CONNECTION.capabilities[0]!, resourceSelection: "automatic" }] }] },
      { ...CATALOG, connections: [{ ...CONNECTION, capabilities: [{ ...CONNECTION.capabilities[0]!, resourceSelection: undefined }] }] },
      { ...CATALOG, connections: [{ ...CONNECTION, extra: true }] },
      "customer/alpha",
    ]) {
      writeFileSync(f.path, JSON.stringify(withBot(f.projection.snapshot(), { connectorCatalog })));
      expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    }
    f.projection.stopping();
  });

  test("a Bot cannot publish credentials, session identities or unknown fields", () => {
    const f = fleet();
    f.projection.accountChanged({
      status: "signedIn",
      account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
    });
    f.projection.controlReady();
    f.bot.eventStreamReady();
    const snapshot = read(f.path);
    expect(snapshot.bots[0]).toMatchObject({ lifecycle: "listening", eventStreamReady: true });
    // Only host facts appear at the top level.
    expect(Object.keys(snapshot).sort().join(","))
      .toBe("accountChangeReady,bots,bridgeVersion,controlAvailable,controlProtocolVersion,processId,productVersion,runId,runtimeAccount,updatedAt,validUntil,version");
    expect(Object.keys(snapshot.bots[0]!).sort().join(","))
      .toBe("activeTurn,botId,botPolicy,characterId,connectorCatalog,contextOrganizationAvailable,enabled,eventStreamReady,feishu,feishuGroups,label,lifecycle,organizingContext,queueDepth");
    expect(JSON.stringify(snapshot)).not.toContain("sessionId");
    expect(JSON.stringify(snapshot)).not.toContain("ghu_");
    f.projection.stopping();
  });

  test("keeps the private control plane available while ChatGPT login is required", () => {
    const f = fleet();
    f.projection.controlReady();
    f.projection.accountChanged({ status: "signedOut" });
    f.bot.awaitingLogin();

    expect(f.projection.snapshot()).toMatchObject({
      version: STATUS_VERSION,
      controlProtocolVersion: MOCHI_CONTROL_PROTOCOL_VERSION,
      controlAvailable: true,
    });
    expect(f.bot.snapshot()).toMatchObject({
      lifecycle: "awaitingLogin",
      eventStreamReady: false,
    });
    expect(JSON.stringify(f.projection.snapshot())).not.toContain("email");
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");

    f.projection.accountChanged({ status: "signingIn" });
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");
    // A Bot signed out of a signing-in account is not a coherent pair.
    f.bot.eventStreamReady();
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.stopping();
  });

  test("a Bot may only listen once the Bot account is signed in", () => {
    const f = fleet();
    f.bot.starting();
    f.bot.eventStreamReady();
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.accountChanged({
      status: "signedIn",
      account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
    });
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");
  });

  test("keeps agent eligibility separate from event-stream health", () => {
    const f = fleet();
    f.projection.accountChanged({
      status: "signedIn",
      account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
    });
    f.bot.contextUsageChanged({ usedTokens: 76_000, modelContextWindow: 100_000 });
    f.bot.runtimeStateChanged({
      activeTurn: false,
      organizingContext: false,
      queueDepth: 0,
      contextOrganizationAvailable: true,
    });
    expect(f.bot.snapshot().contextOrganizationAvailable).toBe(true);
    f.bot.eventStreamReady();
    expect(f.bot.snapshot().contextOrganizationAvailable).toBe(true);
    f.bot.eventStreamUnavailable();
    expect(f.bot.snapshot().contextOrganizationAvailable).toBe(true);
    expect(f.bot.snapshot().problem).toEqual({
      version: 2,
      code: "event_stream_unavailable",
      recoverability: "retryable",
      recoveryAction: "restartBot",
    });
    f.bot.policy({ model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(f.bot.snapshot().problem?.code).toBe("event_stream_unavailable");
    expect(f.bot.snapshot().botPolicy).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");
    f.bot.eventStreamReady();
    expect(f.bot.snapshot().problem).toBeUndefined();
    writeFileSync(f.path, JSON.stringify(withBot(f.projection.snapshot(), { queueDepth: 1 })));
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.stopping();
  });

  test("publishes one explicit setup state whose stage must agree with the account", () => {
    const f = fleet();
    f.bot.starting();
    f.bot.setup("checking");
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");
    f.bot.setup("checking", "account_status_unavailable");
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");

    // A `signIn` stage with an unknown account is not a coherent pair.
    writeFileSync(f.path, JSON.stringify(withBot(f.projection.snapshot(), { setup: { stage: "signIn" } })));
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");

    f.bot.setup("signIn", "account_required");
    expect(f.bot.snapshot()).toMatchObject({
      lifecycle: "setup",
      setup: { stage: "signIn" },
      eventStreamReady: false,
    });
    expect(f.projection.snapshot().controlAvailable).toBe(false);
    // The account is still unknown here, so the snapshot is not yet publishable.
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.accountChanged({ status: "signedOut" });
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");
    expect(JSON.stringify(f.projection.snapshot())).not.toContain("sessionId");

    f.projection.accountChanged({
      status: "signedIn",
      account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
    });
    f.bot.setup("ready");
    expect(f.bot.snapshot().setup).toEqual({ stage: "ready" });
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");
    writeFileSync(f.path, JSON.stringify(withBot(f.projection.snapshot(), { setup: { stage: "ready", purpose: "obsolete" } })));
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.stopping();
  });

  test("publishes only declared problem mappings instead of lower-layer prose", () => {
    const f = fleet();
    f.projection.accountChanged({
      status: "signedIn",
      account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
    });
    f.bot.blocked("runtime_session_unavailable");

    expect(f.bot.snapshot().problem).toEqual({
      version: 2,
      code: "runtime_session_unavailable",
      recoverability: "retryable",
      recoveryAction: "restartBot",
    });
    expect(JSON.stringify(f.projection.snapshot())).not.toContain("private path");
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("current");

    writeFileSync(f.path, JSON.stringify(withBot(f.projection.snapshot(), {
      problem: { ...f.bot.snapshot().problem, recoveryAction: "exportDiagnostics" },
    })));
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.stopping();
  });

  test("distinguishes expired and process-mismatched status", () => {
    const f = fleet();
    f.bot.starting();
    const snapshot = f.projection.snapshot();
    expect(readFleetStatusSnapshot(f.path, process.pid + 1).kind).toBe("wrong_process");
    expect(readFleetStatusSnapshot(f.path, process.pid, new Date(Date.parse(snapshot.validUntil) + 1)).kind)
      .toBe("expired");
    expect(readFleetStatusSnapshot(f.path, process.pid, new Date(Date.parse(snapshot.updatedAt) - 30_000)).kind)
      .toBe("invalid");
    f.projection.stopping();
  });

  test("a duplicate roster identity or a non-UUID Bot is refused on read", () => {
    const f = fleet();
    const snapshot = f.projection.snapshot();
    writeFileSync(f.path, JSON.stringify({ ...snapshot, bots: [snapshot.bots[0], snapshot.bots[0]] }));
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    writeFileSync(f.path, JSON.stringify({
      ...snapshot,
      bots: [{ ...snapshot.bots[0]!, botId: "not-a-uuid" }],
    }));
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.stopping();
  });

  test("a deployment-level failure is never one Bot's problem", () => {
    const f = fleet();
    f.bot.starting();
    f.projection.failed("bridge_startup_failed");
    const snapshot = read(f.path);
    expect(snapshot.problem?.code).toBe("bridge_startup_failed");
    expect(snapshot.controlAvailable).toBe(false);
    expect(snapshot.bots[0]!.problem).toBeUndefined();
  });

  test("stopping clears every Bot's activity in one write", () => {
    const f = fleet();
    f.projection.accountChanged({
      status: "signedIn",
      account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
    });
    f.bot.eventStreamReady();
    f.bot.runtimeStateChanged({ activeTurn: true, organizingContext: true, queueDepth: 3, contextOrganizationAvailable: false });
    f.projection.stopping();
    const snapshot = read(f.path);
    expect(snapshot.controlAvailable).toBe(false);
    expect(snapshot.bots[0]).toMatchObject({
      lifecycle: "stopping", eventStreamReady: false, activeTurn: false,
      organizingContext: false, queueDepth: 0, contextOrganizationAvailable: false,
    });
  });
});

describe("account change readiness and per-connection login", () => {
  const MODEL_API: RuntimeAccountSnapshot = {
    status: "signedIn",
    account: { provider: "mochi-byok", authType: "api_key", subscription: false, label: "API", model: "mochi-byok/gpt-test" },
    connections: [{ provider: "mochi-byok", authType: "api_key", subscription: false, label: "API", model: "mochi-byok/gpt-test" }],
  };

  test("publishes the Bridge's own readiness: control available and every Bot idle", () => {
    const f = fleet([
      { id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true },
      { id: SECOND_BOT_ID, label: "工作", characterId: "mochi", enabled: true },
    ]);
    f.projection.accountChanged(MODEL_API);
    expect(read(f.path).accountChangeReady).toBe(false);
    f.projection.controlReady();
    expect(read(f.path).accountChangeReady).toBe(true);
    // Admission, not the displayed activity, decides readiness.
    f.bot.runtimeStateChanged({ activeTurn: true, organizingContext: false, queueDepth: 0, contextOrganizationAvailable: false });
    expect(read(f.path).accountChangeReady).toBe(true);
    f.projection.bot(SECOND_BOT_ID).idleChanged(false);
    expect(read(f.path).accountChangeReady).toBe(false);
    f.projection.bot(SECOND_BOT_ID).idleChanged(true);
    expect(read(f.path).accountChangeReady).toBe(true);
    writeFileSync(f.path, JSON.stringify({ ...f.projection.snapshot(), controlAvailable: false }));
    expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    f.projection.stopping();
    expect(read(f.path).accountChangeReady).toBe(false);
  });

  test("a pending ChatGPT login keeps Bots on another connection listening", () => {
    const f = fleet([
      { id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true },
      { id: SECOND_BOT_ID, label: "工作", characterId: "mochi", enabled: true },
    ]);
    f.projection.controlReady();
    f.projection.accountChanged(MODEL_API);
    f.bot.eventStreamReady();
    const waiting = f.projection.bot(SECOND_BOT_ID);
    waiting.blocked("model_policy_unavailable");
    f.projection.accountChanged({ ...MODEL_API, pendingLogin: "openai-codex" });
    expect(f.bot.snapshot()).toMatchObject({ lifecycle: "listening", eventStreamReady: true });
    waiting.awaitingLogin();
    expect(read(f.path).runtimeAccount).toEqual({ ...MODEL_API, pendingLogin: "openai-codex" });
    // Once the login settles, waiting for it is no longer a coherent state.
    f.projection.accountChanged({ ...MODEL_API, connections: [...MODEL_API.connections, { provider: "openai-codex", authType: "oauth", subscription: true }] });
    expect(waiting.snapshot().lifecycle).toBe("starting");
    expect(f.bot.snapshot().lifecycle).toBe("listening");
    for (const runtimeAccount of [
      { ...MODEL_API, pendingLogin: "mochi-byok" },
      { ...MODEL_API, connections: [...MODEL_API.connections, { provider: "openai-codex", authType: "oauth", subscription: true }], pendingLogin: "openai-codex" },
    ]) {
      writeFileSync(f.path, JSON.stringify({ ...f.projection.snapshot(), runtimeAccount }));
      expect(readFleetStatusSnapshot(f.path, process.pid).kind).toBe("invalid");
    }
    f.projection.stopping();
  });

  test("a projection that gave up authorship never writes again", () => {
    const f = fleet();
    f.projection.controlReady();
    const before = read(f.path);
    f.projection.close();
    f.bot.starting();
    f.projection.failed("bridge_startup_failed");
    f.projection.stopping();
    expect(read(f.path).updatedAt).toBe(before.updatedAt);
    expect(read(f.path).bots[0]!.lifecycle).toBe(before.bots[0]!.lifecycle);
  });
});

/** Applies one Bot-level change to a snapshot, for malformed-input cases. */
function withBot(snapshot: FleetStatusSnapshot, changes: Record<string, unknown>): FleetStatusSnapshot {
  return { ...snapshot, bots: [{ ...snapshot.bots[0]!, ...changes }] } as FleetStatusSnapshot;
}
