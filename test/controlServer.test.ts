import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { ControlRejection, MochiControlServer, type MochiBotActions, type MochiControlActions } from "../src/control/controlServer.ts";
import { MOCHI_CONTROL_PROTOCOL_VERSION, parseControlResponse } from "../src/control/protocol.ts";
import { ConnectorError } from "../src/connectors/errors.ts";
import { StateStore } from "../src/state.ts";
import { projectSchedule } from "../src/schedules/view.ts";
import { UpdateLifecycle } from "../src/control/updateLifecycle.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";
const VERSION = MOCHI_CONTROL_PROTOCOL_VERSION;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * One deployment serving one Bot.
 *
 * Deployment-wide controllers (the ChatGPT account, the GitHub installation, the
 * roster) sit at the top level; everything a Bot owns is reachable only through
 * `bot()`, so an unknown identity is refused before any action runs.
 */
function deployment(
  bot: Partial<MochiBotActions>,
): MochiControlActions & { reached(botId: string): number; created(): string[] } {
  const reached = new Map<string, number>();
  const created: string[] = [];
  const botActions = {
    feishuSettings: async () => ({ authorizationUrl: "https://open.feishu.cn/app/cli_test" }),
    startGitHubLogin: async () => ({ authorizationUrl: "https://github.com/login/oauth/authorize?state=fixture" }),
    startGitHubInstallation: async () => ({ authorizationUrl: "https://github.com/apps/mochi-companion/installations/new?state=fixture" }),
    cancelGitHubLogin: async () => undefined,
    disconnectGitHub: async () => undefined,
    setBotCharacter: async () => undefined,
    ...bot,
  } as MochiBotActions;
  return {
    configureByok: async () => undefined,
    removeByok: async () => undefined,
    readByok: async () => [],
    startChatGPTLogin: async () => ({ authorizationUrl: "https://auth.openai.com/mochi" }),
    cancelChatGPTLogin: async () => undefined,
    logoutChatGPT: async () => undefined,
    switchChatGPTAccount: async () => ({ authorizationUrl: "https://auth.openai.com/switch" }),
    reached: (botId) => reached.get(botId) ?? 0,
    created: () => created,
    async createBot(label) {
      const botId = "22222222-3333-4444-8555-666666666666";
      created.push(label);
      return { botId };
    },
    bot(botId) {
      if (botId !== BOT_ID) throw new ControlRejection("bot_unknown");
      reached.set(botId, (reached.get(botId) ?? 0) + 1);
      return botActions;
    },

  };
}

describe("Mochi control socket", () => {
  test("stable update handshake serializes against an accepted control operation and acknowledges before stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-up-control-")); directories.push(directory);
    const socketPath = join(directory, "c.sock"), entered = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>();
    const actions = deployment({});
    actions.logoutChatGPT = async () => { entered.resolve(); await settled.promise; };
    let stopped = false;
    const gate = new UpdateLifecycle("0.3.0", () => true);
    const server = new MochiControlServer(actions, socketPath, { lifecycle: gate, stop: async () => { stopped = true; }, health: async () => ({ initialized: true, failures: [] }) });
    await server.start();
    const acquire = { lifecycle: "update", version: 1, command: "acquire", targetVersion: "0.4.0", sha256: "a".repeat(64) };
    try {
      const operation = request(socketPath, { version: VERSION, command: "logout_chatgpt" });
      await entered.promise;
      expect(await request(socketPath, acquire)).toMatchObject({ ok: false, reason: "busy" });
      settled.resolve(); expect((await operation).ok).toBe(true);
      const lease = await request(socketPath, acquire); expect(lease.ok).toBe(true);
      expect(await request(socketPath, { version: VERSION, command: "logout_chatgpt" })).toMatchObject({ ok: false, problem: { code: "connection_change_busy" } });
      expect(await request(socketPath, { lifecycle: "update", version: 1, command: "health" })).toMatchObject({ ok: true, initialized: true, failures: [], productVersion: "0.3.0" });
      expect((await request(socketPath, { lifecycle: "update", version: 1, command: "stop", lease: lease.lease })).ok).toBe(true);
      expect(stopped).toBe(true); expect(gate.acceptingWork).toBe(false);
    } finally { settled.resolve(); await server.stop(); }
  });
  test("arrangements cross the real private socket with revisions, exact Bot scope and bounded UTF-8 records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-schedule-control-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    const socketPath = join(directory, "private", "control.sock");
    const now = Date.parse("2026-10-01T00:00:00Z");
    for (let i = 0; i < 50; i++) state.schedules.create(`schedule:${i.toString(16).padStart(64, "0")}`, {
      title: `安排 ${i}`, task: "查".repeat(4000), rule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
      appId: "cli_test", chatId: "oc_group", threadKey: "omt_origin", replyMessageId: "om_origin", requesterId: "ou_user",
      delivery: "group", sourceMessageLink: null, threadTarget: null, resources: [],
    }, now);
    const actions = deployment({
      readSchedules: async () => state.schedules.list().map((item) => projectSchedule(item, "产品协作群", null)),
      setScheduleEnabled: (id, revision, enabled) => { state.schedules.setEnabled(id, revision, enabled, now); },
      cancelSchedule: (id, revision) => { state.schedules.cancel(id, revision); },
    });
    const server = new MochiControlServer(actions, socketPath);
    try {
      await server.start();
      const read = await request(socketPath, { version: VERSION, command: "read_schedules", botId: BOT_ID });
      const parsed = parseControlResponse(JSON.stringify(read), "read_schedules");
      expect(parsed.schedules).toHaveLength(50);
      expect(parsed.schedules![0]!.task).toHaveLength(4000);
      expect(JSON.stringify(read)).not.toMatch(/om_origin|ou_user|cli_test|selectionId/);
      const first = parsed.schedules![0]!;
      const mutation = { version: VERSION, botId: BOT_ID, command: "set_schedule_enabled", scheduleId: first.id, revision: first.revision, enabled: false };
      expect((await request(socketPath, mutation)).ok).toBe(true);
      expect(state.schedules.get(first.id).enabled).toBe(false);
      expect((await request(socketPath, mutation)).problem?.code).toBe("schedules_conflict");
      const reached = actions.reached(BOT_ID);
      expect((await request(socketPath, { ...mutation, botId: "22222222-3333-4444-8555-666666666666" })).problem?.code).toBe("bot_unknown");
      expect((await request(socketPath, { ...mutation, botId: undefined })).ok).toBe(false);
      expect((await request(socketPath, { ...mutation, transcript: "forbidden" })).ok).toBe(false);
      expect(actions.reached(BOT_ID)).toBe(reached);
      expect((await request(socketPath, { version: VERSION, botId: BOT_ID, command: "cancel_schedule", scheduleId: first.id, revision: first.revision + 1 })).ok).toBe(true);
      expect(state.schedules.list()).toHaveLength(49);
    } finally { await server.stop(); state.close(); }
  });
  test("accepts only the declared context, account, and model-policy commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-context-control-"));
    directories.push(directory);
    const socketPath = join(directory, "private", "control.sock");
    let organizeCount = 0;
    let recoverCount = 0;
    let logoutCount = 0;
    let recheckCount = 0;
    let appliedGroup: { chatId: string; enabled: boolean } | undefined;
    let appliedPolicy: { model: string; reasoningEffort: string } | undefined;
    let selectedProjects: readonly number[] | undefined;
    let byokSetup: { apiKey: string; baseUrl: string; label: string; model: string } | undefined;
    const models = [{
      id: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      description: "Balanced model",
      supportedEfforts: [{ id: "max", description: "Maximum reasoning" }],
      defaultEffort: "max",
    }];
    const actions = deployment({
      readInstructions: () => ({ content: "test", revision: "a".repeat(64) }),
      saveInstructions: (document) => document,
      startFeishuConnection: async () => ({ authorizationUrl: "https://open.feishu.cn/page/cli?user_code=ABCD-1234&lpv=1.0.93&ocv=1.0.93&from=cli" }),
      cancelFeishuConnection: async () => undefined,
      discardFeishuCandidate: async () => undefined,
      checkFeishuCandidate: async () => undefined,
      activateFeishuConnection: async () => undefined,
      disconnectFeishu: async () => undefined,
      organizeContext: async () => { organizeCount += 1; },
      recheckConnections: () => { recheckCount++; },
      updateGroupParticipation: async (chatId, enabled) => { appliedGroup = { chatId, enabled }; },
      modelCatalog: async () => models,
      updateModelPolicy: async (policy) => { appliedPolicy = policy; },
      selectProjects: async (repositoryIds) => { selectedProjects = repositoryIds; },
      renameBot: async () => undefined,
      setBotEnabled: async () => undefined,
      recoverBot: async () => { recoverCount++; },
    });
    // Deployment-wide controllers are reached without naming any Bot.
    actions.logoutChatGPT = async () => { logoutCount += 1; };
    actions.configureByok = async (input) => { byokSetup = input; };
    actions.removeByok = async () => { byokSetup = undefined; };
    actions.readByok = async () => [{
      provider: "mochi-byok-12345678",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-5",
      label: "Example",
    }];
    const server = new MochiControlServer(actions, socketPath);
    await server.start();

    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(statSync(join(directory, "private")).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(await request(socketPath, { version: VERSION, botId: BOT_ID, command: "organize_context" })).toEqual({
      version: VERSION,
      ok: true,
    });
    expect(organizeCount).toBe(1);
    // Reconnecting is one Bot's own action and always names that Bot.
    expect(await request(socketPath, { version: VERSION, botId: BOT_ID, command: "recover_bot" })).toEqual({ version: VERSION, ok: true });
    expect(recoverCount).toBe(1);
    expect(await request(socketPath, { version: VERSION, command: "recover_bot" })).toMatchObject({ ok: false });
    expect(recoverCount).toBe(1);

    expect(await request(socketPath, { version: VERSION, botId: BOT_ID, command: "initialize_runtime" })).toMatchObject({ ok: false });

    expect(await request(socketPath, { version: VERSION, command: "start_chatgpt_login" })).toEqual({
      version: VERSION,
      ok: true,
      authorizationUrl: "https://auth.openai.com/mochi",
    });
    expect(await request(socketPath, { version: VERSION, command: "cancel_chatgpt_login" })).toEqual({
      version: VERSION,
      ok: true,
    });

    expect(await request(socketPath, { version: VERSION, command: "logout_chatgpt" })).toEqual({
      version: VERSION,
      ok: true,
    });
    expect(logoutCount).toBe(1);
    expect(await request(socketPath, {
      version: VERSION,
      command: "configure_byok",
      apiKey: "fixture-api-key",
      baseUrl: "https://api.example.com/v1",
      label: "Example",
      model: "gpt-5",
    })).toEqual({ version: VERSION, ok: true });
    expect(byokSetup).toEqual({ apiKey: "fixture-api-key", baseUrl: "https://api.example.com/v1", label: "Example", model: "gpt-5" });
    expect(await request(socketPath, { version: VERSION, command: "read_byok" })).toEqual({
      version: VERSION,
      ok: true,
      connections: [{
        provider: "mochi-byok-12345678",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-5",
        label: "Example",
      }],
    });
    expect(await request(socketPath, { version: VERSION, command: "remove_byok" })).toEqual({ version: VERSION, ok: true });
    expect(byokSetup).toBeUndefined();
    expect(await request(socketPath, { version: VERSION, command: "switch_chatgpt_account" })).toEqual({
      version: VERSION,
      ok: true,
      authorizationUrl: "https://auth.openai.com/switch",
    });

    expect(await request(socketPath, { version: VERSION, botId: BOT_ID, command: "model_catalog" })).toEqual({
      version: VERSION,
      ok: true,
      models,
    });
    expect(await request(socketPath, {
      version: VERSION,
      botId: BOT_ID,
      command: "update_model_policy",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
    })).toEqual({ version: VERSION, ok: true });
    expect(appliedPolicy).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "max" });

    expect(await request(socketPath, { version: VERSION, botId: BOT_ID, command: "recheck_connections" })).toEqual({ version: VERSION, ok: true });
    expect(recheckCount).toBe(1);
    expect(await request(socketPath, { version: VERSION, botId: BOT_ID, command: "update_group_participation", chatId: "oc_test", enabled: false })).toEqual({ version: VERSION, ok: true });
    expect(appliedGroup).toEqual({ chatId: "oc_test", enabled: false });

    const projectIds = Array.from({ length: 1000 }, (_, index) => 10_000_000 + index);
    expect(await request(socketPath, { version: VERSION, botId: BOT_ID, command: "select_projects", repositoryIds: projectIds })).toEqual({ version: VERSION, ok: true });
    expect(selectedProjects).toEqual(projectIds);
    for (const patch of [{ repositoryIds: [20, 20] }, { repositoryIds: ["20"] }, { repositoryIds: [-1] },
      { repositoryIds: [...projectIds, 42] }, { owner: "arbitrary" }, { token: "private-fixture" }]) {
      expect((await request(socketPath, { version: VERSION, botId: BOT_ID, command: "select_projects", repositoryIds: [20], ...patch })).ok).toBe(false);
    }
    expect(selectedProjects).toEqual(projectIds);
    for (const patch of [{ enabled: "false" }, { chatId: "file:///private" }, { avatarUrl: "https://arbitrary" }, { version: 8 }]) {
      expect((await request(socketPath, { version: VERSION, botId: BOT_ID, command: "update_group_participation", chatId: "oc_test", enabled: true, ...patch })).ok).toBe(false);
    }
    expect(appliedGroup).toEqual({ chatId: "oc_test", enabled: false });

    // A Bot-scoped command must name its Bot; a deployment command is refused one.
    for (const anonymous of [
      { version: VERSION, command: "logout_chatgpt", botId: BOT_ID },
      { version: VERSION, command: "organize_context" },
      { version: VERSION, command: "read_instructions" },
      { version: VERSION, command: "rename_bot", label: "麻薯" },
    ]) {
      const refused = await request(socketPath, anonymous);
      expect(refused.ok).toBe(false);
      expect(refused.problem).toEqual({
        version: 2,
        code: "component_contract_mismatch",
        recoverability: "repairRequired",
        recoveryAction: "prepareProduct",
      });
    }
    expect(organizeCount).toBe(1);
    expect(actions.reached(BOT_ID)).toBeGreaterThan(0);

    // An unknown Bot is refused as one, never silently served by another.
    const unknown = await request(socketPath, { version: VERSION, botId: "99999999-9999-4999-8999-999999999999", command: "organize_context" });
    expect(unknown.ok).toBe(false);
    expect(unknown.problem).toMatchObject({ code: "bot_unknown" });
    expect(organizeCount).toBe(1);

    const rejected = await request(socketPath, { version: VERSION, botId: BOT_ID, command: "restart" });
    expect(rejected.ok).toBe(false);
    expect(rejected.problem).toEqual({
      version: 2,
      code: "component_contract_mismatch",
      recoverability: "repairRequired",
      recoveryAction: "prepareProduct",
    });
    expect(organizeCount).toBe(1);

    const expanded = await request(socketPath, {
      version: VERSION,
      botId: BOT_ID,
      command: "organize_context",
      method: "anything",
    });
    expect(expanded.ok).toBe(false);
    expect(expanded.problem).toEqual(rejected.problem);
    expect(organizeCount).toBe(1);

    const expandedPolicy = await request(socketPath, {
      version: VERSION,
      botId: BOT_ID,
      command: "update_model_policy",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      arbitrary: true,
    });
    expect(expandedPolicy.ok).toBe(false);
    expect(expandedPolicy.problem).toEqual(rejected.problem);

    // Creating a Bot is the one command that answers with the identity it minted.
    expect(await request(socketPath, { version: VERSION, command: "create_bot", label: "工作" })).toEqual({
      version: VERSION,
      ok: true,
      botId: "22222222-3333-4444-8555-666666666666",
    });
    expect(actions.created()).toEqual(["工作"]);

    await server.stop();
    expect(() => lstatSync(socketPath)).toThrow();
  });

  test("resource removal is Bot-scoped, bounded and preserves the selection identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-remove-resource-"));
    directories.push(directory);
    const socketPath = join(directory, "control.sock");
    const calls: unknown[] = [];
    const actions = deployment({ removeConnectorResource: async (...args) => { calls.push(args); } });
    const server = new MochiControlServer(actions, socketPath);
    await server.start();
    try {
      const input = { version: VERSION, botId: BOT_ID, command: "remove_connector_resource", connectionId: "feishu:cli_customer", resourceId: "document:AAA111", selectionId: "b".repeat(32) };
      expect(await request(socketPath, input)).toEqual({ version: VERSION, ok: true });
      expect(calls).toEqual([[input.connectionId, input.resourceId, input.selectionId]]);
      for (const patch of [{ botId: undefined }, { botId: "invalid" }, { selectionId: "old" }, { resourceId: "a".repeat(257) }, { resourceId: "document:\nBAD" }, { connectionId: "../elsewhere" }, { url: "https://example.com" }]) expect((await request(socketPath, { ...input, ...patch })).ok).toBe(false);
      expect(calls).toHaveLength(1);
    } finally { await server.stop(); }
  });

  test("preserves structured connector reference failures at the product boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-reference-problem-"));
    directories.push(directory);
    const socketPath = join(directory, "control.sock");
    const actions = deployment({
      addConnectorResources: async () => {
        throw new ConnectorError("not_readable", "private provider detail");
      },
    });
    const server = new MochiControlServer(actions, socketPath);
    await server.start();
    try {
      const response = await request(socketPath, {
        version: VERSION,
        botId: BOT_ID,
        command: "add_connector_resources",
        connectionId: "feishu:cli_customer",
        references: ["https://acme.feishu.cn/docx/AAA111"],
      });
      expect(response.problem).toMatchObject({
        code: "connector_resource_unreadable",
      });
      expect(JSON.stringify(response)).not.toContain("private provider detail");
    } finally {
      await server.stop();
    }
  });

  test("never projects internal action failures over the product control boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-control-redaction-"));
    directories.push(directory);
    const socketPath = join(directory, "control.sock");
    const server = new MochiControlServer(deployment({
      readInstructions: () => ({ content: "test", revision: "a".repeat(64) }),
      saveInstructions: (document) => document,
      startFeishuConnection: async () => ({ authorizationUrl: "https://open.feishu.cn/page/cli?user_code=ABCD-1234&lpv=1.0.93&ocv=1.0.93&from=cli" }),
      cancelFeishuConnection: async () => undefined,
      discardFeishuCandidate: async () => undefined,
      checkFeishuCandidate: async () => undefined,
      activateFeishuConnection: async () => undefined,
      disconnectFeishu: async () => undefined,
      organizeContext: async () => { throw new Error("private path and credential-shaped failure"); },
      recheckConnections: () => undefined,
      updateGroupParticipation: async () => undefined,
      modelCatalog: async () => [],
      updateModelPolicy: async () => undefined,
      selectProjects: async () => undefined,
      renameBot: async () => undefined,
      setBotEnabled: async () => undefined,
    }), socketPath);
    await server.start();

    const response = await request(socketPath, { version: VERSION, botId: BOT_ID, command: "organize_context" });

    expect(response.ok).toBe(false);
    expect(response.problem).toEqual({
      version: 2,
      code: "context_organization_failed",
      recoverability: "retryable",
      recoveryAction: "retry",
    });
    expect(JSON.stringify(response)).not.toContain("private path");
    await server.stop();
  });

  test("unknown BYOK outcomes request account recovery instead of another validation attempt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-control-byok-outcome-"));
    directories.push(directory);
    const socketPath = join(directory, "control.sock");
    const actions = deployment({});
    actions.configureByok = async () => { throw new Error("private unknown persistence outcome"); };
    const server = new MochiControlServer(actions, socketPath);
    await server.start();
    try {
      const response = await request(socketPath, {
        version: VERSION, command: "configure_byok", baseUrl: "https://example.com/v1",
        label: "Example", model: "gpt-5", apiKey: "fixture-only-key",
      });
      expect(response.ok).toBe(false);
      expect(response.problem?.code).toBe("account_status_unavailable");
      expect(JSON.stringify(response)).not.toMatch(/private|fixture-only-key/);
    } finally { await server.stop(); }
  });
});

function request(
  socketPath: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> & { version: number; ok: boolean; problem?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response.trim()));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}
