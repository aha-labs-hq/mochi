import { describe, expect, test } from "bun:test";
import type { DesktopBotView } from "../src/host/fleet.ts";
import { problem } from "../src/shared/problem.ts";
import {
  botNeedsAttention,
  botStatus,
  effortLabel,
  PHASE_WORDS,
  zh,
} from "../src/shared/vocabulary.ts";

function bot(patch: Partial<DesktopBotView> = {}): DesktopBotView {
  return {
    botId: "11111111-2222-4333-8444-555555555555",
    label: "麻薯",
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

describe("one status vocabulary", () => {
  test("a never-configured 伙伴 is not described as paused", () => {
    const fresh = botStatus(
      bot({ enabled: false, lifecycle: "setup", phase: "stopped" }),
    );
    const paused = botStatus(
      bot({ enabled: false, lifecycle: "paused", phase: "stopped" }),
    );
    expect(fresh.label).not.toBe(paused.label);
    expect(paused.label).toBe(PHASE_WORDS.stopped.label);
    expect(fresh.tone).toBe("pending");
  });

  test("a connected 伙伴 whose Feishu stream is down names the cause, never duty", () => {
    for (const down of [
      bot({ phase: "attention", problemCode: "event_stream_unavailable" }),
      // A fixture without a code still says what the phase proves.
      bot({ phase: "attention" }),
    ]) {
      expect(botNeedsAttention(down)).toBe(true);
      const status = botStatus(down);
      expect(status.label).toBe(problem("event_stream_unavailable").title);
      expect(status.label).not.toBe(PHASE_WORDS.listening.label);
      expect(status.tone).toBe("pending");
    }
    expect(botNeedsAttention(bot())).toBe(false);
    expect(botStatus(bot()).tone).toBe("good");
  });

  test("memory words come from one place", () => {
    expect(botStatus(bot({ phase: "contextFull" })).label).toBe(
      PHASE_WORDS.contextFull.label,
    );
    expect(botStatus(bot({ phase: "organizingContext" })).label).toBe(
      PHASE_WORDS.organizingContext.label,
    );
  });

  test("reasoning depths are named, model order and IDs untouched", () => {
    expect(effortLabel("max")).not.toBe("max");
    expect(effortLabel("high")).not.toBe(effortLabel("max"));
    expect(effortLabel("future-level")).toBe("future-level");
  });

  test("interpolated Latin names get the customary space beside Han text", () => {
    expect(zh`让${"Mochi"}在这台 Mac 上工作`).toBe(
      "让 Mochi 在这台 Mac 上工作",
    );
    expect(zh`让${"麻薯"}在这台 Mac 上工作`).toBe("让麻薯在这台 Mac 上工作");
    expect(zh`${"Kiwi"}正在准备`).toBe("Kiwi 正在准备");
  });
});
