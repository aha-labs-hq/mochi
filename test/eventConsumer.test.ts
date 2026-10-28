import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLarkStderrLine, LarkEventConsumer } from "../src/lark/eventConsumer.ts";
import { log, memoryLogSink, setLogSink } from "../src/log.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Lark event consumer", () => {
  test("consumer lifetime includes the detached bus shutdown, even after its subscription exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-event-shutdown-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
import {existsSync, writeFileSync} from "node:fs";
if (process.argv.includes("stop")) {
  if (existsSync("subscribed")) {
    writeFileSync("stopping-bus", "");
    while (!existsSync("allow-bus-exit")) await Bun.sleep(5);
    writeFileSync("bus-stopped", "");
  }
  process.exit(0);
}
writeFileSync("subscribed", "");
process.stderr.write("[source] feishu-websocket: connected\\n[event] ready event_key=im.message.receive_v1\\n");
process.stdout.write("{}\\n");
await new Promise(() => undefined);
`, { mode: 0o700 });
    const consumer = new LarkEventConsumer({ cliPath: executable, profile: "fixture", configDirectory: directory }, log);
    let complete = false;
    const consuming = consumer.consume(async () => consumer.stop()).then(() => { complete = true; });
    try {
      const deadline = Date.now() + 2_000;
      while (!(await Bun.file(join(directory, "stopping-bus")).exists()) && Date.now() < deadline) await Bun.sleep(5);
      expect(await Bun.file(join(directory, "stopping-bus")).exists()).toBe(true);
      expect(complete).toBe(false);
    } finally {
      writeFileSync(join(directory, "allow-bus-exit"), "");
      consumer.stop();
      await consuming;
    }
    expect(await Bun.file(join(directory, "bus-stopped")).exists()).toBe(true);
    expect(complete).toBe(true);
  });
  test("rapid restarts retire only the idle private bus before requiring a fresh connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "mochi-event-restart-"));
    directories.push(root);
    const directory = realpathSync(root);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(join(directory, "idle-bus"), "old connection");
    writeFileSync(executable, `#!${process.execPath}
import {appendFileSync, existsSync, rmSync, writeFileSync} from "node:fs";
appendFileSync("calls", JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),config:process.env.LARKSUITE_CLI_CONFIG_DIR})+"\\n");
if (process.argv.includes("stop")) {
  if (process.argv.includes("--force") || process.argv.includes("--all")) process.exit(99);
  if (existsSync("idle-bus")) rmSync("idle-bus");
  process.exit(0);
}
if (!existsSync("idle-bus")) process.stderr.write("[source] feishu-websocket: connected\\n");
writeFileSync("idle-bus", "connected, no status replay");
process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
process.stdout.write("{}\\n");
await new Promise(() => undefined);
`, { mode: 0o700 });
    let ready = 0;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const consumer = new LarkEventConsumer({ cliPath: executable, profile: "fixture", configDirectory: directory }, log);
      await consumer.consume(async () => consumer.stop(), { ready: () => ready += 1, unavailable: () => undefined });
    }
    expect(ready).toBe(2);
    const calls = readFileSync(join(directory, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.map((call) => call.args[3])).toEqual(["stop", "consume", "stop", "stop", "consume", "stop"]);
    expect(() => readFileSync(join(directory, "idle-bus"))).toThrow();
    expect(calls.every((call) => call.cwd === directory && call.config === ".")).toBeTrue();
  });

  test("a busy private bus refuses startup without forcing or interrupting its consumers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-event-busy-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop") && !process.argv.includes("--force")) process.exit(2);
process.exit(99);
`, { mode: 0o700 });
    const consumer = new LarkEventConsumer({ cliPath: executable, profile: "fixture", configDirectory: directory }, log);
    await expect(consumer.consume(async () => undefined)).rejects.toThrow("exit=2");
  });

  test("a long private HOME uses the same files through a short relative daemon socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "mochi-event-path-"));
    directories.push(root);
    const directory = join(realpathSync(root), "Library/Application Support/猫咪 Mochi/Development/Connections/feishu/852a8566-2909-49bb-a86d-e0351f0ea0f3");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    expect(Buffer.byteLength(join(directory, "events/cli_fixture/bus.sock"))).toBeGreaterThan(104);
    const daemon = join(root, "daemon.ts");
    writeFileSync(daemon, `
import {mkdirSync} from "node:fs";
import {join} from "node:path";
import {createServer} from "node:net";
const socket = join(process.env.LARKSUITE_CLI_CONFIG_DIR!, "events/cli_fixture/bus.sock");
mkdirSync("events/cli_fixture", {recursive:true,mode:0o700});
const server = createServer();
await new Promise<void>((resolve,reject) => {server.once("error",reject);server.listen(socket,resolve);});
process.stderr.write("[source] feishu-websocket: connected\\n[event] ready event_key=im.message.receive_v1\\n");
console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,config:process.env.LARKSUITE_CLI_CONFIG_DIR,socket}));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, { mode: 0o600 });
    const executable = join(root, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop")) process.exit(0);
const daemon = Bun.spawn([process.execPath, ${JSON.stringify(daemon)}], {stdin:"ignore",stdout:"inherit",stderr:"inherit"});
process.on("SIGTERM", () => daemon.kill("SIGTERM"));
process.exit(await daemon.exited);
`, { mode: 0o700 });
    const consumer = new LarkEventConsumer({ cliPath: executable, profile: "fixture", configDirectory: directory }, log);
    let event: unknown;
    await consumer.consume(async (value) => { event = value; consumer.stop(); });
    expect(event).toEqual({ cwd: directory, home: directory, config: ".", socket: "events/cli_fixture/bus.sock" });
  });
  test("a subscription without a connected socket never proves readiness, and shutdown escalates when TERM is ignored", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-event-proof-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop")) process.exit(0);
process.on("SIGTERM", () => undefined);
process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
process.stdout.write("{}\\n");
await new Promise(() => undefined);
`, { mode: 0o700 });
    let ready = false;
    const consumer = new LarkEventConsumer({ cliPath: executable, profile: "fixture", configDirectory: directory }, log);
    await consumer.consume(async () => { consumer.stop(); }, {
      ready: () => { ready = true; }, unavailable: () => undefined,
    });
    expect(ready).toBe(false);
  });
  test("keeps reading events while an earlier handler is still active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-fake-lark-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop")) process.exit(0);
process.stderr.write("[source] feishu-websocket: connected\\n");
process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
process.stdout.write(JSON.stringify({ message_id: "om_first" }) + "\\n");
process.stdout.write(JSON.stringify({ message_id: "om_second" }) + "\\n");
await new Promise(() => undefined);
`, { mode: 0o700 });
    chmodSync(executable, 0o700);

    let releaseFirst!: () => void;
    const secondArrived = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handled: string[] = [];
    let readyCount = 0;
    const consumer = new LarkEventConsumer({ cliPath: executable, profile: "profile", configDirectory: directory }, log);
    const consuming = consumer.consume(async (value) => {
      const messageId = (value as { message_id: string }).message_id;
      handled.push(messageId);
      if (messageId === "om_first") await secondArrived;
      else releaseFirst();
    }, {
      ready: () => readyCount += 1,
      unavailable: () => undefined,
    });

    await secondArrived;
    consumer.stop();
    await consuming;

    expect(handled).toEqual(["om_first", "om_second"]);
    expect(readyCount).toBe(1);
  });

  test("fails closed when the event process exits successfully after readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-fake-lark-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop")) process.exit(0);
process.stderr.write("[source] feishu-websocket: connected\\n");
process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
`, { mode: 0o700 });
    chmodSync(executable, 0o700);

    const consumer = new LarkEventConsumer({ cliPath: executable, profile: "profile", configDirectory: directory }, log);
    await expect(consumer.consume(async () => undefined)).rejects.toThrow(
      /closed unexpectedly|exited unexpectedly/,
    );
  });

  test("does not publish readiness when the readiness observer fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-fake-lark-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop")) process.exit(0);
process.stderr.write("[source] feishu-websocket: connected\\n");
process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
await new Promise(() => undefined);
`, { mode: 0o700 });
    chmodSync(executable, 0o700);

    const consumer = new LarkEventConsumer({ cliPath: executable, profile: "profile", configDirectory: directory }, log);
    await expect(consumer.consume(async () => undefined, {
      ready: () => { throw new Error("status write failed"); },
      unavailable: () => undefined,
    })).rejects.toThrow("status write failed");
  });

  test("projects disconnect and reconnect diagnostics into stream health", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-fake-lark-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop")) process.exit(0);
process.stderr.write("[source] feishu-websocket: connected\\n");
process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
process.stderr.write("[source] feishu-websocket: disconnected\\n");
process.stderr.write("[source] feishu-websocket: connected\\n");
await new Promise(() => undefined);
`, { mode: 0o700 });
    chmodSync(executable, 0o700);

    const consumer = new LarkEventConsumer({ cliPath: executable, profile: "profile", configDirectory: directory }, log);
    let readyCount = 0;
    let unavailableCount = 0;
    await consumer.consume(async () => undefined, {
      ready: () => {
        readyCount += 1;
        if (readyCount === 2) consumer.stop();
      },
      unavailable: () => unavailableCount += 1,
    });
    expect(readyCount).toBe(2);
    expect(unavailableCount).toBe(1);
  });

  test("disconnects carry a reason code and the Bot that lost its stream", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-fake-lark-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop")) process.exit(0);
process.stderr.write("[source] feishu-websocket: connected\\n[event] ready event_key=im.message.receive_v1\\n");
process.stderr.write("[source] feishu-websocket: reconnecting (network)\\n[source] feishu-websocket: connected\\n");
await new Promise(() => undefined);
`, { mode: 0o700 });
    const sink = memoryLogSink();
    const previous = setLogSink(sink);
    try {
      const consumer = new LarkEventConsumer({ cliPath: executable, profile: "profile", configDirectory: directory }, log.with({ botId: "bot-a" }));
      let ready = 0;
      await consumer.consume(async () => undefined, {
        ready: () => { ready += 1; if (ready === 2) consumer.stop(); },
        unavailable: () => undefined,
      });
    } finally { setLogSink(previous); }
    const lark = sink.records.filter((record) => record.event.startsWith("lark."));
    expect(lark.length).toBeGreaterThan(0);
    expect(lark.every((record) => record.botId === "bot-a")).toBeTrue();
    expect(sink.records.find((record) => record.event === "lark.event.connection_unavailable"))
      .toMatchObject({ level: "warn", reason: "reconnecting", subscriptionReady: true });
  });

  test("stderr outside the known vocabulary is counted and warned about, without its text", async () => {
    expect(classifyLarkStderrLine("[event] consuming as bot (cli_x)")).toEqual({ kind: "progress" });
    expect(classifyLarkStderrLine("[source] feishu-websocket: disconnected (eof)")).toEqual({ kind: "unavailable", reason: "disconnected" });
    // An upstream rewording of the status line is exactly the drift to surface.
    expect(classifyLarkStderrLine("[source] feishu-ws: lost")).toEqual({ kind: "unrecognized" });
    const directory = mkdtempSync(join(tmpdir(), "mochi-fake-lark-"));
    directories.push(directory);
    const executable = join(directory, "fake-lark.ts");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes("stop")) process.exit(0);
process.stderr.write("[event] consuming as bot\\n[source] feishu-websocket: connected\\n[event] ready event_key=im.message.receive_v1\\n");
for (let index = 0; index < 5; index += 1) process.stderr.write("[source] feishu-ws: lost private-chat-text\\n");
process.stdout.write("{}\\n");
await new Promise(() => undefined);
`, { mode: 0o700 });
    const sink = memoryLogSink();
    const previous = setLogSink(sink);
    try {
      const consumer = new LarkEventConsumer({ cliPath: executable, profile: "profile", configDirectory: directory }, log.with({ botId: "bot-a" }));
      await consumer.consume(async () => {
        const deadline = Date.now() + 2_000;
        while (sink.records.filter((record) => record.event === "lark.event.stderr_unrecognized").length < 3 && Date.now() < deadline) await Bun.sleep(5);
        consumer.stop();
      });
    } finally { setLogSink(previous); }
    const warnings = sink.records.filter((record) => record.event === "lark.event.stderr_unrecognized");
    expect(warnings.map((record) => [record.level, record.count])).toEqual([["warn", 1], ["warn", 2], ["warn", 4]]);
    expect(JSON.stringify(sink.records)).not.toContain("private-chat-text");
    expect(sink.records.some((record) => record.event === "lark.event.provider_diagnostic")).toBeFalse();
  });
});
