import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Deliberately exclude product configuration, credentials and signing overrides.
 * This is a clean build environment, not an OS security sandbox.
 */
export function verificationEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "DEVELOPER_DIR",
    "SDKROOT",
  ])
    if (source[key] !== undefined) environment[key] = source[key];
  return {
    ...environment,
    PATH: `${dirname(process.execPath)}:${source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    CI: "true",
    NO_COLOR: "1",
  };
}

function git(
  root: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): string {
  return execFileSync("git", ["-C", root, ...args], {
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertClean(root: string, environment: NodeJS.ProcessEnv): void {
  if (
    git(root, ["status", "--porcelain", "--untracked-files=all"], environment)
  )
    throw new Error(
      "Verification requires a clean committed tree; commit the intended changes first. Nothing was staged or changed.",
    );
}

export interface VerificationReport {
  schemaVersion: 1;
  commit: string;
  tree: string;
  platform: string;
  architecture: string;
  osRelease: string;
  bunVersion: string;
  startedAt: string;
  finishedAt?: string;
  result: "running" | "passed" | "failed";
  failure?: string;
  logSHA256?: string;
}

/** Merge and release consume the same retained receipt.
 * A squash merge may change the commit, but never the verified source tree.
 */
export async function requirePassedVerification(input: {
  resultPath: string;
  sourceRoot: string;
  sourceRevision: string;
  architecture: "arm64" | "x86_64";
}): Promise<VerificationReport> {
  if (
    !isAbsolute(input.resultPath) ||
    !/^[0-9a-f]{40}$/.test(input.sourceRevision)
  )
    throw new Error(
      "Verification evidence requires an absolute receipt and exact source revision",
    );
  const resultMetadata = await lstat(input.resultPath);
  if (
    !resultMetadata.isFile() ||
    resultMetadata.isSymbolicLink() ||
    resultMetadata.size > RECEIPT_BYTES
  )
    throw new Error("Verification receipt must be a bounded regular file");
  const report: unknown = JSON.parse(await readFile(input.resultPath, "utf8"));
  if (!report || typeof report !== "object" || Array.isArray(report))
    throw new Error("A completed passing verification receipt is required");
  const value = report as VerificationReport;
  if (
    value.schemaVersion !== 1 ||
    value.result !== "passed" ||
    value.failure !== undefined ||
    typeof value.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    typeof value.tree !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.tree) ||
    typeof value.logSHA256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.logSHA256) ||
    !value.finishedAt ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.finishedAt)) ||
    Date.parse(value.finishedAt) < Date.parse(value.startedAt)
  )
    throw new Error("A completed passing verification receipt is required");
  const environment = verificationEnvironment(process.env);
  const tree = git(
    input.sourceRoot,
    ["rev-parse", `${input.sourceRevision}^{tree}`],
    environment,
  );
  const metadata = JSON.parse(
    git(
      input.sourceRoot,
      ["show", `${input.sourceRevision}:package.json`],
      environment,
    ),
  ) as {
    packageManager: string;
  };
  if (value.tree !== tree)
    throw new Error("Candidate source tree has not passed verification");
  if (
    value.platform !== "darwin" ||
    value.architecture !== (input.architecture === "x86_64" ? "x64" : "arm64")
  )
    throw new Error(
      "Verification platform or architecture does not match the candidate",
    );
  if (metadata.packageManager !== `bun@${value.bunVersion}`)
    throw new Error("Verification used a different pinned toolchain");
  const logPath = join(dirname(input.resultPath), "verification.log");
  const logMetadata = await lstat(logPath);
  if (
    !logMetadata.isFile() ||
    logMetadata.isSymbolicLink() ||
    logMetadata.size === 0 ||
    logMetadata.size > 64 * 1024 * 1024
  )
    throw new Error("Verification log must be a bounded regular file");
  if (
    new Bun.CryptoHasher("sha256")
      .update(await readFile(logPath))
      .digest("hex") !== value.logSHA256
  )
    throw new Error("Verification log does not match its receipt");
  return value;
}

const RECEIPT_BYTES = 16 * 1024;
/** Runs this young are kept whatever their result, for diagnosis. */
export const VERIFICATION_RETENTION_DAYS = 14;

interface VerificationRun {
  directory: string;
  startedAt: number;
  result?: VerificationReport["result"];
  tree?: string;
  failure?: string;
}

function evidenceRootOf(root: string, environment: NodeJS.ProcessEnv): string {
  return join(
    git(
      root,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      environment,
    ),
    "mochi-verification",
  );
}

/** Only `<commit>/run-*` directories are this launcher's; anything else there belongs to someone else. */
async function verificationRuns(
  evidenceRoot: string,
): Promise<VerificationRun[]> {
  const commits = await readdir(evidenceRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const runs: VerificationRun[] = [];
  for (const commit of commits) {
    if (!commit.isDirectory() || !/^[0-9a-f]{40}$/.test(commit.name)) continue;
    const commitDirectory = join(evidenceRoot, commit.name);
    for (const run of await readdir(commitDirectory, { withFileTypes: true })) {
      if (!run.isDirectory() || !/^run-[A-Za-z0-9]{6}$/.test(run.name))
        continue;
      const directory = join(commitDirectory, run.name);
      let report: Partial<VerificationReport> = {};
      try {
        const resultPath = join(directory, "result.json");
        if ((await lstat(resultPath)).size <= RECEIPT_BYTES)
          report = JSON.parse(await readFile(resultPath, "utf8"));
      } catch {
        // A run interrupted before its first receipt write is still a run; its age decides.
      }
      const startedAt = Date.parse(report.startedAt ?? "");
      runs.push({
        directory,
        startedAt: Number.isFinite(startedAt)
          ? startedAt
          : (await lstat(directory)).mtimeMs,
        ...(typeof report.result === "string" ? { result: report.result } : {}),
        ...(typeof report.tree === "string" ? { tree: report.tree } : {}),
        ...(typeof report.failure === "string"
          ? { failure: report.failure }
          : {}),
      });
    }
  }
  return runs.sort((left, right) => right.startedAt - left.startedAt);
}

/** The newest retained passing receipt for a revision's tree, checked exactly as a release checks it. */
export async function findPassedVerification(input: {
  sourceRoot: string;
  sourceRevision: string;
  architecture: "arm64" | "x86_64";
}): Promise<{ resultPath: string; report: VerificationReport }> {
  const environment = verificationEnvironment(process.env);
  const tree = git(
    input.sourceRoot,
    ["rev-parse", `${input.sourceRevision}^{tree}`],
    environment,
  );
  const runs = (
    await verificationRuns(evidenceRootOf(input.sourceRoot, environment))
  ).filter((run) => run.tree === tree);
  const passed = runs.find((run) => run.result === "passed");
  if (!passed) {
    const latest = runs[0];
    throw new Error(
      `Tree ${tree} of ${input.sourceRevision} has no passing verification receipt; ${
        latest
          ? `its latest run is ${latest.result}: ${latest.failure ?? "no failure recorded"}`
          : "it was never verified"
      }`,
    );
  }
  const resultPath = join(passed.directory, "result.json");
  return {
    resultPath,
    report: await requirePassedVerification({ ...input, resultPath }),
  };
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    bytes += entry.isDirectory()
      ? await directoryBytes(entryPath)
      : (await lstat(entryPath)).size;
  }
  return bytes;
}

/** Bounded receipt retention. Runs younger than the window stay. Older runs go,
 * except the newest passing receipt of every tree a ref still reaches: the
 * receipt merge and release look up. Foreign files are never touched.
 */
export async function pruneVerificationEvidence(
  evidenceRoot: string,
  referencedTrees: ReadonlySet<string>,
  now = Date.now(),
): Promise<{ removedRuns: number; removedBytes: number }> {
  const cutoff = now - VERIFICATION_RETENTION_DAYS * 24 * 60 * 60_000;
  const retainedTrees = new Set<string>();
  let removedRuns = 0;
  let removedBytes = 0;
  // Newest first, so the first passing run seen for a tree is the one kept.
  for (const run of await verificationRuns(evidenceRoot)) {
    if (
      run.result === "passed" &&
      run.tree &&
      referencedTrees.has(run.tree) &&
      !retainedTrees.has(run.tree)
    ) {
      retainedTrees.add(run.tree);
      continue;
    }
    if (run.startedAt >= cutoff) continue;
    removedBytes += await directoryBytes(run.directory);
    await rm(run.directory, { recursive: true, force: true });
    removedRuns++;
    try {
      await rmdir(dirname(run.directory));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT")
        throw error;
    }
  }
  return { removedRuns, removedBytes };
}

/** One process group per operation, so cancellation also stops builds and test servers. */
export async function runLogged(
  command: string[],
  root: string,
  environment: NodeJS.ProcessEnv,
  log: number,
  signal: AbortSignal,
  timeoutMs = 30 * 60_000,
): Promise<void> {
  signal.throwIfAborted();
  const [executable, ...args] = command;
  if (!executable) throw new Error("Verification command is empty");
  const child = spawn(executable, args, {
    cwd: root,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const killGroup = (stopSignal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, stopSignal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const stop = () => {
    if (escalation) return;
    killGroup("SIGTERM");
    escalation = setTimeout(() => killGroup("SIGKILL"), 2_000);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const capture = (chunk: Buffer) => {
    writeSync(log, chunk);
    process.stdout.write(chunk);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    });
    signal.throwIfAborted();
    if (timedOut) throw new Error(`Verification timed out: ${executable}`);
    if (code !== 0)
      throw new Error(
        `Verification command failed (${code}): ${command.join(" ")}`,
      );
  } finally {
    clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener("abort", stop);
    // Also reap detached descendants after a command's own process exits.
    killGroup("SIGKILL");
  }
}

/** Verify exactly HEAD without touching another worktree, its dist, or live services. */
export async function verifyLocal(
  source: string,
  signal = new AbortController().signal,
) {
  if (process.platform !== "darwin")
    throw new Error("Mochi verification requires macOS");
  const root = await realpath(source);
  const environment = verificationEnvironment(process.env);
  if (
    (await realpath(
      git(root, ["rev-parse", "--show-toplevel"], environment),
    )) !== root
  )
    throw new Error("Verification must start at the repository root");
  assertClean(root, environment);
  const commit = git(root, ["rev-parse", "HEAD"], environment);
  const tree = git(root, ["rev-parse", `${commit}^{tree}`], environment);
  const metadata = JSON.parse(
    git(root, ["show", `${commit}:package.json`], environment),
  ) as { packageManager: string };
  if (metadata.packageManager !== `bun@${Bun.version}`)
    throw new Error(
      `Verification requires ${metadata.packageManager}; running bun@${Bun.version}`,
    );

  const evidenceRoot = evidenceRootOf(root, environment);
  const { removedRuns, removedBytes } = await pruneVerificationEvidence(
    evidenceRoot,
    new Set(
      git(root, ["log", "--all", "--format=%T"], environment).split("\n"),
    ),
  );
  if (removedRuns > 0)
    console.log(
      `Retention: removed ${removedRuns} verification runs older than ${VERIFICATION_RETENTION_DAYS} days (${(removedBytes / 1024 / 1024).toFixed(1)} MB)`,
    );
  const commitEvidence = join(evidenceRoot, commit);
  await mkdir(commitEvidence, { recursive: true, mode: 0o700 });
  const evidenceDirectory = await mkdtemp(join(commitEvidence, "run-"));
  const report: VerificationReport = {
    schemaVersion: 1,
    commit,
    tree,
    platform: process.platform,
    architecture: arch(),
    osRelease: release(),
    bunVersion: Bun.version,
    startedAt: new Date().toISOString(),
    result: "running",
  };
  const saveReport = async () => {
    const pending = join(evidenceDirectory, "result.pending.json");
    await writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(pending, join(evidenceDirectory, "result.json"));
  };
  await saveReport();
  console.log(`Verifying ${commit}\nEvidence: ${evidenceDirectory}`);
  const logPath = join(evidenceDirectory, "verification.log");
  const log = openSync(logPath, "wx", 0o600);
  let staging: string | undefined;
  try {
    staging = await mkdtemp(join(tmpdir(), "mochi-verify-"));
    const checkout = join(staging, "checkout");
    await runLogged(
      ["git", "clone", "--no-hardlinks", "--no-checkout", "--", root, checkout],
      root,
      environment,
      log,
      signal,
    );
    await runLogged(
      ["git", "-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit],
      checkout,
      environment,
      log,
      signal,
    );
    if (git(checkout, ["rev-parse", "HEAD"], environment) !== commit)
      throw new Error("Verification checkout identity changed");
    // Execute the suite from the committed copy, never from the developer's mutable checkout.
    // Its `step` names a failed step in this file; nested verifications never inherit the path.
    const failedStep = join(staging, "failed-step");
    try {
      await runLogged(
        // The isolated suite models ordinary system paths, independent of the
        // operator's restrictive shell umask. Evidence roots stay private.
        [
          "/bin/bash",
          "-c",
          'umask 022; exec /bin/bash "$1"',
          "mochi-verify",
          "script/verify_suite.sh",
        ],
        checkout,
        { ...environment, MOCHI_VERIFY_FAILED_STEP: failedStep },
        log,
        signal,
      );
    } catch (error) {
      const step = await readFile(failedStep, "utf8").catch(() => "");
      if (!step || signal.aborted) throw error;
      throw new Error(`Step failed: ${step.trim()}`);
    }
    assertClean(checkout, environment);
    if (git(checkout, ["rev-parse", "HEAD"], environment) !== commit)
      throw new Error("Verification changed its checkout identity");
    signal.throwIfAborted();
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
    writeSync(log, `\n[verify] FAILED: ${report.failure}\n`);
  } finally {
    closeSync(log);
    // Only this invocation's mkdtemp directory is removed; evidence is retained in Git's common directory.
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } catch (error) {
      report.result = "failed";
      report.failure = `Verification cleanup failed: ${String(error)}`;
    }
    if (signal.aborted) {
      report.result = "failed";
      report.failure = "Verification interrupted";
    }
    report.finishedAt = new Date().toISOString();
    report.logSHA256 = new Bun.CryptoHasher("sha256")
      .update(await readFile(logPath))
      .digest("hex");
    await saveReport();
  }
  console.log(
    `Verification ${report.result}: ${commit}\nEvidence: ${evidenceDirectory}`,
  );
  return { report, evidenceDirectory };
}

if (import.meta.main) {
  if (process.argv.length !== 2)
    throw new Error("Usage: bun run verify (verifies committed HEAD)");
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Verification interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const { report } = await verifyLocal(
      resolve(import.meta.dir, ".."),
      controller.signal,
    );
    process.exitCode = report.result === "passed" ? 0 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
