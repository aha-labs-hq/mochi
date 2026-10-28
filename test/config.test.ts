import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentInstructionsPath,
  loadRuntimeConfig,
  parseBotConfig,
  serializeBotConfig,
} from "../src/config.ts";
import { DEFAULT_REASONING_EFFORT } from "../src/runtime/policy.ts";

describe("bot configuration", () => {
  test("loads the complete runtime policy", () => {
    expect(parseBotConfig({
      agent: { instructions_file: "AGENTS.md" },
      runtime: {
        model: "gpt-5.6-terra",
        reasoning_effort: "max",
        turn_timeout_seconds: 600,
      },
    })).toEqual({
      agent: { instructionsFile: "AGENTS.md" },
      runtime: {
        model: "gpt-5.6-terra",
        reasoningEffort: "max",
        turnTimeoutSeconds: 600,
      },
    });
  });

  test("rejects unknown policy and invalid effort", () => {
    expect(() => parseBotConfig({
      agent: { instructions_file: "AGENTS.md" },
      runtime: {
        model: "gpt-5.6-terra",
        reasoning_effort: "extreme",
        turn_timeout_seconds: 600,
      },
    })).toThrow("reasoning_effort must be one of");
    expect(() => parseBotConfig({
      agent: { instructions_file: "AGENTS.md" },
      runtime: {
        model: "gpt-5.6-terra",
        reasoning_effort: "max",
        turn_timeout_seconds: 600,
        fallback_model: "other",
      },
    })).toThrow("unknown keys");
  });

  test("round-trips the complete canonical policy file", () => {
    const config = {
      agent: { instructionsFile: "AGENTS.md" },
      runtime: {
        model: "gpt-5.6-luna",
        reasoningEffort: "minimal" as const,
        turnTimeoutSeconds: 600,
      },
    };
    expect(parseBotConfig(Bun.TOML.parse(serializeBotConfig(config)))).toEqual(config);
  });

  test("keeps the configured AGENTS file inside config", () => {
    const directory = resolve(import.meta.dir, "../config");
    expect(agentInstructionsPath("AGENTS.md", directory)).toEndWith("/config/AGENTS.md");
    expect(() => agentInstructionsPath("../AGENTS.md", directory)).toThrow("configuration directory");
  });

  test("default Agent instructions use the provider-neutral connector surface", () => {
    const instructions = readFileSync(resolve(import.meta.dir, "../config/AGENTS.md"), "utf8");
    expect(instructions).toContain("connector_catalog");
    expect(instructions).toContain("connector_describe");
    expect(instructions).not.toContain("github_list_repositories");
    // Tools that no longer exist must not be named in a new Bot's instructions.
    expect(instructions).not.toMatch(/GitHub 工具|强类型(审计)?工具/);
  });

  test("a new Bot starts at Mochi's one default reasoning effort", () => {
    const template = parseBotConfig(Bun.TOML.parse(readFileSync(resolve(import.meta.dir, "../config/bot.toml"), "utf8")));
    expect(template.runtime.reasoningEffort).toBe(DEFAULT_REASONING_EFFORT);
  });

  test("keeps the isolation boundary compile-time fixed", () => {
    const bot = parseBotConfig({
      agent: { instructions_file: "AGENTS.md" },
      runtime: {
        model: "gpt-5.6-terra",
        reasoning_effort: "max",
        turn_timeout_seconds: 600,
      },
    });
    expect(loadRuntimeConfig(bot, "11111111-2222-4333-8444-555555555555")).toMatchObject({
      botId: "11111111-2222-4333-8444-555555555555",
      workerPath: "/usr/local/libexec/mochi-pi-runtime",
      sudoPath: "/usr/bin/sudo",
      runtimeUser: "_mochi",
      runtimeHome: "/Users/_mochi",
      runtimeCwd: "/Users/_mochi/empty-workspace",
    });
  });
});
