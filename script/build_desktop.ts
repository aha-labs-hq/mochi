import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { prepareElectrobunBundle } from "../controlApp/build/electrobun.ts";
import { desktopIdentity } from "../controlApp/build/identity.ts";
import { writeDesktopNotices } from "../controlApp/build/notices.ts";
import { prepareResources } from "../controlApp/build/resources.ts";
import {
  pinnedElectrobunEnvironment,
  verifyDesktopToolchain,
} from "../controlApp/build/toolchain.ts";
import { buildRenderer } from "../controlApp/build/vite.ts";
import { parseManifest } from "../controlApp/src/host/contract.ts";
import { version } from "../package.json";
import { mochiControlManifest } from "../src/control/manifest.ts";
import { bridgeOnDuty, resumeDuty } from "../src/maintenance/service.ts";
import { userLayout } from "../src/product/layout.ts";
import { BUN_ENTITLEMENTS_PATH } from "./bun_signing.ts";

const root = resolve(import.meta.dir, "..");
const build = join(root, "controlApp/.build");
async function command(
  args: string[],
  input?: string,
  environment = process.env,
): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: root,
    env: environment,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "inherit",
  });
  const [code, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (code !== 0)
    throw new Error(`Desktop build command failed (${code}): ${args[0]}`);
  return output.trim();
}
/** Sign leaves before the bundle. The package builder can then reseal its embedded package. */
export async function signDesktop(
  application: string,
  identity = "-",
): Promise<void> {
  const macho: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const magic = Buffer.from(
          await Bun.file(path).slice(0, 4).arrayBuffer(),
        ).toString("hex");
        if (["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"].includes(magic))
          macho.push(path);
      }
    }
  }
  await visit(join(application, "Contents"));
  for (const path of [...macho, application])
    await command([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      identity,
      ...(identity !== "-" ? ["--timestamp", "--options", "runtime"] : []),
      ...(path === application ||
      path === join(application, "Contents/MacOS/Mochi")
        ? ["--entitlements", BUN_ENTITLEMENTS_PATH]
        : []),
      path,
    ]);
  await command([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    application,
  ]);
}

export async function buildDesktop(buildOnly: boolean): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error("Mochi desktop must be built on macOS");
  const identity = desktopIdentity(buildOnly);
  await mkdir(build, { recursive: true });
  await command([process.execPath, "run", "script/prepare_desktop.ts"]);
  await command([
    join(root, "node_modules/.bin/tsc"),
    "--noEmit",
    "-p",
    "controlApp/tsconfig.json",
  ]);
  await prepareResources(root, build, command);
  const source = process.env.MOCHI_CONTROL_MANIFEST_SOURCE;
  if (source && !buildOnly)
    throw new Error("Installed manifests are only accepted by --build-only");
  const manifest = source
    ? parseManifest(JSON.parse(await readFile(source, "utf8")))
    : mochiControlManifest("development", version);
  if (manifest.productVersion !== version)
    throw new Error("Desktop product version mismatch");
  await writeFile(
    join(build, "resources/MochiControlManifest.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  await buildRenderer();
  const electrobun = await pinnedElectrobunEnvironment(root);
  await command(
    [join(root, "node_modules/.bin/electrobun"), "build", "--env=stable"],
    undefined,
    { ...electrobun, MOCHI_DESKTOP_DEVELOPMENT: buildOnly ? "0" : "1" },
  );
  await verifyDesktopToolchain(root, electrobun);
  const { application: staged, runtimeVersion } = await prepareElectrobunBundle(
    build,
    identity,
    command,
  );
  await writeDesktopNotices(root, staged, runtimeVersion);
  await signDesktop(staged, process.env.MOCHI_APP_SIGN_IDENTITY);
  // LaunchServices must load development code outside TCC-protected checkouts.
  const destination = join(
    buildOnly ? join(root, "dist") : join(homedir(), "Applications"),
    `${identity.name}.app`,
  );
  await mkdir(dirname(destination), { recursive: true });
  const previous = await mkdtemp(join(dirname(destination), ".mochi-publish-"));
  try {
    await cp(staged, join(previous, "incoming.app"), { recursive: true });
    if (!buildOnly) await stopDesktop(destination);
    if (existsSync(destination))
      await rename(destination, join(previous, basename(destination)));
    await rename(join(previous, "incoming.app"), destination);
  } catch (error) {
    if (existsSync(join(previous, basename(destination)))) {
      await rm(destination, { recursive: true, force: true });
      await rename(join(previous, basename(destination)), destination);
    }
    throw error;
  } finally {
    await rm(previous, { recursive: true, force: true });
  }
  return destination;
}

/** The launcher's output, beside the App's own private log. */
function bootstrapLogPath(): string {
  return join(userLayout(homedir()).logDirectory, "desktop-bootstrap.log");
}

export async function launchDesktop(
  application: string,
  renderer?: string,
): Promise<ReturnType<typeof Bun.spawn>> {
  await stopDesktop(application);
  // launchd cannot open redirected streams inside a TCC-protected checkout.
  // Use the same private log directory as the App, without extra permissions.
  const output = bootstrapLogPath();
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, "", { mode: 0o600 });
  // Normal verification uses the same LaunchServices path as Finder. Only HMR
  // needs a direct child with the launcher-owned renderer capability and pipe.
  const child = Bun.spawn(
    renderer
      ? [join(application, "Contents/MacOS/Mochi")]
      : [
          "/usr/bin/open",
          "-n",
          "-W",
          "--stdout",
          output,
          "--stderr",
          output,
          application,
        ],
    {
      env: { ...process.env, MOCHI_RENDERER_URL: renderer },
      cwd: "/var/empty",
      detached: true,
      stdin: renderer ? "pipe" : "ignore",
      stdout: Bun.file(output),
      stderr: Bun.file(output),
    },
  );
  child.unref();
  return child;
}

async function desktopProcesses(
  application: string,
  includeLegacyRuntime = false,
): Promise<number[]> {
  return (await command(["/bin/ps", "-axo", "pid=,comm="]))
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match &&
        (includeLegacyRuntime ? ["Mochi", "bun"] : ["Mochi"]).some(
          (name) => match[2] === join(application, "Contents/MacOS", name),
        )
        ? [Number(match[1])]
        : [];
    });
}
/**
 * Quitting the App ends duty by product contract. A developer launcher replaces
 * the App, not the user's decision, so it leaves duty as it found it: the
 * returned function resumes duty that was on when this was called.
 */
export function preserveDuty(): () => Promise<void> {
  const onDuty = bridgeOnDuty();
  return async () => {
    if (onDuty && !bridgeOnDuty()) await resumeDuty();
  };
}
export async function stopDesktop(application: string): Promise<void> {
  // A running pre-upgrade App still owns Bun under the old launcher identity.
  if (!(await desktopProcesses(application, true)).length) return;
  await command([
    "/usr/bin/osascript",
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('AppKit'); for (const app of ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications)) { if (app.bundleURL && ObjC.unwrap(app.bundleURL.path) === ${JSON.stringify(application)}) app.terminate; }`,
  ]);
  const deadline = Date.now() + 30_000;
  while (
    Date.now() < deadline &&
    (await desktopProcesses(application, true)).length
  )
    await Bun.sleep(100);
  if ((await desktopProcesses(application, true)).length)
    throw new Error(
      "Mochi has not completed shutdown; the existing App was not replaced. Resolve its pending decision or shutdown problem before starting again.",
    );
}
export async function verifyDesktop(
  application: string,
  started: number,
  child: Pick<ReturnType<typeof Bun.spawn>, "exitCode" | "signalCode">,
): Promise<void> {
  const log = userLayout(homedir()).companionLogPath,
    deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Desktop launcher exited before readiness (${child.signalCode ?? child.exitCode}); inspect ${bootstrapLogPath()}`,
      );
    const pids = await desktopProcesses(application);
    if (existsSync(log)) {
      const records = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              timestamp: string;
              event: string;
              processId?: number;
              phase?: string;
            },
        );
      const events = records.filter(
        (record) =>
          Date.parse(record.timestamp) >= started &&
          pids.includes(record.processId ?? 0),
      );
      if (
        ["host.ready", "menu.created", "renderer.ready"].every((event) =>
          events.some((record) => record.event === event),
        ) &&
        events.some(
          (record) =>
            record.event === "renderer.health" &&
            record.phase === "motion-ready",
        )
      ) {
        console.log(
          "Verified exact Mochi executable: host, status item creation, renderer and character assets are ready. Menu visibility and interaction require native acceptance.",
        );
        return;
      }
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Desktop did not prove host, status item creation, renderer and character readiness within 20 seconds; inspect ${bootstrapLogPath()}`,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    args.some((arg) => !["--run", "--build-only", "--verify"].includes(arg))
  )
    throw new Error("Usage: bun run app:build [--run|--build-only|--verify]");
  const run = args.includes("--run") || args.includes("--verify");
  const restoreDuty = run ? preserveDuty() : async () => {};
  try {
    const application = await buildDesktop(!run);
    console.log(`Built ${application}`);
    if (run) {
      const started = Date.now();
      const child = await launchDesktop(application);
      console.log(`Opened ${application}`);
      await verifyDesktop(application, started, child);
    }
  } finally {
    await restoreDuty();
  }
}
