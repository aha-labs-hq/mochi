import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { PI_RUNTIME_CWD, PI_RUNTIME_HOME, PI_RUNTIME_USER, PI_SUDO_PATH, PI_WORKER_PATH } from "../runtime/constants.ts";
import { readFleetStatusSnapshot } from "../control/statusSnapshot.ts";
import { productLayout, SERVICE_LABEL } from "../product/layout.ts";
import { buildLaunchAgentPlist, type ServicePaths } from "../control/launchAgent.ts";
import { verifyRuntimeIsolation } from "../runtime/isolation.ts";
import { describeReadiness, isStableControlPlane } from "../control/readiness.ts";

const LAUNCHCTL = "/bin/launchctl";
const READY_TIMEOUT_MILLISECONDS = 60_000;

export async function run(argv: readonly string[]): Promise<void> {
  if (process.platform !== "darwin") throw new Error("LaunchAgent management only supports macOS");
  const action = argv[0];
  if (!action || argv.length !== 1 || !["install", "restart", "status", "uninstall"].includes(action)) {
    throw new Error("Usage: mochi-bridge service <install|restart|status|uninstall>");
  }
  const paths = servicePaths();
  const target = serviceTarget();
  if (action === "install") await install(paths, target);
  else if (action === "restart") await restart(paths, target);
  else if (action === "status") status(target, paths);
  else uninstall(target, paths.plistPath);
}

function servicePaths(): ServicePaths {
  const layout = productLayout();
  return {
    mode: layout.mode,
    command: [layout.bridgeExecutablePath],
    workingDirectory: layout.workingDirectory,
    immutableRoot: layout.immutableRoot,
    mutableRoot: layout.mutableRoot,
    dataDirectory: layout.mutableRoot,
    plistPath: layout.launchAgentPath,
    structuredLogPath: layout.structuredLogPath,
    statusPath: layout.statusSnapshotPath,
  };
}

async function install(paths: ServicePaths, target: string): Promise<void> {
  await preflightServiceStart(paths);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.dataDirectory, 0o700);
  mkdirSync(dirname(paths.structuredLogPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(paths.structuredLogPath), 0o700);
  mkdirSync(dirname(paths.plistPath), { recursive: true, mode: 0o700 });

  const temporaryPath = `${paths.plistPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, buildLaunchAgentPlist(paths), { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, paths.plistPath);
  const previousRunId = currentRunId(paths.statusPath);
  const previous = runResult([LAUNCHCTL, "print", target]);
  if (previous.code === 0) {
    runCommand([LAUNCHCTL, "bootout", target]);
    await waitUntilStopped(target, parseLaunchStatus(previous.stdout).pid);
  } else if (previous.code !== 113) throw new Error("Cannot inspect the existing LaunchAgent");
  runCommand([LAUNCHCTL, "bootstrap", `gui/${currentUid()}`, paths.plistPath]);
  await waitUntilReady(target, paths.statusPath, previousRunId);
  console.log(`Installed and started ${SERVICE_LABEL}: ${paths.plistPath}`);
}

async function restart(paths: ServicePaths, target: string): Promise<void> {
  if (!isLoaded(target)) throw new Error(`${SERVICE_LABEL} is not loaded; run service:install first`);
  await preflightServiceStart(paths);
  const previousRunId = currentRunId(paths.statusPath);
  runCommand([LAUNCHCTL, "kickstart", "-k", target]);
  await waitUntilReady(target, paths.statusPath, previousRunId);
  console.log(`Restarted ${SERVICE_LABEL}`);
}

/**
 * Isolation is a deployment property of the Pi runtime user, identical for every
 * Bot, so it is verified once from any Bot's policy rather than per Bot.
 */
async function preflightServiceStart(paths: ServicePaths): Promise<void> {
  requireExecutable(paths.command[0]!);
  await verifyRuntimeIsolation({ runtimeCwd: PI_RUNTIME_CWD, runtimeHome: PI_RUNTIME_HOME, runtimeUser: PI_RUNTIME_USER, sudoPath: PI_SUDO_PATH, workerPath: PI_WORKER_PATH });
}

/** Whether the Bridge is on duty: its LaunchAgent is loaded and running. */
export function bridgeOnDuty(): boolean {
  const result = runResult([LAUNCHCTL, "print", serviceTarget()]);
  return result.code === 0 && parseLaunchStatus(result.stdout).state === "running";
}

/**
 * Puts the installed Bridge back on duty from its existing plist, the same
 * bootstrap the App's start action performs. It never rewrites the plist.
 */
export async function resumeDuty(): Promise<void> {
  const paths = servicePaths();
  const target = serviceTarget();
  if (isLoaded(target)) return;
  const previousRunId = currentRunId(paths.statusPath);
  runCommand([LAUNCHCTL, "bootstrap", `gui/${currentUid()}`, paths.plistPath]);
  await waitUntilReady(target, paths.statusPath, previousRunId);
  console.log(`Resumed ${SERVICE_LABEL}`);
}

function status(target: string, paths: ServicePaths): void {
  const result = runResult([LAUNCHCTL, "print", target]);
  if (result.code !== 0) {
    console.log(`not loaded\nplist=${paths.plistPath}`);
    process.exitCode = 1;
    return;
  }
  const launch = parseLaunchStatus(result.stdout);
  const lastExit = result.stdout.match(/^\s*last exit code = (.+)$/m)?.[1] ?? "none";
  const statusResult = launch.pid ? readFleetStatusSnapshot(paths.statusPath, launch.pid) : undefined;
  const readiness = statusResult ? describeStatusRead(statusResult) : "launch agent has no process id";
  const ready = launch.state === "running"
    && statusResult?.kind === "current" && isStableControlPlane(statusResult.snapshot);
  const controlReady = launch.state === "running"
    && statusResult?.kind === "current"
    && statusResult.snapshot.controlAvailable;
  console.log(
    `loaded\nready=${ready}\ncontrol_ready=${controlReady}\nstate=${launch.state}\npid=${launch.pid ?? "none"}`
      + `\nstatus=${readiness}\nbots=${describeBots(statusResult)}`
      + `\nlast_exit=${lastExit}\nplist=${paths.plistPath}`,
  );
  if (!ready) process.exitCode = 1;
}

function uninstall(target: string, plistPath: string): void {
  if (isLoaded(target)) runCommand([LAUNCHCTL, "bootout", target]);
  if (existsSync(plistPath)) unlinkSync(plistPath);
  console.log(`Uninstalled ${SERVICE_LABEL}`);
}

function serviceTarget(): string {
  return `gui/${currentUid()}/${SERVICE_LABEL}`;
}

function currentUid(): number {
  if (!process.getuid) throw new Error("Cannot resolve the current user ID");
  return process.getuid();
}

function isLoaded(target: string): boolean {
  return runResult([LAUNCHCTL, "print", target]).code === 0;
}

function requireExecutable(path: string): void {
  const entry = statSync(path);
  if (!entry.isFile() || (entry.mode & 0o111) === 0) throw new Error(`Service executable is not executable: ${path}`);
}

function runCommand(command: string[]): void {
  const result = runResult(command);
  if (result.code !== 0) {
    throw new Error(`${command[0]} exited ${result.code}: ${result.stderr.trim().slice(0, 2_000)}`);
  }
}

function runResult(command: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}


export async function waitUntilReady(
  target: string,
  statusPath: string,
  previousRunId: string | undefined,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MILLISECONDS;
  let lastReason = "launch agent has not reported readiness";
  while (Date.now() < deadline) {
    const launchResult = runResult([LAUNCHCTL, "print", target]);
    if (launchResult.code !== 0) {
      lastReason = "launch agent is not loaded";
    } else {
      const launch = parseLaunchStatus(launchResult.stdout);
      if (launch.state !== "running") lastReason = `launch agent state is ${launch.state}`;
      else if (!launch.pid) lastReason = "launch agent has no process id";
      else {
        const statusResult = readFleetStatusSnapshot(statusPath, launch.pid);
        lastReason = statusResult.kind === "current"
            ? describeReadiness(statusResult.snapshot)
            : describeStatusRead(statusResult);
        if (
          statusResult.kind === "current"
          && isStableControlPlane(statusResult.snapshot)
        ) {
          if (statusResult.snapshot.runId !== previousRunId) return;
          lastReason = "status snapshot belongs to the previous Bridge run";
        }
      }
    }
    await Bun.sleep(250);
  }
  throw new Error(`${SERVICE_LABEL} did not become ready: ${lastReason}`);
}

/** bootout acknowledges removal before the old process necessarily finishes exiting. */
export async function waitUntilStopped(target: string, previousPid: number | undefined): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MILLISECONDS;
  do {
    const launch = runResult([LAUNCHCTL, "print", target]);
    if (launch.code !== 0 && launch.code !== 113) throw new Error("Cannot verify LaunchAgent shutdown");
    let processExists = false;
    if (previousPid !== undefined) {
      try { process.kill(previousPid, 0); processExists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    if (launch.code === 113 && !processExists) return;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  throw new Error("LaunchAgent shutdown did not complete; no replacement was started");
}

/** The status file itself may be missing, stale or foreign; say which. */
function describeStatusRead(result: ReturnType<typeof readFleetStatusSnapshot>): string {
  switch (result.kind) {
    case "current": return describeReadiness(result.snapshot);
    case "missing": return "status snapshot is missing";
    case "invalid": return `status snapshot is invalid: ${result.reason}`;
    case "wrong_process": return `status snapshot belongs to process ${result.processId}`;
    case "expired": return `status snapshot expired at ${result.validUntil}`;
  }
}

function currentRunId(statusPath: string): string | undefined {
  const result = readFleetStatusSnapshot(statusPath);
  return result.kind === "current" ? result.snapshot.runId : undefined;
}


function parseLaunchStatus(output: string): { state: string; pid?: number } {
  const state = output.match(/^\s*state = (.+)$/m)?.[1] ?? "unknown";
  const pidText = output.match(/^\s*pid = (\d+)$/m)?.[1];
  return { state, ...(pidText ? { pid: Number(pidText) } : {}) };
}

function describeBots(result: ReturnType<typeof readFleetStatusSnapshot> | undefined): string {
  if (result?.kind !== "current") return "unknown";
  if (!result.snapshot.bots.length) return "none";
  return result.snapshot.bots
    .map((bot) => `${bot.label}=${bot.enabled ? bot.lifecycle : "disabled"}`)
    .join(",");
}

if (import.meta.main) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
