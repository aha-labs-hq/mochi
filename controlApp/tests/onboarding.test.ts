import { describe, expect, test } from "bun:test";
import { mochiControlManifest } from "../../src/control/manifest.ts";
import { diagnosticsReport } from "../src/host/diagnostics.ts";
import { initialSnapshot } from "../src/shared/model.ts";
import { problem } from "../src/shared/problem.ts";
import { connectionStatus } from "../src/ui/connectionStatus.ts";
import { setupPresentation } from "../src/ui/setupPresentation.ts";
import { connectedFacts } from "./connectedFacts.ts";

describe("nontechnical onboarding and recovery", () => {
  test("a new BYOK connection asks for model selection before first duty", () => {
    const base = {
      ...initialSnapshot("0.2.0", true),
      ...connectedFacts,
      setup: "ready" as const,
      account: {
        status: "signedIn",
        account: {
          provider: "mochi-byok",
          authType: "api_key",
          subscription: false,
          label: "Example",
          model: "mochi-byok/gpt-5",
        },
        connections: [
          {
            provider: "mochi-byok",
            authType: "api_key",
            subscription: false,
            label: "Example",
            model: "mochi-byok/gpt-5",
          },
        ],
      } as const,
      policy: { model: "gpt-5", reasoningEffort: "high" as const },
    };
    expect(setupPresentation(base).id).toBe("model");
    expect(
      setupPresentation({
        ...base,
        policy: { ...base.policy, model: "mochi-byok/gpt-5" },
      }).id,
    ).not.toBe("model");
    expect(
      setupPresentation({
        ...base,
        policy: { ...base.policy, model: "mochi-byok/gpt-4.1" },
      }).id,
    ).toBe("model");
  });
  test("a model API customer keeps the Feishu QR until Feishu is connected", () => {
    const connection = {
      provider: "mochi-byok",
      authType: "api_key",
      subscription: false,
      label: "Example",
      model: "mochi-byok/gpt-5",
    } as const;
    // The first scan creates the Bot from the template, whose default model
    // belongs to ChatGPT, a connection this customer never made.
    const scanning = {
      ...initialSnapshot("0.2.0", true),
      ...connectedFacts,
      setup: "ready" as const,
      account: {
        status: "signedIn",
        account: connection,
        connections: [connection],
      } as const,
      policy: { model: "gpt-5.6-terra", reasoningEffort: "high" as const },
      feishu: {
        active: null,
        candidate: {
          brand: null,
          state: "registering" as const,
          bot: null,
          problem: null,
        },
      },
    };
    expect(setupPresentation(scanning)).toMatchObject({
      id: "feishu",
      title: "用飞书或 Lark 扫码",
    });
    expect(
      setupPresentation({ ...scanning, feishu: connectedFacts.feishu }).id,
    ).toBe("model");
  });
  test("flow copy names the customer's own 伙伴, never a fixed character", () => {
    const renamed = {
      ...initialSnapshot("0.2.0", true),
      ...connectedFacts,
      bots: connectedFacts.bots.map((bot) => ({
        ...bot,
        label: "设计评审",
        enabled: false,
        lifecycle: "setup" as const,
        phase: "stopped" as const,
      })),
      setup: "ready" as const,
      account: {
        status: "signedIn",
        account: {
          provider: "openai-codex",
          authType: "oauth",
          subscription: true,
        },
        connections: [
          { provider: "openai-codex", authType: "oauth", subscription: true },
        ],
      } as const,
    };
    const scenes = [
      setupPresentation(renamed),
      setupPresentation({ ...renamed, setup: "initializing" }),
      setupPresentation({ ...renamed, connectorCatalog: null }),
      setupPresentation({
        ...renamed,
        feishu: { active: null, candidate: null },
      }),
    ];
    for (const scene of scenes) {
      const copy = `${scene.title}${scene.detail}${scene.note}`;
      expect(copy).not.toContain("麻薯");
    }
    expect(scenes.some((scene) => scene.detail.includes("设计评审"))).toBe(
      true,
    );
    // Before any 伙伴 exists, the application speaks for itself.
    const install = setupPresentation({
      ...initialSnapshot("0.2.0", false),
      setup: "install",
    });
    expect(install.title).toContain("Mochi");
    expect(install.checklist).toHaveLength(4);
  });
  test("copy keeps account login, runtime preparation and actual message delivery distinct", () => {
    const base = initialSnapshot("0.2.0", true);
    expect(setupPresentation({ ...base, setup: "checking" }).action).toBeNull();
    expect(
      setupPresentation({ ...base, setup: "signIn" }).action?.value,
    ).toEqual({ type: "login" });
    expect(setupPresentation({ ...base, setup: "ready" }).title).toBe(
      "连接团队群聊",
    );
    expect(
      setupPresentation({ ...base, setup: "initializing" }).action,
    ).toBeNull();
    const connected = {
      ...base,
      ...connectedFacts,
      controlReady: true,
      eventStreamReady: true,
      account: {
        status: "signedIn",
        account: {
          provider: "openai-codex",
          authType: "oauth",
          subscription: true,
        },
        connections: [
          { provider: "openai-codex", authType: "oauth", subscription: true },
        ],
      },
    } as const;
    expect(setupPresentation(connected).title).toBe("正在读取群聊");
    expect(setupPresentation({ ...connected, feishuGroups: [] }).title).toBe(
      "把机器人加入群聊",
    );
    const groups = [{ id: "oc_a", name: "A", avatarUrl: null, enabled: false }];
    expect(
      setupPresentation({ ...connected, feishuGroups: groups }).title,
    ).toBe("选择一个群，开启回应");
    expect(
      setupPresentation({
        ...connected,
        feishuGroups: [{ ...groups[0]!, enabled: true }],
      }).title,
    ).toBe("去飞书，问第一个问题");
    expect(
      setupPresentation({
        ...connected,
        eventStreamReady: false,
        feishuGroups: groups,
      }).title,
    ).toBe("正在确认飞书连接");
    expect(
      setupPresentation({
        ...connected,
        account: { status: "unknown" },
        feishuGroups: groups,
      }).id,
    ).toBe("connecting");
  });
  test("history and process presence cannot prove a connection", () => {
    const snapshot = {
      ...initialSnapshot("0.2.0", false),
      loaded: true,
      activity: [
        {
          id: "old",
          time: "2026-09-01T00:00:00Z",
          title: "群聊连接好了",
          kind: "normal" as const,
        },
      ],
    };
    expect(connectionStatus(snapshot)).toBe("正在确认连接");
    expect(connectionStatus({ ...snapshot, phase: "attention" })).toBe(
      "尚未连接群聊",
    );
    expect(
      connectionStatus({ ...snapshot, phase: "stopped", loaded: false }),
    ).toBe("尚未连接群聊");
    expect(
      connectionStatus({
        ...snapshot,
        phase: "stopped",
        feishu: {
          active: {
            brand: "feishu" as const,
            state: "ready",
            bot: { name: "Mochi", avatarUrl: null },
          },
          candidate: null,
        },
      }),
    ).toBe("群聊已连接，伙伴已暂停");
    expect(
      connectionStatus({
        ...snapshot,
        phase: "stopped",
        feishu: {
          active: null,
          candidate: {
            brand: null,
            state: "registering",
            bot: null,
            problem: null,
          },
        },
      }),
    ).toBe("等待完成扫码");
    const manifest = mochiControlManifest("installed", "0.2.0");
    expect(
      JSON.stringify(
        diagnosticsReport({ ...snapshot, phase: "listening" }, manifest, []),
      ),
    ).not.toContain("messages.listening");
    expect(
      JSON.stringify(
        diagnosticsReport(
          { ...snapshot, phase: "organizingContext", eventStreamReady: true },
          manifest,
          [],
        ),
      ),
    ).toContain("messages.listening");
  });
  test("recoveries perform the operation they describe, never suggest developer tooling", () => {
    expect(problem("product_preparation_failed").recoveryAction).toBe(
      "prepareProduct",
    );
    expect(problem("login_browser_unavailable").recoveryAction).toBe(
      "reopenBrowser",
    );
    // Only a pending ChatGPT login is reopened; other pages and a Bot that left
    // the roster are dismissed so the customer repeats the action where it was.
    expect(problem("browser_unavailable").recoveryAction).toBe("retry");
    expect(problem("bot_unknown").recoveryAction).toBe("retry");
    expect(problem("service_readiness_timeout").recoveryAction).toBe(
      "exportDiagnostics",
    );
    for (const code of [
      "product_preparation_failed",
      "service_readiness_timeout",
      "service_identity_mismatch",
      "service_configuration_invalid",
      "setup_failed",
    ] as const) {
      const copy = problem(code);
      expect(`${copy.title} ${copy.message}`).not.toMatch(
        /Bun|Node|Pi|终端|Session|sudo|\.env|完整磁盘/,
      );
    }
  });
});
