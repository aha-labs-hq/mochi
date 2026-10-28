import { chmod, copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DevelopmentDeployment } from "../src/product/developmentDeployment.ts";
import { verifyOfficialLarkBinary } from "../src/product/larkBinary.ts";
import { GITHUB_REGISTRATION_RESOURCE_NAME, resolveProductLayout } from "../src/product/layout.ts";
import { stageGitHubClientRegistration } from "../src/github/registration.ts";
import { BRIDGE_VERSION } from "../src/product/version.ts";
import { SERVICE_LABEL } from "../src/product/layout.ts";
import { ProcessLock } from "../src/processLock.ts";
import { waitUntilStopped } from "../src/maintenance/service.ts";

const repository = resolve(import.meta.dir, "..");
const layout = resolveProductLayout({ environment: {} });
const target = `gui/${process.getuid!()}/${SERVICE_LABEL}`;
const environment = Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR"].flatMap((key) =>
  process.env[key] === undefined ? [] : [[key, process.env[key]!]]));

async function command(args: string[], cwd = "/var/empty", timeoutMilliseconds = 120_000): Promise<string> {
  const child = Bun.spawn(args, { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMilliseconds);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Development command failed (${code}): ${args[0]}\n${stderr.trim()}`);
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const args = parseDevelopmentDeployArguments(process.argv.slice(2));
  const lock = await ProcessLock.acquire(join(layout.mutableRoot, "deployment.lock"));
  const transaction = new DevelopmentDeployment(layout, {
    async stop() {
      const current = Bun.spawnSync(["/bin/launchctl", "print", target], { stdout: "pipe", stderr: "pipe" });
      if (current.exitCode === 113) return;
      if (current.exitCode !== 0) throw new Error("Cannot inspect the current development service");
      const program = current.stdout.toString().match(/^\s*program = (.+)$/m)?.[1];
      if (program !== layout.bridgeExecutablePath) throw new Error("Another deployment owns the LaunchAgent; explicit migration is required");
      const pidText = current.stdout.toString().match(/^\s*pid = (\d+)$/m)?.[1];
      await command(["/bin/launchctl", "bootout", target]);
      await waitUntilStopped(target, pidText ? Number(pidText) : undefined);
    },
    async start() {
      await command([process.execPath, "--no-env-file", "run", join(repository, "src/maintenance/service.ts"), "install"]);
    },
    async verify() {
      await command([process.execPath, "--no-env-file", "run", join(repository, "src/maintenance/service.ts"), "status"]);
    },
    async restore() {
      await command(["/bin/launchctl", "bootstrap", `gui/${process.getuid!()}`, layout.launchAgentPath]);
      // The restored release owns its status protocol. Current code must not decode
      // an older snapshot or claim that the restored product has passed readiness.
    },
  });
  try {
    if (args.mode === "rollback") {
      await transaction.rollback();
      console.log("Previous development code and LaunchAgent restored; verify readiness with its matching App. Configuration and state were not replaced.");
      return;
    }
    if (args.mode === "accept") {
      await transaction.accept();
      console.log("Verified development runtime accepted; old code and deployment journal removed. Configuration and state were not replaced.");
      return;
    }
    await verifyOfficialLarkBinary(args.larkCliPath);
    transaction.begin();
    console.log("Preparing checkout-independent development runtime; live service unchanged.");
    await command([process.execPath, "--no-env-file", "run", "script/build_pi_runtime.ts"], repository);
    const bin = join(transaction.stagedRuntime, "bin");
    const resources = join(transaction.stagedRuntime, "Resources");
    await mkdir(bin, { recursive: true, mode: 0o700 });
    await mkdir(resources, { mode: 0o700 });
    stageGitHubClientRegistration(args.githubRegistrationPath, join(resources, GITHUB_REGISTRATION_RESOURCE_NAME));
    for (const [source, destination] of [
      [join(repository, "dist/mochi-bridge"), join(bin, "mochi-bridge")],
      [args.larkCliPath, join(bin, "lark-cli")],
    ]) {
      await copyFile(source!, destination!);
      await chmod(destination!, 0o700);
    }
    await cp(join(repository, "config/protocol"), join(resources, "protocol"), { recursive: true, dereference: false });
    // New Bots are provisioned from the shipped defaults, so a development
    // deployment must stage them exactly as the product package does.
    await cp(join(repository, "config/bot.toml"), join(resources, "defaults/bot.toml"));
    await cp(join(repository, "config/AGENTS.md"), join(resources, "defaults/AGENTS.md"));
    await copyFile(join(repository, "package.json"), join(resources, "product.json"));
    await copyFile(join(repository, "dist/THIRD_PARTY_NOTICES.txt"), join(resources, "THIRD_PARTY_NOTICES.txt"));
    if (!(await readFile(join(resources, "THIRD_PARTY_NOTICES.txt"), "utf8")).trim()) throw new Error("Missing runtime notices");
    await verifyOfficialLarkBinary(join(bin, "lark-cli"));
    if (await command([join(bin, "mochi-bridge"), "--version"], "/var/empty", 10_000) !== `mochi-bridge ${BRIDGE_VERSION}`) {
      throw new Error("Staged Bridge version mismatch");
    }
    console.log("Staged artifacts verified; publishing development runtime.");
    await transaction.publish();
    console.log("Development runtime ready. Existing configuration, database and Pi session retained.");
  } finally {
    await lock.release();
  }
}

export function parseDevelopmentDeployArguments(values: readonly string[]):
  | { mode: "rollback" }
  | { mode: "accept" }
  | { mode: "deploy"; larkCliPath: string; githubRegistrationPath: string } {
  if (values.length === 1 && values[0] === "--rollback") return { mode: "rollback" };
  if (values.length === 1 && values[0] === "--accept") return { mode: "accept" };
  const inputs = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]!, value = values[index + 1];
    if (!["--lark-cli", "--github-registration"].includes(key) || inputs.has(key) || !value || !isAbsolute(value)) {
      throw new Error("Development deploy requires unique --lark-cli and --github-registration absolute paths, --rollback, or --accept");
    }
    inputs.set(key, value);
  }
  if (inputs.size !== 2) throw new Error("Development deploy requires --lark-cli and --github-registration");
  return { mode: "deploy", larkCliPath: inputs.get("--lark-cli")!, githubRegistrationPath: inputs.get("--github-registration")! };
}

if (import.meta.main) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("No account or session reset was performed. If .deployment exists, inspect it and use service:deploy --rollback before another deployment.");
  process.exitCode = 1;
});
