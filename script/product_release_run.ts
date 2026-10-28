import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { Type, type Static } from "typebox";
import Schema from "typebox/schema";
import { loadReleaseCandidate } from "./release_acceptance.ts";

export const RELEASE_ARTIFACT_NAMES = ["Mochi.pkg", "Mochi.dmg"] as const;
type ArtifactName = typeof RELEASE_ARTIFACT_NAMES[number];
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const SubmissionId = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" });
const SubmissionIdValidator = Schema.Compile(SubmissionId);
const ArtifactSchema = Type.Object({
  sha256: Digest,
  submissionStarted: Type.Boolean(),
  submissionId: Type.Optional(SubmissionId),
  status: Type.Optional(Type.Union([Type.Literal("In Progress"), Type.Literal("Accepted"), Type.Literal("Invalid"), Type.Literal("Rejected")])),
  checkedAt: Type.Optional(Type.String()),
  stapledSha256: Type.Optional(Digest),
}, { additionalProperties: false });
const RunSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  sourceRevision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  arguments: Type.Array(Type.String(), { maxItems: 32 }),
  context: Type.String(),
  assemblySha256: Type.Optional(Digest),
  artifacts: Type.Object(Object.fromEntries(RELEASE_ARTIFACT_NAMES.map(name => [name, Type.Optional(ArtifactSchema)])), { additionalProperties: false }),
  publication: Type.Optional(Type.Object({ name: Type.String({ pattern: "^Mochi-[0-9A-Za-z.-]+$" }), manifestSha256: Digest }, { additionalProperties: false })),
}, { additionalProperties: false });
const Validator = Schema.Compile(RunSchema);
type RunRecord = Omit<Static<typeof RunSchema>, "artifacts"> & { artifacts: Partial<Record<ArtifactName, Static<typeof ArtifactSchema>>> };

/** Apple transport only. The run owns when an external submission is allowed. */
export interface ReleaseNotary {
  submit(path: string): Promise<unknown>;
  info(id: string): Promise<unknown>;
  log(id: string): Promise<unknown>;
  staple(path: string): Promise<void>;
  validate(path: string): Promise<void>;
}

/** Private production checkpoint, never a release manifest or installation journal. */
export class ProductReleaseRun {
  readonly work: string;
  readonly originals: string;
  readonly candidate: string;
  readonly path: string;
  private constructor(readonly directory: string, private readonly record: RunRecord) {
    this.path = join(directory, "production.json");
    this.work = join(directory, "assembly");
    this.originals = join(directory, "originals");
    this.candidate = join(directory, "candidate");
  }

  static async create(output: string, sourceRevision: string, args: readonly string[], context: string): Promise<ProductReleaseRun> {
    for (const name of await readdir(output)) {
      if (!name.startsWith(".Mochi-production-")) continue;
      const existing = await ProductReleaseRun.load(join(output, name, "production.json"));
      if (!existing.publication) throw Error(`Unfinished production exists; resume ${existing.path}`);
      // A recorded intent is not proof that the atomic publication completed.
      await privateEntry(join(output, existing.publication.name), true);
      await existing.verifyCandidate(join(output, existing.publication.name), existing.publication.manifestSha256);
    }
    const directory = await mkdtemp(join(output, ".Mochi-production-"));
    await chmod(directory, 0o700);
    const run = new ProductReleaseRun(directory, { schemaVersion: 2, sourceRevision, arguments: [...args], context, artifacts: {} });
    for (const path of [run.work, run.originals, run.candidate]) await mkdir(path, { mode: 0o700 });
    await run.save();
    return run;
  }

  static async load(path: string): Promise<ProductReleaseRun> {
    if (!isAbsolute(path) || basename(path) !== "production.json") throw Error("Resume requires an absolute production.json path");
    await privateEntry(dirname(path), true);
    await privateEntry(path, false);
    if ((await lstat(path)).size > 64 * 1024) throw Error("Production checkpoint is too large");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Validator.Check(value)) throw Error("Invalid production checkpoint");
    return new ProductReleaseRun(dirname(path), value as RunRecord);
  }

  get arguments(): readonly string[] { return this.record.arguments; }
  get publication(): RunRecord["publication"] { return this.record.publication; }

  async verifyContext(sourceRevision: string, context: string, output: string): Promise<void> {
    if (this.record.sourceRevision !== sourceRevision || this.record.context !== context || dirname(this.directory) !== output) {
      throw Error("Production resume requires the same verified source, release inputs and output directory");
    }
    for (const path of [this.work, this.originals]) await privateEntry(path, true);
    if (!this.record.publication) await privateEntry(this.candidate, true);
    if (!this.record.assemblySha256) throw Error("Assembly was interrupted before sealing; no notarization can be resumed");
    if (await this.assemblyDigest() !== this.record.assemblySha256) throw Error("Preserved production assembly changed");
    for (const name of RELEASE_ARTIFACT_NAMES) {
      const artifact = this.record.artifacts[name];
      if (artifact && await releaseFileSha256(join(this.originals, name)) !== artifact.sha256) throw Error(`Original artifact changed: ${name}`);
    }
    for (const name of RELEASE_ARTIFACT_NAMES.filter(name => name !== "Mochi.dmg")) {
      if (!this.record.artifacts[name]) throw Error("Production checkpoint is missing a signed package");
    }
  }

  async sealAssembly(): Promise<void> {
    if (this.record.assemblySha256) throw Error("Production assembly is already sealed");
    this.record.assemblySha256 = await this.assemblyDigest();
    for (const name of RELEASE_ARTIFACT_NAMES.filter(name => name !== "Mochi.dmg")) await this.addArtifact(name);
    await this.save();
  }

  hasArtifact(name: ArtifactName): boolean { return this.record.artifacts[name] !== undefined; }

  async addArtifact(name: ArtifactName): Promise<void> {
    if (this.hasArtifact(name)) throw Error(`Production artifact already exists: ${name}`);
    const path = join(this.originals, name);
    this.record.artifacts[name] = { sha256: await releaseFileSha256(path), submissionStarted: false };
    await chmod(path, 0o600);
    await this.save();
  }

  async notarize(name: ArtifactName, notary: ReleaseNotary): Promise<boolean> {
    const artifact = this.record.artifacts[name];
    if (!artifact) throw Error(`Unsealed production artifact: ${name}`);
    const original = join(this.originals, name);
    if (await releaseFileSha256(original) !== artifact.sha256) throw Error(`Original artifact changed: ${name}`);
    if (!artifact.submissionId) {
      if (artifact.submissionStarted) throw Error(`Submission outcome is unknown for ${name}; inspect Apple history and retained evidence. Automatic re-upload is forbidden.`);
      artifact.submissionStarted = true;
      await this.save(); // Commit intent before the external effect; a crash must not re-upload.
      const submitted = await notary.submit(original) as { id?: unknown } | null;
      if (!submitted || !SubmissionIdValidator.Check(submitted.id)) throw Error("Apple did not return a submission ID; automatic re-upload is forbidden");
      artifact.submissionId = submitted.id as string;
      await this.save(); // Save the ID before any wait or query.
    }
    const response = notaryResponse(await notary.info(artifact.submissionId));
    if (response.id !== artifact.submissionId) throw Error("Notary response belongs to another submission");
    artifact.status = response.status;
    artifact.checkedAt = new Date().toISOString();
    await this.save();
    console.log(`${name}: ${response.status} (${response.id})`);
    if (response.status === "In Progress") return false;
    const log = await notary.log(response.id);
    await atomicJson(join(this.directory, `${name}.notary.json`), log);
    if (response.status !== "Accepted") throw Error(`Apple rejected ${name}: ${response.status}; retained submission ${response.id}`);
    const proof = log as Record<string, unknown> | null;
    if (!proof || proof.status !== "Accepted" || proof.statusCode !== 0 || proof.jobId !== response.id || proof.sha256 !== artifact.sha256) {
      throw Error(`Apple log does not bind Accepted to the exact original ${name}`);
    }
    const final = join(this.candidate, name);
    if (artifact.stapledSha256) {
      if (await releaseFileSha256(final) !== artifact.stapledSha256) throw Error(`Stapled artifact changed: ${name}`);
    } else {
      const temporary = join(this.directory, `.stapling-${randomUUID()}${extname(name)}`);
      try {
        await copyFile(original, temporary);
        await chmod(temporary, 0o600);
        await notary.staple(temporary);
        await notary.validate(temporary);
        const digest = await releaseFileSha256(temporary);
        await rename(temporary, final);
        artifact.stapledSha256 = digest;
      } finally { await rm(temporary, { force: true }); }
      await this.save();
      return true;
    }
    await notary.validate(final);
    return true;
  }

  async publish(name: string, manifestSha256: string): Promise<string> {
    if (RELEASE_ARTIFACT_NAMES.some(name => !this.record.artifacts[name]?.stapledSha256)) throw Error("Production artifacts are incomplete");
    this.record.publication = { name, manifestSha256 };
    await this.save(); // Retain the destination before the atomic rename.
    return this.finishPublication();
  }

  async finishPublication(): Promise<string> {
    const publication = this.record.publication;
    if (!publication) throw Error("No publication was prepared");
    const destination = join(dirname(this.directory), publication.name);
    const staged = await lstat(this.candidate).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (staged) {
      await privateEntry(this.candidate, true);
      await this.verifyCandidate(this.candidate, publication.manifestSha256);
      try { await lstat(destination); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(this.candidate, destination);
        return destination;
      }
      throw Error("Candidate destination already exists; refusing to replace it");
    }
    await privateEntry(destination, true);
    await this.verifyCandidate(destination, publication.manifestSha256);
    return destination;
  }

  private async verifyCandidate(directory: string, digest: string): Promise<void> {
    const { manifest, manifestSha256 } = await loadReleaseCandidate(join(directory, "Mochi-Release.json"));
    if (manifestSha256 !== digest || manifest.sourceRevision !== this.record.sourceRevision) throw Error("Published candidate does not match this production run");
    for (const artifact of manifest.artifacts) {
      if (this.record.artifacts[artifact.filename as ArtifactName]?.stapledSha256 !== artifact.sha256) throw Error("Candidate differs from verified stapled bytes");
    }
    const names = (await readdir(directory)).sort();
    if (JSON.stringify(names) !== JSON.stringify([...RELEASE_ARTIFACT_NAMES, "Mochi-Release.json"].sort())) throw Error("Candidate contains unexpected files");
  }

  private async assemblyDigest(): Promise<string> {
    const hash = createHash("sha256");
    for (const name of ["payload", "scripts", "Mochi.app", "mochi-file-sync"]) {
      hash.update(name).update(await treeDigest(join(this.work, name)));
    }
    return hash.digest("hex");
  }

  private async save(): Promise<void> {
    if (!Validator.Check(this.record)) throw Error("Invalid production state transition");
    await atomicJson(this.path, this.record);
  }
}

function notaryResponse(value: unknown): { id: string; status: "In Progress" | "Accepted" | "Invalid" | "Rejected" } {
  const result = value as Record<string, unknown> | null;
  if (!result || typeof result.id !== "string" || !SubmissionIdValidator.Check(result.id)
    || !["In Progress", "Accepted", "Invalid", "Rejected"].includes(String(result.status))) throw Error("Invalid Apple submission response");
  return result as { id: string; status: "In Progress" | "Accepted" | "Invalid" | "Rejected" };
}

async function privateEntry(path: string, directory: boolean): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile()) || entry.uid !== process.getuid!()
    || (entry.mode & 0o077) !== 0 || await realpath(path) !== path) throw Error("Production evidence must be private, owned and canonical");
}

export async function releaseFileSha256(path: string): Promise<string> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) throw Error("Production artifact must be a non-empty regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (path: string): Promise<void> => {
    const entry = await lstat(path);
    hash.update(JSON.stringify([relative(root, path), entry.mode & 0o7777]));
    if (entry.isDirectory()) {
      hash.update("directory");
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (entry.isFile()) {
      hash.update("file");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } else if (entry.isSymbolicLink()) {
      const target = relative(root, await realpath(path));
      if (target.startsWith("..") || isAbsolute(target)) throw Error("Assembly symlink escapes its root");
      hash.update("symlink").update(await readlink(path));
    } else throw Error("Unsupported production assembly entry");
  };
  await visit(root);
  return hash.digest("hex");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
