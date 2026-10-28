import { constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, copyFileSync, chmodSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { PrivateRecord } from "../privateRecord.ts";
import { ProcessLock } from "../processLock.ts";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hasEntry = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
export function requireRuntimeBotId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid runtime Bot identity");
  return value;
}
export function runtimeBotDirectory(home: string, botId: string): string {
  requireRuntimeBotId(botId);
  return privateRuntimeDirectory(home, [".pi", "mochi", "bots", botId]);
}

export function runtimeAccountDirectory(home: string): string {
  const root = privateRuntimeDirectory(home, [".pi", "mochi"]);
  if (accountAdoptionRecord(root).read()?.complete === false) throw new Error("Shared account adoption is incomplete");
  const bots = join(root, "bots");
  if (hasEntry(join(root, "auth.json")) || (existsSync(bots) && readdirSync(bots).some((id) => hasEntry(join(bots, id, "auth.json"))))) {
    throw new Error("Existing ChatGPT logins require explicit offline account adoption");
  }
  const account = privateRuntimeDirectory(home, [".pi", "mochi", "account"]);
  if (hasEntry(join(account, "auth.json"))) regular(join(account, "auth.json"));
  if (hasEntry(join(account, "byok.json"))) regular(join(account, "byok.json"));
  return account;
}

interface AccountAdoption {
  botId: string;
  complete: boolean;
  sources: { botId: string; digest: string }[];
}

function accountAdoptionRecord(root: string): PrivateRecord<AccountAdoption> {
  return new PrivateRecord(join(root, "account-adoption.json"), (value) => {
    if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "botId,complete,sources") throw new Error("Invalid account adoption record");
    const record = value as AccountAdoption;
    requireRuntimeBotId(record.botId);
    if (typeof record.complete !== "boolean" || !Array.isArray(record.sources) || record.sources.length < 1 || record.sources.length > 64) throw new Error("Invalid account adoption record");
    for (const source of record.sources) {
      if (!source || Object.keys(source).sort().join(",") !== "botId,digest" || !/^[a-f0-9]{64}$/.test(source.digest)) throw new Error("Invalid account adoption source");
      requireRuntimeBotId(source.botId);
    }
    if (new Set(record.sources.map((source) => source.botId)).size !== record.sources.length || !record.sources.some((source) => source.botId === record.botId)) throw new Error("Invalid account adoption source");
    return record;
  }, () => new Error("Shared account adoption requires review"));
}

/** Offline explicit adoption. Only credentials move; Session directories are never opened. */
export async function adoptRuntimeAccount(home: string, botId: string): Promise<{ archivedAccounts: number }> {
  requireRuntimeBotId(botId);
  const root = privateRuntimeDirectory(home, [".pi", "mochi"]);
  if (hasEntry(join(root, "auth.json"))) throw new Error("A runtime login from before independent Bots is not supported");
  const account = privateRuntimeDirectory(home, [".pi", "mochi", "account"]);
  const locks: ProcessLock[] = [];
  try {
    locks.push(await ProcessLock.acquire(join(account, "runtime.lock")));
    const bots = join(root, "bots");
    const ids = existsSync(bots) ? readdirSync(bots).map(requireRuntimeBotId).sort() : [];
    if (!ids.includes(botId)) throw new Error("The selected Bot has no runtime storage");
    for (const id of ids) locks.push(await ProcessLock.acquire(join(runtimeBotDirectory(home, id), "runtime.lock")));
    const receipt = accountAdoptionRecord(root);
    let plan = receipt.read();
    const target = join(account, "auth.json");
    if (plan && plan.botId !== botId) throw new Error("A different account adoption is recorded");
    const recordedSources = plan?.sources;
    if (recordedSources && ids.some((id) => hasEntry(join(bots, id, "auth.json")) && !recordedSources.some((source) => source.botId === id))) throw new Error("An unrecorded account appeared during adoption");
    if (!plan) {
      if (hasEntry(target)) throw new Error("The shared login already exists");
      const sources = ids.flatMap((id) => {
        const path = join(bots, id, "auth.json");
        if (!hasEntry(path)) return [];
        regular(path);
        return [{ botId: id, digest: digest(path) }];
      });
      if (!sources.some((source) => source.botId === botId)) throw new Error("The selected Bot has no login to adopt");
      plan = { botId, complete: false, sources };
      receipt.write(plan);
    }
    const archive = privateRuntimeDirectory(home, [".pi", "mochi", "account-adoption-archive"]);
    for (const source of plan.sources) {
      const original = join(runtimeBotDirectory(home, source.botId), "auth.json");
      const backup = join(archive, `${source.botId}.json`);
      if (hasEntry(backup)) {
        regular(backup);
        if (digest(backup) !== source.digest || hasEntry(original)) throw new Error("Ambiguous account archive");
      } else {
        if (plan.complete) throw new Error("Account archive is missing");
        regular(original);
        if (digest(original) !== source.digest) throw new Error("Account changed during adoption");
        renameSync(original, backup);
        syncPath(dirname(original));
      }
      chmodSync(backup, 0o400);
      syncPath(backup);
      syncPath(archive);
    }
    // A completed receipt remains valid after Pi refreshes or the user logs out.
    if (!plan.complete) {
      const chosen = plan.sources.find((source) => source.botId === botId)!;
      if (!hasEntry(target)) {
        const temporary = join(account, `adopting-${botId}.tmp`);
        if (hasEntry(temporary)) {
          regular(temporary);
          if (digest(temporary) !== chosen.digest) throw new Error("Incomplete credential copy requires review");
        } else copyFileSync(join(archive, `${botId}.json`), temporary, constants.COPYFILE_EXCL);
        chmodSync(temporary, 0o600);
        syncPath(temporary);
        renameSync(temporary, target);
        syncPath(account);
      }
      regular(target);
      if (digest(target) !== chosen.digest) throw new Error("Shared credential verification failed");
      receipt.write({ ...plan, complete: true });
    }
    return { archivedAccounts: plan.sources.length };
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}

function privateRuntimeDirectory(home: string, components: readonly string[]): string {
  let directory = home;
  for (const component of components) {
    directory = join(directory, component);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0 || realpathSync(directory) !== resolve(directory)) throw new Error("Runtime storage is not a private real directory");
  }
  for (const forbidden of ["AGENTS.md", "memories", "plugins", "skills", "extensions"]) {
    if (existsSync(join(directory, forbidden))) throw new Error(`Runtime Bot contains forbidden ambient ${forbidden}`);
  }
  return directory;
}

const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
function regular(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0 || realpathSync(path) !== resolve(path)) throw new Error("Unsafe runtime credential file");
}

function syncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
