import { spawn } from "node:child_process";
import { executionProcess } from "./executionProcess.ts";

type Request = {
  command: string[];
  input?: string;
  timeoutMilliseconds: number;
  combineOutput?: boolean;
};
type Result = { exitCode: number | null; stdout: Buffer; stderr: Buffer };
const MAX_WIRE_BYTES = 96 * 1024 * 1024;

/**
 * A private duplex lease, separate from tool input and output, owns one process
 * group. The child waits for the worker to record its group before executing.
 * Worker death closes the lease; supervisor death lets the worker reap the group.
 */
export function supervisedExecution(
  runner: string, cwd: string, env: NodeJS.ProcessEnv, request: Request, signal: AbortSignal,
): Promise<Result> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const supervisor = spawn(runner, ["--supervise-execution"], {
      cwd, env, stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let group: number | undefined;
    let admitted = false, released = false, closed = false;
    let failure: Error | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const reap = () => {
      if (!group) return;
      try { process.kill(-group, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error; }
    };
    const stop = (error: Error) => {
      if (closed) return;
      failure ??= error;
      reap();
      if (supervisor.connected) supervisor.disconnect();
      // A failed trusted supervisor cannot retain the worker indefinitely.
      // The acknowledged group is already killed; an unacknowledged child
      // only waits on a pipe and exits when its supervisor goes away.
      stopTimer ??= setTimeout(() => supervisor.kill("SIGKILL"), 3_000);
    };
    const abort = () => stop(new Error("Tool execution aborted"));
    const deadline = setTimeout(() => stop(new Error("Tool execution timed out")), request.timeoutMilliseconds + 5_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    supervisor.on("message", (message: { kind?: string; pid?: number }) => {
      if (!admitted && message.kind === "group" && Number.isSafeInteger(message.pid) && message.pid! > 0) {
        group = message.pid; admitted = true;
        if (failure) reap();
        else supervisor.send({ kind: "start" }, (error) => { if (error) stop(error); });
      } else if (admitted && !released && message.kind === "released") {
        group = undefined; released = true;
      } else stop(new Error("Invalid execution supervisor transition"));
    });
    supervisor.stdout!.on("data", (data: Buffer) => {
      length += data.length;
      if (length > MAX_WIRE_BYTES) return stop(new Error("Execution supervisor response is oversized"));
      chunks.push(data);
    });
    // Errors carry no command, input, environment or tool output.
    supervisor.stderr!.resume();
    supervisor.stdin!.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error); });
    supervisor.stdin!.end(JSON.stringify(request));
    supervisor.on("error", (error) => { failure ??= error; });
    supervisor.on("close", (exitCode) => {
      closed = true;
      reap(); clearTimeout(deadline); clearTimeout(stopTimer);
      signal.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (exitCode !== 0 || !released) return reject(new Error("Execution supervisor exited before cleanup completed"));
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString()) as {
          ok: boolean; error?: string; exitCode: number | null; stdout: string; stderr: string;
        };
        if (!reply.ok) throw new Error(reply.error ?? "Execution failed");
        resolve({ exitCode: reply.exitCode, stdout: Buffer.from(reply.stdout, "base64"), stderr: Buffer.from(reply.stderr, "base64") });
      } catch (error) { reject(error); }
    });
  });
}

/** Trusted, credential-free supervisor. No model code or filesystem tools run here. */
export async function runExecutionSupervisor(): Promise<void> {
  process.umask(0o077);
  if (!process.send || !process.connected) throw new Error("Execution supervisor requires its owner channel");
  const abort = new AbortController();
  const start = Promise.withResolvers<void>();
  void start.promise.catch(() => undefined);
  const stop = () => { abort.abort(); start.reject(new Error("Execution owner disconnected")); };
  process.on("disconnect", stop);
  let permitted = false;
  process.on("message", (message: { kind?: string }) => {
    if (!permitted && message.kind === "start") { permitted = true; start.resolve(); }
    else stop();
  });
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    const input = await Bun.stdin.text();
    if (input.length > MAX_WIRE_BYTES) throw new Error("Oversized execution request");
    const request = JSON.parse(input) as Request;
    if (!Array.isArray(request.command) || request.command[0] !== "/bin/bash"
      || !request.command.every((part) => typeof part === "string")
      || !Number.isFinite(request.timeoutMilliseconds) || request.timeoutMilliseconds <= 0
      || request.timeoutMilliseconds > 125_000) throw new Error("Invalid execution request");
    const result = await executionProcess({
      ...request, cwd: process.cwd(), env: process.env, signal: abort.signal, detached: true,
      admit: async (pid) => {
        process.send!({ kind: "group", pid });
        await start.promise;
        abort.signal.throwIfAborted();
      },
    });
    process.send!({ kind: "released" });
    process.stdout.write(JSON.stringify({ ok: true, exitCode: result.exitCode,
      stdout: result.stdout.toString("base64"), stderr: result.stderr.toString("base64") }));
  } catch (error) {
    if (process.connected) process.send!({ kind: "released" });
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Execution failed" }));
  } finally {
    if (process.connected) process.disconnect!();
  }
}
