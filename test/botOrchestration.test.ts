import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_TOOL_CAPABILITY_ABI } from "../src/agent/tools.ts";
import { BotApp } from "../src/app.ts";
import { loadBotContext } from "../src/config.ts";
import { FleetStatusProjection, readFleetStatusSnapshot, type BotStatus } from "../src/control/statusSnapshot.ts";
import { GitHubConnection } from "../src/github/connection.ts";
import { GitHubFileCredentialStore } from "../src/github/credentials.ts";
import { GitHubOAuth } from "../src/github/oauth.ts";
import { FeishuConnection } from "../src/lark/connection.ts";
import { FeishuConnectionStore } from "../src/lark/connectionStore.ts";
import { LarkEventConsumer, type LarkEventStreamObserver } from "../src/lark/eventConsumer.ts";
import { REQUIRED_LARK_TENANT_SCOPES } from "../src/lark/permissions.ts";
import { memoryLogSink, setLogSink } from "../src/log.ts";
import { ProcessLock } from "../src/processLock.ts";
import * as layouts from "../src/product/layout.ts";
import { RuntimeAccountClient } from "../src/runtime/accountClient.ts";
import { SharedRuntimeAccount } from "../src/runtime/sharedAccount.ts";
import { StateStore } from "../src/state.ts";
import { UpdateLifecycle } from "../src/control/updateLifecycle.ts";

// Real BotApps, SQLite, admission, Session agent, runtime client and transport,
// Feishu event consumer, messenger and reactions. Only the two process
// boundaries are scripted: the Pi worker and the official lark-cli.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const APP = { [A]: "cli_alpha", [B]: "cli_beta" } as const;
const FAILURE_REPLY = "这次没有处理完成。你可以在本话题再说一次。";
const INTERRUPTED_REPLY = "处理这条消息时服务重启了，本次没有完成，也不会自动重试。你可以在本话题再说一次。";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function until(predicate: () => boolean, label: string, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Did not converge: ${label}`);
    await Bun.sleep(10);
  }
}

interface BotOptions {
  model?: string;
  /** Messages a previous run claimed and never settled, as a crash leaves them. */
  interrupted?: string[];
}

async function deployment(connections: string, bots: Record<string, BotOptions>, acceptingWork?: () => boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mochi-orchestration-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const layout = layouts.resolveProductLayout({ environment: {}, homeDirectory: root });
  const productLayout = spyOn(layouts, "productLayout").mockReturnValue({
    ...layout, protocolDirectory: resolve(import.meta.dir, "../config/protocol"),
  });
  cleanup.push(() => productLayout.mockRestore());
  const prefix = `#!${process.execPath}\nconst root = ${JSON.stringify(root)};\n`;
  const workerPath = join(root, "worker.ts");
  const cliPath = join(root, "lark.ts");
  writeFileSync(workerPath, prefix + WORKER, { mode: 0o700 });
  writeFileSync(cliPath, prefix + CLI, { mode: 0o700 });
  writeFileSync(join(root, "shared.auth"), connections);
  const status = new FleetStatusProjection(join(root, "status.json"));
  cleanup.push(() => status.stopping());
  const ids = Object.keys(bots);
  status.roster(ids.map((id) => ({ id, label: id === A ? "麻薯" : "伙伴", characterId: "mochi", enabled: true })));
  status.controlReady();
  const apps = new Map<string, BotApp>();
  let queue = Promise.resolve();
  const account = new SharedRuntimeAccount({
    serialize: <T>(operation: () => Promise<T>) => {
      const result = queue.then(operation);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    participants: () => [...apps.values()],
    publish: (snapshot) => status.accountChanged(snapshot),
  }, (observer) => new RuntimeAccountClient(observer, [process.execPath, workerPath, root]));
  cleanup.push(() => account.close());
  await account.start();
  const homes: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  for (const id of ids) {
    const bot = layout.bot(id);
    mkdirSync(bot.configurationDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(bot.stateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(bot.botConfigPath, `[agent]\ninstructions_file = "AGENTS.md"\n[runtime]\nmodel = "${bots[id]!.model ?? "gpt-test"}"\nreasoning_effort = "high"\nturn_timeout_seconds = 1800\n`, { mode: 0o600 });
    writeFileSync(join(bot.configurationDirectory, "AGENTS.md"), `Bot ${id}`, { mode: 0o600 });
    const sessionId = crypto.randomUUID();
    sessions[id] = sessionId;
    const state = new StateStore(bot.stateDatabasePath);
    state.initializeRuntimeSession(sessionId, AGENT_TOOL_CAPABILITY_ABI);
    for (const messageId of bots[id]!.interrupted ?? []) {
      state.claimEvent(messageId, { chatId: "oc_group", threadKey: messageId, requesterId: "ou_person", sourceMessageId: messageId }, true);
    }
    state.close();
    const store = new FeishuConnectionStore(bot.feishuConnectionDirectory);
    const directoryId = store.createDirectory();
    const appId = APP[id as keyof typeof APP];
    store.write({ version: 2, active: { brand: "feishu", directoryId, appId, botOpenId: `ou_${appId}` }, candidate: null });
    homes[store.resolveDirectory(directoryId)] = appId;
    writeFileSync(join(root, "apps.json"), JSON.stringify(homes));
    const context = loadBotContext(bot, sessionId);
    context.runtime.sudoPath = workerPath;
    context.runtime.workerPath = root;
    const app = new BotApp({
      bot: context,
      status: status.bot(id),
      enabled: true,
      ...(acceptingWork ? { acceptingWork } : {}),
      account,
      lock: await ProcessLock.acquire(bot.stateLockPath),
      github: new GitHubConnection({
        store: new GitHubFileCredentialStore(bot.githubCredentialPath),
        oauth: new GitHubOAuth("fixture", (async () => { throw new Error("Unexpected network"); }) as unknown as typeof fetch),
      }),
      feishu: new FeishuConnection(cliPath, store, async () => ({
        appId, brand: "feishu", botOpenId: `ou_${appId}`, bot: { name: "Bot", avatarUrl: null }, problem: null,
        missingScopes: [], grantedScopes: [...REQUIRED_LARK_TENANT_SCOPES],
      })),
      recovery: { delaysMilliseconds: [40, 40, 40], stableMilliseconds: 400 },
    });
    apps.set(id, app);
    cleanup.push(() => app.stop());
    void app.start().catch(() => app.fail());
  }
  const bot = (id: string): BotStatus => {
    expect(readFleetStatusSnapshot(join(root, "status.json")).kind).toBe("current");
    return status.snapshot().bots.find((entry) => entry.botId === id)!;
  };
  let sequence = 0;
  const lines = (name: string) => existsSync(join(root, name))
    ? readFileSync(join(root, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return {
    root, layout, status, account, sessions,
    app: (id: string) => apps.get(id)!,
    bot,
    /** Delivers one group message through the Bot's own event stream. */
    send(id: string, messageId: string, options: { topic?: string; mention?: boolean; text?: string } = {}) {
      const appId = APP[id as keyof typeof APP];
      const directory = join(root, "events", appId);
      mkdirSync(directory, { recursive: true });
      const mention = options.mention ?? options.topic === undefined;
      const event = {
        type: "im.message.receive_v1", message_id: messageId, message_type: "text",
        chat_id: "oc_group", chat_type: "group", sender_id: "ou_person", sender_type: "user",
        content: `${mention ? "@_user_1 " : ""}${options.text ?? "看一下发布阻塞"}`,
        mentions: mention ? [{ id: `ou_${appId}`, key: "@_user_1", name: "Bot" }] : [],
        ...(options.topic ? { root_id: options.topic } : {}),
      };
      const file = join(directory, `${String(++sequence).padStart(6, "0")}.json`);
      // The stream only reads complete files.
      writeFileSync(`${file}.partial`, JSON.stringify(event));
      renameSync(`${file}.partial`, file);
    },
    flag(name: string, on = true) {
      if (on) writeFileSync(join(root, name), "on");
      else rmSync(join(root, name), { force: true });
    },
    replies: (): { app: string; messageId: string; markdown: string }[] => lines("replies.jsonl"),
    reactions: (): { app: string; messageId: string; emoji: string }[] => lines("reactions.jsonl"),
    turns: (id: string): { sessionId: string; sourceMessageId: string }[] => lines(`${id}.turns.jsonl`),
    trace: (id: string) => existsSync(join(root, `${id}.trace`)) ? readFileSync(join(root, `${id}.trace`), "utf8") : "",
    consumes: (id: string) => lines("cli.jsonl").filter((call) => call.app === APP[id as keyof typeof APP] && call.args.includes("consume")).length,
    pid: (name: string) => Number(readFileSync(join(root, `${name}.pid`), "utf8")),
    eventStatus(id: string, messageId: string): string | undefined {
      const database = new Database(layout.bot(id).stateDatabasePath, { readonly: true });
      try {
        return database.query<{ status: string }, [string]>("SELECT status FROM processed_events WHERE message_id = ?").get(messageId)?.status;
      } finally { database.close(); }
    },
  };
}

type Deployment = Awaited<ReturnType<typeof deployment>>;

test("update waits for the final reply delivery, gates all Bots, and never changes their permanent identities", async () => {
  let f: Deployment;
  const gate = new UpdateLifecycle("0.2.0", () => f.app(A).readyForUpdate() && f.app(B).readyForUpdate());
  f = await deployment("codex", { [A]: {}, [B]: {} }, () => gate.acceptingWork);
  await listening(f, A, B);
  const acquire = { lifecycle: "update", version: 1, command: "acquire", targetVersion: "0.3.0", sha256: "c".repeat(64) } as const;
  f.flag("hold-reply");
  f.send(A, "om_updateDelivery");
  await until(() => f.trace(A).includes("turn.start") && !f.bot(A).activeTurn
    && f.eventStatus(A, "om_updateDelivery") === "processing", "model finished while delivery is pending");
  expect(gate.handle(acquire)).toMatchObject({ ok: false, reason: "busy" });
  expect(gate.acceptingWork).toBe(true);
  f.flag("hold-reply", false);
  await until(() => f.app(A).readyForUpdate() && f.app(B).readyForUpdate(), "all delivery settled");
  expect(f.eventStatus(A, "om_updateDelivery")).toBe("completed");
  const lease = gate.handle(acquire);
  expect(lease.ok).toBe(true);
  if (!lease.ok) throw Error("lease was not granted");
  expect(f.bot(A).enabled).toBe(true);
  expect(f.bot(B).enabled).toBe(true);
  expect(gate.handle({ lifecycle: "update", version: 1, command: "release", lease: lease.lease! }).ok).toBe(true);
  f.send(B, "om_afterCancel");
  await until(() => f.eventStatus(B, "om_afterCancel") === "completed", "cancellation resumes normal work");
  expect(f.turns(A).every(t => t.sessionId === f.sessions[A])).toBe(true);
  expect(f.turns(B).every(t => t.sessionId === f.sessions[B])).toBe(true);
});

async function listening(f: Deployment, ...ids: string[]) {
  await until(() => ids.every((id) => f.bot(id).lifecycle === "listening" && f.bot(id).eventStreamReady), `listening ${ids.join(",")}`);
}

test("an old stream cannot revive a paused Bot or change its replacement stream's readiness", async () => {
  const observers: LarkEventStreamObserver[] = [];
  const original = LarkEventConsumer.prototype.consume;
  const consume = spyOn(LarkEventConsumer.prototype, "consume").mockImplementation(function (this: LarkEventConsumer, onEvent, observer) {
    if (observer) observers.push(observer);
    return original.call(this, onEvent, observer);
  });
  cleanup.push(() => consume.mockRestore());
  const f = await deployment("codex", { [A]: {} });
  await listening(f, A);
  const old = observers[0]!;
  await f.app(A).setEnabled(false, () => {});
  const paused = f.bot(A).lifecycle;
  old.ready(); old.unavailable();
  expect(f.bot(A).lifecycle).toBe(paused);
  expect(f.bot(A).eventStreamReady).toBe(false);
  await f.app(A).setEnabled(true, () => {});
  await listening(f, A);
  expect(observers).toHaveLength(2);
  old.unavailable();
  expect(f.bot(A).eventStreamReady).toBe(true);
  observers[1]!.unavailable();
  expect(f.bot(A).eventStreamReady).toBe(false);
  old.ready();
  expect(f.bot(A).eventStreamReady).toBe(false);
  observers[1]!.ready();
  await listening(f, A);
  await f.app(A).stop();
  old.ready(); observers[1]!.ready();
  expect(f.bot(A).eventStreamReady).toBe(false);
}, 30_000);

test("a message sent while context is being organized is claimed at once and answered after it", async () => {
  const f = await deployment("codex", { [A]: {} });
  await listening(f, A);
  f.flag(`${A}.full-context`);
  f.send(A, "om_first");
  await until(() => f.replies().some((reply) => reply.messageId === "om_first"), "first reply");
  await until(() => f.bot(A).contextOrganizationAvailable, "organization offered");
  await until(() => f.app(A).readyForUpdate(), "reply delivery settled before organizing");
  f.flag(`${A}.hold-compact`);
  const organizing = f.app(A).organizeContext();
  await until(() => f.trace(A).includes("session.compact"), "compaction started");
  f.send(A, "om_during");
  // Claimed and acknowledged while the change still holds admission.
  await until(() => f.reactions().some((reaction) => reaction.messageId === "om_during" && reaction.emoji === "OnIt"), "OnIt during change");
  expect(f.eventStatus(A, "om_during")).toBe("processing");
  expect(f.turns(A).map((turn) => turn.sourceMessageId)).toEqual(["om_first"]);
  f.flag(`${A}.hold-compact`, false);
  await organizing;
  // The CLI records the reply before its process exits; only the Bridge's
  // terminal event proves it has received and settled that delivery.
  await until(() => f.eventStatus(A, "om_during") === "completed", "answer settled after change");
  expect(f.replies().find((reply) => reply.messageId === "om_during")?.markdown).toBe("reply:om_during");
  expect(f.eventStatus(A, "om_during")).toBe("completed");
  expect(new Set(f.turns(A).map((turn) => turn.sessionId))).toEqual(new Set([f.sessions[A]!]));
}, 30_000);

test("a message accepted during a change is answered honestly when the Bot stops before running it", async () => {
  const f = await deployment("codex", { [A]: {} });
  await listening(f, A);
  f.flag(`${A}.full-context`);
  f.send(A, "om_first");
  await until(() => f.bot(A).contextOrganizationAvailable, "organization offered");
  await until(() => f.app(A).readyForUpdate(), "reply delivery settled before organizing");
  f.flag(`${A}.hold-compact`);
  const organizing = f.app(A).organizeContext().catch(() => undefined);
  await until(() => f.trace(A).includes("session.compact"), "compaction started");
  f.send(A, "om_late");
  await until(() => f.eventStatus(A, "om_late") === "processing", "claimed during change");
  const stopping = f.app(A).stop();
  f.flag(`${A}.hold-compact`, false);
  await organizing;
  await stopping;
  expect(f.replies().find((reply) => reply.messageId === "om_late")?.markdown).toBe(FAILURE_REPLY);
  expect(f.reactions().filter((reaction) => reaction.messageId === "om_late").map((reaction) => reaction.emoji)).toEqual(["OnIt", "ERROR"]);
  expect(f.eventStatus(A, "om_late")).toBe("failed");
  expect(f.turns(A).map((turn) => turn.sourceMessageId)).toEqual(["om_first"]);
}, 30_000);

test("same-topic messages steer one turn, other topics queue, and each answer goes to its latest message", async () => {
  const f = await deployment("codex", { [A]: {} });
  await listening(f, A);
  f.flag(`${A}.hold-turn`);
  f.send(A, "om_root");
  await until(() => f.turns(A).length === 1, "first turn");
  f.send(A, "om_followup", { topic: "om_root" });
  await until(() => f.trace(A).includes("turn.steer om_followup"), "steered");
  f.send(A, "om_other");
  await until(() => f.bot(A).queueDepth === 1, "other topic queued");
  await until(() => f.reactions().some((reaction) => reaction.messageId === "om_other"), "queued reaction published");
  expect(f.reactions().filter((reaction) => reaction.messageId === "om_other").map((reaction) => reaction.emoji)).toEqual(["OnIt"]);
  f.flag(`${A}.hold-turn`, false);
  await until(() => f.replies().length === 2, "both answers");
  expect(f.replies().map((reply) => [reply.messageId, reply.markdown])).toEqual([
    ["om_followup", "reply:om_root,om_followup"],
    ["om_other", "reply:om_other"],
  ]);
  for (const id of ["om_root", "om_followup", "om_other"]) {
    await until(() => f.eventStatus(A, id) === "completed", `delivery settled for ${id}`);
  }
}, 30_000);

test("a crashed worker reconnects only its own Bot, within a bounded and resettable budget", async () => {
  const f = await deployment("codex", { [A]: {}, [B]: {} });
  await listening(f, A, B);
  const otherWorker = f.pid(B);
  process.kill(f.pid(A), "SIGKILL");
  await until(() => f.bot(A).lifecycle === "blocked", "crash observed");
  await listening(f, A);
  expect(f.trace(A).match(/runtime\.initialize/g)).toHaveLength(2);
  expect(f.pid(B)).toBe(otherWorker);
  expect(f.bot(B).lifecycle).toBe("listening");
  f.send(A, "om_afterRecovery");
  await until(() => f.replies().some((reply) => reply.messageId === "om_afterRecovery"), "answers after recovery");

  // Attempts are forgiven only once the Bot has stayed healthy.
  await Bun.sleep(500);
  // A Session that cannot be resumed exhausts the automatic attempts and stays closed.
  f.flag(`${A}.fail-resume`);
  const resumes = () => f.trace(A).match(/session\.resume/g)?.length ?? 0;
  const before = resumes();
  process.kill(f.pid(A), "SIGKILL");
  await until(() => resumes() === before + 3, "three automatic attempts");
  await Bun.sleep(300);
  expect(resumes()).toBe(before + 3);
  expect(f.bot(A).lifecycle).toBe("blocked");
  expect(f.bot(A).problem).toMatchObject({ code: "runtime_session_unavailable", recoveryAction: "restartBot" });
  expect(f.bot(B).lifecycle).toBe("listening");
  // The customer's reconnect is this Bot's own action with a fresh budget.
  f.flag(`${A}.fail-resume`, false);
  await f.app(A).recover();
  await listening(f, A);
  expect(f.pid(B)).toBe(otherWorker);
}, 30_000);

test("an event stream that exits is reconnected without restarting the other Bot", async () => {
  const f = await deployment("codex", { [A]: {}, [B]: {} });
  await listening(f, A, B);
  const otherWorker = f.pid(B);
  mkdirSync(join(f.root, "events", APP[A]), { recursive: true });
  writeFileSync(join(f.root, "events", APP[A], "EXIT"), "exit");
  await until(() => f.consumes(A) === 2, "stream reconnected");
  await listening(f, A);
  expect(f.consumes(B)).toBe(1);
  expect(f.pid(B)).toBe(otherWorker);
  f.send(A, "om_afterStream");
  await until(() => f.replies().some((reply) => reply.messageId === "om_afterStream"), "answers on the new stream");
}, 30_000);

test("a ChatGPT login beside a model API pauses only the Bot waiting for ChatGPT", async () => {
  const f = await deployment("byok", { [A]: { model: "mochi-byok/gpt-test" }, [B]: {} });
  await listening(f, A);
  await until(() => f.bot(B).problem?.code === "model_policy_unavailable", "ChatGPT Bot waits for a model");
  const apiWorker = f.pid(A);
  f.flag("account.hold-login");
  await f.account.startChatGPTLogin();
  expect(f.status.snapshot().runtimeAccount).toMatchObject({ status: "signedIn", pendingLogin: "openai-codex" });
  await until(() => f.bot(B).lifecycle === "awaitingLogin", "ChatGPT Bot awaits login");
  expect(f.bot(A).lifecycle).toBe("listening");
  f.send(A, "om_duringLogin");
  await until(() => f.replies().some((reply) => reply.messageId === "om_duringLogin"), "model API Bot answers during login");
  f.flag("account.hold-login", false);
  await listening(f, A, B);
  expect(f.status.snapshot().runtimeAccount).not.toHaveProperty("pendingLogin");
  expect(f.pid(A)).toBe(apiWorker);
}, 30_000);

test("only a busy Bot on the changed connection holds an account change, and readiness says so", async () => {
  const f = await deployment("codex,byok", { [A]: { model: "mochi-byok/gpt-test" }, [B]: {} });
  await listening(f, A, B);
  expect(f.status.snapshot().accountChangeReady).toBe(true);
  f.flag(`${B}.hold-turn`);
  f.send(B, "om_chatgptWork");
  await until(() => f.bot(B).activeTurn, "ChatGPT Bot busy");
  expect(f.status.snapshot().accountChangeReady).toBe(false);
  await expect(f.account.logoutChatGPT()).rejects.toThrow("connection_change_busy");
  expect(readFileSync(join(f.root, "shared.auth"), "utf8")).toBe("codex,byok");
  f.flag(`${B}.hold-turn`, false);
  await until(() => f.replies().some((reply) => reply.messageId === "om_chatgptWork"), "ChatGPT work answered");
  await until(() => f.status.snapshot().accountChangeReady, "idle again");
  // A busy Bot on the model API does not hold a ChatGPT change.
  f.flag(`${A}.hold-turn`);
  f.send(A, "om_apiWork");
  await until(() => f.bot(A).activeTurn, "model API Bot busy");
  await f.account.logoutChatGPT();
  await until(() => f.bot(B).problem?.code === "model_policy_unavailable", "ChatGPT Bot signed out");
  expect(f.bot(A).activeTurn).toBe(true);
  f.flag(`${A}.hold-turn`, false);
  await until(() => f.replies().some((reply) => reply.messageId === "om_apiWork"), "model API work answered");
}, 30_000);

test("an account worker exit keeps accepted work and stops new admission", async () => {
  const f = await deployment("codex", { [A]: {} });
  await listening(f, A);
  f.flag(`${A}.hold-turn`);
  f.send(A, "om_accepted");
  await until(() => f.bot(A).activeTurn, "turn running");
  f.send(A, "om_queued");
  await until(() => f.bot(A).queueDepth === 1, "another topic queued");
  process.kill(f.pid("account"), "SIGTERM");
  await until(() => f.status.snapshot().runtimeAccount.status === "unknown", "account unknown");
  expect(f.bot(A)).toMatchObject({ lifecycle: "blocked", activeTurn: true });
  expect(f.bot(A).problem?.code).toBe("account_status_unavailable");
  await expect(f.account.logoutChatGPT()).rejects.toThrow("connection_change_busy");
  f.flag(`${A}.hold-turn`, false);
  await until(() => f.eventStatus(A, "om_accepted") === "completed", "accepted work answered");
  expect(f.replies().find((reply) => reply.messageId === "om_accepted")?.markdown).toBe("reply:om_accepted");
  // Queued work was accepted too, although its turn starts while the account is unknown.
  await until(() => f.eventStatus(A, "om_queued") !== "processing", "queued work settled");
  expect(f.eventStatus(A, "om_queued")).toBe("completed");
  expect(f.replies().find((reply) => reply.messageId === "om_queued")?.markdown).toBe("reply:om_queued");
}, 30_000);

test("a message interrupted by a restart is told so in its own topic and never replayed", async () => {
  const sink = memoryLogSink();
  const previous = setLogSink(sink);
  cleanup.push(() => setLogSink(previous));
  const f = await deployment("codex", { [A]: { interrupted: ["om_unreachable", "om_interrupted"] } });
  await listening(f, A);
  await until(() => f.replies().some((reply) => reply.messageId === "om_interrupted"), "interrupted notice");
  await until(() => f.app(A).readyForUpdate(), "notices settled");
  expect(f.replies()).toEqual([{ app: APP[A], messageId: "om_interrupted", markdown: INTERRUPTED_REPLY }]);
  // An undeliverable notice is logged and leaves the Bot and the other notice alone.
  expect(sink.records).toContainEqual(expect.objectContaining({
    event: "bot.events.interrupted_reply_failed", botId: A, messageId: "om_unreachable",
  }));
  for (const id of ["om_unreachable", "om_interrupted"]) expect(f.eventStatus(A, id)).toBe("failed");
  expect(f.turns(A)).toEqual([]);
  f.send(A, "om_after");
  await until(() => f.eventStatus(A, "om_after") === "completed", "new work answered");
  expect(f.turns(A).map((turn) => turn.sourceMessageId)).toEqual(["om_after"]);
}, 30_000);

const WORKER = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let init; let active; let login;
const CODEX = { provider: "openai-codex", authType: "oauth", subscription: true };
const BYOK = { provider: "mochi-byok", authType: "api_key", subscription: false, label: "Test", model: "mochi-byok/gpt-test" };
const name = () => init?.botId ?? "account";
const out = (message) => process.stdout.write(JSON.stringify({ version: 11, ...message }) + "\n");
const send = (request, result) => out({ type: "response", id: request.id, ok: true, result });
const reject = (request, code) => out({ type: "response", id: request.id, ok: false, error: { code, message: code } });
const event = (event, params) => out({ type: "event", event, params });
const trace = (line) => appendFileSync(join(root, name() + ".trace"), line + "\n");
const flag = (suffix) => existsSync(join(root, name() + "." + suffix));
async function hold(suffix) { const deadline = Date.now() + 20_000; while (flag(suffix)) { if (Date.now() > deadline) throw new Error(suffix + " timeout"); await Bun.sleep(10); } }
const auth = () => existsSync(join(root, "shared.auth")) ? readFileSync(join(root, "shared.auth"), "utf8").split(",").filter(Boolean) : [];
const setAuth = (kinds) => writeFileSync(join(root, "shared.auth"), kinds.join(","));
function account() {
  const connections = auth().map((kind) => kind === "byok" ? BYOK : CODEX);
  return connections.length ? { status: "signedIn", account: connections[0], connections } : { status: "signedOut" };
}
const provider = () => init.model.startsWith("mochi-byok/") ? "byok" : "codex";
async function finish(turn) {
  await hold("hold-turn");
  if (flag("full-context")) event("context.usage", { sessionId: init.sessionId, turnId: turn.turnId, usedTokens: 80000, modelContextWindow: 100000, fractionUsed: 0.8 });
  active = undefined;
  event("turn.completed", { turnId: turn.turnId, status: "completed", text: "reply:" + turn.sources.join(",") });
}
async function handle(request) {
  if (request.method === "runtime.initialize" || request.method === "account.initialize") {
    init = request.method === "account.initialize" ? undefined : request.params;
    writeFileSync(join(root, name() + ".pid"), String(process.pid));
    trace(request.method);
    return send(request, { protocolVersion: 11 });
  }
  trace(request.method + (request.params?.sourceMessageId ? " " + request.params.sourceMessageId : ""));
  switch (request.method) {
    case "account.read": return send(request, account());
    case "model.list": return send(request, auth().map((kind) => ({ id: kind === "byok" ? "mochi-byok/gpt-test" : "gpt-test", displayName: "Test", description: "Test", supportedEfforts: [{ id: "high", description: "High" }], defaultEffort: "high" })));
    case "policy.update": init.model = request.params.model; return send(request, {});
    case "session.resume":
      if (flag("fail-resume")) process.exit(1);
      if (!auth().includes(provider())) return reject(request, "model_policy_unavailable");
      return send(request, { sessionId: init.sessionId, capabilityAbi: init.capabilityAbi });
    case "session.compact":
      await hold("hold-compact");
      send(request, {});
      return event("context.compacted", { sessionId: init.sessionId });
    case "turn.start": {
      appendFileSync(join(root, init.botId + ".turns.jsonl"), JSON.stringify({ sessionId: init.sessionId, sourceMessageId: request.params.sourceMessageId }) + "\n");
      active = { turnId: crypto.randomUUID(), sources: [request.params.sourceMessageId] };
      send(request, { turnId: active.turnId });
      return void finish(active);
    }
    case "turn.steer":
      if (!active || active.turnId !== request.params.turnId) return reject(request, "turn_not_active");
      active.sources.push(request.params.sourceMessageId);
      return send(request, {});
    case "turn.abort":
      send(request, {});
      if (active) event("turn.completed", { turnId: active.turnId, status: "interrupted", error: "aborted" });
      active = undefined;
      return;
    case "account.login.start":
      login = crypto.randomUUID();
      send(request, { loginId: login, authorizationUrl: "https://auth.openai.com/fixture" });
      await hold("hold-login");
      setAuth([...auth(), "codex"]);
      event("account.login.completed", { loginId: login, success: true });
      return event("account.updated", { status: "signedIn" });
    case "account.login.cancel": return send(request, {});
    case "account.logout":
      setAuth(auth().filter((kind) => kind !== "codex"));
      send(request, {});
      return event("account.updated", { status: "signedOut" });
    case "runtime.shutdown": send(request, {}); return process.exit(0);
    default: return send(request, {});
  }
}
for await (const line of console) void handle(JSON.parse(line));
`;

const CLI = String.raw`
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(4);
const app = JSON.parse(readFileSync(join(root, "apps.json"), "utf8"))[process.env.HOME];
appendFileSync(join(root, "cli.jsonl"), JSON.stringify({ app, args }) + "\n");
const option = (name) => args[args.indexOf(name) + 1];
const ok = (data) => console.log(JSON.stringify({ ok: true, identity: "bot", data }));
if (args[0] === "event" && args[1] === "consume") {
  process.stderr.write("[event] ready event_key=im.message.receive_v1\n[source] feishu-websocket: connected\n");
  const directory = join(root, "events", app);
  mkdirSync(directory, { recursive: true });
  while (true) {
    if (existsSync(join(directory, "EXIT"))) { rmSync(join(directory, "EXIT")); process.exit(3); }
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
      process.stdout.write(readFileSync(join(directory, file), "utf8").trim() + "\n");
      rmSync(join(directory, file));
    }
    await Bun.sleep(10);
  }
} else if (args[0] === "event" && args[1] === "stop") {
  ok({});
} else if (args.includes("+chat-list")) {
  console.log(JSON.stringify({ ok: true, identity: "bot", data: { has_more: false, chats: [{ chat_id: "oc_group", name: "测试群", chat_status: "normal", chat_mode: "group" }] }, meta: { pagination: { complete: true } } }));
} else if (args.includes("+messages-reply")) {
  if (option("--message-id") === "om_unreachable") process.exit(6);
  const deadline = Date.now() + 20_000;
  while (existsSync(join(root, "hold-reply"))) { if (Date.now() > deadline) process.exit(5); await Bun.sleep(10); }
  appendFileSync(join(root, "replies.jsonl"), JSON.stringify({ app, messageId: option("--message-id"), markdown: option("--markdown") }) + "\n");
  ok({ message_id: "om_reply" + Date.now() });
} else if (args[0] === "im" && args[1] === "reactions" && args[2] === "create") {
  appendFileSync(join(root, "reactions.jsonl"), JSON.stringify({ app, messageId: JSON.parse(option("--params")).message_id, emoji: JSON.parse(option("--data")).reaction_type.emoji_type }) + "\n");
  ok({ reaction_id: "reaction_" + crypto.randomUUID() });
} else if (args[0] === "im" && args[1] === "reactions" && args[2] === "delete") {
  ok({});
} else {
  // Message evidence and recent context are unavailable in this fixture, so
  // turns run on the degraded event text, exactly as in production.
  process.exit(4);
}
`;
