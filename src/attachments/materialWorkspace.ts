import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { FeishuTopicEvidence } from "../lark/messageEvidence.ts";
import type { FeishuTurnSources } from "../runtime/instructions.ts";
import { PI_MATERIAL_ROOT, PI_RUNTIME_USER } from "../runtime/constants.ts";
import type { AttachmentArtifact, MessageArtifacts } from "./artifacts.ts";

export const MATERIAL_WORKSPACE_ROOT = PI_MATERIAL_ROOT;

export interface PublishedMaterial extends AttachmentArtifact {
  localPath: string;
}

export class MaterialWorkspace {
  readonly #directory: string;
  readonly #inputDirectory: string;
  readonly #published = new Map<string, PublishedMaterial>();
  #messageSequence = 0;
  readonly #recordSequences = new Map<string, number>();
  #disposed = false;

  constructor(root = MATERIAL_WORKSPACE_ROOT) {
    const materialRoot = realpathSync(root);
    const directory = mkdtempSync(join(materialRoot, "turn-"));
    const inputDirectory = join(directory, "input");
    try {
      mkdirSync(inputDirectory, { mode: 0o700 });
      for (const path of [directory, inputDirectory]) chmodSync(path, 0o700);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    this.#directory = directory;
    this.#inputDirectory = inputDirectory;
  }

  get cwd(): string {
    this.#assertActive();
    return this.#directory;
  }

  publish(artifacts: MessageArtifacts | undefined): ReadonlyMap<string, PublishedMaterial> {
    this.#assertActive();
    if (!artifacts || artifacts.attachments.length === 0) return new Map();
    const messageDirectory = join(this.#inputDirectory, `message-${++this.#messageSequence}`);
    mkdirSync(messageDirectory, { mode: 0o700 });
    chmodSync(messageDirectory, 0o700);
    const published = new Map<string, PublishedMaterial>();
    try {
      for (const [index, artifact] of artifacts.attachments.entries()) {
        const localPath = join(
          messageDirectory,
          `${String(index + 1).padStart(2, "0")}-${safePublishedName(artifact.fileName)}`,
        );
        copyFileSync(artifact.path, localPath);
        chmodSync(localPath, 0o400);
        assertChild(this.#directory, localPath);
        const material = { ...artifact, localPath };
        this.#published.set(artifact.id, material);
        published.set(artifact.id, material);
      }
      return published;
    } catch (error) {
      for (const id of published.keys()) this.#published.delete(id);
      rmSync(messageDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  publishTopicEvidence(evidence: FeishuTopicEvidence): string {
    return this.#publishRecord("topic-evidence", evidence);
  }

  /** Identifiers and links the readable turn text leaves out. */
  publishSources(sources: FeishuTurnSources): string {
    return this.#publishRecord("sources", sources);
  }

  #publishRecord(kind: "topic-evidence" | "sources", value: unknown): string {
    this.#assertActive();
    // Per kind, so a steered message's evidence and sources share one ordinal.
    const sequence = (this.#recordSequences.get(kind) ?? 0) + 1;
    this.#recordSequences.set(kind, sequence);
    const localPath = join(this.#inputDirectory, `${kind}-${String(sequence).padStart(2, "0")}.json`);
    writeFileSync(localPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400 });
    chmodSync(localPath, 0o400);
    assertChild(this.#directory, localPath);
    return localPath;
  }

  material(id: string): PublishedMaterial | undefined {
    return this.#disposed ? undefined : this.#published.get(id);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#published.clear();
    rmSync(this.#directory, { recursive: true, force: true });
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Material workspace has already been disposed");
  }
}

/** The root lets the runtime account read every turn workspace created beneath it. */
export function materialRootReadAcl(runtimeUser: string): string {
  assertRuntimeUser(runtimeUser);
  return `user:${runtimeUser} allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit`;
}

/** The parent only lets the runtime account pass through to the root. */
export function materialParentTraverseAcl(runtimeUser: string): string {
  assertRuntimeUser(runtimeUser);
  return `user:${runtimeUser} allow search`;
}

/**
 * Establishes the material access policy as the Bridge account, which owns the
 * root and its parent: each is mode 700 with exactly one ACL entry for the
 * runtime account. Whatever was there before, including inheritable entries
 * another account planted, is replaced before any material is written. The
 * installer and development provisioning only give the parent to the Bridge
 * account; this function is the policy's single owner.
 */
export function prepareMaterialRoot(root = MATERIAL_WORKSPACE_ROOT, runtimeUser = PI_RUNTIME_USER): void {
  requireOwnDirectory(dirname(root));
  if (!pathExists(root)) mkdirSync(root, { mode: 0o700 });
  for (const [directory, entry] of materialAccess(root, runtimeUser)) {
    requireOwnDirectory(directory);
    chmodSync(directory, 0o700);
    const result = spawnSync("/bin/chmod", ["-E", directory], { input: `${entry}\n`, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`Cannot set the access control of ${directory}: ${result.stderr.trim()}`);
    }
  }
  verifyMaterialRoot(root, runtimeUser);
}

/** Proves the exact owner, mode and ACL of the material root and its parent; any drift fails closed. */
export function verifyMaterialRoot(root = MATERIAL_WORKSPACE_ROOT, runtimeUser = PI_RUNTIME_USER): void {
  for (const [directory, entry] of materialAccess(root, runtimeUser)) {
    const stat = requireOwnDirectory(directory);
    if ((stat.mode & 0o7777) !== 0o700) {
      throw new Error(`${directory} must be mode 700, not ${(stat.mode & 0o7777).toString(8)}`);
    }
    const entries = accessControlEntries(directory);
    if (entries.length !== 1 || entries[0] !== entry) {
      throw new Error(`${directory} must carry exactly one ACL entry, "${entry}"; found ${JSON.stringify(entries)}`);
    }
  }
}

/** Establishes the material access policy, then removes turn workspaces a previous Bridge left behind. */
export function resetMaterialWorkspaces(root = MATERIAL_WORKSPACE_ROOT, runtimeUser = PI_RUNTIME_USER): void {
  prepareMaterialRoot(root, runtimeUser);
  const materialRoot = realpathSync(root);
  for (const entry of readdirSync(materialRoot, { withFileTypes: true })) {
    const path = join(materialRoot, entry.name);
    const stat = lstatSync(path);
    if (!entry.name.startsWith("turn-") || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unexpected entry in material workspace root: ${path}`);
    }
    rmSync(path, { recursive: true, force: true });
  }
}

function safePublishedName(value: string): string {
  const name = basename(value).normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .trim()
    .slice(0, 120);
  return name || "material";
}

function assertChild(root: string, path: string): void {
  const child = relative(realpathSync(root), realpathSync(path));
  if (!child || child.startsWith("..") || child.startsWith("/")) {
    throw new Error(`Published material escaped its turn workspace: ${resolve(path)}`);
  }
}

function materialAccess(root: string, runtimeUser: string): readonly (readonly [string, string])[] {
  return [
    [dirname(root), materialParentTraverseAcl(runtimeUser)],
    [root, materialRootReadAcl(runtimeUser)],
  ];
}

function requireOwnDirectory(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path} must be a real directory`);
  if (stat.uid !== process.getuid!()) throw new Error(`${path} must belong to the Bridge account`);
  return stat;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function accessControlEntries(path: string): string[] {
  const listing = spawnSync("/bin/ls", ["-lde", path], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(`Cannot read the access control of ${path}: ${listing.stderr.trim()}`);
  return listing.stdout.split("\n").slice(1).flatMap((line) => {
    const entry = /^\s*\d+: (.+)$/.exec(line)?.[1];
    return entry ? [entry] : [];
  });
}

function assertRuntimeUser(value: string): void {
  if (!/^[a-z_][a-z0-9_-]*$/.test(value)) throw new Error(`Invalid runtime user: ${value}`);
}
