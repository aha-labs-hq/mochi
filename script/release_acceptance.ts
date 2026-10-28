import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import Schema from "typebox/schema";

const CANDIDATE_MANIFEST_NAME = "Mochi-Release.json";
const MAXIMUM_RECORD_BYTES = 1024 * 1024;

const ARTIFACTS = [
  { role: "applicationDiskImage", filename: "Mochi.dmg" },
  { role: "privilegedPackage", filename: "Mochi.pkg" },
] as const;

export const RELEASE_ACCEPTANCE_SCENARIOS = [
  {
    id: "release-security",
    checkpoints: [
      "historical-credential-exposure-inventory-reviewed",
      "every-affected-retired-credential-revoked",
      "current-github-authority-live-verified",
      "public-user-documents-and-data-disclosure-reviewed",
    ],
  },
  {
    id: "fresh-install",
    checkpoints: [
      "clean-supported-target",
      "disk-image-launch-stops-before-authorization",
      "app-dragged-to-applications",
      "standard-user-separate-administrator-authorization",
      "background-preparation-completed-in-app",
      "developer-id-signature",
      "notarization-and-gatekeeper",
      "chatgpt-oauth-completed",
      "runtime-preparation-completed",
      "new-bot-paused-until-explicit-duty-start",
      "feishu-ready",
      "github-ready",
      "checkout-and-toolchain-independent",
    ],
  },
  {
    id: "installed-permissions",
    checkpoints: [
      "installed-paths-match-declared-owner-and-mode",
      "system-ancestors-deny-unprivileged-replacement",
      "material-acls-match-exact-runtime-access",
      "sudo-rules-limited-to-pinned-worker",
    ],
  },
  {
    id: "release-signature-runtime",
    checkpoints: [
      "app-bridge-and-worker-jit-under-release-signature",
      "turn-sandbox-starts-under-release-signature",
      "sandbox-denies-reads-outside-turn-workspace",
      "sandbox-denies-private-network-and-loopback",
    ],
  },
  {
    id: "customer-connections",
    checkpoints: [
      "new-feishu-app-default-scopes-verified",
      "feishu-organization-approval-and-recovery",
      "selected-groups-and-projects-persist",
      "only-selected-projects-readable",
      "github-issue-write-as-app-and-authoritative-readback",
      "github-grant-revocation-blocks-old-authority",
      "same-topic-steer-and-cross-topic-order",
      "message-materials-and-unreadable-content-disclosed",
      "mail-user-authorization-and-selected-mailbox-read",
      "mail-deselection-and-disconnection-block-read",
    ],
  },
  {
    id: "independent-bots",
    checkpoints: [
      "shared-chatgpt-and-model-api-connection-selection",
      "model-api-key-never-enters-renderer-or-diagnostics",
      "bot-memory-instructions-and-resources-isolated",
      "busy-shared-account-change-refused",
      "pause-and-resume-preserve-permanent-session",
      "instructions-conflict-and-next-turn-boundary",
    ],
  },
  {
    id: "schedules",
    checkpoints: [
      "natural-language-create-and-change-read-back",
      "real-due-result-at-agreed-location",
      "pause-cancel-and-accepted-work-semantics",
      "sleep-recovery-latest-occurrence-without-replay",
      "resource-revocation-blocks-dispatch-and-delivery",
      "scheduled-work-cannot-write-or-inherit-human-authority",
    ],
  },
  {
    id: "login-continuity",
    checkpoints: [
      "browser-login-cancelled",
      "browser-login-resumed",
      "quit-and-relaunch-during-setup",
      "reboot-during-setup",
      "prepared-session-identity-unchanged",
    ],
  },
  {
    id: "service-unavailability",
    checkpoints: [
      "offline-single-safe-recovery",
      "feishu-single-safe-recovery",
      "github-single-safe-recovery",
      "chatgpt-single-safe-recovery",
      "browser-single-safe-recovery",
    ],
  },
  {
    id: "fake-ip-proxy",
    checkpoints: [
      "fake-ip-resolution-active-on-target",
      "private-network-and-loopback-unreachable",
      "network-tool-outcome-truthful",
      "product-connections-survive-proxy",
    ],
  },
  {
    id: "login-items",
    checkpoints: [
      "background-item-name-recorded",
      "disabled-background-item-reported-with-one-recovery",
      "no-on-duty-claim-while-disabled",
      "re-enabled-background-item-resumes-same-record",
    ],
  },
  {
    id: "in-app-update",
    checkpoints: [
      "signed-n-to-n-plus-one-without-finder-or-installer-ui",
      "helper-peer-team-path-and-candidate-rejection",
      "busy-bots-queues-schedules-and-final-delivery-settle",
      "login-compaction-and-unsaved-settings-preserved",
      "paused-and-unconnected-bots-remain-paused",
      "same-candidate-resume-and-corruption-rejection",
      "feed-withdrawal-rechecked-at-cutover",
      "permission-cancellation-and-account-switch-recovery",
      "whole-app-and-components-restore-before-intake",
      "finalized-cleanup-never-rolls-back-accepted-work",
      "accounts-history-cwd-policy-and-selection-continuity",
      "offline-window-message-delivery-boundaries-recorded",
      "window-route-and-bot-selection-restored",
      "download-wait-offline-and-interactive-times-measured",
    ],
  },
  {
    id: "interrupted-update",
    checkpoints: [
      "before-existing-service-stop",
      "after-existing-service-stop",
      "after-staged-state-commit",
      "after-new-service-bootstrap",
    ],
  },
  {
    id: "repair",
    checkpoints: [
      "same-app-repair",
      "owned-artifacts-converged",
      "mutable-state-preserved",
      "single-runtime-ready",
      "exact-candidate-remains-installed",
    ],
  },
  {
    id: "multi-user-mac",
    checkpoints: [
      "second-user-cannot-read-or-control-first-user-bot",
      "second-user-cannot-run-worker-through-sudo",
      "pre-created-shared-directory-with-foreign-acl-refused-or-reset",
      "second-user-opening-mochi-sees-one-truthful-next-step",
    ],
  },
  {
    id: "uninstall",
    checkpoints: [
      "in-app-uninstall-cancel-preserves-installation",
      "uninstall-waits-for-accepted-work",
      "keep-data-uninstall-confirmed",
      "executable-authority-removed",
      "configuration-oauth-session-preserved",
      "exact-keep-data-residue",
      "same-candidate-reinstalled",
      "delete-all-uninstall-confirmed",
      "all-product-data-and-service-user-removed",
      "exact-delete-all-residue",
    ],
  },
  {
    id: "accessibility",
    checkpoints: [
      "voiceover",
      "keyboard-focus",
      "reduce-motion",
      "window-reflow",
      "problem-state-announcement",
    ],
  },
] as const;

type AcceptanceCheckpointId = {
  [Scenario in typeof RELEASE_ACCEPTANCE_SCENARIOS[number] as Scenario["id"]]: `${Scenario["id"]}/${Scenario["checkpoints"][number]}`
}[typeof RELEASE_ACCEPTANCE_SCENARIOS[number]["id"]];

/**
 * What a public beta must prove on its clean target, as the owner decided on
 * 2026-10-28: the signed disk image installs for a standard user with one
 * separate administrator authorization, lands inside its declared
 * permissions, and removes everything it installed. Checkpoints that need
 * customer accounts, the issuer's reviews, updates or a kept-data reinstall
 * are the beta's stated limitations; a release needs every checkpoint.
 */
export const PUBLIC_BETA_CHECKPOINTS: readonly AcceptanceCheckpointId[] = [
  "fresh-install/clean-supported-target",
  "fresh-install/disk-image-launch-stops-before-authorization",
  "fresh-install/app-dragged-to-applications",
  "fresh-install/standard-user-separate-administrator-authorization",
  "fresh-install/background-preparation-completed-in-app",
  "fresh-install/developer-id-signature",
  "fresh-install/notarization-and-gatekeeper",
  "fresh-install/checkout-and-toolchain-independent",
  "installed-permissions/installed-paths-match-declared-owner-and-mode",
  "installed-permissions/system-ancestors-deny-unprivileged-replacement",
  "installed-permissions/material-acls-match-exact-runtime-access",
  "installed-permissions/sudo-rules-limited-to-pinned-worker",
  "uninstall/delete-all-uninstall-confirmed",
  "uninstall/all-product-data-and-service-user-removed",
  "uninstall/exact-delete-all-residue",
];

/** The report failures that still block a public beta: target and evidence failures, and its own checkpoints. */
export function publicBetaFailures(report: ReleaseAcceptanceReport): string[] {
  return report.failures.filter((failure) => {
    const checkpoint = /^([a-z0-9-]+\/[a-z0-9-]+) is /.exec(failure)?.[1];
    return checkpoint === undefined || (PUBLIC_BETA_CHECKPOINTS as readonly string[]).includes(checkpoint);
  });
}

const BASELINE_FACTS = [
  "priorMochiStateAbsent",
  "repositoryAbsent",
  "bunAbsent",
  "nodeAbsent",
  "swiftAbsent",
  "jqAbsent",
  "globalPiAbsent",
  "globalLarkCliAbsent",
] as const;

const EVIDENCE_KINDS = [
  "screenRecording",
  "screenshot",
  "redactedTranscript",
  "diagnosticsReport",
  "operatorRecord",
] as const;

type ArtifactRole = typeof ARTIFACTS[number]["role"];
type Architecture = "arm64" | "x86_64";
type EvidenceKind = typeof EVIDENCE_KINDS[number];
type CheckpointResult = "pass" | "fail" | "blocked";

interface CandidateArtifact {
  role: ArtifactRole;
  filename: string;
  sha256: string;
  sizeBytes: number;
}

interface CandidateManifest {
  schemaVersion: 4;
  sourceRevision: string;
  productVersion: string;
  architecture: Architecture;
  minimumMacOS: string;
  limitations: string[];
  artifacts: CandidateArtifact[];
}

interface EvidenceReference {
  kind: EvidenceKind;
  path: string;
  sha256: string;
  sizeBytes: number;
}

interface AcceptanceCheckpoint {
  id: string;
  result: CheckpointResult;
  observedAt: string;
  evidence: EvidenceReference[];
}

interface AcceptanceRecord {
  schemaVersion: 8;
  candidate: { manifestFilename: typeof CANDIDATE_MANIFEST_NAME; manifestSha256: string };
  target: {
    id: string;
    architecture: Architecture;
    macOSVersion: string;
    baseline: Record<typeof BASELINE_FACTS[number], boolean>;
    evidence: EvidenceReference[];
  };
  scenarios: Array<{ id: string; checkpoints: AcceptanceCheckpoint[] }>;
}

export interface ReleaseAcceptanceReport {
  schemaVersion: 8;
  accepted: boolean;
  candidateManifestSha256: string;
  acceptanceRecordSha256: string;
  sourceRevision: string;
  productVersion: string;
  architecture: Architecture;
  targetId: string;
  targetMacOSVersion: string;
  artifactCount: number;
  scenarioCount: number;
  passedScenarioCount: number;
  checkpointCount: number;
  passedCheckpointCount: number;
  failures: string[];
}

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Architecture = Type.Union([Type.Literal("arm64"), Type.Literal("x86_64")]);
const EvidenceReferenceSchema = Type.Object({
  kind: Type.Union(EVIDENCE_KINDS.map((kind) => Type.Literal(kind))),
  path: Type.String({ minLength: 1, maxLength: 500 }),
  sha256: Sha256,
  sizeBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });
const CandidateSchema = Type.Object({
  schemaVersion: Type.Literal(4),
  sourceRevision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  productVersion: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }),
  architecture: Architecture,
  minimumMacOS: Type.String({ pattern: "^[0-9]+\\.[0-9]+(?:\\.[0-9]+)?$" }),
  limitations: Type.Array(Type.String({ minLength: 1, maxLength: 500, pattern: "^[^\\u0000\\r\\n]+$" })),
  artifacts: Type.Array(Type.Object({
    role: Type.Union(ARTIFACTS.map(({ role }) => Type.Literal(role))),
    filename: Type.String({ minLength: 1, maxLength: 100 }),
    sha256: Sha256,
    sizeBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  }, { additionalProperties: false }), { minItems: ARTIFACTS.length, maxItems: ARTIFACTS.length }),
}, { additionalProperties: false });
const AcceptanceSchema = Type.Object({
  schemaVersion: Type.Literal(8),
  candidate: Type.Object({
    manifestFilename: Type.Literal(CANDIDATE_MANIFEST_NAME),
    manifestSha256: Sha256,
  }, { additionalProperties: false }),
  target: Type.Object({
    id: Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$" }),
    architecture: Architecture,
    macOSVersion: Type.String({ pattern: "^[0-9]+\\.[0-9]+(?:\\.[0-9]+)?$" }),
    baseline: Type.Object(
      Object.fromEntries(BASELINE_FACTS.map((fact) => [fact, Type.Boolean()])),
      { additionalProperties: false },
    ),
    evidence: Type.Array(EvidenceReferenceSchema),
  }, { additionalProperties: false }),
  scenarios: Type.Tuple(RELEASE_ACCEPTANCE_SCENARIOS.map((scenario) => Type.Object({
    id: Type.Literal(scenario.id),
    checkpoints: Type.Tuple(scenario.checkpoints.map((id) => Type.Object({
      id: Type.Literal(id),
      result: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")]),
      observedAt: Type.String({
        pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
      }),
      evidence: Type.Array(EvidenceReferenceSchema),
    }, { additionalProperties: false }))),
  }, { additionalProperties: false }))),
}, { additionalProperties: false });
const CandidateValidator = Schema.Compile(CandidateSchema);
const AcceptanceValidator = Schema.Compile(AcceptanceSchema);

export async function createReleaseCandidateManifest(input: {
  candidateDirectory: string;
  sourceRevision: string;
  productVersion: string;
  architecture: Architecture;
  minimumMacOS: string;
  limitations: string[];
}): Promise<{ manifestPath: string; manifestSha256: string }> {
  const candidateDirectory = absolutePath(input.candidateDirectory, "candidate directory");
  const directoryMetadata = await lstat(candidateDirectory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error("candidate directory must be a real directory");
  }
  const artifacts: CandidateArtifact[] = [];
  for (const artifact of ARTIFACTS) {
    const path = await confinedFile(candidateDirectory, artifact.filename, "candidate artifact");
    const metadata = await stat(path);
    artifacts.push({
      role: artifact.role,
      filename: artifact.filename,
      sha256: await fileSha256(path),
      sizeBytes: metadata.size,
    });
  }
  const manifest: CandidateManifest = {
    schemaVersion: 4,
    sourceRevision: input.sourceRevision,
    productVersion: input.productVersion,
    architecture: input.architecture,
    minimumMacOS: input.minimumMacOS,
    limitations: input.limitations,
    artifacts,
  };
  if (!CandidateValidator.Check(manifest)) throw new Error("candidate manifest does not match schema 4");
  const manifestPath = join(candidateDirectory, CANDIDATE_MANIFEST_NAME);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const { manifestSha256 } = await loadReleaseCandidate(manifestPath);
  return { manifestPath, manifestSha256 };
}

export async function createReleaseAcceptanceTemplate(input: {
  candidateManifestPath: string;
  outputPath: string;
  targetId: string;
  macOSVersion: string;
}): Promise<void> {
  const candidatePath = absolutePath(input.candidateManifestPath, "candidate manifest");
  const outputPath = absolutePath(input.outputPath, "acceptance record");
  const { manifest, manifestSha256 } = await loadReleaseCandidate(candidatePath);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(input.targetId)) {
    throw new Error("target ID must be an opaque lowercase label");
  }
  if (!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(input.macOSVersion)) {
    throw new Error("target macOS version is invalid");
  }
  const now = new Date().toISOString();
  const record: AcceptanceRecord = {
    schemaVersion: 8,
    candidate: { manifestFilename: CANDIDATE_MANIFEST_NAME, manifestSha256 },
    target: {
      id: input.targetId,
      architecture: manifest.architecture,
      macOSVersion: input.macOSVersion,
      baseline: Object.fromEntries(BASELINE_FACTS.map((fact) => [fact, false])) as AcceptanceRecord["target"]["baseline"],
      evidence: [],
    },
    scenarios: RELEASE_ACCEPTANCE_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      checkpoints: scenario.checkpoints.map((id) => ({ id, result: "blocked", observedAt: now, evidence: [] })),
    })),
  };
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function verifyReleaseAcceptance(input: {
  candidateManifestPath: string;
  acceptanceRecordPath: string;
}): Promise<ReleaseAcceptanceReport> {
  const candidatePath = absolutePath(input.candidateManifestPath, "candidate manifest");
  const recordPath = absolutePath(input.acceptanceRecordPath, "acceptance record");
  const [{ manifest, manifestSha256 }, recordSource] = await Promise.all([
    loadReleaseCandidate(candidatePath),
    boundedRead(recordPath, "acceptance record"),
  ]);
  const record = parseAcceptanceRecord(JSON.parse(recordSource.toString("utf8")) as unknown);
  const failures: string[] = [];

  if (record.candidate.manifestSha256 !== manifestSha256) failures.push("record is bound to another candidate manifest");
  if (record.target.architecture !== manifest.architecture) failures.push("target architecture does not match candidate");
  if (compareVersions(record.target.macOSVersion, manifest.minimumMacOS) < 0) failures.push("target macOS is unsupported");
  for (const fact of BASELINE_FACTS) {
    if (!record.target.baseline[fact]) failures.push(`target baseline is not proven: ${fact}`);
  }
  if (record.target.evidence.length === 0) failures.push("target baseline has no evidence");

  const allEvidence = [
    ...record.target.evidence,
    ...record.scenarios.flatMap(({ checkpoints }) => checkpoints.flatMap(({ evidence }) => evidence)),
  ];
  await verifyFiles(dirname(recordPath), allEvidence, "acceptance evidence");

  let passedScenarioCount = 0;
  let checkpointCount = 0;
  let passedCheckpointCount = 0;
  for (const scenario of record.scenarios) {
    let scenarioPassed = true;
    for (const checkpoint of scenario.checkpoints) {
      checkpointCount += 1;
      if (checkpoint.result === "pass") passedCheckpointCount += 1;
      else {
        scenarioPassed = false;
        failures.push(`${scenario.id}/${checkpoint.id} is ${checkpoint.result}`);
      }
    }
    if (scenarioPassed) passedScenarioCount += 1;
  }

  return {
    schemaVersion: 8,
    accepted: failures.length === 0,
    candidateManifestSha256: manifestSha256,
    acceptanceRecordSha256: sha256(recordSource),
    sourceRevision: manifest.sourceRevision,
    productVersion: manifest.productVersion,
    architecture: manifest.architecture,
    targetId: record.target.id,
    targetMacOSVersion: record.target.macOSVersion,
    artifactCount: manifest.artifacts.length,
    scenarioCount: record.scenarios.length,
    passedScenarioCount,
    checkpointCount,
    passedCheckpointCount,
    failures,
  };
}

export async function loadReleaseCandidate(path: string): Promise<{ manifest: CandidateManifest; manifestSha256: string }> {
  if (basename(path) !== CANDIDATE_MANIFEST_NAME) throw new Error(`candidate manifest must be ${CANDIDATE_MANIFEST_NAME}`);
  const source = await boundedRead(path, "candidate manifest");
  const value = JSON.parse(source.toString("utf8")) as unknown;
  if (!CandidateValidator.Check(value)) throw new Error("candidate manifest does not match schema 4");
  const manifest = value as CandidateManifest;
  if (new Set(manifest.artifacts.map(({ role }) => role)).size !== ARTIFACTS.length) {
    throw new Error("candidate must contain every release package exactly once");
  }
  for (const artifact of manifest.artifacts) {
    const expected = ARTIFACTS.find(({ role }) => role === artifact.role)!;
    if (artifact.filename !== expected.filename) throw new Error(`${artifact.role} must be ${expected.filename}`);
  }
  await verifyFiles(dirname(path), manifest.artifacts.map((artifact) => ({
    kind: "operatorRecord",
    path: artifact.filename,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  })), "candidate artifact");
  return { manifest, manifestSha256: sha256(source) };
}

function parseAcceptanceRecord(value: unknown): AcceptanceRecord {
  if (!AcceptanceValidator.Check(value)) throw new Error("acceptance record does not match the finite schema 8 suite");
  const record = value as unknown as AcceptanceRecord;
  const checkpoints = record.scenarios.flatMap(({ checkpoints }) => checkpoints);
  for (const reference of [
    ...record.target.evidence,
    ...checkpoints.flatMap(({ evidence }) => evidence),
  ]) assertRelativeFile(reference.path);
  for (const checkpoint of checkpoints) {
    if (new Date(checkpoint.observedAt).toISOString() !== checkpoint.observedAt) {
      throw new Error(`${checkpoint.id} has an invalid observation time`);
    }
    if (checkpoint.result !== "blocked" && checkpoint.evidence.length === 0) {
      throw new Error(`${checkpoint.id} observed ${checkpoint.result} without evidence`);
    }
  }
  return record;
}

async function verifyFiles(root: string, references: readonly EvidenceReference[], label: string): Promise<void> {
  const verified = new Map<string, { sha256: string; sizeBytes: number }>();
  for (const reference of references) {
    const existing = verified.get(reference.path);
    if (existing) {
      if (existing.sha256 !== reference.sha256 || existing.sizeBytes !== reference.sizeBytes) {
        throw new Error(`${label} ${reference.path} has conflicting identities`);
      }
      continue;
    }
    const path = await confinedFile(root, reference.path, label);
    const metadata = await stat(path);
    if (metadata.size !== reference.sizeBytes) throw new Error(`${label} ${reference.path} size does not match the record`);
    if (await fileSha256(path) !== reference.sha256) throw new Error(`${label} ${reference.path} SHA-256 does not match the record`);
    verified.set(reference.path, { sha256: reference.sha256, sizeBytes: reference.sizeBytes });
  }
}

async function confinedFile(root: string, path: string, label: string): Promise<string> {
  assertRelativeFile(path);
  const rootPath = resolve(root);
  let cursor = rootPath;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`${label} must not traverse a symlink: ${path}`);
  }
  const [rootRealPath, fileRealPath] = await Promise.all([realpath(rootPath), realpath(cursor)]);
  const confined = relative(rootRealPath, fileRealPath);
  if (!confined || confined.startsWith("..") || isAbsolute(confined)) throw new Error(`${label} escapes its record directory`);
  const metadata = await stat(fileRealPath);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`${label} must be a non-empty file: ${path}`);
  return fileRealPath;
}

function assertRelativeFile(path: string): void {
  if (
    isAbsolute(path)
    || path.startsWith(".")
    || path.includes("//")
    || path.includes("\\")
    || /[\u0000\r\n]/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("evidence path must be a normalized relative file path");
}

async function boundedRead(path: string, label: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0 || metadata.size > MAXIMUM_RECORD_BYTES) {
    throw new Error(`${label} must be a non-empty regular file no larger than ${MAXIMUM_RECORD_BYTES} bytes`);
  }
  return readFile(path);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} path must be absolute`);
  return resolve(value);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "template" && args.length === 4) {
    await createReleaseAcceptanceTemplate({
      candidateManifestPath: args[0]!,
      outputPath: args[1]!,
      targetId: args[2]!,
      macOSVersion: args[3]!,
    });
    process.stdout.write(`${args[1]}\n`);
    return;
  }
  if (command === "verify" && args.length === 2) {
    const report = await verifyReleaseAcceptance({
      candidateManifestPath: args[0]!,
      acceptanceRecordPath: args[1]!,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.accepted) process.exitCode = 1;
    return;
  }
  throw new Error(
    "Usage: release_acceptance.ts template /absolute/Mochi-Release.json /absolute/Mochi-Acceptance.json target-id macOS-version\n"
    + "   or: release_acceptance.ts verify /absolute/Mochi-Release.json /absolute/Mochi-Acceptance.json",
  );
}

if (import.meta.main) await main();
