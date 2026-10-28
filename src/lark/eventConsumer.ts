import { errorFields, type Logger } from "../log.ts";
import { larkCommand, larkContextEnvironment, type LarkContext } from "./process.ts";

// lark-cli has no machine-readable connection status; these stderr lines are
// the contract (CLI 1.0.93). If upstream rewords them, readiness or disconnect
// detection stops working, so any line outside this vocabulary is counted and
// warned about rather than ignored.
const READY_MARKER = "[event] ready event_key=im.message.receive_v1";
const CONNECTED_MARKER = "[source] feishu-websocket: connected";
const DISCONNECTED_MARKER = "[source] feishu-websocket: disconnected";
const RECONNECTING_MARKER = "[source] feishu-websocket: reconnecting";
/** The CLI's own progress lines ("[event] consuming as …"); they carry no state. */
const PROGRESS_PREFIX = "[event] ";

export type LarkStderrLine =
  | { kind: "ready" }
  | { kind: "connected" }
  | { kind: "unavailable"; reason: "disconnected" | "reconnecting" }
  | { kind: "progress" }
  | { kind: "unrecognized" };

export function classifyLarkStderrLine(line: string): LarkStderrLine {
  if (line.includes(READY_MARKER)) return { kind: "ready" };
  if (line.includes(DISCONNECTED_MARKER)) return { kind: "unavailable", reason: "disconnected" };
  if (line.includes(RECONNECTING_MARKER)) return { kind: "unavailable", reason: "reconnecting" };
  if (line.includes(CONNECTED_MARKER)) return { kind: "connected" };
  return line.startsWith(PROGRESS_PREFIX) ? { kind: "progress" } : { kind: "unrecognized" };
}

/** Warn on the 1st, 2nd, 4th, 8th… unrecognized line: drift is visible at once, log volume stays bounded. */
function isWarningCount(count: number): boolean {
  return (count & (count - 1)) === 0;
}

export interface LarkEventStreamObserver {
  ready(): void;
  unavailable(): void;
}

const NULL_OBSERVER: LarkEventStreamObserver = {
  ready: () => undefined,
  unavailable: () => undefined,
};

export class LarkEventConsumer {
  readonly #context: LarkContext;
  readonly #log: Logger;
  #process: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  #stopping = false;
  #preparing = false;
  #killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: LarkContext, logger: Logger) {
    this.#context = Object.freeze({ ...context });
    this.#log = logger;
  }

  async consume(
    onEvent: (event: unknown) => Promise<void>,
    observer: LarkEventStreamObserver = NULL_OBSERVER,
  ): Promise<void> {
    if (this.#process || this.#preparing) throw new Error("Lark event consumer is already running");
    this.#stopping = false;
    this.#preparing = true;
    try { await stopIdleEventBus(this.#context, "startup", this.#log); }
    finally { this.#preparing = false; }
    if (this.#stopping) return;
    const process = Bun.spawn({
      cmd: larkCommand(this.#context, [
        "event",
        "consume",
        "im.message.receive_v1",
        "--as",
        "bot",
      ]),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // The official CLI puts its Unix socket beneath CONFIG_DIR and its daemon
      // inherits cwd. Relative addressing keeps macOS's sun_path limit independent
      // of the customer's home path; HOME and all stored files remain unchanged.
      env: { ...larkContextEnvironment(this.#context), LARKSUITE_CLI_CONFIG_DIR: "." },
      cwd: this.#context.configDirectory,
    });
    this.#process = process;

    let markReady: (() => void) | undefined;
    let markReadyFailed: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markReadyFailed = reject;
    });

    let readySeen = false;
    let connected = false;
    let unrecognizedLines = 0;
    const publishReady = () => {
      if (!readySeen || !connected) return;
      observer.ready();
      markReady?.();
    };
    const stderrTask = (async () => {
      try {
        for await (const line of readLines(process.stderr)) {
          if (!line.trim()) continue;
          const status = classifyLarkStderrLine(line);
          if (status.kind === "ready") {
            readySeen = true;
            publishReady();
            this.#log.info("lark.event.subscription_ready", { profile: this.#context.profile });
          } else if (status.kind === "unavailable") {
            connected = false;
            if (readySeen) observer.unavailable();
            this.#log.warn("lark.event.connection_unavailable", { reason: status.reason, subscriptionReady: readySeen });
          } else if (status.kind === "connected") {
            connected = true;
            publishReady();
            this.#log.info("lark.event.connection_ready", { profile: this.#context.profile });
          } else if (status.kind === "unrecognized" && !this.#stopping) {
            unrecognizedLines += 1;
            if (isWarningCount(unrecognizedLines)) {
              // Only the size: provider diagnostics can quote message content.
              this.#log.warn("lark.event.stderr_unrecognized", {
                count: unrecognizedLines, bytes: Buffer.byteLength(line), subscriptionReady: readySeen, connectionReady: connected,
              });
            }
          }
        }
        if (!this.#stopping) throw new Error("lark-cli event diagnostic stream closed unexpectedly");
      } catch (error) {
        markReadyFailed?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    })();

    let readyTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const readyTimeout = new Promise<never>((_, reject) => {
      readyTimeoutId = setTimeout(
        () => reject(new Error("Timed out waiting for lark-cli subscription and connection readiness")),
        20_000,
      );
    });
    const exited = process.exited.then((code) => {
      if (this.#stopping) return;
      this.#log.error("lark.event.process_exited", {
        exitCode: code, subscriptionReady: readySeen, connectionReady: connected, unrecognizedStderrLines: unrecognizedLines,
      });
      throw new Error(`lark-cli event consumer exited unexpectedly with code ${code}`);
    });
    const handlers = new Set<Promise<void>>();
    const stdoutTask = (async () => {
      for await (const line of readLines(process.stdout)) {
        if (!line.trim()) continue;
        try {
          const handler = onEvent(JSON.parse(line) as unknown).catch((error) => {
            this.#log.error("lark.event.handler_failed", errorFields(error));
          });
          handlers.add(handler);
          void handler.then(
            () => handlers.delete(handler),
            () => handlers.delete(handler),
          );
        } catch (error) {
          this.#log.error("lark.event.handler_failed", errorFields(error));
        }
      }
      if (!this.#stopping) throw new Error("lark-cli event stream closed unexpectedly");
    })();

    try {
      await Promise.race([ready, readyTimeout, exited, stderrTask, stdoutTask]);
      if (readyTimeoutId) clearTimeout(readyTimeoutId);
      await Promise.race([stdoutTask, stderrTask, exited]);
      await Promise.allSettled([process.exited, stdoutTask, stderrTask]);
      await Promise.allSettled(handlers);
    } catch (error) {
      this.#terminate();
      await Promise.allSettled([process.exited, stdoutTask, stderrTask]);
      await Promise.allSettled(handlers);
      if (this.#stopping) return;
      throw error;
    } finally {
      if (readyTimeoutId) clearTimeout(readyTimeoutId);
      clearTimeout(this.#killTimer);
      this.#killTimer = undefined;
      // The subscription and its detached event bus have one lifecycle. The
      // official stop command waits for daemon exit; no 30-second idle tail.
      try { await stopIdleEventBus(this.#context, "shutdown", this.#log); }
      finally { if (this.#process === process) this.#process = undefined; }
    }
  }

  stop(): void {
    this.#stopping = true;
    this.#terminate();
  }

  #terminate(): void {
    const child = this.#process;
    if (!child || this.#killTimer) return;
    child.kill("SIGTERM");
    this.#killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  }
}

async function stopIdleEventBus(context: LarkContext, phase: "startup" | "shutdown", logger: Logger): Promise<void> {
  // CLI 1.0.93 retains an idle daemon for 30s, but source_status is only a
  // broadcast transition, not replayed to a new subscriber. Start a fresh
  // connection via its official lifecycle; never force-stop other consumers.
  const child = Bun.spawn({
    cmd: larkCommand(context, ["event", "stop", "--json"]),
    env: { ...larkContextEnvironment(context), LARKSUITE_CLI_CONFIG_DIR: "." },
    cwd: context.configDirectory,
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 10_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 11_000);
  try {
    const code = await child.exited;
    if (timedOut || code !== 0) {
      logger.error("lark.event.bus_stop_failed", { phase, exitCode: code, timedOut });
      throw new Error(`Cannot stop the private Feishu event bus (exit=${code}, timeout=${timedOut}); active consumers are not interrupted`);
    }
    logger.info("lark.event.bus_stopped", { profile: context.profile, phase });
  } finally { clearTimeout(timeout); clearTimeout(kill); }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        yield buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

export { CONNECTED_MARKER, DISCONNECTED_MARKER, READY_MARKER, RECONNECTING_MARKER, readLines };
