import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryLogSink, setLogSink } from "../src/log.ts";
import { RuntimeTransport, workerStderrRecord } from "../src/runtime/transport.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Pi runtime JSONL transport", () => {
  test("relays responses, events, and worker requests over one exact channel", async () => {
    const events: { event: string; params: unknown }[] = [];
    const requests: { method: string; params: unknown }[] = [];
    const transport = new RuntimeTransport({
      command: [fakeWorker(ROUNDTRIP_WORKER)],
      environment: {},
      onEvent: (event, params) => events.push({ event, params }),
      onRequest: async (method, params) => {
        requests.push({ method, params });
        return { ok: true, result: { accepted: true } };
      },
      onFatal: () => undefined,
      onExit: () => undefined,
    });
    transport.start();
    try {
      await expect(transport.request("roundtrip", { value: 1 })).resolves.toEqual({ complete: true });
      expect(events).toEqual([{ event: "worker.ready", params: { sequence: 1 } }]);
      expect(requests).toEqual([{ method: "tool.execute", params: { name: "github_get_issue" } }]);
    } finally {
      await transport.stop(new Error("test complete"));
    }
  });

  test("worker stderr reaches the log only as identifiers, sizes and error class names", async () => {
    expect(workerStderrRecord(JSON.stringify({
      event: "runtime.local_tool.completed", sessionId: "s-1", turnId: "t-1", toolName: "bash", isError: false,
      sourceMessageId: "om_1", command: "cat secret.txt",
    }))).toEqual({ level: "info", event: "runtime.local_tool.completed", fields: {
      sessionId: "s-1", turnId: "t-1", toolName: "bash", isError: false, sourceMessageId: "om_1",
    } });
    expect(workerStderrRecord("TypeError: cannot read 'quarterly plan' of undefined")).toEqual({
      level: "warn", event: "runtime.worker.stderr", fields: { bytes: 52, errorName: "TypeError" },
    });
    expect(workerStderrRecord("    at summarize (worker.ts:12:3)")).toBeNull();
    expect(workerStderrRecord(JSON.stringify({ event: "bot.fatal", errorMessage: "forged" })))
      .toMatchObject({ event: "runtime.worker.stderr", fields: { bytes: expect.any(Number) } });

    const sink = memoryLogSink();
    const previous = setLogSink(sink);
    const transport = new RuntimeTransport({
      command: [fakeWorker('process.stderr.write("Error: customer said hello\\n    at main (x.ts:1:1)\\n"); for await (const _line of lines()) {}')],
      environment: {},
      onEvent: () => undefined,
      onRequest: async () => ({ ok: false, error: { code: "unexpected", message: "unexpected" } }),
      onFatal: () => undefined,
      onExit: () => undefined,
    });
    try {
      transport.start();
      const deadline = Date.now() + 2_000;
      while (!sink.records.some((record) => record.event === "runtime.worker.stderr") && Date.now() < deadline) await Bun.sleep(5);
    } finally {
      await transport.stop(new Error("test complete"));
      setLogSink(previous);
    }
    const stderr = sink.records.filter((record) => record.event === "runtime.worker.stderr");
    expect(stderr).toEqual([expect.objectContaining({ level: "warn", errorName: "Error", bytes: 26 })]);
    expect(JSON.stringify(sink.records)).not.toContain("hello");
  });

  test("fails the channel and every pending request on malformed protocol", async () => {
    let fatal: Error | undefined;
    const transport = new RuntimeTransport({
      command: [fakeWorker('for await (const _line of lines()) { process.stdout.write("not-json\\n"); }')],
      environment: {},
      onEvent: () => undefined,
      onRequest: async () => ({ ok: false, error: { code: "unexpected", message: "unexpected" } }),
      onFatal: (error) => { fatal = error; },
      onExit: () => undefined,
    });
    transport.start();
    await expect(transport.request("malformed", {})).rejects.toThrow();
    await transport.exited;
    expect(fatal?.message).toContain("JSON");
  });

  test("bounds a silent request and rejects a request when the worker exits", async () => {
    const silent = new RuntimeTransport({
      command: [fakeWorker("for await (const _line of lines()) {}")],
      environment: {},
      onEvent: () => undefined,
      onRequest: async () => ({ ok: false, error: { code: "unexpected", message: "unexpected" } }),
      onFatal: () => undefined,
      onExit: () => undefined,
    });
    silent.start();
    await expect(silent.request("silent", {}, 20)).rejects.toThrow("timed out: silent");
    await silent.stop(new Error("test complete"));

    const exiting = new RuntimeTransport({
      command: [fakeWorker("for await (const _line of lines()) process.exit(7);")],
      environment: {},
      onEvent: () => undefined,
      onRequest: async () => ({ ok: false, error: { code: "unexpected", message: "unexpected" } }),
      onFatal: () => undefined,
      onExit: () => undefined,
    });
    exiting.start();
    await expect(exiting.request("exit", {})).rejects.toThrow("exited with code 7");
    await exiting.exited;
  });
});

const ROUNDTRIP_WORKER = `
let bridgeRequest;
for await (const line of lines()) {
  const message = JSON.parse(line);
  if (message.type === "request" && message.method === "roundtrip") {
    bridgeRequest = message;
    send({ version: 11, type: "event", event: "worker.ready", params: { sequence: 1 } });
    send({ version: 11, type: "request", id: "worker-1", method: "tool.execute", params: { name: "github_get_issue" } });
  } else if (message.type === "response" && message.id === "worker-1") {
    if (!message.ok || message.result.accepted !== true) process.exit(4);
    send({ version: 11, type: "response", id: bridgeRequest.id, ok: true, result: { complete: true } });
  }
}
`;

function fakeWorker(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "mochi-runtime-transport-"));
  directories.push(directory);
  const path = join(directory, "worker.ts");
  writeFileSync(path, `#!${process.execPath}\n${WORKER_PREAMBLE}\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

const WORKER_PREAMBLE = `
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
async function* lines() {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline = buffer.indexOf("\\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\\n");
    }
  }
}
`;
