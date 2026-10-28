import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileLogSink,
  log,
  logSinkFromEnvironment,
  memoryLogSink,
  setLogSink,
  STRUCTURED_LOG_PATH_ENVIRONMENT_KEY,
} from "../src/log.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryLog(): string {
  const directory = mkdtempSync(join(tmpdir(), "mochi-log-"));
  directories.push(directory);
  return join(directory, "private", "service.jsonl");
}

function capture(run: () => void): ReturnType<typeof memoryLogSink>["records"] {
  const sink = memoryLogSink();
  const previous = setLogSink(sink);
  try { run(); } finally { setLogSink(previous); }
  return sink.records;
}

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("structured log", () => {
  test("caller fields cannot forge the event, level or timestamp, and bound fields always apply", () => {
    const records = capture(() => {
      log.with({ botId: "bot-a" }).warn("lark.event.connection_unavailable", {
        botId: "forged", event: "forged.event", level: "info", timestamp: "forged", reason: "disconnected",
      });
    });
    expect(records).toEqual([expect.objectContaining({
      botId: "bot-a", event: "lark.event.connection_unavailable", level: "warn", reason: "disconnected",
    })]);
    expect(Date.parse(records[0]!.timestamp)).toBeFinite();
  });

  test("the LaunchAgent's path selects one owner-private file", () => {
    const path = temporaryLog();
    const previous = setLogSink(logSinkFromEnvironment({ [STRUCTURED_LOG_PATH_ENVIRONMENT_KEY]: path }));
    try { log.info("test.structured_log", { stableId: "one" }); } finally { setLogSink(previous); }
    expect(lines(path)).toEqual([expect.objectContaining({ level: "info", event: "test.structured_log", stableId: "one" })]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  test("keeps two bounded generations and restarts each generation with the run marker", () => {
    const path = temporaryLog();
    const write = fileLogSink(path, { runMarker: "bot.starting", maximumBytes: 512 });
    const previous = setLogSink(write);
    try {
      log.info("bot.starting", { botId: "bot-a" });
      for (let index = 0; index < 20; index += 1) log.info("bot.event.completed", { index });
    } finally { setLogSink(previous); }
    for (const generation of [path, `${path}.1`, `${path}.2`]) {
      expect(statSync(generation).size).toBeLessThanOrEqual(512);
      expect(lines(generation)[0]?.event).toBe("bot.starting");
    }
    expect(lines(path).at(-1)).toMatchObject({ event: "bot.event.completed", index: 19 });
    expect(() => statSync(`${path}.3`)).toThrow();
  });

  test("refuses to write through a symlink or an oversized record", () => {
    const path = temporaryLog();
    const write = fileLogSink(path);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const previous = setLogSink(write);
    try {
      log.info("first");
      const target = `${path}.target`;
      writeFileSync(target, "");
      rmSync(path);
      symlinkSync(target, path);
      // The sink refuses; the caller's work goes on.
      expect(() => log.info("redirected")).not.toThrow();
      expect(readFileSync(target, "utf8")).toBe("");
      expect(stderr).toHaveBeenCalledTimes(1);
      rmSync(path);
      log.info("after");
    } finally { setLogSink(previous); stderr.mockRestore(); }
    expect(lines(path)).toEqual([
      expect.objectContaining({ event: "log.records_dropped", count: 1 }),
      expect.objectContaining({ event: "after" }),
    ]);
    const small = fileLogSink(temporaryLog(), { maximumBytes: 64 });
    expect(() => small({ timestamp: "t", level: "info", event: "x".repeat(80) })).toThrow("bounded");
  });

  test("rotation keeps the marker even when an outside write filled the file", () => {
    const path = temporaryLog();
    const previous = setLogSink(fileLogSink(path, { runMarker: "bot.starting", maximumBytes: 4_096 }));
    try {
      log.info("bot.starting", { runtimeModel: "test-model" });
      appendFileSync(path, "x".repeat(4_096));
      log.info("lark.event.connection_ready");
    } finally { setLogSink(previous); }
    expect(lines(path).map(({ event }) => event)).toEqual(["bot.starting", "lark.event.connection_ready"]);
    expect(readFileSync(`${path}.1`, "utf8")).toContain('"event":"bot.starting"');
  });

  test("a failing sink never reaches the caller and its gap is reported once writing resumes", () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const sink = memoryLogSink();
    let full = true;
    const previous = setLogSink((record) => {
      if (full) throw new Error("ENOSPC: no space left on device, write");
      sink(record);
    });
    try {
      expect(() => {
        log.info("bot.event.completed", { messageId: "om_answered" });
        log.warn("bot.reaction.delete_failed", { messageId: "om_answered" });
      }).not.toThrow();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toMatchObject({
        level: "error", event: "log.write_failed", droppedEvent: "bot.event.completed", errorMessage: expect.stringContaining("ENOSPC"),
      });
      full = false;
      log.info("bot.event.completed", { messageId: "om_next" });
    } finally { setLogSink(previous); stderr.mockRestore(); }
    expect(sink.records).toEqual([
      expect.objectContaining({ level: "error", event: "log.records_dropped", count: 2 }),
      expect.objectContaining({ event: "bot.event.completed", messageId: "om_next" }),
    ]);
  });

  test("memory sink keeps only the newest records", () => {
    const sink = memoryLogSink(2);
    for (const event of ["one", "two", "three"]) sink({ timestamp: "t", level: "info", event });
    expect(sink.records.map(({ event }) => event)).toEqual(["two", "three"]);
  });
});
