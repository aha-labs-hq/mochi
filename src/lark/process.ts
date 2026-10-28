import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { LarkBrand } from "./platform.ts";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const DEFAULT_LARK_COMMAND_TIMEOUT_MILLISECONDS = 30_000;

/** Captured per connection. Never resolve an ambient/default profile during a turn. */
export interface LarkContext {
  readonly cliPath: string;
  readonly profile: string;
  readonly configDirectory: string;
  readonly brand?: LarkBrand;
}

export function larkCommand(context: LarkContext, args: readonly string[]): string[] {
  assertLarkContext(context);
  return [context.cliPath, "--profile", context.profile, ...args];
}

export function larkContextEnvironment(context: LarkContext): Record<string, string> {
  assertLarkContext(context);
  return { ...larkEnvironment(context.cliPath), HOME: context.configDirectory,
    LARKSUITE_CLI_CONFIG_DIR: context.configDirectory };
}

function assertLarkContext(context: LarkContext): void {
  if (!isAbsolute(context.cliPath) || !/^[a-zA-Z0-9_-]{1,128}$/.test(context.profile)
    || !isAbsolute(context.configDirectory) || resolve(context.configDirectory) !== context.configDirectory) {
    throw new Error("Invalid explicit lark-cli connection context");
  }
}

export function larkEnvironment(
  cliPath: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    ["LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME"]
      .flatMap((key) => source[key] === undefined ? [] : [[key, source[key] as string]]),
  );
  environment.HOME = source.HOME?.trim() || homedir();
  environment.PATH = isAbsolute(cliPath) ? `${dirname(cliPath)}:${SYSTEM_PATH}` : SYSTEM_PATH;
  environment.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = "1";
  environment.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = "1";
  return environment;
}

export async function runLarkJson(
  context: LarkContext,
  args: readonly string[],
  options: { cwd?: string; timeoutMilliseconds?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const command = larkCommand(context, args);
  const text = await runLarkCommand(context.cliPath, command.slice(1), {
    ...options, configDirectory: context.configDirectory,
  });
  if (!text) throw new Error("lark-cli returned empty stdout");
  return JSON.parse(text) as unknown;
}

export async function runLarkCommand(
  cliPath: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMilliseconds?: number; configDirectory?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const timeoutMilliseconds = options.timeoutMilliseconds
    ?? DEFAULT_LARK_COMMAND_TIMEOUT_MILLISECONDS;
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("lark-cli timeout must be a positive integer");
  }
  if (options.signal?.aborted) throw new Error("lark-cli aborted");
  const process = Bun.spawn({
    cmd: [cliPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...larkEnvironment(cliPath),
      ...(options.configDirectory ? { HOME: options.configDirectory, LARKSUITE_CLI_CONFIG_DIR: options.configDirectory } : {}),
    },
    cwd: options.cwd ?? "/var/empty",
  });
  let timedOut = false;
  let aborted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    process.kill("SIGKILL");
  }, timeoutMilliseconds);
  const abort = () => {
    aborted = true;
    process.kill("SIGKILL");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  let stdout: string;
  let exitCode: number;
  try {
    [stdout, , exitCode] = await Promise.all([
      readBoundedOutput(process.stdout, 32 * 1024 * 1024),
      readBoundedOutput(process.stderr, 64 * 1024),
      process.exited,
    ]);
  } catch (error) {
    process.kill("SIGKILL");
    await process.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
  if (aborted) throw new Error("lark-cli aborted");
  if (timedOut) throw new Error(`lark-cli timed out after ${timeoutMilliseconds}ms`);
  if (exitCode !== 0) {
    // Provider prose can contain authorization URLs or credential details. The caller
    // owns recovery; subprocess stderr is never a product error or a log payload.
    throw new Error(`lark-cli exited ${exitCode}`);
  }
  return stdout.trim();
}

async function readBoundedOutput(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error("lark-cli output exceeded its bounded contract");
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally { reader.releaseLock(); }
}

export function isSuccessfulLarkEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}
