import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

type LockProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

// macOS 14 has flock(2), but not the lockf(1) executable. Use the same BSD
// kernel lock from the already bundled Bun executable, under its own signature.
// One child owns one descriptor until the parent's stdin pipe closes. A parent
// crash therefore releases the lock, and an unexpected child exit remains observable.
const LOCK_HOLDER_SCRIPT = `
import { dlopen, read } from "bun:ffi";
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, openSync, writeSync } from "node:fs";
const path = process.argv[1];
const ownerPid = Number(process.argv[2]);
if (!path || !Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error("Invalid process lock holder arguments");
const library = dlopen("/usr/lib/libSystem.B.dylib", {
  flock: { args: ["i32", "i32"], returns: "i32" },
  __error: { args: [], returns: "ptr" },
});
const descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
try {
  const entry = fstatSync(descriptor);
  if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid()) throw new Error("Unsafe process lock file");
  if (library.symbols.flock(descriptor, 2 | 4) !== 0) {
    const errno = read.i32(library.symbols.__error());
    if (errno === 35) process.exit(75); // Darwin EWOULDBLOCK / EX_TEMPFAIL.
    throw new Error("Process flock failed with errno " + errno);
  }
  fchmodSync(descriptor, 0o600);
  ftruncateSync(descriptor, 0);
  writeSync(descriptor, ownerPid + "\\n");
  process.stdout.write("ready\\n");
  for await (const _ of Bun.stdin.stream()) {}
} finally {
  closeSync(descriptor);
  library.close();
}
`;
const RELEASE_GRACE_MILLISECONDS = 1_000;

/** Holds a kernel advisory lock for the lifetime of the Bridge process. */
export class ProcessLock {
  readonly #process: LockProcess;
  #released = false;
  /**
   * Settles only if the lock ends while its owner still holds it: the holder
   * process exited, so the kernel already released the lock to anyone else.
   * The owner must stop using what the lock protected.
   */
  readonly lost: Promise<void>;

  private constructor(process: LockProcess) {
    this.#process = process;
    this.lost = new Promise((resolve) => {
      void process.exited.then(() => { if (!this.#released) resolve(); });
    });
  }

  static async acquire(path: string, pid = process.pid): Promise<ProcessLock> {
    if (!isAbsolute(path)) throw new Error("Process lock requires an absolute path");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const holder = Bun.spawn({
      cmd: [process.execPath, "-e", LOCK_HOLDER_SCRIPT, path, String(pid)],
      cwd: "/var/empty",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
    });
    const outcome = await Promise.race([
      firstLine(holder.stdout).then((line) => ({ kind: "ready" as const, line })),
      holder.exited.then((code) => ({ kind: "exited" as const, code })),
    ]);
    if (outcome.kind === "exited" || outcome.line !== "ready" || holder.exitCode !== null) {
      await stopLockProcess(holder);
      if (holder.exitCode === 75) throw lockHeldError(path);
      throw new Error(`Could not acquire process lock ${path} (holder exit ${holder.exitCode})`);
    }
    return new ProcessLock(holder);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await stopLockProcess(this.#process);
  }
}

function lockHeldError(path: string): Error {
  const owner = readOwner(path);
  return new Error(owner
    ? `Another bot process already owns ${path} (pid ${owner})`
    : `Another bot process already owns ${path}`);
}

function readOwner(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    while (value.length <= 128) {
      const chunk = await reader.read();
      if (chunk.done) break;
      value += decoder.decode(chunk.value, { stream: true });
      const newline = value.indexOf("\n");
      if (newline >= 0) return value.slice(0, newline).replace(/\r$/, "");
    }
    return value + decoder.decode();
  } finally {
    reader.releaseLock();
  }
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

async function stopLockProcess(process: LockProcess): Promise<void> {
  process.stdin.end();
  if (!await resolvesWithin(process.exited, RELEASE_GRACE_MILLISECONDS)) {
    process.kill("SIGKILL");
    await process.exited;
  }
}
