import { statSync } from "node:fs";
import { relative } from "node:path";
import type { RuntimeConfig } from "../config.ts";
import { exactKeys, record } from "./protocol.ts";
import { runtimeLauncherEnvironment, runtimeWorkerCommand } from "./process.ts";
import { RuntimeTransport } from "./transport.ts";

/** Verifies the root-owned launcher locally, then asks that same worker to audit its opaque account. */
export async function verifyRuntimeIsolation(config: Pick<RuntimeConfig, "sudoPath" | "runtimeUser" | "workerPath" | "runtimeCwd" | "runtimeHome">): Promise<string> {
  const currentUser = process.env.USER?.trim();
  const currentHome = process.env.HOME?.trim();
  if (currentUser && config.runtimeUser === currentUser) throw new Error("runtime user equals Bridge user");
  if (currentHome && isWithin(currentHome, config.workerPath)) {
    throw new Error("Pi worker must not be loaded from the Bridge user's home");
  }
  for (const path of [config.workerPath, config.sudoPath]) {
    const entry = statSync(path);
    if (!entry.isFile() || (entry.mode & 0o111) === 0) throw new Error(`${path} is not executable`);
    if (entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
      throw new Error(`${path} must be root-owned and not group/world-writable`);
    }
  }
  const home = statSync(config.runtimeHome);
  const runtimeUid = Number(await runCommand(["/usr/bin/id", "-u", config.runtimeUser]));
  if (!Number.isInteger(runtimeUid)) throw new Error(`cannot resolve uid for ${config.runtimeUser}`);
  if (!home.isDirectory() || home.uid !== runtimeUid || (home.mode & 0o077) !== 0) {
    throw new Error(`${config.runtimeHome} must be a mode-700 directory owned by ${config.runtimeUser}`);
  }
  const bridgeRoot = process.cwd();
  for (const path of [config.runtimeHome, config.runtimeCwd]) {
    if (isWithin(bridgeRoot, path) || isWithin(path, bridgeRoot)) {
      throw new Error("Pi runtime paths must not overlap the Bridge repository");
    }
  }

  let fatal: Error | undefined;
  const transport = new RuntimeTransport({
    command: runtimeWorkerCommand(config),
    environment: runtimeLauncherEnvironment(),
    onEvent: (event) => { fatal = new Error(`Unexpected runtime audit event: ${event}`); },
    onRequest: async (method) => ({
      ok: false,
      error: { code: "audit_rejected", message: `Unexpected runtime audit request: ${method}` },
    }),
    onFatal: (error) => { fatal = error; },
    onExit: () => undefined,
  });
  transport.start();
  try {
    const audit = record(await transport.request("runtime.audit", {}), "runtime.audit result");
    exactKeys(audit, ["userId", "home", "cwd"], "runtime.audit result");
    if (
      audit.userId !== runtimeUid
      || audit.home !== config.runtimeHome
      || audit.cwd !== config.runtimeCwd
      || fatal
    ) throw fatal ?? new Error("Pi worker returned an inconsistent isolation audit");
  } finally {
    await transport.stop(new Error("Pi runtime isolation audit completed"));
  }
  return `user=${config.runtimeUser} cwd=empty auth=opaque capabilities=fixed`;
}

async function runCommand(command: string[]): Promise<string> {
  const process = Bun.spawn({
    cmd: command,
    stdout: "pipe",
    stderr: "pipe",
    env: runtimeLauncherEnvironment(),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim().slice(0, 2_000)}`);
  return stdout.trim();
}

function isWithin(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !value.startsWith("/"));
}
