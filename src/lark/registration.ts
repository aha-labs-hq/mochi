import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { larkContextEnvironment } from "./process.ts";
import { isLarkBrand, isLarkOpenOrigin, type LarkBrand } from "./platform.ts";

const PROFILE = "mochi";
const REGISTRATION_TIMEOUT_MS = 10 * 60_000;
const MAXIMUM_OUTPUT_BYTES = 64 * 1024;

export type FeishuRegistrationFailure = "registration_cancelled" | "registration_expired"
  | "registration_output_invalid" | "registration_failed" | "registration_stage_invalid";

export class FeishuRegistrationError extends Error {
  constructor(readonly code: FeishuRegistrationFailure) { super(code); this.name = "FeishuRegistrationError"; }
}

export interface FeishuRegisteredApp {
  appId: string;
  brand: LarkBrand;
  profile: "mochi";
}

/** Official lark-cli 1.0.93 prints the pending URL as a standalone stderr line,
 * not JSON. Only this documented transport is decoded; prose and QR art are ignored.
 * The returned opaque URL is host-only and must never enter status/logs/the renderer.
 */
export function parseFeishuRegistrationUrl(line: string): string | undefined {
  const text = line.trim();
  if (!text.startsWith("https://")) return undefined;
  if (text.length > 2_048) throw new FeishuRegistrationError("registration_output_invalid");
  let url: URL;
  try { url = new URL(text); } catch { throw new FeishuRegistrationError("registration_output_invalid"); }
  if (!isLarkOpenOrigin(url.origin) || url.pathname !== "/page/cli" || url.username || url.password
    || url.hash || url.href !== text) throw new FeishuRegistrationError("registration_output_invalid");
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 4 || new Set(keys).size !== 4
    || keys.some((key) => !["user_code", "lpv", "ocv", "from"].includes(key))
    || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(url.searchParams.get("user_code") ?? "")
    || !/^\d+\.\d+\.\d+$/.test(url.searchParams.get("lpv") ?? "")
    || url.searchParams.get("ocv") !== url.searchParams.get("lpv")
    || url.searchParams.get("from") !== "cli") throw new FeishuRegistrationError("registration_output_invalid");
  return text;
}

/** config init's terminal result is deliberately not the usual API envelope.
 * Its only credential field must be masked. A valid result proves local handoff,
 * not scopes, publication, group membership or a usable message stream.
 */
export function parseFeishuRegisteredApp(value: unknown): FeishuRegisteredApp {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeishuRegistrationError("registration_output_invalid");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "appId,appSecret,brand" || !isLarkBrand(data.brand)
    || typeof data.appId !== "string" || !/^cli_[a-zA-Z0-9_]{1,128}$/.test(data.appId)
    || data.appSecret !== "****") throw new FeishuRegistrationError("registration_output_invalid");
  return { appId: data.appId, brand: data.brand, profile: PROFILE };
}

/** Creates through the provider's official browser flow in a new isolated
 * CLI config directory. No current profile is overwritten and no secret is parsed.
 * The caller retains the stage on every outcome: a canceled/timed-out browser flow
 * may already have created an external App. Never retry creation automatically.
 * A private exclusive marker claims this stage before spawning: even if the CLI
 * has not saved a profile yet, neither a second click nor a restart can reuse it.
 * An explicit per-connection HOME also contains the official CLI's encrypted
 * files. macOS Keychain access still belongs to the signed CLI and current user;
 * Mochi never exports or downgrades its master key. Delete-all can therefore
 * remove customer credentials with the same product-owned data root.
 * This adapter does not promote credentials or change an existing connection.
 */
export async function registerFeishuApp(input: {
  cliPath: string;
  stageDirectory: string;
  signal: AbortSignal;
  onVerificationUrl: (url: string) => void;
}): Promise<FeishuRegisteredApp> {
  if (input.signal.aborted) throw new FeishuRegistrationError("registration_cancelled");
  assertEmptyPrivateStage(input.stageDirectory);
  try {
    const marker = openSync(join(input.stageDirectory, ".registration-started"), "wx", 0o600);
    try { fsyncSync(marker); } finally { closeSync(marker); }
    const directory = openSync(input.stageDirectory, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  catch { throw new FeishuRegistrationError("registration_stage_invalid"); }
  let child: ReturnType<typeof spawnRegistration>;
  try { child = spawnRegistration(input.cliPath, input.stageDirectory); }
  catch { throw new FeishuRegistrationError("registration_failed"); }
  let failure: FeishuRegistrationError | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let verificationUrl: string | undefined;
  const stop = (code: FeishuRegistrationFailure) => {
    if (failure) return;
    failure = new FeishuRegistrationError(code);
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  };
  const cancel = () => stop("registration_cancelled");
  input.signal.addEventListener("abort", cancel, { once: true });
  if (input.signal.aborted) cancel();
  const deadline = setTimeout(() => stop("registration_expired"), REGISTRATION_TIMEOUT_MS);
  const stdout: string[] = [];
  let buffered = "";
  const line = (text: string) => {
    if (failure) return;
    const url = parseFeishuRegistrationUrl(text);
    if (!url) return;
    if (verificationUrl && verificationUrl !== url) throw new FeishuRegistrationError("registration_output_invalid");
    if (!verificationUrl) { verificationUrl = url; input.onVerificationUrl(url); }
  };
  try {
    const [, , exitCode] = await Promise.all([
      drain(child.stdout, (text) => stdout.push(text), stop),
      drain(child.stderr, (text) => {
        buffered += text;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop()!;
        for (const text of lines) line(text);
      }, stop),
      child.exited,
    ]);
    if (failure) throw failure;
    line(buffered);
    if (failure) throw failure;
    if (exitCode !== 0) throw new FeishuRegistrationError("registration_failed");
    if (!verificationUrl) throw new FeishuRegistrationError("registration_output_invalid");
    let result: unknown;
    try { result = JSON.parse(stdout.join("")); } catch { throw new FeishuRegistrationError("registration_output_invalid"); }
    return parseFeishuRegisteredApp(result);
  } finally {
    clearTimeout(deadline);
    clearTimeout(killTimer);
    input.signal.removeEventListener("abort", cancel);
  }
}

function spawnRegistration(cliPath: string, stageDirectory: string) {
  return Bun.spawn({
    cmd: [cliPath, "config", "init", "--new", "--name", PROFILE, "--brand", "feishu", "--lang", "zh"],
    cwd: "/var/empty", stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: larkContextEnvironment({ cliPath, profile: PROFILE, configDirectory: stageDirectory }),
  });
}

async function drain(stream: ReadableStream<Uint8Array>, consume: (text: string) => void,
  stop: (code: FeishuRegistrationFailure) => void): Promise<void> {
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let invalid = false;
  try {
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (invalid) continue;
      try {
        if (bytes > MAXIMUM_OUTPUT_BYTES) throw new FeishuRegistrationError("registration_output_invalid");
        consume(decoder.decode(chunk, { stream: true }));
      } catch { invalid = true; stop("registration_output_invalid"); }
    }
    if (!invalid) consume(decoder.decode());
  } catch { stop("registration_output_invalid"); }
}

function assertEmptyPrivateStage(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!isAbsolute(path) || realpathSync(path) !== resolve(path) || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700 || readdirSync(path).length !== 0) throw new Error();
  } catch { throw new FeishuRegistrationError("registration_stage_invalid"); }
}
