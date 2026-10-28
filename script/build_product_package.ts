import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BRIDGE_PROCESS_TYPE } from "../src/control/launchAgent.ts";
import { MINIMUM_MACOS_VERSION } from "../src/product/version.ts";
import { mochiControlManifest } from "../src/control/manifest.ts";
import { PI_WORKER_PROTOCOL_VERSION } from "../src/runtime/protocol.ts";
import { verifyOfficialLarkBinary } from "../src/product/larkBinary.ts";
import { GITHUB_REGISTRATION_RESOURCE_NAME } from "../src/product/layout.ts";
import { readGitHubClientRegistration, stageGitHubClientRegistration } from "../src/github/registration.ts";
import {
  EMBEDDED_SETUP_PACKAGE_PATH,
  INSTALLER_PAYLOAD_ROOT,
  installationComponent,
  installationComponentSource,
  installationManifest,
} from "../src/product/installation.ts";
import { developerIdApplicationRequirement, packageTrustEnvironment } from "../controlApp/build/packageTrust.ts";
import { createReleaseCandidateManifest, loadReleaseCandidate } from "./release_acceptance.ts";
import { releaseDistribution, requireDeveloperIdTeam } from "./release_distribution.ts";
import { requirePassedVerification } from "./verify.ts";
import { buildDurabilityTool, buildUpdateHelper, updateDaemonPlist } from "./build_update_helper.ts";
import { signDesktop } from "./build_desktop.ts";
import { ProcessLock } from "../src/processLock.ts";
import { ProductReleaseRun, releaseFileSha256 } from "./product_release_run.ts";
import { bunJitAvailable, requireBunEntitlements, signBunExecutable, verifyBunExecutable } from "./bun_signing.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const distDirectory = join(repositoryRoot, "dist");
const installerDirectory = join(repositoryRoot, "installer");

const diskImageBackground = {
  filename: "MochiDiskImageBackground.png",
  source: join(installerDirectory, "Resources", "MochiDiskImageBackground.png"),
} as const;
const diskImageWindow = { width: 768, height: 512 } as const;
const diskImageBackgroundPixels = { width: 1536, height: 1024 } as const;
const diskImageBackgroundPixelsPerMeter = 5669;
const diskImageVolumeIconFilename = ".VolumeIcon.icns";
const applicationIconResource = join("Contents", "Resources", "Mochi.icns");
const setFileExecutable = "/usr/bin/SetFile";
const minimumMacOSVersion = MINIMUM_MACOS_VERSION;
const packageVersion = (JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { version: string }).version;
const productControlManifest = mochiControlManifest("installed", packageVersion);
const productInstallationManifest = installationManifest(packageVersion, productControlManifest);
const diskImageSigningIdentifier = `${productInstallationManifest.hostApplication.bundleIdentifier}.disk-image`;
const buildArchitecture = currentBuildArchitecture(process.arch);

function currentBuildArchitecture(architecture: NodeJS.Architecture): "arm64" | "x86_64" {
  if (architecture === "arm64") return "arm64";
  if (architecture === "x64") return "x86_64";
  throw new Error(`Unsupported macOS build architecture: ${architecture}`);
}

interface Arguments {
  larkCliPath: string;
  githubRegistrationPath: string;
  release: boolean;
  appIdentity?: string;
  installerIdentity?: string;
  notaryProfile?: string;
  notaryKeychainPath?: string;
  releaseNotesPath?: string;
  releaseOutputDirectory?: string;
  verificationResultPath?: string;
}

interface ReleaseNotes {
  schemaVersion: 1;
  limitations: readonly string[];
}

interface ReleaseContext {
  appIdentity: string;
  installerIdentity: string;
  teamId: string;
  notaryProfile: string;
  notaryKeychainPath: string;
  notes: ReleaseNotes;
  outputDirectory: string;
  sourceRevision: string;
}

if (import.meta.main) {
  // Public product resources must be readable by the recipient and _mochi.
  // Private inputs, staging roots and final artifacts have explicit modes.
  process.umask(0o022);
  await main(process.argv.slice(2));
}

async function main(values: readonly string[]): Promise<void> {
  const resuming = values.includes("--resume-release");
  if (resuming && (values.length !== 2 || values[0] !== "--resume-release")) {
    throw Error("--resume-release takes only the original absolute production.json path");
  }
  const previous = resuming ? await ProductReleaseRun.load(values[1]!) : undefined;
  const args = parseArguments(previous?.arguments ?? values);
  const release = args.release ? await prepareRelease(args) : undefined;
  if (previous && !release) throw Error("Only release production can be resumed");
  await requirePrivateFile(args.githubRegistrationPath, "native GitHub registration");
  readGitHubClientRegistration(args.githubRegistrationPath, process.getuid!());
  await verifyOfficialLarkBinary(args.larkCliPath, buildArchitecture);
  await requireFile(resolve(args.larkCliPath, "../../LICENSE"), "official Lark package LICENSE beside its bin directory");
  await requireExecutable(setFileExecutable, "macOS SetFile");
  const lock = release ? await ProcessLock.acquire(join(release.outputDirectory, ".production.lock")) : undefined;
  void lock?.lost.then(() => { console.error("Production lock lost; stopping"); process.exit(1); });
  let work: string | undefined;
  let production: ProductReleaseRun | undefined;
  try {
    if (release) {
      const context = JSON.stringify({ ...release, architecture: buildArchitecture,
        githubRegistrationSha256: await releaseFileSha256(args.githubRegistrationPath),
        larkCliSha256: await releaseFileSha256(args.larkCliPath),
      });
      production = previous ?? await ProductReleaseRun.create(release.outputDirectory, release.sourceRevision, values, context);
      work = production.work;
      console.log(`Production evidence: ${production.path}`);
      if (previous) {
        await production.verifyContext(release.sourceRevision, context, release.outputDirectory);
        if (production.publication) {
          console.log(`Candidate: ${await production.finishPublication()}`);
          return;
        }
      } else {
        await requireFinderLayoutSession();
        await assemble(args, release, work, production.originals);
        await production.sealAssembly();
      }
      await finishRelease(production, release);
    } else {
      await requireFinderLayoutSession();
      work = await mkdtemp(join(tmpdir(), "mochi-product-package-"));
      const { outputPackage } = await assemble(args, undefined, work, distDirectory);
      await run(["/usr/sbin/pkgutil", "--expand-full", outputPackage, join(work, "expanded-development-package")], repositoryRoot);
      const diskImage = join(distDirectory, "Mochi-Development.dmg");
      await buildApplicationDiskImage({ work, applicationPath: join(work, "Mochi.app"), packagePath: outputPackage, diskImagePath: diskImage });
      for (const artifact of [diskImage, outputPackage]) await chmod(artifact, 0o600);
      console.log([diskImage, outputPackage].join("\n"));
    }
  } catch (error) {
    if (production) console.error(`Production retained at ${production.path}; resume only this checkpoint, never re-upload an unknown submission.`);
    throw error;
  } finally {
    if (!release && work) await rm(work, { recursive: true, force: true });
    await lock?.release();
  }
}

async function assemble(args: Arguments, release: ReleaseContext | undefined, work: string, outputDirectory: string): Promise<{ outputPackage: string }> {
  const larkLicensePath = resolve(args.larkCliPath, "../../LICENSE");
  const manifestPath = join(work, "MochiControlManifest.json");
  await writeFile(manifestPath, `${JSON.stringify(productControlManifest)}\n`);

  await run([process.execPath, "run", "script/build_pi_runtime.ts"], repositoryRoot);
  await run([join(distDirectory, "mochi-pi-runtime"), "--version"], repositoryRoot, `mochi-pi-runtime ${PI_WORKER_PROTOCOL_VERSION}`);
  await run(
    [join(distDirectory, "mochi-bridge"), "--version"],
    repositoryRoot,
    `mochi-bridge ${productControlManifest.bridgeVersion}`,
  );
  await signBunExecutable(join(distDirectory, "mochi-pi-runtime"), release?.appIdentity);
  await signBunExecutable(join(distDirectory, "mochi-bridge"), release?.appIdentity);
  await run(["/usr/bin/env", "bash", "script/build_and_run.sh", "--build-only"], repositoryRoot, undefined, {
    MOCHI_CONTROL_MANIFEST_SOURCE: manifestPath,
    MOCHI_APP_SIGN_IDENTITY: release?.appIdentity ?? "-",
    // The App proves its embedded package against this before root installs it.
    MOCHI_PACKAGE_TRUST: packageTrustEnvironment(
      release ? { mode: "developer-id", teamId: release.teamId } : { mode: "development" },
    ),
  });

  const payload = join(work, "payload");
  const scripts = join(work, "scripts");
  const stagedProductBin = stagedComponentPath(payload, "product-bin");
  const stagedProductResources = stagedComponentPath(payload, "product-resources");
  const stagedWorker = stagedComponentPath(payload, "runtime-worker");
  const stagedNotices = stagedComponentPath(payload, "notices");
  await mkdir(stagedProductBin, { recursive: true });
  await mkdir(join(stagedProductResources, "defaults"), { recursive: true });
  await mkdir(join(stagedProductResources, "protocol"), { recursive: true });
  await mkdir(dirname(stagedWorker), { recursive: true });
  await mkdir(stagedNotices, { recursive: true });
  await mkdir(scripts, { recursive: true });
  const durabilityTool = join(work, "mochi-file-sync");
  await buildDurabilityTool(durabilityTool);
  await run(["/usr/bin/codesign", "--force", "--sign", release?.appIdentity ?? "-", "--options", "runtime", ...(release ? ["--timestamp"] : []), durabilityTool], repositoryRoot);
  await copyExecutable(durabilityTool, join(scripts, "mochi-file-sync"));

  await copyExecutable(join(distDirectory, "mochi-bridge"), join(stagedProductBin, "mochi-bridge"));
  const updateHelper = join(stagedProductBin, "mochi-update");
  await buildUpdateHelper(updateHelper);
  await run(["/usr/bin/codesign", "--force", "--sign", release?.appIdentity ?? "-", "--options", "runtime", ...(release ? ["--timestamp"] : []), updateHelper], repositoryRoot);
  await writeFile(stagedComponentPath(payload, "update-daemon"), updateDaemonPlist(), { mode: 0o644 });
  await copyExecutable(args.larkCliPath, join(stagedProductBin, "lark-cli"));
  await copyExecutable(join(distDirectory, "mochi-pi-runtime"), stagedWorker);
  await copyProductResource(join(distDirectory, "THIRD_PARTY_NOTICES.txt"), join(stagedNotices, "THIRD_PARTY_NOTICES.txt"));
  await copyProductResource(join(repositoryRoot, "config", "bot.toml"), join(stagedProductResources, "defaults", "bot.toml"));
  await copyProductResource(join(repositoryRoot, "config", "AGENTS.md"), join(stagedProductResources, "defaults", "AGENTS.md"));
  await writeFile(join(stagedProductResources, "product.json"), `${JSON.stringify({ version: packageVersion })}\n`);
  await writeFile(
    join(stagedProductResources, "installation.json"),
    `${JSON.stringify(productInstallationManifest)}\n`,
  );
  await copyProductResource(join(repositoryRoot, "config", "protocol"), join(stagedProductResources, "protocol"));
  stageGitHubClientRegistration(args.githubRegistrationPath, join(stagedProductResources, GITHUB_REGISTRATION_RESOURCE_NAME));
  await copyProductResource(larkLicensePath, join(stagedNotices, "lark-cli-LICENSE.txt"));
  const postinstallPath = join(scripts, "postinstall");
  const preinstallPath = join(scripts, "preinstall");
  await copyExecutable(join(installerDirectory, "preinstall.sh"), preinstallPath);
  await copyExecutable(join(installerDirectory, "uninstall.sh"), join(scripts, "uninstall"));
  await writeFile(postinstallPath, renderProductPostinstall(await readFile(join(installerDirectory, "postinstall.sh"), "utf8")), { mode: 0o755 });
  await writeFile(join(scripts, "lifecycle.sh"), renderProductLifecycle(await readFile(join(installerDirectory, "lifecycle.sh"), "utf8"), release?.teamId), { mode: 0o755 });
  await writeFile(join(scripts, "installation.json"), `${JSON.stringify(productInstallationManifest)}\n`);
  await run(["/bin/bash", "-n", preinstallPath], repositoryRoot);
  await run(["/bin/bash", "-n", postinstallPath], repositoryRoot);
  await run(["/bin/bash", "-n", join(scripts, "lifecycle.sh")], repositoryRoot);
  await verifyProductPayload(payload, release);

  const componentPackage = join(work, "Mochi-component.pkg");
  const outputPackage = join(outputDirectory, args.release ? "Mochi.pkg" : "Mochi-Development.pkg");
  await run([
    "/usr/bin/pkgbuild",
    "--root", payload,
    "--scripts", scripts,
    "--identifier", "app.mochi.product",
    "--version", packageVersion,
    "--install-location", "/",
    "--ownership", "recommended",
    "--compression", "latest",
    "--min-os-version", minimumMacOSVersion,
    ...(release ? ["--sign", release.installerIdentity] : []),
    componentPackage,
  ], repositoryRoot);
  if (release) await verifyPackageSignature(componentPackage, release);
  const distributionPath = join(work, "Distribution.xml");
  await writeFile(distributionPath, distributionXml());
  await run([
    "/usr/bin/productbuild",
    "--distribution", distributionPath,
    "--package-path", work,
    ...(release ? ["--sign", release.installerIdentity] : []),
    outputPackage,
  ], repositoryRoot);

  // Preserve the signed pre-embedding App with the assembly, not a mutable dist path.
  await cp(join(distDirectory, "Mochi.app"), join(work, "Mochi.app"), { recursive: true, verbatimSymlinks: true });
  return { outputPackage };
}

async function finishRelease(production: ProductReleaseRun, release: ReleaseContext): Promise<void> {
  const auth = ["--keychain-profile", release.notaryProfile, "--keychain", release.notaryKeychainPath, "--no-progress", "--output-format", "json"];
  const notary = {
    submit: async (path: string) => JSON.parse(await captureStdout(["/usr/bin/xcrun", "notarytool", "submit", path, "--no-wait", ...auth], 30 * 60_000)) as unknown,
    info: async (id: string) => JSON.parse(await captureStdout(["/usr/bin/xcrun", "notarytool", "info", id, ...auth], 60_000)) as unknown,
    log: async (id: string) => JSON.parse(await captureStdout(["/usr/bin/xcrun", "notarytool", "log", id, ...auth], 60_000)) as unknown,
    staple: (path: string) => run(["/usr/bin/xcrun", "stapler", "staple", "-v", path], repositoryRoot),
    validate: (path: string) => run(["/usr/bin/xcrun", "stapler", "validate", "-v", path], repositoryRoot),
  };
  let packagesAccepted = true;
  const definitions = [
    { name: "Mochi.pkg" },
  ] as const;
  for (const definition of definitions) {
    await verifyPackageSignature(join(production.originals, definition.name), release);
    if (!await production.notarize(definition.name, notary)) { packagesAccepted = false; continue; }
    const path = join(production.candidate, definition.name);
    await verifyGatekeeper(path, release);
    const verificationWork = await mkdtemp(join(production.directory, "verification-"));
    try {
      await verifyProductPackage(path, join(production.work, "payload"), join(production.work, "scripts"), verificationWork, release);
    } finally { await rm(verificationWork, { recursive: true, force: true }); }
  }
  if (!packagesAccepted) { pendingProduction(production); return; }
  const diskImage = join(production.originals, "Mochi.dmg");
  if (!production.hasArtifact("Mochi.dmg")) {
    await requireFinderLayoutSession();
    await buildApplicationDiskImage({ work: production.work, applicationPath: join(production.work, "Mochi.app"),
      packagePath: join(production.candidate, "Mochi.pkg"), diskImagePath: diskImage, release });
    await production.addArtifact("Mochi.dmg");
  }
  if (!await production.notarize("Mochi.dmg", notary)) { pendingProduction(production); return; }
  const finalDiskImage = join(production.candidate, "Mochi.dmg");
  await verifyDiskImageGatekeeper(finalDiskImage);
  await verifyApplicationDiskImage(finalDiskImage, join(production.candidate, "Mochi.pkg"), release);
  const manifestPath = join(production.candidate, "Mochi-Release.json");
  // A crash after manifest creation but before rename retains the same exact set.
  const existing = await lstat(manifestPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const manifest = existing ? await loadReleaseCandidate(manifestPath) : await createReleaseCandidateManifest({
    candidateDirectory: production.candidate, sourceRevision: release.sourceRevision, productVersion: packageVersion,
    architecture: buildArchitecture, minimumMacOS: minimumMacOSVersion, limitations: [...release.notes.limitations],
  });
  if ("manifest" in manifest && (manifest.manifest.sourceRevision !== release.sourceRevision
    || manifest.manifest.productVersion !== packageVersion || manifest.manifest.architecture !== buildArchitecture
    || manifest.manifest.minimumMacOS !== minimumMacOSVersion
    || JSON.stringify(manifest.manifest.limitations) !== JSON.stringify(release.notes.limitations))) {
    throw Error("Retained candidate manifest does not match the release inputs");
  }
  const name = `Mochi-${packageVersion}-${buildArchitecture}-${manifest.manifestSha256.slice(0, 16)}`;
  console.log(`Candidate: ${await production.publish(name, manifest.manifestSha256)}`);
}

function pendingProduction(production: ProductReleaseRun): void {
  console.log(`Apple processing; no candidate published. Resume with product:package -- --resume-release ${production.path}`);
  process.exitCode = 75;
}

export function parseArguments(values: readonly string[]): Arguments {
  const result: Partial<Arguments> = { release: false };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (seen.has(value)) throw new Error(`Duplicate product packaging argument: ${value}`);
    seen.add(value);
    if (value === "--release") {
      result.release = true;
      continue;
    }
    const next = values[++index];
    if (!next) throw new Error(`Missing value for ${value}`);
    if (value === "--lark-cli") result.larkCliPath = absoluteFile(next, value);
    else if (value === "--github-registration") result.githubRegistrationPath = absoluteFile(next, value);
    else if (value === "--app-identity") result.appIdentity = next;
    else if (value === "--installer-identity") result.installerIdentity = next;
    else if (value === "--notary-profile") result.notaryProfile = next;
    else if (value === "--notary-keychain") result.notaryKeychainPath = absoluteFile(next, value);
    else if (value === "--release-notes") result.releaseNotesPath = absoluteFile(next, value);
    else if (value === "--release-output") result.releaseOutputDirectory = absoluteFile(next, value);
    else if (value === "--verification-result") result.verificationResultPath = absoluteFile(next, value);
    else throw new Error(`Unknown product packaging argument: ${value}`);
  }
  if (!result.larkCliPath || !result.githubRegistrationPath) {
    throw new Error("Usage: product:package -- --lark-cli /path/lark-cli --github-registration /path/github-oauth.json [release inputs]");
  }
  if (result.release) {
    const required = [
      ["--app-identity", result.appIdentity],
      ["--installer-identity", result.installerIdentity],
      ["--notary-profile", result.notaryProfile],
      ["--notary-keychain", result.notaryKeychainPath],
      ["--release-notes", result.releaseNotesPath],
      ["--release-output", result.releaseOutputDirectory],
      ["--verification-result", result.verificationResultPath],
    ].filter((entry) => !entry[1]).map((entry) => entry[0]);
    if (required.length > 0) {
      throw new Error(`Release packaging requires explicit ${required.join(", ")}`);
    }
  } else if (
    result.appIdentity
    || result.installerIdentity
    || result.notaryProfile
    || result.notaryKeychainPath
    || result.releaseNotesPath
    || result.releaseOutputDirectory
    || result.verificationResultPath
  ) {
    throw new Error("Release-only inputs require --release");
  }
  return result as Arguments;
}

async function prepareRelease(args: Arguments): Promise<ReleaseContext> {
  const appIdentity = args.appIdentity!;
  const installerIdentity = args.installerIdentity!;
  const appTeamId = developerIdentityTeam(appIdentity, "Application");
  const installerTeamId = developerIdentityTeam(installerIdentity, "Installer");
  if (appTeamId !== installerTeamId) {
    throw new Error("Developer ID Application and Installer identities must belong to the same team");
  }
  if (appTeamId !== requireDeveloperIdTeam(await releaseDistribution())) {
    throw new Error("Developer ID identities must belong to the Team in release/distribution.json");
  }
  const notaryProfile = text(args.notaryProfile, "notary profile");
  const notaryKeychainPath = args.notaryKeychainPath!;
  await requireFile(notaryKeychainPath, "notary keychain");
  const notesPath = args.releaseNotesPath!;
  await requireFile(notesPath, "release notes");
  const notes = parseReleaseNotes(JSON.parse(await readFile(notesPath, "utf8")) as unknown);
  const outputDirectory = await requirePrivateOutputDirectory(args.releaseOutputDirectory!);
  const status = await capture(["/usr/bin/git", "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim()) throw new Error("Release packaging requires a clean source worktree");
  const sourceRevision = (await capture(["/usr/bin/git", "rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("Release source revision is invalid");
  await requirePassedVerification({
    resultPath: args.verificationResultPath!,
    sourceRoot: repositoryRoot,
    sourceRevision,
    architecture: buildArchitecture,
  });
  // Use the same explicit file-backed Keychain for preflight and submission.
  // An unavailable profile must fail before expensive assembly and signing.
  await captureStdout([
    "/usr/bin/xcrun", "notarytool", "history",
    "--keychain-profile", notaryProfile, "--keychain", notaryKeychainPath,
    "--output-format", "json",
  ], 60_000);
  return {
    appIdentity,
    installerIdentity,
    teamId: appTeamId,
    notaryProfile,
    notaryKeychainPath,
    notes,
    outputDirectory,
    sourceRevision,
  };
}

export function developerIdentityTeam(identity: string, kind: "Application" | "Installer"): string {
  const value = text(identity, `Developer ID ${kind} identity`);
  const match = new RegExp(`^Developer ID ${kind}: .+ \\(([A-Z0-9]{10})\\)$`).exec(value);
  if (!match) {
    throw new Error(`Developer ID ${kind} identity must be one explicit certificate name with team ID`);
  }
  return match[1]!;
}

export function parseReleaseNotes(value: unknown): ReleaseNotes {
  const root = object(value, "release notes", ["schemaVersion", "limitations"]);
  if (root.schemaVersion !== 1) throw new Error("Release notes schemaVersion must be 1");
  if (!Array.isArray(root.limitations) || root.limitations.length > 32) {
    throw new Error("Release notes limitations must be an array of at most 32 entries");
  }
  const limitations = root.limitations.map((entry, index) => {
    const limitation = text(entry, `release notes limitation ${index + 1}`);
    if (limitation.length > 500) throw new Error(`Release notes limitation ${index + 1} is too long`);
    return limitation;
  });
  if (new Set(limitations).size !== limitations.length) {
    throw new Error("Release notes limitations must not contain duplicates");
  }
  return { schemaVersion: 1, limitations };
}

export function distributionXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Mochi</title>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <options customize="never" require-scripts="false" hostArchitectures="${buildArchitecture}"/>
  <allowed-os-versions><os-version min="${minimumMacOSVersion}"/></allowed-os-versions>
  <choices-outline><line choice="default"><line choice="app.mochi.product"/></line></choices-outline>
  <choice id="default"/>
  <choice id="app.mochi.product" visible="false"><pkg-ref id="app.mochi.product"/></choice>
  <pkg-ref id="app.mochi.product" version="${packageVersion}" onConclusion="none">Mochi-component.pkg</pkg-ref>
</installer-gui-script>
`;
}

async function requirePrivateOutputDirectory(path: string): Promise<string> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Release output must be an existing, real directory");
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new Error("Release output must not be group- or world-accessible");
  }
  const resolved = await realpath(path);
  const repositoryRelativePath = relative(repositoryRoot, resolved);
  if (!repositoryRelativePath.startsWith("..") && !isAbsolute(repositoryRelativePath)) {
    throw new Error("Release output must be outside the source repository");
  }
  return resolved;
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const result = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const missing = keys.filter((key) => !(key in result));
  const unknown = Object.keys(result).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) throw new Error(`${path} has an invalid shape`);
  return result;
}

function text(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.includes("\0")
    || value.includes("\n")
    || value.includes("\r")
  ) throw new Error(`${path} must be a non-empty single-line string`);
  return value.trim();
}

function absoluteFile(value: string, option: string): string {
  if (!isAbsolute(value)) throw new Error(`${option} must be an absolute path`);
  return resolve(value);
}

async function requireFile(path: string, label: string): Promise<void> {
  const entry = await stat(path);
  if (!entry.isFile() || entry.size === 0) throw new Error(`${label} must be a non-empty file`);
}

async function requirePrivateFile(path: string, label: string): Promise<void> {
  await requireFile(path, label);
  if (((await stat(path)).mode & 0o077) !== 0) throw new Error(`${label} must not be group- or world-readable`);
}

async function requireExecutable(path: string, label: string): Promise<void> {
  await requireFile(path, label);
  if (((await stat(path)).mode & 0o111) === 0) throw new Error(`${label} must be executable`);
}

async function copyExecutable(source: string, destination: string): Promise<void> {
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}

/** Package copies have public resource modes; private build inputs keep theirs. */
export async function copyProductResource(source: string, destination: string): Promise<void> {
  const entry = await lstat(source);
  if (entry.isDirectory()) {
    await mkdir(destination, { recursive: true });
    await chmod(destination, 0o755);
    for (const name of await readdir(source)) {
      await copyProductResource(join(source, name), join(destination, name));
    }
  } else if (entry.isFile()) {
    await copyFile(source, destination);
    await chmod(destination, 0o644);
  } else {
    throw new Error("Product resources must be regular files or directories");
  }
}

function stagedComponentPath(payload: string, id: string): string {
  return join(payload, installationComponentSource(
    productInstallationManifest,
    installationComponent(productInstallationManifest, id),
  ).slice(1));
}

async function verifyProductPayload(
  payload: string,
  release?: ReleaseContext,
): Promise<void> {
  const entries = await payloadEntries(payload);
  const stagedRoot = INSTALLER_PAYLOAD_ROOT.slice(1);
  const required = [
    `${stagedRoot}/Product/bin/mochi-bridge`,
    `${stagedRoot}/Product/bin/lark-cli`,
    `${stagedRoot}/Product/bin/mochi-update`,
    `${stagedRoot}/Product/app.mochi.update.plist`,
    `${stagedRoot}/Product/Resources/product.json`,
    `${stagedRoot}/Product/Resources/installation.json`,
    `${stagedRoot}/Product/Resources/${GITHUB_REGISTRATION_RESOURCE_NAME}`,
    `${stagedRoot}/Runtime/mochi-pi-runtime`,
    `${stagedRoot}/Documentation/mochi/THIRD_PARTY_NOTICES.txt`,
    `${stagedRoot}/Documentation/mochi/lark-cli-LICENSE.txt`,
  ];
  for (const path of required) {
    if (!entries.has(path)) throw new Error(`Product payload is missing ${path}`);
  }
  const forbiddenNames = new Set([".env", ".git", "node_modules", "package.json", "Enrollment", "enrollment.json", "deployment.env", "github-app-private-key.pem"]);
  for (const path of entries) {
    if (path.split("/").some((part) => forbiddenNames.has(part)) || path.endsWith(".ts")) {
      throw new Error(`Product payload contains a developer artifact: ${path}`);
    }
    if (
      path.startsWith("Applications/")
      || path.startsWith("Library/Application Support/Mochi/")
      || path === "usr/local/libexec/mochi-pi-runtime"
      || path.startsWith("usr/local/share/doc/mochi/")
    ) {
      throw new Error(`Product payload bypasses the installation stage: ${path}`);
    }
  }
  const bridge = join(stagedComponentPath(payload, "product-bin"), "mochi-bridge");
  const worker = stagedComponentPath(payload, "runtime-worker");
  const larkCli = join(stagedComponentPath(payload, "product-bin"), "lark-cli");
  const updateHelper = join(stagedComponentPath(payload, "product-bin"), "mochi-update");
  await run([updateHelper, "--version"], repositoryRoot, "mochi-update 1");
  await run(["/usr/bin/codesign", "--verify", "--strict", ...(release ? [`-R=${developerIdApplicationRequirement(release.teamId)}`] : []), updateHelper], repositoryRoot);
  if (await readFile(stagedComponentPath(payload, "update-daemon"), "utf8") !== updateDaemonPlist()) throw Error("Unexpected update service authority");
  const productResources = stagedComponentPath(payload, "product-resources");
  // Exercise the same compiled command the privileged installer calls.
  await run(
    [bridge, "--validate-github-registration", join(productResources, GITHUB_REGISTRATION_RESOURCE_NAME)],
    repositoryRoot,
  );
  const installationManifestPath = join(
    productResources,
    "installation.json",
  );
  if (
    JSON.stringify(JSON.parse(await readFile(installationManifestPath, "utf8")))
    !== JSON.stringify(productInstallationManifest)
  ) {
    throw new Error("Product resources carry an unexpected installation contract");
  }
  const productMetadata = JSON.parse(await readFile(join(productResources, "product.json"), "utf8")) as unknown;
  if (JSON.stringify(productMetadata) !== JSON.stringify({ version: packageVersion })) {
    throw new Error("Product payload carries unexpected version metadata");
  }
  await requireFile(join(stagedComponentPath(payload, "notices"), "THIRD_PARTY_NOTICES.txt"), "third-party notices");
  await requireFile(join(stagedComponentPath(payload, "notices"), "lark-cli-LICENSE.txt"), "lark-cli license");
  await run(
    [bridge, "--version"],
    repositoryRoot,
    `mochi-bridge ${productControlManifest.bridgeVersion}`,
  );
  await run([worker, "--version"], repositoryRoot, `mochi-pi-runtime ${PI_WORKER_PROTOCOL_VERSION}`);
  await verifyOfficialLarkBinary(larkCli, buildArchitecture);
  for (const executable of [bridge, worker]) {
    await verifyExecutableArchitecture(executable);
    await verifyBunExecutable(executable);
    if (release) await verifyDeveloperCodeSignature(executable, release);
  }
}

async function verifyExecutableArchitecture(path: string): Promise<void> {
  const architectures = (await capture(["/usr/bin/lipo", "-archs", path])).trim().split(/\s+/);
  if (!architectures.includes(buildArchitecture)) {
    throw new Error(`${basename(path)} does not support the release architecture ${buildArchitecture}`);
  }
}

export async function payloadEntries(root: string): Promise<ReadonlySet<string>> {
  const result = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      result.add(name);
      if (entry.isSymbolicLink()) throw new Error(`Product payload must not contain symlinks: ${name}`);
      const mode = (await lstat(path)).mode & 0o7777;
      const readable = entry.isDirectory() ? 0o555 : 0o444;
      if ((mode & readable) !== readable || (mode & 0o7022) !== 0) {
        throw new Error(`Product payload permissions are unsafe or inaccessible: ${name} (${mode.toString(8)})`);
      }
      if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile()) throw new Error(`Product payload contains an unsupported entry: ${name}`);
    }
  };
  await visit(root);
  return result;
}

interface CodeSignatureProof {
  identifier: string;
  teamId: string;
  authorities: readonly string[];
  hardenedRuntime: boolean;
  timestamped: boolean;
}

export function parseCodeSignature(value: string): CodeSignatureProof {
  const lines = value.split(/\r?\n/);
  const field = (name: string): string => {
    const result = lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).trim();
    if (!result) throw new Error(`Code signature is missing ${name}`);
    return result;
  };
  return {
    identifier: field("Identifier"),
    teamId: field("TeamIdentifier"),
    authorities: lines
      .filter((line) => line.startsWith("Authority="))
      .map((line) => line.slice("Authority=".length).trim()),
    hardenedRuntime: lines.some((line) => /(?:^|\s)flags=.*\(.*runtime.*\)/.test(line)),
    timestamped: lines.some((line) => line.startsWith("Timestamp=") && !line.endsWith("=none")),
  };
}

async function verifyDeveloperCodeSignature(
  path: string,
  release: ReleaseContext,
  expectedIdentifier?: string,
): Promise<void> {
  await run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", path], repositoryRoot);
  const proof = parseCodeSignature(await capture(["/usr/bin/codesign", "-dv", "--verbose=4", path]));
  if (
    proof.teamId !== release.teamId
    || (expectedIdentifier !== undefined && proof.identifier !== expectedIdentifier)
    || !proof.authorities.includes(release.appIdentity)
    || !proof.hardenedRuntime
    || !proof.timestamped
  ) {
    throw new Error(`${basename(path)} is not signed with the intended timestamped Developer ID Application identity`);
  }
}

async function verifyPackageSignature(path: string, release: ReleaseContext): Promise<void> {
  const proof = await capture(["/usr/sbin/pkgutil", "--check-signature", path]);
  if (
    !proof.includes("Certificate Chain:")
    || !proof.includes(`1. ${release.installerIdentity}`)
  ) {
    throw new Error(`${basename(path)} is not signed with the intended Developer ID Installer identity`);
  }
}

export function verifyDiskImageSigningProof(output: string, appIdentity: string): void {
  const proof = parseCodeSignature(output);
  if (
    proof.identifier !== diskImageSigningIdentifier
    || proof.teamId !== developerIdentityTeam(appIdentity, "Application")
    || proof.authorities[0] !== appIdentity
    || !proof.timestamped
  ) {
    throw new Error("Disk image is not signed with the intended timestamped Developer ID Application identity");
  }
}

async function verifyDiskImageSignature(path: string, release: ReleaseContext): Promise<void> {
  await run([
    "/usr/bin/codesign", "--verify", "--strict", "--verbose=2",
    `-R=${developerIdApplicationRequirement(release.teamId)}`, path,
  ], repositoryRoot);
  verifyDiskImageSigningProof(await capture(["/usr/bin/codesign", "-dv", "--verbose=4", path]), release.appIdentity);
}

async function verifyGatekeeper(path: string, release: ReleaseContext): Promise<void> {
  // pkgutil owns signer/Team proof. spctl's package assessment does not
  // consistently print origin; its structured verdict owns Gatekeeper trust.
  await verifyPackageSignature(path, release);
  verifyNotarizedAssessment(await captureStdout([
    "/usr/sbin/spctl", "--assess", "--type", "install", "--raw", path,
  ]));
}

export function verifyNotarizedAssessment(plist: string): void {
  // A valid spctl plist may contain dates, which plutil cannot convert to JSON.
  // Extract only the typed fields that own the trust decision.
  const field = (key: string, type: "bool" | "string"): string => {
    const parsed = Bun.spawnSync([
      "/usr/bin/plutil", "-extract", key, "raw", "-expect", type, "-n", "-o", "-", "-",
    ], { stdin: Buffer.from(plist), stdout: "pipe", stderr: "pipe" });
    if (parsed.exitCode !== 0) throw new Error(`Invalid Gatekeeper assessment field: ${key}`);
    return parsed.stdout.toString();
  };
  if (field("assessment:verdict", "bool") !== "true"
    || field("assessment:authority.assessment:authority:source", "string") !== "Notarized Developer ID") {
    throw new Error("Gatekeeper did not accept the artifact as notarized Developer ID software");
  }
}

async function verifyProductPackage(
  packagePath: string,
  sourcePayload: string,
  sourceScripts: string,
  work: string,
  release: ReleaseContext,
): Promise<void> {
  const expanded = join(work, "verified-product-package");
  await run(["/usr/sbin/pkgutil", "--expand-full", packagePath, expanded], repositoryRoot);
  const component = join(expanded, "Mochi-component.pkg");
  await verifyPackageInfo(join(component, "PackageInfo"), "app.mochi.product");
  const expandedPayload = join(component, "Payload");
  await verifyProductPayload(expandedPayload, release);
  await verifyExactTree(sourcePayload, expandedPayload, "product payload");
  for (const name of ["preinstall", "postinstall", "uninstall", "lifecycle.sh", "installation.json", "mochi-file-sync"]) {
    await verifyExactFile(
      join(component, "Scripts", name),
      await readFile(join(sourceScripts, name)),
      `packaged ${name}`,
    );
  }
  await verifyExpandedDistribution(join(expanded, "Distribution"));
}

export async function verifyExpandedDistribution(path: string): Promise<void> {
  const queries: readonly [string, string][] = [
    ["string(/installer-gui-script/title)", "Mochi"],
    ["string(/installer-gui-script/domains/@enable_anywhere)", "false"],
    ["string(/installer-gui-script/domains/@enable_currentUserHome)", "false"],
    ["string(/installer-gui-script/domains/@enable_localSystem)", "true"],
    ["string(/installer-gui-script/options/@hostArchitectures)", buildArchitecture],
    ["string(/installer-gui-script/allowed-os-versions/os-version/@min)", minimumMacOSVersion],
    ["string(/installer-gui-script/pkg-ref[@id='app.mochi.product'][@version]/@version)", packageVersion],
    ["normalize-space(/installer-gui-script/pkg-ref[@id='app.mochi.product'][@version]/text())", "#Mochi-component.pkg"],
  ];
  for (const [query, expected] of queries) {
    const value = (await capture(["/usr/bin/xmllint", "--xpath", query, path])).trim();
    if (value !== expected) throw new Error("Expanded product Distribution does not match the release contract");
  }
}


export async function verifyPackageInfo(path: string, identifier: string): Promise<void> {
  const source = await readFile(path, "utf8");
  if (
    !new RegExp(`\\bidentifier="${escapeRegularExpression(identifier)}"`).test(source)
    || !new RegExp(`\\bversion="${escapeRegularExpression(packageVersion)}"`).test(source)
  ) {
    throw new Error(`${identifier} package metadata does not match the release contract`);
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function verifyExactTree(expectedRoot: string, actualRoot: string, label: string): Promise<void> {
  const expected = await payloadEntries(expectedRoot);
  const actual = await payloadEntries(actualRoot);
  const expectedNames = [...expected].sort();
  const actualNames = [...actual].sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error(`${label} inventory changed during package assembly`);
  }
  for (const name of expectedNames) {
    const expectedPath = join(expectedRoot, name);
    const actualPath = join(actualRoot, name);
    const expectedStat = await stat(expectedPath);
    const actualStat = await stat(actualPath);
    if (expectedStat.isFile() !== actualStat.isFile() || expectedStat.isDirectory() !== actualStat.isDirectory()) {
      throw new Error(`${label} entry type changed: ${name}`);
    }
    if ((expectedStat.mode & 0o777) !== (actualStat.mode & 0o777)) {
      throw new Error(`${label} mode changed: ${name}`);
    }
    if (expectedStat.isFile()) {
      await verifyExactFile(actualPath, await readFile(expectedPath), `${label} file ${name}`);
    }
  }
}

async function verifyExactFile(path: string, expected: Uint8Array, label: string): Promise<void> {
  const actual = await readFile(path);
  if (!actual.equals(expected)) throw new Error(`${label} does not match its source`);
}

async function verifyDiskImageBackground(path: string): Promise<void> {
  const png = await readFile(path);
  const hasPngHeader = png.length >= 24
    && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && png.toString("ascii", 12, 16) === "IHDR";
  const width = hasPngHeader ? png.readUInt32BE(16) : 0;
  const height = hasPngHeader ? png.readUInt32BE(20) : 0;
  const colorType = hasPngHeader ? png[25] : undefined;
  const density = pngPhysicalPixelDensity(png);
  if (
    width !== diskImageBackgroundPixels.width
    || height !== diskImageBackgroundPixels.height
    || colorType !== 2
    || density === undefined
    || density.x !== diskImageBackgroundPixelsPerMeter
    || density.y !== diskImageBackgroundPixelsPerMeter
    || density.unit !== 1
  ) {
    throw new Error(
      `Mochi disk-image background must be a ${diskImageBackgroundPixels.width}x${diskImageBackgroundPixels.height} 144 ppi RGB PNG`,
    );
  }
}

function pngPhysicalPixelDensity(
  png: Buffer,
): { readonly x: number; readonly y: number; readonly unit: number } | undefined {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const dataLength = png.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const nextChunk = dataStart + dataLength + 4;
    if (nextChunk > png.length) return undefined;
    if (png.toString("ascii", typeStart, dataStart) === "pHYs") {
      if (dataLength !== 9) return undefined;
      return {
        x: png.readUInt32BE(dataStart),
        y: png.readUInt32BE(dataStart + 4),
        unit: png[dataStart + 8]!,
      };
    }
    offset = nextChunk;
  }
  return undefined;
}

async function buildApplicationDiskImage(input: {
  work: string;
  applicationPath: string;
  packagePath: string;
  diskImagePath: string;
  release?: ReleaseContext;
}): Promise<void> {
  const root = join(input.work, "application-disk-image");
  const application = join(root, "Mochi.app");
  const backgroundDirectory = join(root, ".background");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await cp(input.applicationPath, application, { recursive: true });
  await copyProductResource(input.packagePath, join(application, EMBEDDED_SETUP_PACKAGE_PATH));
  await mkdir(backgroundDirectory, { recursive: true });
  await verifyDiskImageBackground(diskImageBackground.source);
  await copyProductResource(
    diskImageBackground.source,
    join(backgroundDirectory, diskImageBackground.filename),
  );
  await symlink("/Applications", join(root, "Applications"));
  await signDesktop(application, input.release?.appIdentity);
  if (input.release) {
    await verifyDeveloperCodeSignature(application, input.release, "app.mochi.companion");
  }

  const writableDiskImage = join(input.work, "Mochi-writable.dmg");
  const layoutVolumeName = `Mochi Layout ${process.pid}`;
  await rm(input.diskImagePath, { force: true });
  await rm(writableDiskImage, { force: true });
  await run([
    "/usr/bin/hdiutil", "create",
    "-quiet",
    "-volname", layoutVolumeName,
    "-srcfolder", root,
    "-format", "UDRW",
    writableDiskImage,
  ], repositoryRoot);
  await styleDiskImage(
    writableDiskImage,
    join(application, applicationIconResource),
  );
  await run([
    "/usr/bin/hdiutil", "convert",
    "-quiet",
    writableDiskImage,
    "-format", "UDZO",
    "-imagekey", "zlib-level=9",
    "-o", input.diskImagePath,
  ], repositoryRoot);
  await rm(writableDiskImage, { force: true });
  if (input.release) {
    await run([
      "/usr/bin/codesign", "--sign", input.release.appIdentity, "--timestamp",
      "--identifier", diskImageSigningIdentifier, input.diskImagePath,
    ], repositoryRoot);
  }
  await verifyApplicationDiskImage(input.diskImagePath, input.packagePath, input.release);
}

async function requireFinderLayoutSession(): Promise<void> {
  try {
    await captureStdout([
      "/usr/bin/osascript",
      "-e",
      'with timeout of 10 seconds\n  tell application "Finder" to get name\nend timeout',
    ]);
  } catch {
    throw new Error(
      "Product packaging requires a logged-in graphical macOS session with Finder available for the disk-image layout",
    );
  }
}

export function finderDiskImageLayoutScript(): string {
  return `on run argv
  set backgroundImage to POSIX file ((item 1 of argv) & "/.background/${diskImageBackground.filename}")
  set volumeName to item 2 of argv
  tell application "Finder"
    set targetDisk to disk volumeName
    tell targetDisk
      open
      set diskWindow to container window
      set current view of diskWindow to icon view
      set toolbar visible of diskWindow to false
      set statusbar visible of diskWindow to false
      set viewOptions to icon view options of diskWindow
      set icon size of viewOptions to 128
      set text size of viewOptions to 14
      set background picture of viewOptions to backgroundImage
      set bounds of diskWindow to {120, 120, ${120 + diskImageWindow.width}, ${120 + diskImageWindow.height}}
      set position of item "Mochi.app" to {220, 275}
      set position of item "Applications" to {548, 275}
      update without registering applications
      delay 2
      close diskWindow
    end tell
  end tell
end run`;
}

async function styleDiskImage(
  diskImagePath: string,
  volumeIconSourcePath: string,
): Promise<void> {
  // Finder can only style a disk that is visible as a mounted volume. A
  // private `-nobrowse` mountpoint is intentionally not used here: Finder
  // cannot resolve it as a `disk`, so the layout script would fail closed.
  let mount: string | undefined;
  let mounted = false;
  let detachTarget: string | undefined;
  try {
    const attachOutput = await capture([
      "/usr/bin/hdiutil", "attach", "-readwrite", diskImagePath,
    ]);
    mounted = true;
    const attachedPartition = /\/dev\/(disk\d+s\d+)[^\n]*\/Volumes\/[^\n]+/.exec(attachOutput)?.[1];
    if (attachedPartition) detachTarget = `/dev/${attachedPartition}`;
    const mountLine = attachOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.includes("/Volumes/"));
    mount = mountLine?.slice(mountLine.indexOf("/Volumes/")).trim();
    if (!mount?.startsWith("/Volumes/")) {
      throw new Error("Finder disk-image attach did not expose a visible /Volumes mountpoint");
    }
    if (!detachTarget) throw new Error("Finder disk-image attach did not expose a detachable volume");
    const diskInfo = await capture(["/usr/sbin/diskutil", "info", mount]);
    const mountedVolumeName = /^\s*Volume Name:\s*(.+)$/m.exec(diskInfo)?.[1]?.trim();
    if (!mountedVolumeName) throw new Error("Finder disk-image mount did not expose a volume name");
    await run([
      "/usr/bin/osascript",
      "-e",
      finderDiskImageLayoutScript(),
      mount,
      mountedVolumeName,
    ], repositoryRoot);
    // Finder rewrites the root metadata while applying the icon-view layout and removes
    // a pre-existing custom volume icon. Install the icon last so the final image keeps
    // the same branded identity without affecting the authored .DS_Store arrangement.
    await copyFile(volumeIconSourcePath, join(mount, diskImageVolumeIconFilename));
    await run([setFileExecutable, "-a", "V", join(mount, diskImageVolumeIconFilename)], repositoryRoot);
    await run([setFileExecutable, "-a", "C", mount], repositoryRoot);
    await run(["/usr/sbin/diskutil", "renameVolume", mount, "Mochi"], repositoryRoot);
    await run(["/bin/sync"], repositoryRoot);
  } finally {
    if (mounted && detachTarget) await run(["/usr/bin/hdiutil", "detach", "-quiet", detachTarget], repositoryRoot);
  }
}

async function verifyApplicationDiskImage(
  diskImagePath: string,
  packagePath: string,
  release: ReleaseContext | undefined,
): Promise<void> {
  if (release) await verifyDiskImageSignature(diskImagePath, release);
  await run(["/usr/bin/hdiutil", "verify", "-quiet", diskImagePath], repositoryRoot);
  const mountRoot = await mkdtemp(join(tmpdir(), "mochi-application-mount-"));
  const mount = join(mountRoot, "Mochi");
  await mkdir(mount);
  let mounted = false;
  try {
    await run([
      "/usr/bin/hdiutil", "attach", "-quiet", "-readonly", "-nobrowse",
      "-mountpoint", mount,
      diskImagePath,
    ], repositoryRoot);
    mounted = true;
    const entries = (await readdir(mount)).filter((entry) => !entry.startsWith(".")).sort();
    if (JSON.stringify(entries) !== JSON.stringify(["Applications", "Mochi.app"])) {
      throw new Error("Mochi disk image must expose only the App and Applications link");
    }
    const applicationsLink = await lstat(join(mount, "Applications"));
    const applicationsTarget = await realpath(join(mount, "Applications"));
    if (!applicationsLink.isSymbolicLink() || applicationsTarget !== "/Applications") {
      throw new Error("Mochi disk image Applications entry is not the canonical Finder link");
    }
    const application = join(mount, "Mochi.app");
    const embeddedPackage = join(application, EMBEDDED_SETUP_PACKAGE_PATH);
    await verifyExactFile(embeddedPackage, await readFile(packagePath), "Mochi embedded setup package");
    if (((await lstat(embeddedPackage)).mode & 0o7777) !== 0o644) {
      throw new Error("Mochi embedded setup package must be readable by every recipient account");
    }
    await verifyExactFile(
      join(mount, diskImageVolumeIconFilename),
      await readFile(join(application, applicationIconResource)),
      "Mochi disk-image volume icon",
    );
    await run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", application], repositoryRoot);
    if (release) await verifyDeveloperCodeSignature(application, release, "app.mochi.companion");
    await requireBunEntitlements(application);
    if (!(await bunJitAvailable(join(application, "Contents", "MacOS", "Mochi")))) {
      throw new Error("Mochi disk image App lost Bun's JIT under its signature");
    }
    const identifier = (await capture([
      "/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-",
      join(application, "Contents", "Info.plist"),
    ])).trim();
    const version = (await capture([
      "/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-",
      join(application, "Contents", "Info.plist"),
    ])).trim();
    if (identifier !== productInstallationManifest.hostApplication.bundleIdentifier || version !== packageVersion) {
      throw new Error("Mochi disk image App identity or version drifted");
    }
    const controlManifest = JSON.parse(
      await readFile(join(application, "Contents", "Resources", "MochiControlManifest.json"), "utf8"),
    ) as unknown;
    if (JSON.stringify(controlManifest) !== JSON.stringify(productControlManifest)) {
      throw new Error("Mochi disk image App carries an unexpected compatibility manifest");
    }
  } finally {
    if (mounted) await run(["/usr/bin/hdiutil", "detach", "-quiet", mount], repositoryRoot);
    await rm(mountRoot, { recursive: true, force: true });
  }
}

async function verifyDiskImageGatekeeper(path: string): Promise<void> {
  verifyNotarizedAssessment(await captureStdout([
    "/usr/sbin/spctl", "--assess", "--type", "open",
    "--context", "context:primary-signature", "--raw", path,
  ]));
}

async function run(
  command: readonly string[],
  cwd: string,
  expectedOutput?: string,
  environment: Record<string, string> = {},
): Promise<void> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: expectedOutput ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = expectedOutput ? await new Response(child.stdout).text() : "";
  const code = await child.exited;
  if (code !== 0) throw new Error(`${basename(command[0]!)} exited ${code}`);
  if (expectedOutput && output.trim() !== expectedOutput) {
    throw new Error(`${basename(command[0]!)} returned an unexpected version`);
  }
}

async function capture(command: readonly string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${basename(command[0]!)} exited ${code}`);
  return `${stdout}${stderr}`;
}

async function captureStdout(command: readonly string[], timeout?: number): Promise<string> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const deadline = timeout === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`${basename(command[0]!)} exceeded its ${timeout}ms deadline`);
    if (code !== 0) {
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`${basename(command[0]!)} exited ${code}${detail ? `: ${detail}` : ""}`);
    }
    return stdout;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

export function renderProductLifecycle(source: string, teamId?: string): string {
  const marker = "@MOCHI_HOST_APPLICATION_REQUIREMENT@";
  if (source.split(marker).length !== 2) throw new Error("Lifecycle template must have exactly one host signature marker");
  return source.replace(marker, teamId === undefined ? "" : developerIdApplicationRequirement(teamId));
}

export function renderProductPostinstall(source: string): string {
  const marker = "@MOCHI_BRIDGE_PROCESS_TYPE@";
  if (source.split(marker).length !== 2) throw new Error("Installer must contain exactly one Bridge scheduling marker");
  return source.replace(marker, BRIDGE_PROCESS_TYPE);
}
