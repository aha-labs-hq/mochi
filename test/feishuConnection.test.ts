import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuConnection } from "../src/lark/connection.ts";
import { proveFeishuConnection, type FeishuConnectionProof } from "../src/lark/connectionProof.ts";
import { FeishuConnectionError, isFeishuConnectionSnapshot } from "../src/lark/connectionState.ts";
import { FeishuConnectionStore, parseFeishuConnectionRecord } from "../src/lark/connectionStore.ts";
import { REQUIRED_LARK_TENANT_SCOPES, LARK_APPLICATION_PROOF_SCOPES } from "../src/lark/permissions.ts";
import { FeishuRegistrationError, type registerFeishuApp } from "../src/lark/registration.ts";

const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
const verificationUrl = "https://open.feishu.cn/page/cli?user_code=ABCD-1234&lpv=1.0.93&ocv=1.0.93&from=cli";
const proof: FeishuConnectionProof = { brand: "feishu", appId: "cli_customer", botOpenId: "ou_customer", bot: { name: "客户的飞书 Bot", avatarUrl: null }, problem: null, missingScopes: [], grantedScopes: [...REQUIRED_LARK_TENANT_SCOPES, LARK_APPLICATION_PROOF_SCOPES[0]] };

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-feishu-connection-")));
  const store = new FeishuConnectionStore(join(directory, "connection"));
  disposals.push(() => rmSync(directory, { recursive: true }));
  let inspection = structuredClone(proof);
  let inspectionFailure: FeishuConnectionError | undefined;
  let registrations = 0;
  const completed = Promise.withResolvers<void>();
  const register: typeof registerFeishuApp = async ({ signal, onVerificationUrl }) => {
    registrations++;
    onVerificationUrl(verificationUrl);
    await Promise.race([completed.promise, new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new FeishuRegistrationError("registration_cancelled")), { once: true });
    })]);
    return { appId: inspection.appId, brand: inspection.brand, profile: "mochi" };
  };
  const connection = new FeishuConnection("/native/lark-cli", store, async () => {
    if (inspectionFailure) throw inspectionFailure;
    return structuredClone(inspection);
  }, register);
  disposals.push(() => connection.close());
  return { connection, store, directory, completed, registrations: () => registrations,
    inspect: (next: FeishuConnectionProof) => { inspection = next; },
    failInspection: (error: FeishuConnectionError | undefined) => { inspectionFailure = error; },
  };
}

async function ready(f: ReturnType<typeof fixture>) {
  const signal = Promise.withResolvers<void>();
  const unsubscribe = f.connection.subscribe((s) => { if (s.candidate?.state === "ready") signal.resolve(); });
  f.completed.resolve();
  await signal.promise;
  await Promise.resolve();
  // Registration owns its completion until the terminal promise settles.
  await f.connection.cancelRegistration();
  unsubscribe();
}

test("empty product boots without pre-enrolled customer credentials", async () => {
  const f = fixture();
  await f.connection.refresh();
  expect(f.connection.snapshot()).toEqual({ active: null, candidate: null });
  expect(f.connection.runtimeBinding()).toBeUndefined();
  expect(f.registrations()).toBe(0);
});

test("official discovery can connect Lark, retaining its platform through activation and restart", async () => {
  const f = fixture();
  const international = { ...proof, brand: "lark" as const };
  f.inspect(international);
  await f.connection.startRegistration();
  expect(f.connection.snapshot().candidate?.brand).toBeNull();
  await ready(f);
  expect(f.connection.snapshot().candidate?.brand).toBe("lark");
  expect(f.connection.settingsUrl()).toBe("https://open.larksuite.com/app/cli_customer");
  await f.connection.activateCandidate();
  expect(f.connection.runtimeBinding()?.brand).toBe("lark");
  await f.connection.close();
  const resumed = new FeishuConnection("/native/lark-cli", f.store, async (_context, expected) => {
    expect(expected?.brand).toBe("lark");
    return international;
  });
  disposals.push(() => resumed.close());
  await resumed.refresh();
  expect(resumed.snapshot().active?.brand).toBe("lark");
  expect(resumed.runtimeBinding()?.configDirectory).toBe(f.store.resolveDirectory(f.store.read().active!.directoryId));
});

test("legacy Feishu metadata migrates without changing the credential directory or identity", () => {
  const active = { directoryId: crypto.randomUUID(), appId: proof.appId, botOpenId: proof.botOpenId };
  const migrated = parseFeishuConnectionRecord({ version: 1, active, candidate: null });
  expect(migrated).toEqual({ version: 2, active: { ...active, brand: "feishu" }, candidate: null });
  expect(() => parseFeishuConnectionRecord({ ...migrated, active: { ...migrated.active, brand: "unknown" } })).toThrow();
});

test("platform proof accepts Lark and rejects an identity that changes platform", async () => {
  const values = responses(); values[0]!.brand = "lark";
  expect(await proveFeishuConnection(context, { ...proof, brand: "lark" }, async () => values.shift())).toMatchObject({ brand: "lark", problem: null });
  const changed = responses(); changed[0]!.brand = "lark";
  await expect(proveFeishuConnection(context, proof, async () => changed.shift())).rejects.toThrow("identity_changed");
});

test("QR creation is single-use and never installs an unconfirmed Bot", async () => {
  const f = fixture();
  expect(await f.connection.startRegistration()).toBe(verificationUrl);
  expect(await f.connection.startRegistration()).toBe(verificationUrl);
  expect(f.registrations()).toBe(1);
  expect(f.connection.runtimeBinding()).toBeUndefined();
  expect(JSON.stringify(f.connection.snapshot())).not.toContain("user_code");
  await ready(f);
  expect(f.connection.snapshot().candidate).toMatchObject({ state: "ready", brand: "feishu", bot: proof.bot });
  expect(f.connection.runtimeBinding()).toBeUndefined();
  await f.connection.activateCandidate();
  expect(f.connection.runtimeBinding()).toMatchObject({ targetAppId: "cli_customer", botOpenId: "ou_customer", profile: "mochi" });
  expect(f.connection.activeConnectionId()).toBe("feishu:cli_customer");
  expect(f.connection.connectorBinding()).toMatchObject({
    status: "ready",
    problem: null,
    targetAppId: "cli_customer",
  });
  expect(f.connection.snapshot().candidate).toBeNull();
  expect(f.registrations()).toBe(1);
});

test("cancel and process restart retain one candidate without recreating an external app", async () => {
  const f = fixture();
  await f.connection.startRegistration();
  await f.connection.cancelRegistration();
  expect(f.connection.snapshot().candidate?.problem).toBe("registration_cancelled");
  const oldRecord = f.store.read();
  await f.connection.close();
  const resumed = new FeishuConnection("/native/lark-cli", f.store, async () => proof);
  disposals.push(() => resumed.close());
  await expect(resumed.startRegistration()).rejects.toThrow("candidate_unverified");
  await resumed.refresh();
  expect(f.store.read().candidate?.directoryId).toBe(oldRecord.candidate?.directoryId);
  expect(resumed.snapshot().candidate?.state).toBe("ready");
  expect(f.registrations()).toBe(1);
});

test("missing permissions retain verified identity for recovery, but cannot become active", async () => {
  const f = fixture();
  f.inspect({ ...proof, problem: "permissions_required", missingScopes: ["im:chat:read"] });
  await f.connection.startRegistration();
  await f.connection.cancelRegistration();
  await f.connection.refresh();
  expect(f.connection.snapshot().candidate).toEqual({ state: "needsAction", brand: "feishu", bot: proof.bot, problem: "permissions_required" });
  expect(f.connection.settingsUrl()).toBe("https://open.feishu.cn/page/scope-apply?clientID=cli_customer&scopes=im%3Achat%3Aread");
  await expect(f.connection.activateCandidate()).rejects.toThrow("candidate_unverified");
  expect(f.store.read().active).toBeNull();
});

test("a replacement cannot retarget a captured context; cancel preserves the current Bot", async () => {
  const f = fixture();
  await f.connection.startRegistration();
  await ready(f);
  await f.connection.activateCandidate();
  const captured = f.connection.runtimeBinding()!;
  const before = f.store.read().active;
  await f.connection.startRegistration();
  await f.connection.cancelRegistration();
  await f.connection.discardCandidate();
  expect(f.store.read().active).toEqual(before);
  expect(f.connection.runtimeBinding()).toEqual(captured);
  expect(Object.isFrozen(captured)).toBe(true);
  await f.connection.disconnect();
  expect(f.connection.runtimeBinding()).toBeUndefined();
  expect(captured.targetAppId).toBe("cli_customer");
});

test("replacement steps publish without changing the active connector binding", async () => {
  // BotApp invalidates connector proofs only when this binding changes, because
  // nothing re-proves the mail grant or fixed documents after these steps.
  const f = fixture();
  await f.connection.startRegistration();
  await ready(f);
  await f.connection.activateCandidate();
  const active = f.connection.connectorBinding();
  let published = 0;
  const unsubscribe = f.connection.subscribe(() => {
    published++;
    expect(f.connection.connectorBinding()).toEqual(active);
  });
  await f.connection.startRegistration();
  await f.connection.cancelRegistration();
  await f.connection.refreshCandidate();
  await f.connection.discardCandidate();
  unsubscribe();
  expect(published).toBeGreaterThan(0);
  expect(f.connection.connectorBinding()).toEqual(active);
});

test("a transient refresh keeps the last confirmed identity for display but not runtime access", async () => {
  const f = fixture();
  await f.connection.startRegistration();
  await ready(f);
  await f.connection.activateCandidate();
  f.failInspection(new FeishuConnectionError("provider_unavailable"));
  await f.connection.refresh();

  expect(f.connection.runtimeBinding()).toBeUndefined();
  expect(f.connection.connectorBinding()).toMatchObject({
    status: "unavailable",
    problem: "provider_unavailable",
    displayName: proof.bot.name,
    grantedScopes: proof.grantedScopes,
    targetAppId: proof.appId,
  });
});

test("a recheck reports only a different, definitive answer and never disturbs the working Bot", async () => {
  const f = fixture();
  await f.connection.startRegistration();
  await ready(f);
  await f.connection.activateCandidate();
  let published = 0;
  f.connection.subscribe(() => { published++; });

  expect(await f.connection.recheck()).toBe(false);
  // Feishu not answering is no answer: the working Bot keeps its proof.
  f.failInspection(new FeishuConnectionError("provider_unavailable"));
  expect(await f.connection.recheck()).toBe(false);
  f.failInspection(new FeishuConnectionError("provider_response_invalid"));
  expect(await f.connection.recheck()).toBe(false);
  // A definitive failure or a new grant is a change; applying it is the caller's.
  f.failInspection(new FeishuConnectionError("identity_changed"));
  expect(await f.connection.recheck()).toBe(true);
  f.failInspection(undefined);
  f.inspect({ ...proof, grantedScopes: [...proof.grantedScopes, "docx:document:readonly"] });
  expect(await f.connection.recheck()).toBe(true);

  expect(published).toBe(0);
  expect(f.connection.snapshot().active).toEqual({ state: "ready", brand: "feishu", bot: proof.bot });
  expect(f.connection.runtimeBinding()).toMatchObject({ targetAppId: proof.appId, grantedScopes: proof.grantedScopes });
});

test("a connection that failed to prove itself is rechecked into service once Feishu answers", async () => {
  const f = fixture();
  await f.connection.startRegistration();
  await ready(f);
  await f.connection.activateCandidate();
  f.failInspection(new FeishuConnectionError("provider_unavailable"));
  await f.connection.refresh();
  expect(f.connection.runtimeBinding()).toBeUndefined();

  expect(await f.connection.recheck()).toBe(false);
  f.failInspection(undefined);
  expect(await f.connection.recheck()).toBe(true);
  await f.connection.refresh();
  expect(f.connection.runtimeBinding()).toMatchObject({ targetAppId: proof.appId });

  // A known permission problem is not replaced by Feishu briefly not answering.
  f.inspect({ ...proof, problem: "permissions_required", missingScopes: ["im:message"] });
  await f.connection.refresh();
  f.failInspection(new FeishuConnectionError("provider_unavailable"));
  expect(await f.connection.recheck()).toBe(false);
  f.failInspection(undefined);
  expect(await f.connection.recheck()).toBe(false);
  f.inspect(proof);
  expect(await f.connection.recheck()).toBe(true);
});

test("an active refresh preserves actionable provider failures for connector recovery", async () => {
  const f = fixture();
  await f.connection.startRegistration();
  await ready(f);
  await f.connection.activateCandidate();
  f.failInspection(new FeishuConnectionError("identity_changed"));

  await f.connection.refresh();

  expect(f.connection.runtimeBinding()).toBeUndefined();
  expect(f.connection.connectorBinding()).toMatchObject({
    status: "unavailable",
    problem: "identity_changed",
    displayName: proof.bot.name,
    grantedScopes: proof.grantedScopes,
  });
});

test("private metadata has no tokens and rejects extra fields, path injection and unsafe custody", async () => {
  const f = fixture();
  await f.connection.startRegistration();
  const path = join(f.store.directory, "connection.json");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(f.store.directory).mode & 0o777).toBe(0o700);
  const text = readFileSync(path, "utf8");
  expect(text).not.toMatch(/secret|token|user_code|authorizationUrl/);
  const record = f.store.read();
  expect(() => parseFeishuConnectionRecord({ ...record, token: "forbidden" })).toThrow();
  expect(() => parseFeishuConnectionRecord({ ...record, candidate: { directoryId: "../escape", appId: null } })).toThrow();
  chmodSync(path, 0o644);
  expect(() => f.store.read()).toThrow("connection_storage_unavailable");
  chmodSync(path, 0o600);
  const link = join(f.directory, "alias");
  symlinkSync(f.store.directory, link);
  expect(() => new FeishuConnectionStore(link).read()).toThrow("connection_storage_unavailable");
});

const context = { cliPath: "/native/lark-cli", profile: "mochi", configDirectory: "/private/profile" };
function responses() {
  return [
    { verified: true, brand: "feishu", appId: "cli_customer", identities: { bot: { status: "ready", available: true, verified: true, openId: "ou_customer", appName: "客户的飞书 Bot" } } },
    { ok: true, identity: "bot", data: { scopes: [...REQUIRED_LARK_TENANT_SCOPES, "application:application:self_manage"].map((scope_name) => ({ scope_name, scope_type: "tenant", grant_status: 1 })) } },
    { ok: true, identity: "bot", data: { app: { app_id: "cli_customer", status: 1, online_version_id: "oav_published", app_name: "客户的飞书 Bot", avatar_url: "https://s1-imfile.feishucdn.com/avatar" } } },
  ];
}

test("provider proof checks real identity, complete scopes, published version and native avatar", async () => {
  const results = responses();
  const calls: unknown[] = [];
  const result = await proveFeishuConnection(context, proof, async (...args) => { calls.push(args); return results.shift(); });
  expect(result).toEqual({ ...proof, bot: { name: proof.bot.name, avatarUrl: "https://s1-imfile.feishucdn.com/avatar" } });
  expect(calls).toHaveLength(3);
  expect(calls.every((args) => (args as unknown[])[0] === context)).toBe(true);
});

test("no user credential, wrong identity, missing permission, unpublished app or empty generic bot result passes", async () => {
  for (const [index, replacement, expected] of [
    [0, { ...responses()[0], verified: false }, "credential_unavailable"],
    [0, { ...responses()[0], appId: "cli_other" }, "identity_changed"],
    [1, { ...responses()[1], identity: "user" }, "provider_response_invalid"],
    [2, { ok: true, identity: "bot", data: {} }, "provider_response_invalid"],
    [2, { ok: true, identity: "bot", data: { app: { ...responses()[2]!.data!.app, app_id: "cli_other" } } }, "identity_changed"],
  ] as const) {
    const results: unknown[] = responses();
    results[index] = replacement;
    await expect(proveFeishuConnection(context, proof, async () => results.shift())).rejects.toThrow(expected);
  }
  const missing: unknown[] = responses();
  missing[1] = { ok: true, identity: "bot", data: { scopes: [] } };
  expect(await proveFeishuConnection(context, proof, async () => missing.shift())).toMatchObject({ appId: proof.appId, problem: "group_messages_required" });
  const unpublished = responses();
  unpublished[2]!.data!.app!.online_version_id = "";
  expect(await proveFeishuConnection(context, proof, async () => unpublished.shift())).toMatchObject({ problem: "publication_required" });
  await expect(proveFeishuConnection(context, proof, async () => { throw new Error("secret URL"); })).rejects.toEqual(new FeishuConnectionError("provider_unavailable"));
});

test("public snapshots reject credentials and arbitrary avatar origins", () => {
  const snapshot = { active: { state: "ready", brand: "feishu", bot: proof.bot }, candidate: null };
  expect(isFeishuConnectionSnapshot(snapshot)).toBe(true);
  expect(isFeishuConnectionSnapshot({ ...snapshot, token: "forbidden" })).toBe(false);
  expect(isFeishuConnectionSnapshot({ ...snapshot, active: { state: "ready", bot: null } })).toBe(false);
  expect(isFeishuConnectionSnapshot({ ...snapshot, active: { state: "ready", bot: { name: "Bot", avatarUrl: "https://tracking.example/avatar" } } })).toBe(false);
});

test("unrequested group messages and ungranted tenant permission have distinct recovery without passing either", async () => {
  for (const requested of [false, true]) {
    const result = responses();
    const entries = result[1]!.data!.scopes!;
    if (requested) entries.find((entry) => entry.scope_name === "im:message.group_msg")!.grant_status = 2;
    else result[1]!.data!.scopes = entries.filter((entry) => entry.scope_name !== "im:message.group_msg");
    const inspected = await proveFeishuConnection(context, proof, async () => result.shift());
    expect(inspected.missingScopes).toEqual(["im:message.group_msg"]);
    expect(inspected.problem).toBe(requested ? "permissions_approval_required" : "group_messages_required");
  }
});

test("an unknown replacement never opens the active Bot's settings", async () => {
  const f = fixture();
  await f.connection.startRegistration();
  await ready(f);
  await f.connection.activateCandidate();
  await f.connection.close();
  f.store.write({ ...f.store.read(), candidate: { directoryId: f.store.createDirectory(), appId: null, brand: null } });
  const resumed = new FeishuConnection("/native/lark-cli", f.store);
  disposals.push(() => resumed.close());
  expect(() => resumed.settingsUrl()).toThrow("candidate_required");
});
