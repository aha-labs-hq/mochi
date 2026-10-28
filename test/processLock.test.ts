import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProcessLock } from "../src/processLock.ts";
import { killLockHolder } from "./lockHolder.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("process lock", () => {
  test("rejects a second live bot and releases ownership", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-lock-"));
    directories.push(directory);
    const path = join(directory, "bot.lock");
    const first = await ProcessLock.acquire(path, 123);
    const inode = statSync(path).ino;
    await expect(ProcessLock.acquire(path)).rejects.toThrow("Another bot process already owns");
    expect(readFileSync(path, "utf8")).toBe("123\n");
    expect(statSync(path).ino).toBe(inode);
    await first.release();
    const second = await ProcessLock.acquire(path);
    await second.release();
  });

  test("reclaims a stale or malformed lock without replacing its inode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-lock-"));
    directories.push(directory);
    const path = join(directory, "bot.lock");
    writeFileSync(path, "not-a-pid\n", { mode: 0o600 });
    const lock = await ProcessLock.acquire(path);
    const inode = statSync(path).ino;
    await lock.release();
    expect(statSync(path).ino).toBe(inode);
  });

  test("never follows a lock-file symlink", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-lock-"));
    directories.push(directory);
    const target = join(directory, "target");
    const path = join(directory, "bot.lock");
    writeFileSync(target, "protected\n", { mode: 0o600 });
    symlinkSync(target, path);
    await expect(ProcessLock.acquire(path)).rejects.toThrow();
  });

  test("refuses a hard-linked file without changing its content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-lock-"));
    directories.push(directory);
    const target = join(directory, "target");
    const path = join(directory, "bot.lock");
    writeFileSync(target, "protected\n", { mode: 0o600 });
    linkSync(target, path);
    await expect(ProcessLock.acquire(path)).rejects.toThrow("Could not acquire process lock");
    expect(readFileSync(target, "utf8")).toBe("protected\n");
  });

  test.skipIf(!existsSync("/usr/bin/lockf"))("interoperates with the previous system lock holder on the same inode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-lock-"));
    directories.push(directory);
    const path = join(directory, "bot.lock");
    const held = await ProcessLock.acquire(path);
    expect(Bun.spawnSync(["/usr/bin/lockf", "-k", "-t", "0", path, "/usr/bin/true"]).exitCode).toBe(75);
    await held.release();
    const previous = Bun.spawn(["/usr/bin/lockf", "-k", "-t", "0", path, "/bin/sh", "-c", 'printf "ready\\n"; exec /bin/cat >/dev/null'], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      expect(await firstLine(previous.stdout)).toBe("ready");
      await expect(ProcessLock.acquire(path)).rejects.toThrow("Another bot process already owns");
    } finally {
      previous.stdin.end();
      await previous.exited;
    }
    const replacement = await ProcessLock.acquire(path);
    await replacement.release();
  });

  test("releases the kernel lock when its Bridge process crashes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-lock-"));
    directories.push(directory);
    const path = join(directory, "bot.lock");
    const helper = join(directory, "owner.ts");
    writeFileSync(helper, [
      `import { ProcessLock } from ${JSON.stringify(resolve(import.meta.dir, "../src/processLock.ts"))};`,
      `await ProcessLock.acquire(${JSON.stringify(path)});`,
      'process.stdout.write("ready\\n");',
      "await new Promise(() => undefined);",
    ].join("\n"));
    const owner = Bun.spawn({ cmd: [process.execPath, helper], stdout: "pipe", stderr: "pipe" });
    try {
      expect(await firstLine(owner.stdout)).toBe("ready");
      await expect(ProcessLock.acquire(path)).rejects.toThrow("Another bot process already owns");
      owner.kill("SIGKILL");
      await owner.exited;
      const replacement = await acquireWithin(path, 1_000);
      await replacement.release();
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
    }
  });
});

describe("process lock loss", () => {
  test("reports a holder that exits while its owner still holds the lock, and never after release", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-lock-"));
    directories.push(directory);
    const path = join(directory, "bot.lock");
    const released = await ProcessLock.acquire(path);
    let releasedLost = false;
    void released.lost.then(() => { releasedLost = true; });
    await released.release();
    const held = await ProcessLock.acquire(path);
    killLockHolder(path);
    await held.lost;
    // The kernel lock is free again, so the owner can no longer claim it.
    const replacement = await acquireWithin(path, 1_000);
    await replacement.release();
    await held.release();
    expect(releasedLost).toBe(false);
  });
});

async function acquireWithin(path: string, milliseconds: number): Promise<ProcessLock> {
  const deadline = Date.now() + milliseconds;
  while (true) {
    try {
      return await ProcessLock.acquire(path);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(10);
    }
  }
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    while (!value.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      value += decoder.decode(chunk.value, { stream: true });
    }
    return value.slice(0, value.indexOf("\n")).replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}
