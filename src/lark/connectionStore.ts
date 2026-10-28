import { fsyncSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrivateRecord } from "../privateRecord.ts";
import { FeishuConnectionError } from "./connectionState.ts";
import { isFeishuAppId, isFeishuBotOpenId, type FeishuIdentity } from "./connectionProof.ts";
import { isLarkBrand, type LarkBrand } from "./platform.ts";

export interface FeishuBinding extends FeishuIdentity { directoryId: string }
export interface FeishuCandidate { directoryId: string; appId: string | null; brand: LarkBrand | null }
export interface FeishuConnectionRecord { version: 2; active: FeishuBinding | null; candidate: FeishuCandidate | null }

/** Connection metadata only. The official CLI exclusively owns its encrypted credentials. */
export class FeishuConnectionStore {
  readonly #record: PrivateRecord<FeishuConnectionRecord>;
  constructor(readonly directory: string) {
    this.#record = new PrivateRecord(join(directory, "connection.json"), parseFeishuConnectionRecord,
      () => new FeishuConnectionError("connection_storage_unavailable"));
  }
  read(): FeishuConnectionRecord { return this.#record.read() ?? { version: 2, active: null, candidate: null }; }
  write(value: FeishuConnectionRecord): void { this.#record.write(value); }
  createDirectory(): string {
    this.#record.directory();
    const id = crypto.randomUUID();
    try {
      mkdirSync(join(this.directory, id), { mode: 0o700 });
      const fd = openSync(this.directory, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      return id;
    } catch { throw new FeishuConnectionError("connection_storage_unavailable"); }
  }
  resolveDirectory(id: string): string {
    if (!isDirectoryId(id)) throw new FeishuConnectionError("connection_storage_unavailable");
    const path = join(this.directory, id);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
        || (stat.mode & 0o777) !== 0o700 || realpathSync(path) !== resolve(path)) throw new Error();
      return path;
    } catch { throw new FeishuConnectionError("connection_storage_unavailable"); }
  }
}

export function parseFeishuConnectionRecord(value: unknown): FeishuConnectionRecord {
  const invalid = (): never => { throw new FeishuConnectionError("connection_storage_unavailable"); };
  if (!record(value) || keys(value) !== "active,candidate,version" || (value.version !== 1 && value.version !== 2)) return invalid();
  const legacy = value.version === 1;
  const active = value.active;
  const candidate = value.candidate;
  if (active !== null && (!record(active) || keys(active) !== (legacy ? "appId,botOpenId,directoryId" : "appId,botOpenId,brand,directoryId") || (!legacy && !isLarkBrand(active.brand))
    || !isDirectoryId(active.directoryId) || !isFeishuAppId(active.appId) || !isFeishuBotOpenId(active.botOpenId))) return invalid();
  if (candidate !== null && (!record(candidate) || keys(candidate) !== (legacy ? "appId,directoryId" : "appId,brand,directoryId") || (!legacy && candidate.brand !== null && !isLarkBrand(candidate.brand))
    || !isDirectoryId(candidate.directoryId) || (candidate.appId !== null && !isFeishuAppId(candidate.appId)))) return invalid();
  if (active && candidate && active.directoryId === candidate.directoryId) return invalid();
  // Version 1 could only activate Feishu. An interrupted registration may not
  // have completed discovery yet, so its platform remains unknown until proof.
  if (legacy) return { version: 2, active: active ? { ...active, brand: "feishu" } as unknown as FeishuBinding : null,
    candidate: candidate ? { ...candidate, brand: candidate.appId === null ? null : "feishu" } as unknown as FeishuCandidate : null };
  return structuredClone(value) as unknown as FeishuConnectionRecord;
}
function isDirectoryId(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: object): string { return Object.keys(value).sort().join(","); }
