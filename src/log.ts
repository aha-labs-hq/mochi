import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * The one structured logger for the Bridge and the companion App.
 *
 * A record is `{ ...fields, timestamp, level, event }`: the reserved keys are
 * written last, so caller fields can never forge an event or a level. Where a
 * record goes is a process decision (a private file, the console, or memory in
 * tests), made once through `setLogSink`; call sites only name the event.
 */
export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export interface LogRecord extends LogFields {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
}
export type LogSink = (record: LogRecord) => void;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger whose records always carry these fields, such as a Bot's `botId`. */
  with(fields: LogFields): Logger;
}

export const STRUCTURED_LOG_PATH_ENVIRONMENT_KEY = "MOCHI_STRUCTURED_LOG_PATH";
/** Every structured log file keeps at most this many bytes per generation. */
export const MAXIMUM_LOG_BYTES = 5 * 1_024 * 1_024;
/** The live file plus two rotated generations. */
const LOG_GENERATIONS = 3;

let activeSink: LogSink | undefined;

/** Replaces where this process writes records; returns the previous sink. */
export function setLogSink(sink: LogSink): LogSink {
  const previous = currentSink();
  activeSink = sink;
  return previous;
}

function currentSink(): LogSink {
  activeSink ??= logSinkFromEnvironment(process.env);
  return activeSink;
}

/** The Bridge's LaunchAgent names its private file; without it, records go to the console. */
export function logSinkFromEnvironment(environment: Readonly<Record<string, string | undefined>>): LogSink {
  const path = environment[STRUCTURED_LOG_PATH_ENVIRONMENT_KEY];
  return path ? fileLogSink(path, { runMarker: "bot.starting" }) : consoleLogSink;
}

export const consoleLogSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else console.log(line);
};

/** Keeps the most recent records in memory. Tests install one instead of printing. */
export function memoryLogSink(capacity = 1_000): LogSink & { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const sink = (record: LogRecord) => {
    records.push(record);
    if (records.length > capacity) records.splice(0, records.length - capacity);
  };
  return Object.assign(sink, { records });
}

/**
 * An owner-private JSONL file with bounded rotation.
 *
 * The directory is 700 and the file 600, single-link and owned by this user; a
 * symlink or a foreign file fails closed instead of being written through. When
 * a record would exceed the bound the file rotates to `.1` and `.2`, and the new
 * generation starts with the last run marker, so every file says which run wrote it.
 */
export function fileLogSink(
  path: string,
  options: { runMarker?: string; maximumBytes?: number } = {},
): LogSink {
  const maximumBytes = options.maximumBytes ?? MAXIMUM_LOG_BYTES;
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("Log rotation limit must be positive");
  let marker = "";
  return (record) => {
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > maximumBytes) {
      throw new Error("Structured log record exceeds the bounded log capacity");
    }
    if (record.event === options.runMarker) marker = line;
    preparePrivateDirectory(dirname(path));
    let fd = openPrivateLog(path);
    try {
      if (fstatSync(fd).size + Buffer.byteLength(line) > maximumBytes) {
        closeSync(fd);
        fd = -1;
        rotate(path);
        fd = openPrivateLog(path);
        const prefix = marker && marker !== line ? marker : "";
        if (Buffer.byteLength(prefix) + Buffer.byteLength(line) > maximumBytes) {
          throw new Error("Structured log record leaves no capacity for the process run marker");
        }
        if (prefix) writeSync(fd, prefix);
      }
      writeSync(fd, line);
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  };
}

function preparePrivateDirectory(directory: string): void {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || entry.uid !== process.getuid!()) throw new Error("Invalid structured log directory");
  if ((entry.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
}

function openPrivateLog(path: string): number {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const entry = fstatSync(fd);
  if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid!()) {
    closeSync(fd);
    throw new Error("Invalid structured log file");
  }
  if ((entry.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
  return fd;
}

function rotate(path: string): void {
  for (let generation = LOG_GENERATIONS - 1; generation >= 1; generation -= 1) {
    const target = `${path}.${generation}`;
    const source = generation === 1 ? path : `${path}.${generation - 1}`;
    if (generation === LOG_GENERATIONS - 1 && existsSync(target)) unlinkSync(target);
    if (existsSync(source)) renameSync(source, target);
  }
}

/** Records the sink refused since it last accepted one. */
let droppedRecords = 0;

/**
 * Logging serves the code that calls it, so a sink failure such as a full disk
 * never reaches the caller. The record is dropped; the first failure in a run
 * prints one stderr line, and the next record the sink accepts is preceded by
 * `log.records_dropped` with the count, so the gap is visible in the log itself.
 */
function write(record: LogRecord): void {
  try {
    const sink = currentSink();
    if (droppedRecords > 0) {
      sink({ timestamp: record.timestamp, level: "error", event: "log.records_dropped", count: droppedRecords });
      droppedRecords = 0;
    }
    sink(record);
  } catch (error) {
    if (droppedRecords++ > 0) return;
    try {
      process.stderr.write(`${JSON.stringify({
        timestamp: record.timestamp, level: "error", event: "log.write_failed", droppedEvent: record.event, ...errorFields(error),
      })}\n`);
    } catch {
      // Nowhere is left to report it; the count still reaches the log once it recovers.
    }
  }
}

function logger(bound: LogFields): Logger {
  const emit = (level: LogLevel) => (event: string, fields: LogFields = {}) => {
    write({ ...fields, ...bound, timestamp: new Date().toISOString(), level, event });
  };
  return {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    with: (fields) => logger({ ...bound, ...fields }),
  };
}

export const log: Logger = logger({});

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorMessage: String(error) };
}
