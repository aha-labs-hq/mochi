import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * The one entitlement every shipped Bun executable carries. Under the hardened
 * runtime JavaScriptCore can only allocate executable memory with MAP_JIT;
 * without it Bun silently falls back to its interpreter (about 6x slower).
 */
export const BUN_ENTITLEMENTS_PATH = join(import.meta.dir, "bun.entitlements.plist");
export const BUN_ENTITLEMENTS = { "com.apple.security.cs.allow-jit": true } as const;

// JavaScriptCore reports this compile count when its optimizing JIT cannot run.
const JIT_UNAVAILABLE = 1_000_000;
const JIT_PROBE = `import { numberOfDFGCompiles } from "bun:jsc";
function hot(n) { let total = 0; for (let index = 0; index < n; index += 1) total = (total + index * 7) % 1000003; return total; }
const deadline = performance.now() + 10000;
let compiles = numberOfDFGCompiles(hot);
while (compiles === 0 && performance.now() < deadline) { hot(10000); compiles = numberOfDFGCompiles(hot); }
process.stdout.write(compiles > 0 && compiles < ${JIT_UNAVAILABLE} ? "jit" : "interpreter");`;

/**
 * One signing recipe for the Bridge and the Pi worker in development and release
 * packages: hardened runtime plus exactly the Bun entitlement. Only the identity
 * differs, so an ad-hoc development package already runs under the release
 * runtime constraints and proves JIT on its exact bytes.
 */
export async function signBunExecutable(path: string, identity?: string): Promise<void> {
  await inspect([
    "/usr/bin/codesign", "--force", "--options", "runtime",
    "--entitlements", BUN_ENTITLEMENTS_PATH,
    ...(identity ? ["--timestamp"] : []),
    "--sign", identity ?? "-",
    path,
  ]);
  await verifyBunExecutable(path);
}

/** The signed executable keeps its hardened runtime, exact entitlement and working JIT. */
export async function verifyBunExecutable(path: string): Promise<void> {
  await inspect(["/usr/bin/codesign", "--verify", "--strict", path]);
  const details = await inspect(["/usr/bin/codesign", "-dv", "--verbose=2", path]);
  if (!/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/m.test(details)) {
    throw new Error(`${basename(path)} is not signed with the hardened runtime`);
  }
  await requireBunEntitlements(path);
  if (!(await bunJitAvailable(path))) {
    throw new Error(`${basename(path)} lost Bun's JIT under its signature; it needs ${Object.keys(BUN_ENTITLEMENTS)[0]}`);
  }
}

/** Signed code (an executable or an App bundle) carries exactly the Bun entitlement. */
export async function requireBunEntitlements(path: string): Promise<void> {
  const plist = await inspect(["/usr/bin/codesign", "-d", "--entitlements", "-", "--xml", path], "stdout");
  const actual = plist.trim()
    ? JSON.parse(await inspect(["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"], "stdout", plist)) as unknown
    : {};
  if (!isDeepStrictEqual(actual, BUN_ENTITLEMENTS)) {
    throw new Error(`${basename(path)} must carry exactly the Bun JIT entitlement`);
  }
}

/**
 * Runs a fixed JIT probe inside the exact signed Bun executable. `BUN_BE_BUN`
 * makes a compiled Bun program act as the Bun CLI, so the probe runs under the
 * program's own code signature without executing Mochi code.
 */
export async function bunJitAvailable(executable: string): Promise<boolean> {
  const result = await inspect([executable, "-e", JIT_PROBE], "stdout", undefined, {
    BUN_BE_BUN: "1",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: tmpdir(),
  });
  if (result !== "jit" && result !== "interpreter") {
    throw new Error(`${basename(executable)} returned an unexpected JIT probe result`);
  }
  return result === "jit";
}

async function inspect(
  command: readonly string[],
  output: "stdout" | "both" = "both",
  input?: string,
  // Signing keeps the caller's session environment: Developer ID keys live in its Keychain.
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd: "/var/empty",
    env: environment,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${basename(command[0]!)} exited ${code} for ${basename(command.at(-1)!)}`);
    return output === "stdout" ? stdout : `${stdout}${stderr}`;
  } finally {
    clearTimeout(timeout);
  }
}
