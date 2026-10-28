import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { BINDING_ENTRY, bootstrapCompleted } from "../src/runtime/sessionBinding.ts";

const reply = (text: string, stopReason: StopReason = "stop"): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6.1-sol",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: Date.now(),
});

test("only a successful reply after the latest binding completes a Session bootstrap", () => {
  const directory = mkdtempSync(join(tmpdir(), "mochi-binding-"));
  try {
    const manager = SessionManager.inMemory(directory);
    expect(bootstrapCompleted(manager)).toBeFalse();
    manager.appendCustomEntry(BINDING_ENTRY, { capabilityAbi: "sha256:fixture" });
    // Pi persists the candidate here, before any reply exists.
    manager.appendMessage({ role: "user", content: "Create the durable Session by replying with READY.", timestamp: 1 });
    expect(bootstrapCompleted(manager)).toBeFalse();
    manager.appendMessage(reply("", "aborted"));
    manager.appendMessage(reply("upstream failed", "error"));
    manager.appendMessage(reply("   "));
    expect(bootstrapCompleted(manager)).toBeFalse();
    manager.appendMessage(reply("READY"));
    expect(bootstrapCompleted(manager)).toBeTrue();
    // A migration target inherits earlier replies; only one after its own binding counts.
    manager.appendCustomEntry(BINDING_ENTRY, { capabilityAbi: "sha256:migrated" });
    expect(bootstrapCompleted(manager)).toBeFalse();
    manager.appendMessage(reply("READY"));
    expect(bootstrapCompleted(manager)).toBeTrue();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
