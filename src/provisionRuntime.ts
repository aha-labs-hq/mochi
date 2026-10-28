import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { MATERIAL_WORKSPACE_ROOT, prepareMaterialRoot } from "./attachments/materialWorkspace.ts";
import { userInfo } from "node:os";
import type { RuntimeConfig } from "./config.ts";
import { verifyRuntimeIsolation } from "./runtime/isolation.ts";
import { PI_WORKER_PROTOCOL_VERSION } from "./runtime/protocol.ts";
import { BRIDGE_USER_PATTERN, buildRuntimeSudoersRule } from "./runtime/sudoers.ts";
import {
  PI_RUNTIME_CWD,
  PI_RUNTIME_GROUP,
  PI_RUNTIME_HOME,
  PI_RUNTIME_NOTICES_PATH,
  PI_RUNTIME_USER,
  PI_SUDO_PATH,
  PI_WORKER_PATH,
} from "./runtime/constants.ts";

const SUDOERS_PATH = "/etc/sudoers.d/mochi-pi-runtime";
const PATHS = Object.freeze({
  chmod: "/bin/chmod",
  chown: "/usr/sbin/chown",
  dscl: "/usr/bin/dscl",
  id: "/usr/bin/id",
  install: "/usr/bin/install",
  mkdir: "/bin/mkdir",
  visudo: "/usr/sbin/visudo",
});

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Pi runtime provisioning only supports macOS");
  const elevated = process.getuid!() === 0;
  const args = process.argv.slice(2);
  if (args.length !== (elevated ? 3 : 1) || (elevated && args[0] !== "--authorized")) {
    throw new Error("Usage: bun run runtime:provision -- /absolute/path/to/mochi-pi-runtime");
  }
  const sourceWorker = args.at(-1)!;
  if (!sourceWorker.startsWith("/")) throw new Error("Worker source must be absolute");
  const bridgeUser = elevated ? args[1]! : userInfo().username;
  if (!BRIDGE_USER_PATTERN.test(bridgeUser) || bridgeUser === "root") throw new Error("Invalid Bridge login user");
  const config = {
    workerPath: PI_WORKER_PATH, sudoPath: PI_SUDO_PATH, runtimeUser: PI_RUNTIME_USER,
    runtimeHome: PI_RUNTIME_HOME, runtimeCwd: PI_RUNTIME_CWD,
  };
  assertFixedRuntime(config, bridgeUser);
  verifySourceWorker(sourceWorker);
  const sourceNotices = join(dirname(sourceWorker), basename(PI_RUNTIME_NOTICES_PATH));
  verifySourceNotices(sourceNotices);
  if (!elevated) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-runtime-authorization-")));
    try {
      const executable = join(directory, "mochi-runtime-provision");
      await run([process.execPath, "build", "--compile", import.meta.path, `--outfile=${executable}`]);
      // Copy before authorization: root must not need access to a protected Documents checkout.
      const stagedWorker = join(directory, basename(PI_WORKER_PATH));
      copyFileSync(sourceWorker, stagedWorker);
      chmodSync(stagedWorker, 0o700);
      copyFileSync(sourceNotices, join(directory, basename(PI_RUNTIME_NOTICES_PATH)));
      const result = await authorizeProvisioning(executable, bridgeUser, stagedWorker);
      if (result === "cancelled") {
        process.exitCode = 130;
        console.log("Authorization cancelled; runtime unchanged.");
        return;
      }
      prepareMaterialRoot();
      console.log(await verifyRuntimeIsolation(config));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    return;
  }
  // The native authorization operates only on the active desktop user's development runtime.
  if ((await run(["/usr/bin/stat", "-f", "%Su", "/dev/console"])) !== bridgeUser) {
    throw new Error("Bridge user must be the active macOS console user");
  }
  const existingUid = await optionalUserId(config.runtimeUser);
  if (existingUid === undefined && existsSync(config.runtimeHome)) {
    throw new Error(`${config.runtimeHome} exists without the ${config.runtimeUser} account`);
  }
  const runtimeGroupId = await ensureRuntimeGroup(PI_RUNTIME_GROUP);
  if (existingUid === undefined) {
    await createRuntimeUser(config.runtimeUser, config.runtimeHome, runtimeGroupId);
  }
  await verifyRuntimeUser(config.runtimeUser, config.runtimeHome, runtimeGroupId);

  for (const directory of [config.runtimeHome, config.runtimeCwd]) {
    // The runtime account owns its home, so never follow a link it could have placed there.
    await privileged([PATHS.mkdir, "-p", directory]);
    await privileged([PATHS.chown, "-h", `${config.runtimeUser}:${PI_RUNTIME_GROUP}`, directory]);
    await privileged([PATHS.chmod, "-h", "700", directory]);
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${directory} must be a real directory`);
  }
  await adoptMaterialParent(bridgeUser);
  await installSystemDirectory(dirname(config.workerPath));
  await privileged([
    PATHS.install,
    "-o", "root",
    "-g", "wheel",
    "-m", "0755",
    sourceWorker,
    config.workerPath,
  ]);
  verifyInstalledWorker(config.workerPath);
  await installSystemDirectory(dirname(PI_RUNTIME_NOTICES_PATH));
  await privileged([
    PATHS.install,
    "-o", "root",
    "-g", "wheel",
    "-m", "0444",
    sourceNotices,
    PI_RUNTIME_NOTICES_PATH,
  ]);
  verifyInstalledNotices(PI_RUNTIME_NOTICES_PATH);

  const digest = createHash("sha256").update(readFileSync(config.workerPath)).digest("hex");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "mochi-pi-sudoers-"));
  const temporaryRule = join(temporaryDirectory, basename(SUDOERS_PATH));
  try {
    writeFileSync(temporaryRule, buildRuntimeSudoersRule(bridgeUser, config, digest), { mode: 0o600 });
    chmodSync(temporaryRule, 0o600);
    await privileged([PATHS.visudo, "-cf", temporaryRule]);
    await privileged([
      PATHS.install,
      "-o", "root",
      "-g", "wheel",
      "-m", "0440",
      temporaryRule,
      SUDOERS_PATH,
    ]);
    await privileged([PATHS.visudo, "-cf", SUDOERS_PATH]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const version = await run([config.workerPath, "--version"]);
  if (version !== `mochi-pi-runtime ${PI_WORKER_PROTOCOL_VERSION}`) throw new Error(`unexpected worker version: ${version}`);
  console.log(`Provisioned ${config.runtimeUser}; ${version}; digest=${digest}`);
}

export function assertFixedRuntime(
  config: Pick<RuntimeConfig, "runtimeUser" | "runtimeHome" | "runtimeCwd" | "workerPath" | "sudoPath">,
  bridgeUser: string,
): void {
  if (config.runtimeUser !== PI_RUNTIME_USER) throw new Error(`PI_RUNTIME_USER must be ${PI_RUNTIME_USER}`);
  if (config.runtimeHome !== PI_RUNTIME_HOME) throw new Error("PI_RUNTIME_HOME is fixed");
  if (config.runtimeCwd !== PI_RUNTIME_CWD) throw new Error("PI_RUNTIME_CWD is fixed");
  if (config.workerPath !== PI_WORKER_PATH) throw new Error("PI_WORKER_PATH is fixed");
  if (config.sudoPath !== PI_SUDO_PATH) throw new Error("PI_SUDO_PATH is fixed");
  if (bridgeUser === config.runtimeUser) throw new Error("Bridge and runtime users must be distinct");
}

export function verifySourceWorker(path: string): void {
  const resolved = realpathSync(path);
  if (resolved !== path) throw new Error("Provisioning source must be canonical");
  const entry = lstatSync(path);
  if (!entry.isFile() || (entry.mode & 0o111) === 0) throw new Error("source worker must be an executable regular file");
}

export function verifySourceNotices(path: string): void {
  const resolved = realpathSync(path);
  if (resolved !== path) throw new Error("Provisioning source must be canonical");
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.size === 0) throw new Error("source worker notices must be a non-empty regular file");
}

function verifyInstalledWorker(path: string): void {
  const entry = statSync(path);
  if (!entry.isFile() || entry.uid !== 0 || (entry.mode & 0o022) !== 0 || (entry.mode & 0o111) === 0) {
    throw new Error(`${path} must be a root-owned non-writable executable`);
  }
}

function verifyInstalledNotices(path: string): void {
  const entry = statSync(path);
  if (!entry.isFile() || entry.uid !== 0 || (entry.mode & 0o222) !== 0 || entry.size === 0) {
    throw new Error(`${path} must be a root-owned, read-only, non-empty regular file`);
  }
}

// The runtime account owns a primary group of its own. In `staff` it could
// enter the owner's home and read every group-readable file there.
async function ensureRuntimeGroup(group: string): Promise<number> {
  let gid = await optionalGroupId(group);
  if (gid === undefined) {
    gid = await nextServiceId("/Groups", "PrimaryGroupID");
    for (const [key, value] of [
      ["RealName", "Mochi Pi Runtime"],
      ["PrimaryGroupID", String(gid)],
    ] satisfies [string, string][]) {
      await privileged([PATHS.dscl, ".", "-create", `/Groups/${group}`, key, value]);
    }
  }
  if (gid < 401 || gid >= 500) throw new Error(`${group} must use a hidden service GID in 401-499`);
  return gid;
}

async function createRuntimeUser(user: string, home: string, gid: number): Promise<void> {
  const uid = await nextServiceId("/Users", "UniqueID");
  const record = `/Users/${user}`;
  for (const [key, value] of [
    ["RealName", "Mochi Pi Runtime"],
    ["UniqueID", String(uid)],
    ["PrimaryGroupID", String(gid)],
    ["NFSHomeDirectory", home],
    ["UserShell", "/usr/bin/false"],
    ["IsHidden", "1"],
  ] satisfies [string, string][]) {
    await privileged([PATHS.dscl, ".", "-create", record, key, value]);
  }
}

async function nextServiceId(
  directory: "/Users" | "/Groups", attribute: "UniqueID" | "PrimaryGroupID",
): Promise<number> {
  const output = await run([PATHS.dscl, ".", "-list", directory, attribute]);
  const used = new Set(output.split("\n").flatMap((line) => {
    const value = Number(line.trim().split(/\s+/).at(-1));
    return Number.isInteger(value) ? [value] : [];
  }));
  for (let id = 401; id < 500; id += 1) if (!used.has(id)) return id;
  throw new Error(`No unused hidden service ID is available in ${directory} 401-499`);
}

async function optionalUserId(user: string): Promise<number | undefined> {
  const process = Bun.spawn({ cmd: [PATHS.id, "-u", user], stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  if (code !== 0) return undefined;
  const value = Number(stdout.trim());
  if (!Number.isInteger(value)) throw new Error(`invalid uid for ${user}`);
  return value;
}

async function optionalGroupId(group: string): Promise<number | undefined> {
  const process = Bun.spawn({
    cmd: [PATHS.dscl, ".", "-read", `/Groups/${group}`, "PrimaryGroupID"], stdout: "pipe", stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  if (code !== 0) return undefined;
  const value = Number(directoryServiceAttributeValue(stdout, "PrimaryGroupID"));
  if (!Number.isInteger(value)) throw new Error(`invalid gid for ${group}`);
  return value;
}

async function verifyRuntimeUser(user: string, home: string, gid: number): Promise<void> {
  const uid = await optionalUserId(user);
  if (uid === undefined || uid < 401 || uid >= 500) {
    throw new Error(`${user} must use a hidden service UID in 401-499`);
  }
  const record = `/Users/${user}`;
  for (const [attribute, expected] of [
    ["NFSHomeDirectory", home],
    ["UserShell", "/usr/bin/false"],
    ["PrimaryGroupID", String(gid)],
    ["IsHidden", "1"],
  ] satisfies [string, string][]) {
    const output = await run([PATHS.dscl, ".", "-read", record, attribute]);
    const value = directoryServiceAttributeValue(output, attribute);
    if (value !== expected) throw new Error(`${record} ${attribute} must be ${expected}`);
  }
  const groups = (await run([PATHS.id, "-Gn", user])).split(/\s+/);
  for (const forbidden of ["admin", "staff"]) {
    if (groups.includes(forbidden)) throw new Error(`${user} must not belong to the ${forbidden} group`);
  }
}

export function directoryServiceAttributeValue(output: string, attribute: string): string {
  const value = output.trim();
  for (const prefix of [`${attribute}:`, `dsAttrTypeNative:${attribute}:`]) {
    if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
  }
  throw new Error(`Directory Services returned an unexpected ${attribute} record`);
}

/**
 * Gives the material root's parent, directly in the world-writable `/Users/Shared/`,
 * to the Bridge account, exactly as the package installer does: it is created
 * in one step, or adopted only while it is a real directory that root or the
 * Bridge account already owns. The Bridge then owns its access policy.
 */
async function adoptMaterialParent(bridgeUser: string): Promise<void> {
  const parent = dirname(MATERIAL_WORKSPACE_ROOT);
  const bridgeUid = await optionalUserId(bridgeUser);
  if (bridgeUid === undefined) throw new Error(`cannot resolve uid for ${bridgeUser}`);
  if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  const before = lstatSync(parent);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${parent} must be a real directory`);
  if (before.uid !== 0 && before.uid !== bridgeUid) {
    throw new Error(`${parent} belongs to another account; remove it before provisioning`);
  }
  await privileged([PATHS.chown, "-h", bridgeUser, parent]);
  const after = lstatSync(parent);
  if (!after.isDirectory() || after.isSymbolicLink() || after.uid !== bridgeUid) {
    throw new Error(`${parent} changed while it was being adopted`);
  }
}

/** Creates each missing directory down to `path` as root:wheel 755, one level at a time, and never changes one that exists. */
async function installSystemDirectory(path: string): Promise<void> {
  if (existsSync(path)) return;
  await installSystemDirectory(dirname(path));
  await privileged([PATHS.install, "-d", "-o", "root", "-g", "wheel", "-m", "0755", path]);
}

async function privileged(command: string[]): Promise<void> {
  if (process.getuid!() !== 0) throw new Error("Provisioning requires native administrator authorization");
  await run(command);
}

export function provisioningAuthorizationScript(executable: string, bridgeUser: string, sourceWorker: string): string {
  if (![executable, sourceWorker].every((path) => path.startsWith("/") && !/[\r\n\0]/.test(path))
    || !BRIDGE_USER_PATTERN.test(bridgeUser)) throw new Error("Invalid authorization input");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = "/usr/bin/env -i HOME=/var/root USER=root LOGNAME=root PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 "
    + [executable, "--authorized", bridgeUser, sourceWorker].map(quote).join(" ");
  const literal = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `do shell script "${literal}" with administrator privileges with prompt "Mochi 需要更新安全的后台组件。"`;
}

export async function authorizeProvisioning(
  executable: string, bridgeUser: string, sourceWorker: string,
  execute: (script: string) => Promise<{ code: number; stderr: string }> = async (script) => {
    const child = Bun.spawn({ cmd: ["/usr/bin/osascript", "-e", script], cwd: "/var/empty",
      stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr };
    } finally { clearTimeout(timer); }
  },
): Promise<"completed" | "cancelled"> {
  const result = await execute(provisioningAuthorizationScript(executable, bridgeUser, sourceWorker));
  if (result.code === 0) return "completed";
  if (/\(-128\)\s*$/.test(result.stderr.trim())) return "cancelled";
  throw new Error("macOS runtime preparation failed: " + result.stderr.trim().slice(0, 2_000));
}

async function run(command: string[]): Promise<string> {
  const process = Bun.spawn({ cmd: command, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim().slice(0, 2_000)}`);
  return stdout.trim();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
