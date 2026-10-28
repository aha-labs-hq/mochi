import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_TOOL_CAPABILITY_ABI } from "../src/agent/tools.ts";
import { BotApp } from "../src/app.ts";
import { loadBotContext } from "../src/config.ts";
import {
  FleetStatusProjection,
  type RuntimeAccountSnapshot,
} from "../src/control/statusSnapshot.ts";
import { GitHubConnection } from "../src/github/connection.ts";
import { GitHubFileCredentialStore } from "../src/github/credentials.ts";
import { GitHubOAuth } from "../src/github/oauth.ts";
import { FeishuConnection } from "../src/lark/connection.ts";
import { FeishuConnectionStore } from "../src/lark/connectionStore.ts";
import { REQUIRED_LARK_TENANT_SCOPES } from "../src/lark/permissions.ts";
import { ProcessLock } from "../src/processLock.ts";
import * as layouts from "../src/product/layout.ts";
import type { ScheduleDefinition } from "../src/schedules/store.ts";
import { StateStore } from "../src/state.ts";

const BOT = "11111111-1111-4111-8111-111111111111";

async function until(predicate: () => boolean, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Bot schedule did not converge");
    await Bun.sleep(20);
  }
}

// Real Bot composition, clock, SQLite and private worker/CLI transports. The
// child processes provide deterministic model/provider replies, never live auth.
test("Bot clock delivers accepted work in its original Session and rechecks group authority before sending", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mochi-schedule-bot-")));
  const layout = layouts.resolveProductLayout({
    environment: {},
    homeDirectory: root,
  });
  const productLayout = spyOn(layouts, "productLayout").mockReturnValue({
    ...layout,
    protocolDirectory: resolve(import.meta.dir, "../config/protocol"),
  });
  const bot = layout.bot(BOT);
  mkdirSync(bot.configurationDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(bot.stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    bot.botConfigPath,
    '[agent]\ninstructions_file = "AGENTS.md"\n[runtime]\nmodel = "gpt-test"\nreasoning_effort = "high"\nturn_timeout_seconds = 1800\n',
    { mode: 0o600 },
  );
  writeFileSync(join(bot.configurationDirectory, "AGENTS.md"), "Test Bot", {
    mode: 0o600,
  });
  const state = new StateStore(bot.stateDatabasePath);
  const session = crypto.randomUUID();
  state.initializeRuntimeSession(session, AGENT_TOOL_CAPABILITY_ABI);
  const now = Date.now();
  const definition: ScheduleDefinition = {
    title: "已接受的工作",
    task: "核对发布阻塞，给出依据。",
    appId: "cli_customer",
    chatId: "oc_group",
    threadKey: "omt_origin",
    replyMessageId: "om_origin",
    requesterId: "ou_person",
    sourceMessageLink:
      "https://applink.feishu.cn/client/message/open?messageId=om_origin",
    delivery: "group",
    threadTarget: null,
    resources: [],
    rule: { kind: "once", timeZone: "UTC", at: new Date(now).toISOString() },
  };
  const accepted = state.schedules.create(
    `schedule:${"a".repeat(64)}`,
    definition,
    now - 1_000,
  );
  const revoked = state.schedules.create(
    `schedule:${"b".repeat(64)}`,
    { ...definition, title: "执行中权限变化" },
    now - 900,
  );
  const workerPath = join(root, "worker.ts");
  const cliPath = join(root, "lark.ts");
  const prefix = `#!${process.execPath}\nconst root = ${JSON.stringify(root)};\n`;
  writeFileSync(workerPath, prefix + worker, { mode: 0o700 });
  writeFileSync(cliPath, prefix + cli, { mode: 0o700 });
  writeFileSync(join(root, "hold-turn"), "hold");
  const context = loadBotContext(bot, session);
  context.runtime.sudoPath = workerPath;
  context.runtime.workerPath = root;
  const connectionStore = new FeishuConnectionStore(
    bot.feishuConnectionDirectory,
  );
  const directoryId = connectionStore.createDirectory();
  connectionStore.write({
    version: 2,
    active: {
      brand: "feishu",
      directoryId,
      appId: "cli_customer",
      botOpenId: "ou_customer",
    },
    candidate: null,
  });
  const feishu = new FeishuConnection(cliPath, connectionStore, async () => ({
    appId: "cli_customer",
    brand: "feishu",
    botOpenId: "ou_customer",
    bot: { name: "Test Bot", avatarUrl: null },
    problem: null,
    missingScopes: [],
    grantedScopes: [...REQUIRED_LARK_TENANT_SCOPES],
  }));
  const github = new GitHubConnection({
    store: new GitHubFileCredentialStore(bot.githubCredentialPath),
    oauth: new GitHubOAuth("fixture", (async () => {
      throw new Error("Unexpected network");
    }) as unknown as typeof fetch),
  });
  const status = new FleetStatusProjection(join(root, "status.json"));
  status.roster([
    { id: BOT, label: "Test", characterId: "mochi", enabled: true },
  ]);
  status.controlReady();
  const account: RuntimeAccountSnapshot = {
    status: "signedIn" as const,
    account: {
      provider: "openai-codex",
      authType: "oauth" as const,
      subscription: true,
    },
    connections: [
      {
        provider: "openai-codex",
        authType: "oauth" as const,
        subscription: true,
      },
    ],
  };
  status.accountChanged(account);
  let app: BotApp | undefined;
  try {
    app = new BotApp({
      bot: context,
      github,
      feishu,
      status: status.bot(BOT),
      enabled: true,
      account: { snapshot: () => account },
      lock: await ProcessLock.acquire(bot.stateLockPath),
    });
    void app.start().catch(() => app?.fail());
    await until(() => status.snapshot().bots[0]?.lifecycle === "listening");
    await until(() => existsSync(join(root, "turn-started")), 20_000);
    // The fixture marks its turn before replying; status follows the reply.
    await until(() => status.snapshot().bots[0]?.activeTurn === true);
    const active = state.schedules.get(accepted.id);
    expect(active.lastRun?.status).toBe("running");
    app.setScheduleEnabled(accepted.id, active.revision, false);
    rmSync(join(root, "hold-turn"));
    await until(
      () => state.schedules.get(accepted.id).lastRun?.status === "delivered",
    );
    expect(state.schedules.get(accepted.id).enabled).toBe(false);
    expect(state.topicIsActive("oc_group", "om_result")).toBe(true);
    expect(
      state.schedules
        .inTopic("cli_customer", "oc_group", "om_result")
        .map((item) => item.id),
    ).toEqual([accepted.id]);
    expect(state.recoverInterruptedEvents()).toEqual([]);
    await until(
      () => state.schedules.get(revoked.id).lastRun?.status === "blocked",
      20_000,
    );
    expect(state.schedules.get(revoked.id).lastRun?.problem).toBe(
      "group_unavailable",
    );
    const sends = readFileSync(join(root, "sends.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("+messages-send");
    expect(sends[0]).not.toContain("--reply-in-thread");
    expect(sends[0]?.[sends[0].indexOf("--markdown") + 1]).toContain("原讨论");
    const turns = readFileSync(join(root, "turns.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn.sessionId).toBe(session);
      expect(turn.executionPolicy).toBe("scheduled");
      expect(turn.text).toContain("<scheduled_work>");
      expect(turn.text).not.toContain("<feishu_turn>");
      // The Bot's group directory names where the result goes.
      expect(turn.text).toContain("群：测试群");
    }
    expect(state.runtimeSession()?.sessionId).toBe(session);
    expect(state.runtimeSession()?.turnCount).toBe(2);
    await app.stop();
    app = undefined;
    expect(state.schedules.recoverInterrupted(Date.now())).toBe(0);
    expect(state.schedules.due(Date.now())).toBeNull();
  } finally {
    await app?.stop();
    state.close();
    status.stopping();
    productLayout.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

const worker = String.raw`
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let init;
function send(request, result) {
  process.stdout.write(JSON.stringify({ version: 11, type: "response", id: request.id, ok: true, result }) + "\n");
}
for await (const line of console) {
  const request = JSON.parse(line);
  if (request.method === "runtime.initialize") {
    init = request.params;
    send(request, { protocolVersion: 11 });
  } else if (request.method === "session.resume") {
    send(request, { sessionId: init.sessionId, capabilityAbi: init.capabilityAbi });
  } else if (request.method === "turn.start") {
    appendFileSync(join(root, "turns.jsonl"), JSON.stringify({ sessionId: init.sessionId, ...request.params }) + "\n");
    writeFileSync(join(root, "turn-started"), "started");
    const turnId = crypto.randomUUID();
    send(request, { turnId });
    const deadline = Date.now() + 5_000;
    while (existsSync(join(root, "hold-turn"))) {
      if (Date.now() > deadline) throw new Error("Fixture turn hold timed out");
      await Bun.sleep(20);
    }
    if (request.params.text.includes("执行中权限变化")) writeFileSync(join(root, "group-revoked"), "revoked");
    await Bun.sleep(20);
    process.stdout.write(JSON.stringify({ version: 11, type: "event", event: "turn.completed", params: { turnId, status: "completed", text: "发布没有新增阻塞。" } }) + "\n");
  } else if (request.method === "runtime.shutdown") {
    send(request, {});
    process.exit(0);
  } else throw new Error("Unexpected worker method: " + request.method);
}
`;

const cli = String.raw`
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("consume")) {
  process.stderr.write("[event] ready event_key=im.message.receive_v1\n[source] feishu-websocket: connected\n");
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
} else if (args.includes("stop")) {
  process.exit(0);
} else if (args.includes("+chat-list")) {
  console.log(JSON.stringify({ ok: true, identity: "bot", data: { has_more: false, chats: existsSync(join(root, "group-revoked")) ? [] : [{ chat_id: "oc_group", name: "测试群", chat_status: "normal", chat_mode: "group" }] }, meta: { pagination: { complete: true } } }));
} else if (args.includes("+messages-send")) {
  appendFileSync(join(root, "sends.jsonl"), JSON.stringify(args) + "\n");
  console.log(JSON.stringify({ ok: true, identity: "bot", data: { chat_id: "oc_group", message_id: "om_result" } }));
} else throw new Error("Unexpected CLI command: " + JSON.stringify(args));
`;
