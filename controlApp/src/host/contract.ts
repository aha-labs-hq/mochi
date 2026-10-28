import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type MochiControlManifest,
  mochiControlManifest,
} from "../../../src/control/manifest.ts";
import { userLayout } from "../../../src/product/layout.ts";
import { fail } from "../shared/problem.ts";

export function parseManifest(value: unknown): MochiControlManifest {
  if (!value || typeof value !== "object")
    fail("component_contract_unavailable");
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.serviceMode !== "development" &&
      candidate.serviceMode !== "installed") ||
    typeof candidate.productVersion !== "string"
  )
    fail("component_contract_unavailable");
  let expected: MochiControlManifest;
  try {
    expected = mochiControlManifest(
      candidate.serviceMode,
      candidate.productVersion,
    );
  } catch {
    fail("component_contract_unavailable");
  }
  if (!isDeepStrictEqual(value, expected)) fail("component_contract_mismatch");
  return expected;
}

export interface DesktopEnvironment {
  manifest: MochiControlManifest;
  application: string;
  resources: string;
  home: string;
  statusPath: string;
  socketPath: string;
  plistPath: string;
  /** The Bridge's structured log, read for activity and diagnostics. */
  logPath: string;
  /** This App's own structured log. */
  companionLogPath: string;
}

export function environment(): DesktopEnvironment {
  const resources = resolve(dirname(process.execPath), "../Resources");
  const manifest = parseManifest(
    JSON.parse(
      readFileSync(join(resources, "MochiControlManifest.json"), "utf8"),
    ),
  );
  return environmentFor(manifest, resolve(resources, "../.."), homedir());
}

export function environmentFor(
  manifest: MochiControlManifest,
  application: string,
  home: string,
): DesktopEnvironment {
  // The Bridge resolves the same user paths from the same owner, so the two
  // sides of the socket and status file cannot drift apart.
  const paths = userLayout(home);
  return {
    manifest,
    application,
    resources: join(application, "Contents/Resources"),
    home,
    statusPath: paths.statusSnapshotPath,
    socketPath: paths.controlSocketPath,
    plistPath: paths.launchAgentPath,
    logPath: paths.structuredLogPath,
    companionLogPath: paths.companionLogPath,
  };
}

export function locationReady(env: DesktopEnvironment): boolean {
  if (env.manifest.serviceMode === "development") return true;
  return (
    resolve(env.application) === env.manifest.installedApplicationPath &&
    exactFile(env.application, "directory")
  );
}

export function exactFile(
  path: string,
  kind: "directory" | "file" | "socket",
): boolean {
  try {
    const entry = lstatSync(path);
    const canonical =
      kind === "socket"
        ? realpathSync(dirname(path)) === resolve(dirname(path))
        : realpathSync(path) === resolve(path);
    return (
      !entry.isSymbolicLink() &&
      canonical &&
      (kind === "directory"
        ? entry.isDirectory()
        : kind === "socket"
          ? entry.isSocket()
          : entry.isFile())
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
