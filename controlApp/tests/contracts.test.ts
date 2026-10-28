import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstructionStore } from "../../src/agent/instructionStore.ts";
import {
  type MochiBotActions,
  MochiControlServer,
} from "../../src/control/controlServer.ts";
import { mochiControlManifest } from "../../src/control/manifest.ts";
import { productProblem } from "../../src/control/productProblem.ts";
import {
  MOCHI_CONTROL_PROTOCOL_VERSION,
  parseControlRequest,
  parseControlResponse,
} from "../../src/control/protocol.ts";
import {
  FleetStatusProjection,
  readFleetStatusSnapshot,
} from "../../src/control/statusSnapshot.ts";
import {
  INSTALLED_PRODUCT_ROOT,
  resolveProductLayout,
} from "../../src/product/layout.ts";
import {
  CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS,
  WORKER_RECOVERY_TIMEOUT_MILLISECONDS,
} from "../../src/runtime/timing.ts";
import {
  environmentFor,
  locationReady,
  parseManifest,
} from "../src/host/contract.ts";
import { sendControl } from "../src/host/control.ts";
import {
  ACTIVITY_EVENTS,
  activityFrom,
  DIAGNOSTIC_EVENTS,
  diagnosticsReport,
} from "../src/host/diagnostics.ts";
import { phaseForBot, projectFleet } from "../src/host/fleet.ts";
import { installerScript, prepareProduct } from "../src/host/installer.ts";
import { run } from "../src/host/process.ts";
import { parseAction } from "../src/shared/actions.ts";
import { initialSnapshot } from "../src/shared/model.ts";
import {
  controlRequestTimeout,
  DESKTOP_RPC_TIMEOUT_MILLISECONDS,
} from "../src/shared/timing.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";
const PROTOCOL_VERSION = MOCHI_CONTROL_PROTOCOL_VERSION;

test("manual organization can outlast ordinary controls and still finish recovery before either App deadline", () => {
  const completionBudget =
    CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS +
    WORKER_RECOVERY_TIMEOUT_MILLISECONDS;
  expect(CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS).toBeGreaterThan(6 * 60_000);
  expect(controlRequestTimeout("read_skills")).toBeLessThan(
    CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS,
  );
  expect(controlRequestTimeout("organize_context")).toBeGreaterThan(
    completionBudget,
  );
  expect(DESKTOP_RPC_TIMEOUT_MILLISECONDS).toBeGreaterThan(
    controlRequestTimeout("organize_context"),
  );
});

const directories: string[] = [];
function temporary() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "mochi-desktop-test-")));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const model = {
  id: "gpt-test",
  displayName: "Test",
  description: "Provider description",
  supportedEfforts: [{ id: "max", description: "Maximum" }],
  defaultEffort: "max",
};

describe("one desktop control contract", () => {
  test("rejects extra request fields and arbitrary RPC actions", () => {
    for (const value of [
      { version: PROTOCOL_VERSION, command: "shell" },
      {
        version: PROTOCOL_VERSION,
        command: "logout_chatgpt",
        botId: BOT_ID,
        path: "/tmp",
      },
      {
        version: PROTOCOL_VERSION,
        command: "update_model_policy",
        model: "a",
        reasoningEffort: "max",
        token: "never",
      },
    ])
      expect(() => parseControlRequest(JSON.stringify(value))).toThrow();
    for (const value of [
      { type: "login", path: "/tmp" },
      { type: "service", operation: "install" },
      { type: "selectBot", botId: BOT_ID, label: "另一个名字" },
      { type: "selectBot" },
      {
        type: "updatePolicy",
        policy: { model: "a", reasoningEffort: "max", path: "/tmp" },
      },
    ])
      expect(() => parseAction(value)).toThrow();
    expect(parseAction({ type: "service", operation: "stop" })).toEqual({
      type: "service",
      operation: "stop",
    });
    // Selecting a Bot names an identity only; the roster decides whether it is real.
    expect(parseAction({ type: "selectBot", botId: BOT_ID })).toEqual({
      type: "selectBot",
      botId: BOT_ID,
    });
  });
  test("validates exact command-specific successful payloads", () => {
    const parse = (value: object) =>
      parseControlResponse(JSON.stringify(value), "model_catalog");
    expect(
      parse({ version: PROTOCOL_VERSION, ok: true, models: [model] }).models,
    ).toEqual([model]);
    for (const models of [
      [],
      [model, model],
      [{ ...model, defaultEffort: "missing" }],
      [
        {
          ...model,
          supportedEfforts: [
            ...model.supportedEfforts,
            ...model.supportedEfforts,
          ],
        },
      ],
      [{ ...model, private: "x" }],
    ])
      expect(() =>
        parse({ version: PROTOCOL_VERSION, ok: true, models }),
      ).toThrow();
    expect(() => parse({ version: 7, ok: true, models: [model] })).toThrow();
    expect(() =>
      parseControlResponse(
        '{"version":8,"ok":true,"models":[]}',
        "logout_chatgpt",
      ),
    ).toThrow();
  });
  test("never accepts raw problems or unsafe authorization URLs", () => {
    expect(
      parseControlResponse(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          ok: false,
          problem: productProblem("login_failed"),
        }),
        "start_chatgpt_login",
      ).problem?.code,
    ).toBe("login_failed");
    expect(() =>
      parseControlResponse(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          ok: false,
          problem: { ...productProblem("login_failed"), message: "private" },
        }),
        "start_chatgpt_login",
      ),
    ).toThrow();
    for (const authorizationUrl of [
      "file:///etc/passwd",
      "http://auth.example",
      "https://user:secret@auth.example",
    ])
      expect(() =>
        parseControlResponse(
          JSON.stringify({
            version: PROTOCOL_VERSION,
            ok: true,
            authorizationUrl,
          }),
          "start_chatgpt_login",
        ),
      ).toThrow();
  });
  test("speaks to the real Bridge server over a mode-600 Unix socket", async () => {
    const directory = temporary();
    const path = join(directory, "private/control.sock");
    const instructionsPath = join(directory, "AGENTS.md");
    writeFileSync(instructionsPath, "original", { mode: 0o600 });
    const instructions = new InstructionStore(instructionsPath);
    let enabled = false;
    // One deployment serving one Bot: the account, the GitHub grant and the
    // roster are deployment-wide, and everything else is reached through bot().
    const botActions: MochiBotActions = {
      readInstructions: () => instructions.read(),
      readSchedules: async () => [],
      setScheduleEnabled: () => undefined,
      cancelSchedule: () => undefined,
      saveInstructions: (document) => instructions.save(document),
      selectProjects: async () => undefined,
      addConnectorResources: async () => undefined,
      removeConnectorResource: async () => undefined,
      organizeContext: async () => {},
      startFeishuConnection: async () => ({
        authorizationUrl:
          "https://open.feishu.cn/page/cli?user_code=ABCD-1234&lpv=1.0.93&ocv=1.0.93&from=cli",
      }),
      cancelFeishuConnection: async () => undefined,
      discardFeishuCandidate: async () => undefined,
      checkFeishuCandidate: async () => undefined,
      activateFeishuConnection: async () => undefined,
      disconnectFeishu: async () => undefined,
      feishuSettings: async () => ({
        authorizationUrl: "https://open.feishu.cn/app/cli_test",
      }),
      startFeishuMailAuthorization: async () => ({
        authorizationUrl: "https://open.feishu.cn/page/mail-auth?code=fixture",
      }),
      cancelFeishuMailAuthorization: async () => undefined,
      feishuMailSettings: async () => ({
        authorizationUrl: "https://open.feishu.cn/app/cli_fixture",
      }),
      disconnectFeishuMail: async () => undefined,
      recheckConnections: () => undefined,
      updateGroupParticipation: async () => undefined,
      modelCatalog: async () => [model],
      updateModelPolicy: async () => {},
      renameBot: async () => undefined,
      recoverBot: async () => undefined,
      setBotEnabled: async (value) => {
        enabled = value;
      },
      setBotCharacter: async () => undefined,
      startGitHubLogin: async () => ({
        authorizationUrl:
          "https://github.com/login/oauth/authorize?state=fixture",
      }),
      startGitHubInstallation: async () => ({
        authorizationUrl:
          "https://github.com/apps/mochi-companion/installations/new?state=fixture",
      }),
      cancelGitHubLogin: async () => undefined,
      disconnectGitHub: async () => undefined,
    };
    const server = new MochiControlServer(
      {
        configureByok: async () => {},
        removeByok: async () => {},
        readByok: async () => [],
        createBot: async () => ({ botId: BOT_ID }),
        bot: () => botActions,
        startChatGPTLogin: async () => ({
          authorizationUrl: "https://auth.openai.com/test",
        }),
        cancelChatGPTLogin: async () => {},
        logoutChatGPT: async () => {},
        switchChatGPTAccount: async () => ({
          authorizationUrl: "https://auth.openai.com/test",
        }),
      },
      path,
    );
    await server.start();
    try {
      const original = (
        await sendControl(path, {
          version: PROTOCOL_VERSION,
          command: "read_instructions",
          botId: BOT_ID,
        })
      ).document!;
      const content = "请用所有同事都能懂的话。\n".repeat(1000);
      const saved = (
        await sendControl(path, {
          version: PROTOCOL_VERSION,
          command: "save_instructions",
          botId: BOT_ID,
          document: { ...original, content },
        })
      ).document!;
      expect(readFileSync(instructionsPath, "utf8")).toBe(content);
      const skills = (
        await sendControl(path, {
          version: PROTOCOL_VERSION,
          command: "read_skills",
          botId: BOT_ID,
        })
      ).skills!;
      expect(skills).toHaveLength(4);
      expect(
        skills.find(({ id }) => id === "github-investigation")?.content,
      ).toContain("# GitHub 调查协议");
      expect(saved.revision).not.toBe(original.revision);
      await expect(
        sendControl(path, {
          version: PROTOCOL_VERSION,
          command: "save_instructions",
          botId: BOT_ID,
          document: { ...original, content: "stale" },
        }),
      ).rejects.toThrow("instructions_conflict");
      expect(
        (
          await sendControl(path, {
            version: PROTOCOL_VERSION,
            command: "model_catalog",
            botId: BOT_ID,
          })
        ).models,
      ).toEqual([model]);
      expect(enabled).toBe(false);
      await sendControl(path, {
        version: PROTOCOL_VERSION,
        command: "set_bot_enabled",
        botId: BOT_ID,
        enabled: true,
      });
      expect(enabled).toBe(true);
      chmodSync(path, 0o666);
      await expect(
        sendControl(path, {
          version: PROTOCOL_VERSION,
          command: "model_catalog",
          botId: BOT_ID,
        }),
      ).rejects.toThrow("control_unavailable");
    } finally {
      await server.stop();
    }
  });
});

describe("desktop installation and evidence boundaries", () => {
  test("manifest is generated from the product authority and rejects drift", () => {
    const manifest = mochiControlManifest("installed", "0.2.0");
    expect(parseManifest(manifest)).toEqual(manifest);
    for (const patch of [
      { statusVersion: 11 },
      { extra: "value" },
      { installedApplicationPath: "/tmp/Mochi.app" },
    ])
      expect(() => parseManifest({ ...manifest, ...patch })).toThrow();
  });
  test("the App meets the Bridge at the paths the layout owns, in both modes", () => {
    for (const [mode, environment] of [
      ["development", {}],
      ["installed", { MOCHI_PRODUCT_ROOT: INSTALLED_PRODUCT_ROOT }],
    ] as const) {
      const bridge = resolveProductLayout({
        environment,
        homeDirectory: "/Users/test",
      });
      const app = environmentFor(
        mochiControlManifest(mode, "0.2.0"),
        "/Applications/Mochi.app",
        "/Users/test",
      );
      expect(bridge.mode).toBe(mode);
      expect({
        statusPath: app.statusPath,
        socketPath: app.socketPath,
        plistPath: app.plistPath,
        logPath: app.logPath,
        companionLogPath: app.companionLogPath,
      }).toEqual({
        statusPath: bridge.statusSnapshotPath,
        socketPath: bridge.controlSocketPath,
        plistPath: bridge.launchAgentPath,
        logPath: bridge.structuredLogPath,
        companionLogPath: bridge.companionLogPath,
      });
    }
  });
  test("wrong-location startup does not ask for administrator authorization", async () => {
    const env = environmentFor(
      mochiControlManifest("installed", "0.2.0"),
      join(temporary(), "Mochi.app"),
      "/Users/test",
    );
    let calls = 0;
    expect(locationReady(env)).toBe(false);
    await expect(
      prepareProduct(env, async () => {
        calls++;
        return { code: 0, stdout: "", stderr: "" };
      }),
    ).rejects.toThrow("application_location_invalid");
    expect(calls).toBe(0);
  });
  test("only installed exact app and package can reach authorization", async () => {
    const directory = temporary(),
      app = join(directory, "Mochi.app");
    mkdirSync(app);
    const alias = join(directory, "alias.app");
    symlinkSync(app, alias);
    const env = environmentFor(
      mochiControlManifest("installed", "0.2.0"),
      alias,
      directory,
    );
    expect(locationReady(env)).toBe(false);
    expect(
      installerScript("/Applications/Mochi.app/Contents/Resources/Mochi.pkg", {
        mode: "development",
      }),
    ).toContain("/usr/bin/env -i HOME=/var/root USER=root LOGNAME=root");
    expect(() =>
      installerScript("/tmp/a\nb.pkg", { mode: "development" }),
    ).toThrow();
  });
  test("status projection preserves the complete Bridge lifecycle without identities", () => {
    const path = join(temporary(), "status.json");
    const fleet = new FleetStatusProjection(path);
    fleet.roster([
      { id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true },
    ]);
    const projection = fleet.bot(BOT_ID);
    projection.starting();
    fleet.controlReady();
    fleet.accountChanged({
      status: "signedIn",
      account: {
        provider: "openai-codex",
        authType: "oauth",
        subscription: true,
      },
      connections: [
        { provider: "openai-codex", authType: "oauth", subscription: true },
      ],
    });
    projection.eventStreamReady();
    try {
      const base = initialSnapshot("0.2.0", true);
      expect(phaseForBot(projection.snapshot())).toBe("listening");
      projection.runtimeStateChanged({
        activeTurn: true,
        organizingContext: false,
        queueDepth: 0,
        contextOrganizationAvailable: false,
      });
      expect(phaseForBot(projection.snapshot())).toBe("working");
      projection.runtimeStateChanged({
        activeTurn: true,
        organizingContext: true,
        queueDepth: 1,
        contextOrganizationAvailable: false,
      });
      expect(readFleetStatusSnapshot(path).kind).toBe("current");
      expect(phaseForBot(projection.snapshot())).toBe("organizingContext");
      projection.runtimeStateChanged({
        activeTurn: true,
        organizingContext: false,
        queueDepth: 1,
        contextOrganizationAvailable: false,
      });
      expect(phaseForBot(projection.snapshot())).toBe("working");
      projection.runtimeStateChanged({
        activeTurn: false,
        organizingContext: true,
        queueDepth: 0,
        contextOrganizationAvailable: false,
      });
      expect(phaseForBot(projection.snapshot())).toBe("organizingContext");
      const snapshot = projectFleet(base, fleet.snapshot(), BOT_ID);
      const report = JSON.stringify(
        diagnosticsReport(
          snapshot,
          mochiControlManifest("development", "0.2.0"),
          [],
        ),
      );
      for (const forbidden of [
        "processId",
        "runId",
        "session",
        "gpt-test",
        "token",
        "email",
      ])
        expect(report).not.toContain(forbidden);
      expect(report).not.toMatch(/\/(?:Users|home)\//);
    } finally {
      projection.stopping();
    }
  });
  test("activity and diagnostics name only events something actually logs", async () => {
    const root = join(import.meta.dir, "../..");
    const emitted = new Set<string>();
    for (const pattern of ["src/**/*.ts", "controlApp/src/host/**/*.ts"]) {
      for await (const file of new Bun.Glob(pattern).scan(root)) {
        if (file.endsWith("diagnostics.ts")) continue;
        const text = await Bun.file(join(root, file)).text();
        for (const match of text.matchAll(
          /\b(?:log|logger|this\.#log|this\.log|this\.logger)\.(?:info|warn|error)\(\s*"([^"]+)"/g,
        ))
          emitted.add(match[1]!);
        // Worker diagnostics are forwarded under their own names.
        for (const match of text.matchAll(/event: "(runtime\.[a-z_.]+)"/g))
          emitted.add(match[1]!);
      }
    }
    for (const event of [...ACTIVITY_EVENTS, ...DIAGNOSTIC_EVENTS])
      expect([event, emitted.has(event)]).toEqual([event, true]);
  });
  test("activity projects only fixed labels from the current run", () => {
    const record = (event: string, extra = {}) =>
      JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", event, ...extra });
    const activity = activityFrom(
      [
        record("runtime.turn.completed"),
        record("bot.starting"),
        record("bot.fatal", { errorMessage: "private secret", level: "error" }),
        record("unknown", { title: "unsafe" }),
      ].join("\n"),
    );
    expect(activity).toHaveLength(2);
    expect(JSON.stringify(activity)).not.toContain("private");
    expect(JSON.stringify(activity)).not.toContain("unsafe");
    expect(activity[0]?.kind).toBe("warning");
  });
  test("drains stdout and stderr concurrently with a hard bound", async () => {
    const output = await run([
      process.execPath,
      "-e",
      'process.stdout.write("x".repeat(131072)); process.stderr.write("y".repeat(131072))',
    ]);
    expect(output.stdout.length).toBe(131072);
    expect(output.stderr.length).toBe(131072);
    await expect(
      run([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        timeout: 50,
      }),
    ).rejects.toThrow("native_command_timeout");
  });
});
