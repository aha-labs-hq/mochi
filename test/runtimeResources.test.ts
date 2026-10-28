import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isolatedResourceLoader, isolatedSettings, SESSION_COMPACTION_INSTRUCTIONS } from "../src/runtime/resources.ts";
import { executionTools } from "../src/runtime/execution.ts";

test("the pinned Pi SDK reloads only explicit instructions, preserving history, tools and identity", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-policy-sdk-")));
  try {
    writeFileSync(join(directory, "AGENTS.md"), "AMBIENT_MUST_NOT_LOAD");
    // Pi 0.99 added built-in MCP, codemode and tool search; none may enter the SDK Session.
    const ambientMcp = JSON.stringify({ mcpServers: { ambient: { command: "/usr/bin/true" } } });
    writeFileSync(join(directory, "mcp.json"), ambientMcp);
    mkdirSync(join(directory, ".pi"));
    writeFileSync(join(directory, ".pi/mcp.json"), ambientMcp);
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = runtime.getModels("openai-codex")[0]!;
    expect(model).toBeDefined();
    let prompt = "OLD_POLICY";
    const manager = SessionManager.inMemory(directory);
    const nativeTools = executionTools(() => { throw new Error("No active turn"); });
    manager.appendMessage({ role: "user", content: "EXISTING_HISTORY", timestamp: 1 });
    const { session } = await createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime: runtime, model,
      sessionManager: manager,
      settingsManager: isolatedSettings(true),
      resourceLoader: isolatedResourceLoader(() => prompt), noTools: "all", tools: ["fixture_read", ...nativeTools.map(({ name }) => name)],
      customTools: [{ name: "fixture_read", label: "Read", description: "fixture", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }, ...nativeTools],
    });
    try {
      const identity = session.sessionId;
      const history = structuredClone(session.messages);
      prompt = "NEW_POLICY";
      await session.reload();
      session.setSteeringMode("one-at-a-time");
      expect(session.systemPrompt).toContain("NEW_POLICY");
      expect(session.systemPrompt).not.toContain("OLD_POLICY");
      expect(session.systemPrompt).not.toContain("AMBIENT_MUST_NOT_LOAD");
      expect(session.sessionId).toBe(identity);
      expect(session.messages).toEqual(history);
      expect(session.getActiveToolNames()).toEqual(["fixture_read", "read", "bash", "edit", "write", "web_search", "web_fetch"]);
      expect(session.getAllTools().map(({ name }) => name).sort()).toEqual(["bash", "edit", "fixture_read", "read", "web_fetch", "web_search", "write"]);
      expect(session.extensionRunner.getExtensionPaths()).toEqual([]);
      expect(session.steeringMode).toBe("one-at-a-time");
      expect(session.autoCompactionEnabled).toBe(true);
      expect(session.autoRetryEnabled).toBe(false);
    } finally { session.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the pinned Pi SDK automatically compacts in the same Session, with Mochi's provenance-keeping focus", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-compaction-sdk-")));
  try {
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    await runtime.setRuntimeApiKey("openai", "fixture-no-network");
    const model = { ...runtime.getModels("openai")[0]!, contextWindow: 100_000 };
    const manager = SessionManager.inMemory(directory);
    const assistant = (text: string, tokens: number): AssistantMessage => ({
      role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: tokens, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    });
    for (let index = 0; index < 2; index++) {
      manager.appendMessage({ role: "user", content: "old context ".repeat(10_000), timestamp: 1 });
      manager.appendMessage(assistant("old answer", 100));
    }
    const { session } = await createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime: runtime, model, sessionManager: manager,
      settingsManager: isolatedSettings(true),
      resourceLoader: isolatedResourceLoader(() => "fixture"), noTools: "all", tools: [],
    });
    try {
      const identity = session.sessionId;
      const events: string[] = [];
      const summaryPrompts: string[] = [];
      let requests = 0;
      session.agent.streamFunction = (_model, context) => {
        if (requests === 1) summaryPrompts.push(JSON.stringify(context.messages));
        const stream = createAssistantMessageEventStream();
        const message = ++requests === 1 ? assistant("final answer", 95_000) : assistant("summary", 100);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        return stream;
      };
      session.subscribe((event) => {
        if (event.type === "compaction_start") events.push(`start:${event.reason}`);
        if (event.type === "compaction_end") {
          expect(event.result).toBeDefined();
          expect(event.willRetry).toBeFalse();
          events.push(`end:${event.reason}`);
        }
      });
      await session.prompt("current question", { expandPromptTemplates: false });
      events.push("settled");
      expect(events).toEqual(["start:threshold", "end:threshold", "settled"]);
      expect(session.sessionId).toBe(identity);
      expect(session.getLastAssistantText()).toBe("final answer");
      expect(session.getContextUsage()?.tokens).toBeNull();
      expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(7);
      expect(requests).toBe(2);
      // Automatic compaction (patched Pi setting) and manual compaction (worker's
      // compact call) share one focus, so the summary keeps group, topic and speaker.
      expect(summaryPrompts).toHaveLength(1);
      expect(summaryPrompts[0]).toContain(JSON.stringify(`Additional focus: ${SESSION_COMPACTION_INSTRUCTIONS}`).slice(1, -1));
    } finally { session.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cancelling Pi compaction lets an aborted turn settle without replacing its Session or history", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-compaction-abort-sdk-")));
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  await runtime.setRuntimeApiKey("openai", "fixture-no-network");
  const model = { ...runtime.getModels("openai")[0]!, contextWindow: 100_000 };
  const manager = SessionManager.inMemory(directory);
  const assistant: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text: "saved answer" }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 95_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 95_010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
  for (let index = 0; index < 2; index++) {
    manager.appendMessage({ role: "user", content: "old context ".repeat(10_000), timestamp: 1 });
    manager.appendMessage({ ...assistant, usage: { ...assistant.usage, input: 100, totalTokens: 110 } });
  }
  const { session } = await createAgentSession({
    cwd: directory, agentDir: directory, modelRuntime: runtime, model, sessionManager: manager,
    settingsManager: isolatedSettings(true),
    resourceLoader: isolatedResourceLoader(() => "fixture"), noTools: "all", tools: [],
  });
  try {
    const identity = session.sessionId;
    const started = Promise.withResolvers<void>();
    let requests = 0;
    let compactionAborted = false;
    session.agent.streamFunction = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      if (++requests === 1) {
        stream.push({ type: "done", reason: "stop", message: assistant });
        stream.end();
      } else {
        expect(requests).toBe(2);
        expect(options?.signal).toBeDefined();
        options!.signal!.addEventListener("abort", () => {
          stream.push({ type: "error", reason: "aborted", error: { ...assistant, content: [], stopReason: "aborted", errorMessage: "Cancelled compaction" } });
          stream.end();
        }, { once: true });
        started.resolve();
      }
      return stream;
    };
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        expect(event.result).toBeUndefined();
        compactionAborted = event.aborted;
      }
    });
    const prompt = session.prompt("current question", { expandPromptTemplates: false });
    await started.promise;
    session.abortCompaction();
    const abort = session.abort();
    expect(session.isCompacting).toBeTrue();
    await Promise.all([prompt, abort]);
    expect(compactionAborted).toBeTrue();
    expect(session.isStreaming).toBeFalse();
    expect(session.isCompacting).toBeFalse();
    expect(session.sessionId).toBe(identity);
    expect(session.getLastAssistantText()).toBe("saved answer");
    expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
    expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(7);
    expect(requests).toBe(2);
  } finally {
    session.abortCompaction();
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
