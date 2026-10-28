import { errorFields, log, type LogFields } from "../log.ts";
import { RUNTIME_REQUEST_TIMEOUT_MILLISECONDS, WORKER_TERMINATION_GRACE_MILLISECONDS } from "./timing.ts";
import {
  parseWorkerMessage,
  PI_WORKER_PROTOCOL_VERSION,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";

type WorkerProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export class RuntimeRequestError extends Error {
  constructor(readonly code: string, method: string, message: string) {
    super(`Pi worker ${method} failed [${code}]: ${message}`);
    this.name = "RuntimeRequestError";
  }
}

export class RuntimeRequestTimedOutError extends Error {
  constructor(method: string) {
    super(`Pi worker request timed out: ${method}`);
    this.name = "RuntimeRequestTimedOutError";
  }
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export type WorkerReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface RuntimeTransportOptions {
  command: readonly string[];
  environment: Record<string, string | undefined>;
  onEvent(event: string, params: unknown): void;
  onRequest(method: string, params: unknown): Promise<WorkerReply>;
  onFatal(error: Error): void;
  onExit(error: Error): Promise<void> | void;
}

/**
 * The worker writes these structured diagnostics to stderr on purpose
 * (`worker.ts`). They carry identifiers and flags only, so they are forwarded
 * under their own event names.
 */
const WORKER_DIAGNOSTIC_EVENTS = new Set([
  "runtime.local_tool.started",
  "runtime.local_tool.completed",
  "runtime.context.compaction_started",
  "runtime.context.compaction_finished",
]);
const WORKER_DIAGNOSTIC_FIELDS = new Set([
  "sessionId", "turnId", "toolCallId", "toolName", "sourceMessageId",
  "isError", "reason", "completed", "aborted", "willRetry", "failed",
]);
const DIAGNOSTIC_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ERROR_NAME = /^(?:Uncaught )?((?:[A-Z][A-Za-z]{0,63})?(?:Error|Exception))\b/;

/**
 * What one worker stderr line may put in the Bridge log.
 *
 * Anything else the worker or a dependency prints, such as a stack trace or a
 * provider message, can quote conversation content, so only its size and a
 * leading error class name are kept. Stack frames add nothing without the text.
 */
export function workerStderrRecord(line: string): { level: "info" | "warn"; event: string; fields: LogFields } | null {
  if (!line.trim() || /^\s+at\s/.test(line)) return null;
  try {
    const value = JSON.parse(line) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const { event, ...rest } = value as Record<string, unknown>;
      if (typeof event === "string" && WORKER_DIAGNOSTIC_EVENTS.has(event)) {
        const fields: LogFields = {};
        for (const [key, field] of Object.entries(rest)) {
          if (!WORKER_DIAGNOSTIC_FIELDS.has(key)) continue;
          if (typeof field === "boolean" || (typeof field === "string" && DIAGNOSTIC_VALUE.test(field))) fields[key] = field;
        }
        return { level: "info", event, fields };
      }
    }
  } catch {
    // Not one of the worker's structured diagnostics.
  }
  const errorName = ERROR_NAME.exec(line)?.[1];
  return { level: "warn", event: "runtime.worker.stderr", fields: { bytes: Buffer.byteLength(line), ...(errorName ? { errorName } : {}) } };
}

// Bun can deliver stdout EOF just before the child-exit promise for the same ordinary exit.
const PROCESS_EXIT_OBSERVATION_MILLISECONDS = 25;

/** Owns one isolated Pi worker and the narrow, versioned, bidirectional JSONL protocol. */
export class RuntimeTransport {
  readonly #options: RuntimeTransportOptions;
  #process: WorkerProcess | undefined;
  #readerTask: Promise<void> = Promise.resolve();
  #stderrTask: Promise<void> = Promise.resolve();
  #exitTask: Promise<void> = Promise.resolve();
  #pending = new Map<string, PendingRequest>();
  #nextRequestId = 1;
  #exitError: Error | undefined;
  #stopping = false;

  constructor(options: RuntimeTransportOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#process) throw new Error("Pi worker transport is already started");
    const process = Bun.spawn({
      cmd: [...this.#options.command],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.#options.environment,
    });
    this.#process = process;
    this.#readerTask = this.#readMessages(process.stdout);
    this.#stderrTask = this.#readStderr(process.stderr);
    this.#exitTask = process.exited.then((code) => this.#handleExit(code));
  }

  get isRunning(): boolean {
    return this.#process?.exitCode === null;
  }

  get exited(): Promise<void> {
    return this.#exitTask;
  }

  request(method: string, params: unknown, timeoutMilliseconds = RUNTIME_REQUEST_TIMEOUT_MILLISECONDS): Promise<unknown> {
    const id = `bridge-${this.#nextRequestId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RuntimeRequestTimedOutError(method));
      }, timeoutMilliseconds);
      this.#pending.set(id, { method, resolve, reject, timeout });
    });
    try {
      this.#write({
        version: PI_WORKER_PROTOCOL_VERSION,
        type: "request",
        id,
        method,
        params,
      } satisfies WorkerRequest);
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(asError(error));
      }
    }
    return promise;
  }

  async stop(error: Error): Promise<void> {
    if (!this.#process) return;
    this.#stopping = true;
    this.#exitError ??= error;
    this.#process.kill("SIGTERM");
    if (!await resolvesWithin(this.#exitTask, WORKER_TERMINATION_GRACE_MILLISECONDS)) {
      this.#process.kill("SIGKILL");
      await this.#exitTask;
    }
  }

  #write(message: unknown): void {
    const process = this.#process;
    if (!process || process.exitCode !== null) throw new Error("Pi worker is not connected");
    process.stdin.write(`${JSON.stringify(message)}\n`);
    process.stdin.flush();
  }

  async #readMessages(stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const line of readLines(stream)) {
        if (!line.trim()) continue;
        this.#handleMessage(JSON.parse(line) as unknown);
      }
      if (!this.#stopping && this.#process?.exitCode === null) {
        const processExited = await resolvesWithin(
          this.#process.exited,
          PROCESS_EXIT_OBSERVATION_MILLISECONDS,
        );
        if (!processExited) this.#fail(new Error("Pi worker protocol stream closed unexpectedly"));
      }
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  async #readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const line of readLines(stream)) {
        const record = workerStderrRecord(line);
        if (record) log[record.level](record.event, record.fields);
      }
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  #handleMessage(value: unknown): void {
    const message = parseWorkerMessage(value);
    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new RuntimeRequestError(message.error.code, pending.method, message.error.message));
      return;
    }
    if (message.type === "request") {
      void this.#answerWorkerRequest(message).catch((error) => this.#fail(asError(error)));
      return;
    }
    this.#options.onEvent(message.event, message.params);
  }

  async #answerWorkerRequest(request: WorkerRequest): Promise<void> {
    let response: WorkerResponse;
    try {
      const reply = await this.#options.onRequest(request.method, request.params);
      response = reply.ok
        ? { version: PI_WORKER_PROTOCOL_VERSION, type: "response", id: request.id, ok: true, result: reply.result }
        : { version: PI_WORKER_PROTOCOL_VERSION, type: "response", id: request.id, ok: false, error: reply.error };
    } catch (error) {
      response = {
        version: PI_WORKER_PROTOCOL_VERSION,
        type: "response",
        id: request.id,
        ok: false,
        error: { code: "bridge_request_failed", message: asError(error).message.slice(0, 4_096) },
      };
    }
    this.#write(response);
  }

  #fail(error: Error): void {
    if (this.#exitError) return;
    this.#exitError = error;
    log.error("runtime.transport.failed", errorFields(error));
    this.#options.onFatal(error);
    this.#process?.kill("SIGTERM");
  }

  async #handleExit(code: number): Promise<void> {
    await Promise.allSettled([this.#readerTask, this.#stderrTask]);
    const error = this.#exitError ?? new Error(`Pi worker exited with code ${code}`);
    this.#exitError = error;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.#pending.delete(id);
    }
    await this.#options.onExit(error);
  }
}

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        yield buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function resolvesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
