import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";

/**
 * The one official lark-cli Mochi deploys and ships. Its event and mail adapters
 * depend on this release's exact behavior, so an upgrade is a reviewed change of
 * this pin. The digest is of `lark-cli` inside the official GitHub release
 * archive `lark-cli-<version>-darwin-arm64.tar.gz`, which the npm package installs.
 */
export const OFFICIAL_LARK_CLI = {
  version: "1.0.93",
  teamId: "JBRN9C6V7T",
  executableSha256: {
    arm64: "9092c3f255b749afdc2a842be5d582511d978424c11326d59af90c0fd5f5c044",
  } as Readonly<Record<string, string>>,
} as const;

/** One official executable requirement for development and release artifacts. */
export async function verifyOfficialLarkBinary(path: string, architecture = process.arch === "arm64" ? "arm64" : "x86_64"): Promise<void> {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o111) === 0) {
    throw new Error("lark-cli must be a regular native executable, not a wrapper or symlink");
  }
  const expectedSha256 = OFFICIAL_LARK_CLI.executableSha256[architecture];
  if (!expectedSha256) throw new Error(`No official lark-cli is pinned for ${architecture}; Mochi ships for Apple silicon only`);
  if (await fileSha256(path) !== expectedSha256) {
    throw new Error(`lark-cli is not the pinned official ${OFFICIAL_LARK_CLI.version} executable`);
  }
  await inspect(["/usr/bin/codesign", "--verify", "--strict", path]);
  const signature = await inspect(["/usr/bin/codesign", "-dv", "--verbose=4", path]);
  if (!/^Identifier=lark-cli$/m.test(signature) || !new RegExp(`^TeamIdentifier=${OFFICIAL_LARK_CLI.teamId}$`, "m").test(signature)) {
    throw new Error("lark-cli is not the official Lark-signed native executable");
  }
  if (/^lark-cli version (\S+)$/m.exec(await inspect([path, "--version"]))?.[1] !== OFFICIAL_LARK_CLI.version) {
    throw new Error(`lark-cli does not report the pinned version ${OFFICIAL_LARK_CLI.version}`);
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspect(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: "/var/empty", stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native lark-cli verification failed: ${command[0]} (${code})`);
    return `${stdout}\n${stderr}`;
  } finally {
    clearTimeout(timeout);
  }
}
