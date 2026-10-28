import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isIP } from "node:net";
import { loadReleaseCandidate, publicBetaFailures, verifyReleaseAcceptance } from "./release_acceptance.ts";
import { requirePassedVerification, verificationEnvironment } from "./verify.ts";

export interface PublicationDetails {
  schemaVersion: 1;
  publisherName: string;
  downloadPageUrl: string;
  supportUrl: string;
  privacyContactEmail: string;
}

export function parsePublicationDetails(value: unknown): PublicationDetails {
  const keys = ["schemaVersion", "publisherName", "downloadPageUrl", "supportUrl", "privacyContactEmail"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    throw new Error("Publication details must contain only the schema-1 public fields");
  const details = value as PublicationDetails;
  if (details.schemaVersion !== 1) throw new Error("Publication details must use schema 1");
  for (const key of keys.slice(1) as Array<Exclude<keyof PublicationDetails, "schemaVersion">>) {
    const text = details[key];
    if (typeof text !== "string" || text !== text.trim() || !text || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text))
      throw new Error(`Publication ${key} must be one reviewed non-empty line`);
  }
  publicHttpsAddress(details.downloadPageUrl, "Publication downloadPageUrl");
  // Support is a public page or a mailbox; privacy requests always go to a mailbox.
  if (details.supportUrl.startsWith("mailto:")) publicEmail(details.supportUrl.slice("mailto:".length), "Publication supportUrl");
  else publicHttpsAddress(details.supportUrl, "Publication supportUrl");
  publicEmail(details.privacyContactEmail, "Publication privacyContactEmail");
  return details;
}

/** One plain, real public mailbox; never a reserved example host or extra mail fields. */
function publicEmail(text: string, label: string): void {
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(text) || reservedHost(text.split("@")[1]!))
    throw new Error(`${label} must be a real public contact`);
}

/** A reviewed, credential-free public address; never an example or local host. */
export function publicHttpsAddress(text: string, label: string): URL {
  const url = new URL(text);
  if (text !== text.trim() || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)
    || url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")
    || isIP(url.hostname.replace(/^\[|\]$/g, "")) || reservedHost(url.hostname.replace(/\.$/, "")))
    throw new Error(`${label} must be a real public HTTPS address`);
  return url;
}

export type PublicDocumentField = "PUBLISHER_NAME" | "DOWNLOAD_PAGE_URL" | "SUPPORT_URL" | "PRIVACY_CONTACT_EMAIL";

/** The issuer facts named by `release/public/` documents, escaped for Markdown. */
export function publicDocumentFields(details: PublicationDetails): Record<PublicDocumentField, string> {
  return {
    PUBLISHER_NAME: markdown(details.publisherName),
    DOWNLOAD_PAGE_URL: link(details.downloadPageUrl),
    SUPPORT_URL: link(details.supportUrl),
    PRIVACY_CONTACT_EMAIL: markdown(details.privacyContactEmail),
  };
}

/** Fills a public document's `{{FIELD}}` placeholders; an unknown field fails. */
export function renderPublicDocument(template: string, fields: Record<PublicDocumentField, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const replacement = (fields as Record<string, string>)[key];
    if (replacement === undefined) throw new Error(`Unknown public-document field: ${key}`);
    return replacement;
  });
}

/**
 * A release passes every acceptance checkpoint. A public beta passes only
 * PUBLIC_BETA_CHECKPOINTS, names itself a beta in its directory and notes,
 * and never moves the update feed.
 */
export type PublicationChannel = "release" | "public-beta";

export interface ReleasePublicationInput {
  channel: PublicationChannel;
  sourceRoot: string;
  candidateManifestPath: string;
  acceptanceRecordPaths: string[];
  verificationResultPath: string;
  publicationDetailsPath: string;
}

/** One read-only gate for public attachments and the website's download facts. */
export async function validateReleasePublication(input: ReleasePublicationInput) {
  for (const path of [input.sourceRoot, input.candidateManifestPath, input.verificationResultPath,
    input.publicationDetailsPath, ...input.acceptanceRecordPaths]) {
    if (!isAbsolute(path)) throw new Error("Publication inputs must use absolute paths");
  }
  if (input.acceptanceRecordPaths.length === 0 || input.acceptanceRecordPaths.length > 16)
    throw new Error("Publication requires 1–16 exact-candidate acceptance records");
  const root = await realpath(input.sourceRoot);
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], {
    env: verificationEnvironment(process.env), encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (git(["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("Publication preparation requires a clean source checkout");
  const { manifest, manifestSha256 } = await loadReleaseCandidate(input.candidateManifestPath);
  // Published files and their documents come from the candidate's own revision.
  // The checkout may have moved on, so the website changes without a new App
  // build, but it must still contain the candidate.
  try { git(["merge-base", "--is-ancestor", manifest.sourceRevision, "HEAD"]); }
  catch { throw new Error("Publication must run from the candidate source revision or a later commit that contains it"); }
  await requirePassedVerification({
    resultPath: input.verificationResultPath, sourceRoot: root,
    sourceRevision: manifest.sourceRevision, architecture: manifest.architecture,
  });
  const targets = new Set<string>();
  let minimumSystemObserved = false;
  for (const acceptanceRecordPath of input.acceptanceRecordPaths) {
    const report = await verifyReleaseAcceptance({ candidateManifestPath: input.candidateManifestPath, acceptanceRecordPath });
    const failures = input.channel === "release" ? report.failures : publicBetaFailures(report);
    if (failures.length)
      throw new Error(`${input.channel === "release" ? "Release" : "Public beta"} acceptance is incomplete: ${failures.join("; ")}`);
    if (targets.has(report.targetId)) throw new Error("Publication acceptance targets must be distinct");
    targets.add(report.targetId);
    if (report.targetMacOSVersion.split(".")[0] === manifest.minimumMacOS.split(".")[0]) minimumSystemObserved = true;
  }
  if (!minimumSystemObserved) throw new Error("Publication requires observed acceptance on the declared minimum macOS major version");
  const metadata = await lstat(input.publicationDetailsPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024)
    throw new Error("Publication details must be a bounded regular file");
  const details = parsePublicationDetails(JSON.parse(await readFile(input.publicationDetailsPath, "utf8")) as unknown);
  const channelName = input.channel === "public-beta" ? "-beta" : "";
  return { root, git, manifest, manifestSha256, details, channel: input.channel,
    directoryName: `Mochi-${manifest.productVersion}${channelName}-${manifest.architecture}-${manifestSha256.slice(0, 16)}` };
}

type ValidatedPublication = Awaited<ReturnType<typeof validateReleasePublication>>;

/** One public file of an accepted candidate, identified by its exact bytes. */
export interface PublicationFile {
  filename: string;
  sizeBytes: number;
  sha256: string;
}

type PublicationContent = PublicationFile & ({ source: string } | { bytes: Buffer });

/**
 * The exact public directory for one accepted candidate: its artifacts and
 * record byte for byte, the public documents rendered from its committed
 * sources, and their checksums. Staging writes it; upload, readback and the
 * download page accept only a directory that still equals it.
 */
async function publicationContents(input: ReleasePublicationInput, validated: ValidatedPublication): Promise<PublicationContent[]> {
  const { git, manifest, manifestSha256, details, channel } = validated;
  const candidateDirectory = resolve(input.candidateManifestPath, "..");
  const contents: PublicationContent[] = manifest.artifacts.filter(({ role }) => role === "applicationDiskImage").map(({ filename, sizeBytes, sha256 }) => ({
    filename, sizeBytes, sha256, source: join(candidateDirectory, filename),
  }));
  contents.push({
    filename: "Mochi-Release.json",
    sizeBytes: (await stat(input.candidateManifestPath)).size,
    sha256: manifestSha256,
    source: input.candidateManifestPath,
  });
  const rendered = (filename: string, text: string) => {
    const bytes = Buffer.from(text);
    contents.push({ filename, sizeBytes: bytes.length, sha256: sha256(bytes), bytes });
  };
  const fields = publicDocumentFields(details);
  for (const [source, filename] of [["quick-start.md", "README.md"], ["privacy.md", "PRIVACY.md"]] as const) {
    rendered(filename, `${renderPublicDocument(git(["show", `${manifest.sourceRevision}:release/public/${source}`]), fields)}\n`);
  }
  const architecture = manifest.architecture === "arm64" ? "Apple 芯片 Mac" : "Intel Mac";
  const limitations = manifest.limitations.length ? manifest.limitations.map((item) => `- ${markdown(item)}`).join("\n") : "本候选包未声明额外限制。";
  const beta = channel === "public-beta"
    ? "这是公开测试版：只在干净的 Mac 上验收了安装、安装权限与完整卸载；账号连接、对话等其余能力尚未在这一版逐项验收，见下方使用边界。应用内更新尚未开放。新版本发布在官方下载页；安装前先在当前 Mochi 的「关于与更新」中选择「卸载 Mochi」并保留数据，再安装新的 `Mochi.dmg`。不要把新版本直接拖进「应用程序」覆盖旧版。\n\n"
    : "";
  rendered("RELEASE_NOTES.md", `# Mochi ${manifest.productVersion}${channel === "public-beta" ? " 公开测试版" : ""}\n\n发行方：${markdown(details.publisherName)}\n\n适用设备：${architecture}，macOS ${manifest.minimumMacOS} 或更新版本。\n\n${beta}从 [官方下载页](${link(details.downloadPageUrl)}) 下载 \`Mochi.dmg\`，按 [开始使用](README.md) 安装。\`Mochi.pkg\` 仅是 App 内嵌的后台组件包，不作为公开下载文件。卸载请在 App 的“关于与更新”中选择。\n\n## 使用边界\n\n${limitations}\n\n数据处理见 [隐私说明](PRIVACY.md)；遇到问题请使用 [支持入口](${link(details.supportUrl)})。\n\n## 文件来源\n\n源码版本：\`${manifest.sourceRevision}\`。候选身份：\`${manifestSha256}\`。文件摘要见 \`SHA256SUMS.txt\`；磁盘映像及 \`Mochi-Release.json\` 均保留已验收的原始字节。\n`);
  const checksums = [...contents].sort((left, right) => (left.filename < right.filename ? -1 : 1))
    .map(({ filename, sha256 }) => `${sha256}  ${filename}`);
  rendered("SHA256SUMS.txt", `${checksums.join("\n")}\n`);
  return contents;
}

/** Stages reviewed public files. Never uploads, changes repository visibility,
 * copies acceptance attachments, or installs any product component.
 */
export async function stageReleasePublication(input: ReleasePublicationInput & {
  outputDirectory: string;
}): Promise<{ publicationDirectory: string; candidateManifestSha256: string; fileCount: number }> {
  if (!isAbsolute(input.outputDirectory)) throw new Error("Publication inputs must use absolute paths");
  const validated = await validateReleasePublication(input);
  const { root, manifestSha256, directoryName } = validated;
  const outputMetadata = await lstat(input.outputDirectory);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink() || outputMetadata.uid !== process.getuid!()
    || (outputMetadata.mode & 0o077) !== 0) throw new Error("Publication output must be an existing owner-private directory");
  const outputDirectory = await realpath(input.outputDirectory);
  const outputRelative = relative(root, outputDirectory);
  if (!outputRelative || (!outputRelative.startsWith("../") && !isAbsolute(outputRelative)))
    throw new Error("Publication output must stay outside the source checkout");
  const publicationDirectory = join(outputDirectory, directoryName);
  try {
    await lstat(publicationDirectory);
    throw new Error("Publication directory already exists; accepted files are never overwritten");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const contents = await publicationContents(input, validated);
  const staging = await mkdtemp(join(outputDirectory, ".Mochi-publication-"));
  try {
    for (const content of contents) {
      const path = join(staging, content.filename);
      if ("source" in content) {
        await copyFile(content.source, path);
        await chmod(path, 0o600);
      } else {
        await writeFile(path, content.bytes, { flag: "wx", mode: 0o600 });
      }
    }
    // Check the copied bytes as well: a source change during copying cannot be published.
    await verifyPublicationDirectory(staging, contents);
    await rename(staging, publicationDirectory);
    return { publicationDirectory, candidateManifestSha256: manifestSha256, fileCount: contents.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Re-proves a staged directory before it leaves the machine or is linked:
 * the candidate is still accepted and the directory still holds exactly the
 * bytes staging would write for it.
 */
export async function verifyStagedPublication(input: ReleasePublicationInput & { publicationDirectory: string }): Promise<{
  directoryName: string;
  files: Array<PublicationFile & { path: string }>;
}> {
  if (!isAbsolute(input.publicationDirectory)) throw new Error("Publication inputs must use absolute paths");
  const validated = await validateReleasePublication(input);
  if (basename(input.publicationDirectory) !== validated.directoryName)
    throw new Error(`Publication directory must be ${validated.directoryName} for this candidate`);
  const contents = await publicationContents(input, validated);
  await verifyPublicationDirectory(input.publicationDirectory, contents);
  return {
    directoryName: validated.directoryName,
    files: contents.map(({ filename, sizeBytes, sha256 }) => ({
      filename, sizeBytes, sha256, path: join(input.publicationDirectory, filename),
    })),
  };
}

async function verifyPublicationDirectory(directory: string, expected: readonly PublicationFile[]): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Publication directory must be a real directory");
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected.map(({ filename }) => filename).sort()))
    throw new Error("Publication directory does not contain exactly the accepted public files");
  for (const file of expected) {
    const path = join(directory, file.filename);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== file.sizeBytes || await digest(path) !== file.sha256)
      throw new Error(`Publication file ${file.filename} does not match the accepted candidate`);
  }
}

/** One HTTP representation per public file; every object in a candidate directory is immutable. */
export function publicationObjectHeaders(filename: string): { contentType: string; contentDisposition: string; cacheControl: string } {
  const cacheControl = "public, max-age=31536000, immutable";
  const download = (contentType: string) => ({ contentType, contentDisposition: `attachment; filename="${filename}"`, cacheControl });
  const view = (contentType: string) => ({ contentType, contentDisposition: `inline; filename="${filename}"`, cacheControl });
  if (filename === "Mochi.dmg") return download("application/x-apple-diskimage");
  if (filename === "Mochi-Release.json") return view("application/json");
  if (["README.md", "PRIVACY.md", "RELEASE_NOTES.md", "SHA256SUMS.txt"].includes(filename)) return view("text/plain; charset=utf-8");
  throw new Error(`No public representation is defined for ${filename}`);
}

function reservedHost(host: string): boolean {
  return /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost|local|internal)$/i.test(host);
}

function markdown(text: string): string { return text.replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&"); }
function link(text: string): string { return new URL(text).toString().replace(/[()[\]<>]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`); }

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** The inputs shared by staging, upload and readback; a public beta is chosen explicitly with a leading --public-beta. */
export function publicationArguments(values: readonly string[], usage: string): ReleasePublicationInput & { directory: string } {
  const channel: PublicationChannel = values[0] === "--public-beta" ? "public-beta" : "release";
  const [candidateManifestPath, verificationResultPath, publicationDetailsPath, directory, ...acceptanceRecordPaths] =
    channel === "public-beta" ? values.slice(1) : values;
  if (!candidateManifestPath || !verificationResultPath || !publicationDetailsPath || !directory || !acceptanceRecordPaths.length
    || [candidateManifestPath, verificationResultPath, publicationDetailsPath, directory, ...acceptanceRecordPaths].some((value) => value.startsWith("--")))
    throw new Error(`Usage: ${usage} -- [--public-beta] /absolute/Mochi-Release.json /absolute/result.json /absolute/publication.json /absolute/directory /absolute/acceptance.json [...]`);
  return {
    channel, sourceRoot: resolve(import.meta.dir, ".."), candidateManifestPath, verificationResultPath,
    publicationDetailsPath, acceptanceRecordPaths, directory,
  };
}

if (import.meta.main) {
  const { directory, ...input } = publicationArguments(process.argv.slice(2), "release:stage");
  const result = await stageReleasePublication({ ...input, outputDirectory: directory });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
