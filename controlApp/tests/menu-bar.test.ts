import { expect, test } from "bun:test";
import type { DesktopBotView } from "../src/host/fleet.ts";
import { menuBarState, parseMenuBarAction } from "../src/host/menuBar.ts";
import { type DesktopSnapshot, initialSnapshot } from "../src/shared/model.ts";
import { problem } from "../src/shared/problem.ts";
import {
  NOT_RUNNING,
  PHASE_WORDS,
  START_APPLICATION,
} from "../src/shared/vocabulary.ts";

function snapshot(patch: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    ...initialSnapshot("0.2.0", true),
    installed: true,
    loaded: true,
    controlReady: true,
    phase: "listening",
    eventStreamReady: true,
    queueDepth: 0,
    ...patch,
  };
}

let botNumber = 0;
function bot(patch: Partial<DesktopBotView> = {}): DesktopBotView {
  botNumber++;
  return {
    botId: `00000000-0000-4000-8000-${String(botNumber).padStart(12, "0")}`,
    label: `伙伴${botNumber}`,
    characterId: "mochi",
    groupCount: 1,
    projectCount: 1,
    enabled: true,
    lifecycle: "listening",
    phase: "listening",
    problemCode: null,
    ...patch,
  };
}
const streamDown = {
  phase: "attention",
  problemCode: "event_stream_unavailable",
} as const;

test("menu counts only enabled groups without exposing names, IDs or avatars", () => {
  const state = menuBarState(
    snapshot({
      feishuGroups: [
        { id: "private-a", name: "Private A", avatarUrl: null, enabled: true },
        { id: "private-b", name: "Private B", avatarUrl: null, enabled: false },
      ],
    }),
  );
  expect(state.status).toBe("正在值班 · 1 个群");
  expect(state.detail).toBe("飞书已连接 · 在 1 个群值班");
  expect(JSON.stringify(state)).not.toMatch(/private|Private/);
});

test("unknown group inventory is different from no enabled groups", () => {
  expect(menuBarState(snapshot()).status).toBe("正在值班");
  expect(menuBarState(snapshot({ feishuGroups: [] })).status).toBe(
    "已连接 · 尚未开启群聊回应",
  );
});

test("old activity and group membership never prove an online connection", () => {
  const state = menuBarState(
    snapshot({
      phase: "attention",
      eventStreamReady: false,
      feishuGroups: [{ id: "a", name: "A", avatarUrl: null, enabled: true }],
      activity: [
        { id: "old", kind: "normal", time: "12:00", title: "飞书已连接" },
      ],
    }),
  );
  expect(state.status).toBe("需要你看一下");
  expect(state.detail).toBe("飞书暂未连接");
  expect(state.tone).toBe("attention");
});

test("reply status exposes waiting work and a failure takes precedence", () => {
  expect(
    menuBarState(snapshot({ phase: "working", queueDepth: 3 })).status,
  ).toBe("正在回复 · 3 条等待中");
  const failure = problem("service_operation_failed");
  const state = menuBarState(snapshot({ problem: failure }));
  expect(state.status).toBe(failure.title);
  expect(state.detail).toBe(failure.message);
  expect(state.tone).toBe("attention");
});

test("service availability describes the actual LaunchAgent state", () => {
  const online = menuBarState(snapshot());
  expect(online.serviceTitle).not.toBe(START_APPLICATION);
  expect(online.serviceOperation).toBe("stop");
  expect(online.serviceEnabled).toBe(true);
  expect(menuBarState(snapshot({ busy: "service" })).serviceEnabled).toBe(
    false,
  );
  const stopped = menuBarState(
    snapshot({ phase: "stopped", loaded: false, eventStreamReady: false }),
  );
  expect(stopped.serviceTitle).toBe(START_APPLICATION);
  expect(stopped.status).toBe(NOT_RUNNING.label);
  expect(stopped.serviceOperation).toBe("start");
  const firstLaunch = menuBarState(initialSnapshot("0.2.0", false));
  expect(firstLaunch.serviceVisible).toBe(false);
  expect(firstLaunch.serviceEnabled).toBe(false);
});

test("a failure outranks every 伙伴 that still looks on duty", () => {
  const failure = problem("event_stream_unavailable");
  for (const bots of [[bot()], [bot(), bot()]]) {
    const state = menuBarState(snapshot({ bots, problem: failure }));
    expect(state.status).toBe(failure.title);
    expect(state.detail).toBe(failure.message);
    expect(state.tone).toBe("attention");
    expect(state.icon).toBe("attention");
  }
});

test("a 伙伴 whose Feishu stream is down is never reported on duty", () => {
  const down = bot({ ...streamDown, label: "设计评审" });
  const single = menuBarState(
    snapshot({ phase: "attention", eventStreamReady: false, bots: [down] }),
  );
  expect(single.status).toBe(problem("event_stream_unavailable").title);
  expect(single.status).not.toContain(PHASE_WORDS.listening.label);
  expect(single.tone).toBe("attention");
  expect(single.icon).toBe("attention");
  const fleet = menuBarState(snapshot({ bots: [bot(), down] }));
  expect(fleet.status).toContain("设计评审");
  expect(fleet.status).not.toContain(PHASE_WORDS.listening.label);
  expect(fleet.tone).toBe("attention");
  expect(fleet.icon).toBe("attention");
  const both = menuBarState(snapshot({ bots: [bot(streamDown), down] }));
  expect(both.status).toContain("2");
  expect(both.tone).toBe("attention");
});

test("paused and never-configured 伙伴 are not described as ready or on duty", () => {
  const paused = {
    enabled: false,
    lifecycle: "paused",
    phase: "stopped",
  } as const;
  const one = menuBarState(snapshot({ phase: "stopped", bots: [bot(paused)] }));
  expect(one.status).toBe(PHASE_WORDS.stopped.label);
  expect(one.tone).toBe("quiet");
  expect(one.icon).toBe("sleeping");
  const all = menuBarState(snapshot({ bots: [bot(paused), bot(paused)] }));
  expect(all.status).not.toContain(PHASE_WORDS.listening.label);
  expect(all.tone).toBe("quiet");
  expect(all.icon).toBe("sleeping");
  const fresh = menuBarState(
    snapshot({
      bots: [
        bot({ enabled: false, lifecycle: "setup", phase: "stopped" }),
        bot({ enabled: false, lifecycle: "setup", phase: "stopped" }),
      ],
    }),
  );
  expect(fresh.status).not.toBe(all.status);
  expect(fresh.tone).toBe("quiet");
  const mixed = menuBarState(snapshot({ bots: [bot(), bot(paused)] }));
  expect(mixed.status).toContain("1");
  expect(mixed.tone).toBe("good");
  expect(mixed.icon).toBe("awake");
});

test("menu icons distinguish work, rest, connection, organization and failure", () => {
  const cases = {
    checking: "connecting",
    notInstalled: "sleeping",
    stopped: "sleeping",
    starting: "connecting",
    listening: "awake",
    working: "replying",
    contextFull: "full",
    organizingContext: "organizing",
    attention: "attention",
  } as const;
  for (const [phase, icon] of Object.entries(cases))
    expect(
      menuBarState(snapshot({ phase: phase as DesktopSnapshot["phase"] })).icon,
    ).toBe(icon);
  expect(
    menuBarState(snapshot({ problem: problem("service_shutdown_failed") }))
      .icon,
  ).toBe("attention");
  const quitting = menuBarState(snapshot({ busy: "shutdown" }));
  expect(quitting.status).toBe("正在退出…");
  expect(quitting.serviceEnabled).toBe(false);
  expect(quitting.icon).toBe("sleeping");
});

test("native callbacks accept only explicit menu intents", () => {
  for (const action of ["show", "settings", "start", "stop", "quit"] as const)
    expect(parseMenuBarAction(action)).toBe(action);
  for (const action of ["toggleService", "login", "initialize_runtime", ""])
    expect(() => parseMenuBarAction(action)).toThrow(
      "Unknown native menu action",
    );
});
