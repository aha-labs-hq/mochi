import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { ProcessLock } from "../src/processLock.ts";
import { adoptRuntimeAccount, runtimeAccountDirectory, runtimeBotDirectory } from "../src/runtime/storage.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mochi-shared-account-")));
  roots.push(home);
  const root = join(home, ".pi", "mochi");
  const source = (id: string) => join(runtimeBotDirectory(home, id), "auth.json");
  const session = (id: string) => join(runtimeBotDirectory(home, id), "sessions", "history.jsonl");
  for (const id of [A, B]) {
    writeFileSync(source(id), JSON.stringify({ fixture: id }), { mode: 0o600 });
    mkdirSync(join(runtimeBotDirectory(home, id), "sessions"), { mode: 0o700 });
    writeFileSync(session(id), `unchanged history for ${id}\n`, { mode: 0o600 });
  }
  return { home, root, source, session, target: join(root, "account", "auth.json") };
}
function interruptedPlan(f: ReturnType<typeof fixture>) {
  const sources = [A, B].map((botId) => ({ botId, digest: new Bun.CryptoHasher("sha256").update(readFileSync(f.source(botId))).digest("hex") }));
  writeFileSync(join(f.root, "account-adoption.json"), JSON.stringify({ botId: B, complete: false, sources }), { mode: 0o600 });
  mkdirSync(join(f.root, "account-adoption-archive"), { mode: 0o700 });
  renameSync(f.source(A), join(f.root, "account-adoption-archive", `${A}.json`));
}

test("explicit adoption shares only the selected login and preserves every Session byte", async () => {
  const f = fixture();
  const before = [A, B].map((id) => readFileSync(f.session(id)));
  expect(() => runtimeAccountDirectory(f.home)).toThrow("explicit offline");
  expect(await adoptRuntimeAccount(f.home, B)).toEqual({ archivedAccounts: 2 });
  expect(readFileSync(f.target, "utf8")).toBe(JSON.stringify({ fixture: B }));
  expect(statSync(f.target).mode & 0o777).toBe(0o600);
  for (const [index, id] of [A, B].entries()) {
    expect(existsSync(f.source(id))).toBe(false);
    expect(readFileSync(f.session(id))).toEqual(before[index]!);
    const archive = join(f.root, "account-adoption-archive", `${id}.json`);
    expect(readFileSync(archive, "utf8")).toBe(JSON.stringify({ fixture: id }));
    expect(statSync(archive).mode & 0o777).toBe(0o400);
  }
  expect(runtimeAccountDirectory(f.home)).toBe(join(f.root, "account"));
  writeFileSync(f.target, "{}");
  expect(await adoptRuntimeAccount(f.home, B)).toEqual({ archivedAccounts: 2 });
  expect(readFileSync(f.target, "utf8")).toBe("{}");
  await expect(adoptRuntimeAccount(f.home, A)).rejects.toThrow("different account");
});

test("an interrupted archive resumes the recorded source without accepting a new choice", async () => {
  const f = fixture();
  interruptedPlan(f);
  expect(() => runtimeAccountDirectory(f.home)).toThrow("incomplete");
  await expect(adoptRuntimeAccount(f.home, A)).rejects.toThrow("different account");
  expect(await adoptRuntimeAccount(f.home, B)).toEqual({ archivedAccounts: 2 });
  expect(readFileSync(f.target, "utf8")).toBe(JSON.stringify({ fixture: B }));
});

test("adoption refuses altered archives and keeps the remaining login intact", async () => {
  const f = fixture();
  interruptedPlan(f);
  writeFileSync(join(f.root, "account-adoption-archive", `${A}.json`), "tampered");
  await expect(adoptRuntimeAccount(f.home, B)).rejects.toThrow("Ambiguous account archive");
  expect(readFileSync(f.source(B), "utf8")).toBe(JSON.stringify({ fixture: B }));
  expect(existsSync(f.target)).toBe(false);
});

test("adoption refuses an active Bot or shared owner before moving any login", async () => {
  const f = fixture();
  mkdirSync(join(f.root, "account"), { mode: 0o700 });
  for (const path of [join(runtimeBotDirectory(f.home, B), "runtime.lock"), join(f.root, "account", "runtime.lock")]) {
    const lock = await ProcessLock.acquire(path);
    try { await expect(adoptRuntimeAccount(f.home, B)).rejects.toThrow("already owns"); }
    finally { await lock.release(); }
    expect(existsSync(f.source(A))).toBe(true);
    expect(existsSync(f.source(B))).toBe(true);
    expect(existsSync(join(f.root, "account-adoption.json"))).toBe(false);
  }
});

test("adoption never chooses implicitly or accepts an unsafe credential", async () => {
  const f = fixture();
  await expect(adoptRuntimeAccount(f.home, "")).rejects.toThrow("identity");
  chmodSync(f.source(B), 0o644);
  await expect(adoptRuntimeAccount(f.home, B)).rejects.toThrow("Unsafe");
  rmSync(f.source(B));
  symlinkSync(f.source(A), f.source(B));
  await expect(adoptRuntimeAccount(f.home, B)).rejects.toThrow("Unsafe");
  expect(existsSync(f.source(A))).toBe(true);
});

test("shared credentials reject dangling symlinks before Pi can create their target", async () => {
  const f = fixture();
  await adoptRuntimeAccount(f.home, A);
  rmSync(f.target);
  const outside = join(f.home, "outside-auth.json");
  symlinkSync(outside, f.target);
  expect(() => runtimeAccountDirectory(f.home)).toThrow("Unsafe");
  expect(existsSync(outside)).toBe(false);
});

test("Pi's shared auth store serializes independent process updates and rereads external changes", async () => {
  const f = fixture();
  await adoptRuntimeAccount(f.home, A);
  const provider = "openai-codex";
  const storage = AuthStorage.create(f.target);
  await storage.modify(provider, async () => ({ type: "oauth", access: "fixture", refresh: "fixture", expires: 0 }));
  const source = `import { AuthStorage } from ${JSON.stringify(new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href)};
    const storage = AuthStorage.create(process.argv[1]);
    for (let i = 0; i < 4; i++) await storage.modify("openai-codex", async (current) => {
      await Bun.sleep(5);
      return { ...current, expires: current.expires + 1 };
    });`;
  const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "-e", source, f.target], { stdout: "pipe", stderr: "pipe" }));
  for (const child of children) {
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  }
  expect(await storage.read(provider)).toMatchObject({ expires: 12 });
}, 15_000);
