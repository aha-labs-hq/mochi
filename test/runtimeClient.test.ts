import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../src/config.ts";
import { PiRuntimeClient, RuntimeTurnNotActiveError, RuntimeTurnTimedOutError } from "../src/runtime/client.ts";
import { RuntimeRequestError } from "../src/runtime/transport.ts";
import { type RuntimeToolSpec } from "../src/runtime/protocol.ts";

const directories: string[] = [];
const SESSION = "session-test";
const ABI = `sha256:${"a".repeat(64)}`;
const TOOL: RuntimeToolSpec = {
  type: "function",
  name: "github_get_issue",
  description: "Read one issue",
  inputSchema: {
    type: "object",
    properties: { number: { type: "integer" } },
    required: ["number"],
    additionalProperties: false,
  },
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Pi runtime client process contract", () => {
  test("a failed policy commit discards the worker and restarts with the durable policy", async () => {
    const fixture = runtimeFixture("policy");
    try {
      await fixture.client.resumeSession();
      await expect(fixture.client.updateTurnPolicy({ model: "mochi-byok/gpt-test", reasoningEffort: "low" }, () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
      await fixture.client.resumeSession();
      const trace = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
      expect(trace.filter((line) => line === "policy.update")).toHaveLength(1);
      expect(trace.filter((line) => line === "model:gpt-test")).toHaveLength(2);
      expect(trace.filter((line) => line === "session.resume")).toHaveLength(2);
    } finally { await fixture.client.close(); }
  });
  test("stops timed-out manual compaction and verifies the original Session before accepting another turn", async () => {
    const fixture = runtimeFixture("manual-timeout");
    try {
      await fixture.client.resumeSession();
      fixture.client.restoreContextUsage({
        sessionId: SESSION, turnId: "previous", usedTokens: 90_000,
        modelContextWindow: 100_000, fractionUsed: 0.9,
      });
      await expect(fixture.client.compactSession()).rejects.toThrow("timed out: session.compact");
      expect(fixture.client.contextUsage()).toBeUndefined();
      const turn = await fixture.client.startTurn(
        { sourceMessageId: "om_after_compaction", text: "new message", images: [] }, async () => [], { cwd: "/tmp" },
      );
      await expect(turn.completed).resolves.toBe("new message completed");
      const trace = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
      expect(trace.filter((line) => line === "session.compact")).toHaveLength(1);
      expect(trace.filter((line) => line === "turn.start")).toHaveLength(1);
      expect(trace.filter((line) => line === "session.resume")).toHaveLength(2);
      expect(trace.indexOf("compaction.cancelled")).toBeLessThan(trace.lastIndexOf("process.start"));
      expect(trace.lastIndexOf("session.resume")).toBeLessThan(trace.indexOf("turn.start"));
    } finally { await fixture.client.close(); }
  });

  test("fails closed if recovery from manual compaction resumes a different Session", async () => {
    const fixture = runtimeFixture("manual-recovery-invalid");
    try {
      await fixture.client.resumeSession();
      await expect(fixture.client.compactSession()).rejects.toThrow("recovery failed after timed-out context organization");
      await expect(fixture.client.startTurn(
        { sourceMessageId: "om_blocked", text: "new message", images: [] }, async () => [], { cwd: "/tmp" },
      )).rejects.toThrow("recovery failed after timed-out context organization");
      const trace = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
      expect(trace.filter((line) => line === "session.resume")).toHaveLength(2);
      expect(trace).not.toContain("turn.start");
      expect(trace).not.toContain("session.create");
    } finally { await fixture.client.close(); }
  });

  for (const failed of [false, true]) test(`a confirmed manual compaction ${failed ? "failure" : "success"} does not restart the worker`, async () => {
    const fixture = runtimeFixture(failed ? "manual-failed" : "manual-completed");
    try {
      await fixture.client.resumeSession();
      if (failed) await expect(fixture.client.compactSession()).rejects.toThrow("provider declined");
      else await expect(fixture.client.compactSession()).resolves.toBeUndefined();
      const trace = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
      expect(trace.filter((line) => line === "process.start")).toHaveLength(1);
      expect(trace.filter((line) => line === "session.compact")).toHaveLength(1);
    } finally { await fixture.client.close(); }
  });

  test("automatic compaction clears usage without completing or replaying the active turn", async () => {
    const fixture = runtimeFixture("compaction");
    const states: boolean[] = [];
    fixture.client.onCompactionChanged(() => states.push(fixture.client.isCompacting()));
    try {
      await fixture.client.resumeSession();
      fixture.client.restoreContextUsage({
        sessionId: SESSION, turnId: "previous", usedTokens: 90_000,
        modelContextWindow: 100_000, fractionUsed: 0.9,
      });
      const turn = await fixture.client.startTurn(
        { sourceMessageId: "om_compact", text: "continue", images: [] }, async () => [], { cwd: "/tmp" },
      );
      await expect(turn.completed).resolves.toBe("finished after compaction");
      expect(fixture.client.contextUsage()).toBeUndefined();
      expect(states).toEqual([true, false]);
      const trace = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
      expect(trace.filter((line) => line === "turn.start")).toHaveLength(1);
      expect(trace.filter((line) => line === "session.resume")).toHaveLength(1);
    } finally { await fixture.client.close(); }
  });
  for (const scenario of ["compaction-failed", "compaction-aborted", "compaction-exited", "compaction-recovery"]) {
    test(`${scenario} clears visible compaction without replaying the turn`, async () => {
      const fixture = runtimeFixture(scenario, scenario === "compaction-recovery" ? 20 : 1_000, 20);
      const states: boolean[] = [];
      fixture.client.onCompactionChanged(() => states.push(fixture.client.isCompacting()));
      try {
        const turn = await fixture.client.startTurn(
          { sourceMessageId: "om_compact", text: "continue", images: [] }, async () => [], { cwd: "/tmp" },
        );
        await expect(turn.completed).rejects.toThrow();
        expect(states).toEqual([true, false]);
        expect(fixture.client.isCompacting()).toBeFalse();
        const trace = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
        expect(trace.filter((line) => line === "turn.start")).toHaveLength(1);
        expect(trace.filter((line) => line === "session.resume")).toHaveLength(scenario === "compaction-recovery" ? 2 : 1);
      } finally { await fixture.client.close(); }
    });
  }

  for (const scenario of ["compaction-wrong-session", "compaction-invalid-state"]) {
    test(`${scenario} fails closed before publishing a compaction state`, async () => {
      const fixture = runtimeFixture(scenario);
      const states: boolean[] = [];
      fixture.client.onCompactionChanged(() => states.push(fixture.client.isCompacting()));
      try {
        const turn = await fixture.client.startTurn(
          { sourceMessageId: "om_invalid", text: "continue", images: [] }, async () => [], { cwd: "/tmp" },
        );
        await expect(turn.completed).rejects.toThrow("invalid Session compaction state");
        expect(states).toEqual([]);
      } finally { await fixture.client.close(); }
    });
  }
  test("samples new instructions only for a fresh turn, without replacing the worker or Session", async () => {
    let prompt = "first instructions";
    const fixture = runtimeFixture("instructions", 1_000, 100, () => prompt);
    try {
      await fixture.client.resumeSession();
      for (const next of ["first instructions", "all colleagues can understand this"]) {
        prompt = next;
        const turn = await fixture.client.startTurn({ sourceMessageId: "om_policy", text: "test", images: [] }, async () => [], { cwd: "/tmp" });
        await expect(turn.completed).resolves.toBe(next);
      }
      const trace = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
      expect(trace.filter((line) => line === "process.start")).toHaveLength(1);
      expect(trace.filter((line) => line === "session.resume")).toHaveLength(1);
    } finally { await fixture.client.close(); }
  });
  test("binds each relayed tool call to the worker's exact Feishu source", async () => {
    const fixture = runtimeFixture("tool");
    const client = fixture.client;
    const observed: unknown[] = [];
    try {
      await client.resumeSession();
      const turn = await client.startTurn({
        sourceMessageId: "om_exact",
        text: "hello",
        images: [],
      }, async (sourceMessageId, name, args) => {
        observed.push({ sourceMessageId, name, args });
        return [{ type: "text", text: "{}" }];
      }, { cwd: "/tmp" });
      await expect(turn.completed).resolves.toBe("finished");
      expect(observed).toEqual([{
        sourceMessageId: "om_exact",
        name: "github_get_issue",
        args: { number: 17 },
      }]);
    } finally {
      await client.close();
    }
  });

  test("classifies steering refusals by the worker's error code, never by its message", async () => {
    const fixture = runtimeFixture("steer");
    try {
      await fixture.client.resumeSession();
      const turn = await fixture.client.startTurn({ sourceMessageId: "om_first", text: "hold", images: [] }, async () => [], { cwd: "/tmp" });
      await expect(fixture.client.steerTurn(turn.turnId, { sourceMessageId: "om_late", text: "inactive", images: [] }))
        .rejects.toBeInstanceOf(RuntimeTurnNotActiveError);
      // A provider message that merely quotes the code is a different failure.
      const quoted = fixture.client.steerTurn(turn.turnId, { sourceMessageId: "om_quote", text: "quote", images: [] });
      await expect(quoted).rejects.toBeInstanceOf(RuntimeRequestError);
      await expect(quoted).rejects.not.toBeInstanceOf(RuntimeTurnNotActiveError);
    } finally {
      await fixture.client.close();
    }
  });

  test("settles a timed-out turn only from the worker terminal event", async () => {
    const fixture = runtimeFixture("timeout-terminal", 20, 100);
    try {
      await fixture.client.resumeSession();
      const turn = await fixture.client.startTurn(
        { sourceMessageId: "om_timeout", text: "wait", images: [] },
        async () => [],
        { cwd: "/tmp" },
      );
      await expect(turn.completed).rejects.toBeInstanceOf(RuntimeTurnTimedOutError);
      expect(readFileSync(fixture.tracePath, "utf8")).toContain("turn.abort");
    } finally {
      await fixture.client.close();
    }
  });

  test("reopens and resumes the same Session before releasing a missing terminal", async () => {
    const fixture = runtimeFixture("timeout-recovery", 20, 20);
    try {
      await fixture.client.resumeSession();
      const turn = await fixture.client.startTurn(
        { sourceMessageId: "om_recover", text: "wait", images: [] },
        async () => [],
        { cwd: "/tmp" },
      );
      await expect(turn.completed).rejects.toBeInstanceOf(RuntimeTurnTimedOutError);
      const trace = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
      expect(trace.filter((line) => line === "process.start")).toHaveLength(2);
      expect(trace.filter((line) => line === "session.resume")).toHaveLength(2);
    } finally {
      await fixture.client.close();
    }
  });
});

function runtimeFixture(
  scenario: string,
  turnTimeoutMilliseconds = 1_000,
  interruptGraceMilliseconds = 100,
  systemPrompt: string | (() => string) = "test",
): { client: PiRuntimeClient; tracePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "mochi-runtime-client-"));
  directories.push(directory);
  const launcher = join(directory, "fake-launcher.ts");
  const tracePath = join(directory, "trace.log");
  writeFileSync(launcher, `#!${process.execPath}\n${CLIENT_WORKER}\n`, { mode: 0o700 });
  chmodSync(launcher, 0o700);
  const config: RuntimeConfig & { sessionId: string } = {
    botId: "11111111-2222-4333-8444-555555555555",
    workerPath: `${scenario}|${tracePath}`,
    sudoPath: launcher,
    runtimeUser: "runtime-test",
    runtimeHome: "/tmp/runtime-test",
    runtimeCwd: "/tmp/runtime-test-cwd",
    model: "gpt-test",
    reasoningEffort: "high",
    turnTimeoutMilliseconds,
    sessionId: SESSION,
  };
  return {
    tracePath,
    client: new PiRuntimeClient({
      config,
      tools: [TOOL],
      capabilityAbi: ABI,
      systemPrompt,
      client: { interruptGraceMilliseconds, contextOrganizationTimeoutMilliseconds: 50 },
    }),
  };
}

const CLIENT_WORKER = String.raw`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [scenario, tracePath] = process.argv.at(-1).split("|");
const recovering = existsSync(tracePath) && readFileSync(tracePath, "utf8").includes("session.compact");
appendFileSync(tracePath, "process.start\n");
let initialization;
let activeTurn;
let compacting = false;
function trace(value) { appendFileSync(tracePath, value + "\n"); }
process.on("SIGTERM", () => {
  if (compacting) trace("compaction.cancelled");
  process.exit(0);
});
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function compaction(active) {
  compacting = active;
  send({ version: 11, type: "event", event: "context.compaction", params: { sessionId: initialization.sessionId, active } });
}
function respond(request, result) {
  send({ version: 11, type: "response", id: request.id, ok: true, result });
}
async function* lines() {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
}
for await (const line of lines()) {
  const message = JSON.parse(line);
  if (message.type === "response" && message.id === "worker-tool") {
    if (!message.ok) process.exit(5);
    send({ version: 11, type: "event", event: "turn.completed", params: {
      turnId: activeTurn.turnId, status: "completed", text: "finished",
    }});
    continue;
  }
  if (message.type !== "request") continue;
  trace(message.method);
  if (message.method === "runtime.initialize") {
    initialization = message.params;
    if (scenario === "policy") trace("model:" + initialization.model);
    respond(message, { protocolVersion: 11 });
  } else if (message.method === "policy.update") {
    respond(message, {});
  } else if (message.method === "session.resume") {
    if (initialization.sessionId !== "session-test") process.exit(6);
    respond(message, {
      sessionId: recovering && scenario === "manual-recovery-invalid" ? "wrong-session" : initialization.sessionId,
      capabilityAbi: initialization.capabilityAbi,
    });
  } else if (message.method === "session.compact") {
    compaction(true);
    if (scenario === "manual-completed" || scenario === "manual-failed") compaction(false);
    if (scenario === "manual-completed") respond(message, {});
    else if (scenario === "manual-failed") send({ version: 11, type: "response", id: message.id, ok: false,
      error: { code: "provider_error", message: "provider declined" },
    });
    else compacting = true;
  } else if (message.method === "turn.start") {
    if (compacting) {
      send({ version: 11, type: "response", id: message.id, ok: false,
        error: { code: "invalid_request", message: "Runtime already has active work" },
      });
      continue;
    }
    activeTurn = { turnId: "turn-1", sourceMessageId: message.params.sourceMessageId };
    respond(message, { turnId: activeTurn.turnId });
    if (scenario === "manual-timeout") {
      send({ version: 11, type: "event", event: "turn.completed", params: {
        turnId: activeTurn.turnId, status: "completed", text: "new message completed",
      }});
    }
    if (scenario === "compaction") {
      compaction(true);
      send({ version: 11, type: "event", event: "context.compacted", params: { sessionId: initialization.sessionId }});
      compaction(false);
      send({ version: 11, type: "event", event: "turn.completed", params: {
        turnId: activeTurn.turnId, status: "completed", text: "finished after compaction",
      }});
    }
    if (["compaction-failed", "compaction-aborted", "compaction-exited", "compaction-recovery"].includes(scenario)) {
      compaction(true);
      if (scenario === "compaction-exited") process.exit(7);
      if (scenario !== "compaction-recovery") {
        compaction(false);
        send({ version: 11, type: "event", event: "turn.completed", params: {
          turnId: activeTurn.turnId, status: scenario === "compaction-aborted" ? "interrupted" : "failed", error: "compaction did not finish",
        }});
      }
    }
    if (scenario === "compaction-wrong-session" || scenario === "compaction-invalid-state") {
      send({ version: 11, type: "event", event: "context.compaction", params: {
        sessionId: scenario === "compaction-wrong-session" ? "foreign-session" : initialization.sessionId,
        active: scenario === "compaction-invalid-state" ? "true" : true,
      }});
    }
    if (scenario === "instructions") {
      send({ version: 11, type: "event", event: "turn.completed", params: {
        turnId: activeTurn.turnId, status: "completed", text: message.params.systemPrompt,
      }});
    }
    if (scenario === "tool") {
      send({ version: 11, type: "request", id: "worker-tool", method: "tool.execute", params: {
        turnId: activeTurn.turnId,
        toolCallId: "call-1",
        sourceMessageId: activeTurn.sourceMessageId,
        name: "github_get_issue",
        arguments: { number: 17 },
      }});
    }
  } else if (message.method === "turn.steer") {
    send({ version: 11, type: "response", id: message.id, ok: false, error: message.params.text === "inactive"
      ? { code: "turn_not_active", message: "No matching active turn" }
      : { code: "provider_error", message: "upstream said [turn_not_active]" } });
  } else if (message.method === "turn.abort") {
    respond(message, {});
    if (scenario === "timeout-terminal") {
      send({ version: 11, type: "event", event: "turn.completed", params: {
        turnId: activeTurn.turnId, status: "interrupted", error: "aborted",
      }});
    }
  } else if (message.method === "runtime.shutdown") {
    respond(message, {});
    setTimeout(() => process.exit(0), 0);
  }
}
`;
