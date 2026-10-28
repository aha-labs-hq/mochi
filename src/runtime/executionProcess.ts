import { spawn } from "node:child_process";

/** Owns command IO, deadlines and cancellation of its ordinary subprocess group. */
export async function executionProcess(options: {
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal | undefined;
  timeoutMilliseconds: number;
  detached: boolean;
  onData?: (data: Buffer) => void;
}): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(options.command[0]!, options.command.slice(1), {
      cwd: options.cwd, env: options.env, detached: options.detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let failure: Error | undefined;
    let bytes = 0;
    const kill = () => {
      try {
        if (options.detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
      }
    };
    const stop = (error: Error) => { failure ??= error; kill(); };
    const abort = () => stop(new Error("Tool execution aborted"));
    const timer = setTimeout(() => stop(new Error("Tool execution timed out")), options.timeoutMilliseconds);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const receive = (target: Buffer[], data: Buffer) => {
      bytes += data.length;
      if (bytes > 32 * 1024 * 1024) return stop(new Error("Tool output exceeded 32 MiB; save large results to a file"));
      try {
        if (options.onData) options.onData(data);
        else target.push(data);
      } catch (error) { stop(error as Error); }
    };
    child.stdout.on("data", (data: Buffer) => receive(stdout, data));
    child.stderr.on("data", (data: Buffer) => receive(stderr, data));
    child.stdin.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error); });
    child.stdin.end(options.input);
    child.on("error", (error) => { failure ??= error; });
    // Reap background children as soon as the command exits, before waiting for their pipes.
    child.on("exit", () => { if (options.detached) kill(); });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}
