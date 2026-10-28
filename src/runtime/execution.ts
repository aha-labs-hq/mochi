import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executionToolDefinitions } from "./executionRunner.ts";
import { NON_PUBLIC_ADDRESS_RANGES, PublicNetworkUnavailableError, publicDestinationFilter, systemResolve } from "./executionNetwork.ts";
import { supervisedExecution } from "./executionSupervisor.ts";
import { webResearchTools } from "./webResearch.ts";

const SYSTEM_READ_PATHS = [
  "/bin", "/usr/bin", "/usr/lib", "/usr/share", "/System/Library",
  "/System/Volumes/Preboot/Cryptexes", "/Library/Apple",
  "/private/etc/ssl", "/private/etc/resolv.conf", "/private/etc/hosts",
  "/private/var/db/timezone", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/fd",
];

/**
 * The unsandboxed shell that starts sandbox-exec resolves sandbox-runtime's
 * leading `env` through PATH, so it only ever sees system directories. The
 * turn's writable bin joins PATH inside the sandbox.
 */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** sandbox-runtime chains through these and leaves address checks to the upstream proxy. */
const UPSTREAM_PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"];

/**
 * sandbox-runtime keeps one proxy and one policy per process, and a reset or a
 * second initialize silently changes what every later wrap enforces. One turn
 * owns it at a time, and every command re-checks that it still does.
 */
let sandboxOwner: symbol | undefined;

/** One turn's OS sandbox. The model can compose commands, but cannot reach worker state. */
export class TurnExecution {
  readonly cwd: string;
  readonly #runner: readonly string[];
  readonly #owner: symbol;
  readonly #config: SandboxRuntimeConfig;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #abort = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #fakeIpRefusals = 0;
  #publicNetworkError: PublicNetworkUnavailableError | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  private constructor(cwd: string, runner: readonly string[], owner: symbol, config: SandboxRuntimeConfig) {
    this.cwd = cwd;
    this.#runner = runner;
    this.#owner = owner;
    this.#config = config;
    this.#environment = {
      PATH: SYSTEM_PATH,
      HOME: cwd, TMPDIR: join(cwd, "tmp"), LANG: "en_US.UTF-8",
      CURL_CA_BUNDLE: "/private/etc/ssl/cert.pem",
      SSL_CERT_FILE: "/private/etc/ssl/cert.pem",
    };
  }

  static async create(root: string, materials: string, runner = [process.execPath, "--execute-tool"], resolve = systemResolve): Promise<TurnExecution> {
    if (process.platform !== "darwin") throw new Error("Mochi execution requires the macOS sandbox");
    const upstream = UPSTREAM_PROXY_VARIABLES.filter((name) => process.env[name]);
    if (upstream.length > 0) throw new Error(`Mochi execution cannot run behind an inherited upstream proxy (${upstream.join(", ")})`);
    // Claim before touching the root: its cleanup would remove another turn's scratch.
    if (sandboxOwner) throw new Error("Another turn still owns the execution sandbox");
    const owner = Symbol("execution sandbox owner");
    sandboxOwner = owner;
    let execution: TurnExecution | undefined;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const entry = await lstat(root);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
        || entry.uid !== process.getuid!() || await realpath(root) !== root) throw new Error("Invalid execution root");
      // The Bot's runtime.lock excludes another owner; only abandoned turn scratch is reclaimed.
      for (const name of await readdir(root)) {
        if (!/^turn-[A-Za-z0-9]+$/.test(name)) throw new Error("Unexpected execution root entry");
        await rm(join(root, name), { recursive: true, force: true });
      }
      const cwd = await mkdtemp(join(root, "turn-"));
      const current = new TurnExecution(cwd, runner, owner, executionSandboxConfig(cwd, materials, runner[0]!));
      execution = current;
      await chmod(cwd, 0o700);
      await mkdir(join(cwd, "tmp"), { mode: 0o700 });
      await mkdir(join(cwd, "bin"), { mode: 0o700 });
      await writeFile(join(cwd, "bin/bun"), `#!/bin/bash\nBUN_BE_BUN=1 exec ${shellQuote(runner[0]!)} "$@"\n`, { mode: 0o700 });
      await SandboxManager.initialize(current.#config, publicDestinationFilter((error) => current.#refuseFakeIp(error), resolve), false);
      await current.#verifyBoundary(dirname(root));
      return current;
    } catch (error) {
      if (execution) await execution.close();
      else sandboxOwner = undefined;
      throw error;
    }
  }

  /** Set once this turn has seen fake-IP DNS; public web research cannot succeed for the rest of the turn. */
  get publicNetworkError(): PublicNetworkUnavailableError | undefined { return this.#publicNetworkError; }

  async execute(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error("Execution workspace is closed");
    const refusals = this.#fakeIpRefusals;
    const pending = this.#execute(name, args, AbortSignal.any([this.#abort.signal, ...(signal ? [signal] : [])]));
    this.#pending.add(pending);
    let result: unknown;
    try { result = await pending; }
    finally { this.#pending.delete(pending); }
    // The command only sees the proxy's generic refusal; say why it happened.
    if (this.#fakeIpRefusals === refusals || !this.#publicNetworkError) return result;
    const { content = [], ...rest } = result as { content?: unknown[] };
    return { ...rest, content: [...content, { type: "text", text: this.#publicNetworkError.message }] };
  }

  async #execute(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    if (sandboxOwner !== this.#owner || SandboxManager.getConfig() !== this.#config || SandboxManager.getProxyPort() === undefined) {
      throw new Error("The execution sandbox no longer holds this turn's policy");
    }
    let bashResult: { exitCode: number | null; output: string } | undefined;
    if (name === "bash") {
      const input = args as { command?: unknown; timeout?: unknown };
      if (!input || typeof input.command !== "string") throw new Error("Shell command must be a string");
      if (input.timeout !== undefined && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0)) {
        throw new Error("Command timeout must be positive");
      }
      const result = await this.#run(["/bin/bash", "--noprofile", "--norc", "-c", input.command],
        undefined, Math.min((input.timeout as number | undefined) ?? 120, 120) * 1_000, true, signal);
      bashResult = { exitCode: result.exitCode, output: result.stdout.toString("base64") };
    }
    // Pi's output formatting stays sandboxed: even temporary output paths may
    // have been replaced by a symlink by the preceding model command.
    const output = await this.#run(this.#runner, JSON.stringify({ name, args, bashResult }), 125_000, false, signal);
    if (output.exitCode !== 0) throw new Error(`Sandboxed tool process exited ${output.exitCode}: ${output.stderr.toString().slice(0, 2_000)}`);
    const reply = JSON.parse(output.stdout.toString()) as { ok: boolean; result?: unknown; error?: string };
    if (!reply.ok) throw new Error(reply.error ?? "Sandboxed tool failed");
    return reply.result;
  }

  async #run(argv: readonly string[], input: string | undefined, timeoutMilliseconds: number, combineOutput: boolean, signal: AbortSignal) {
    const command = [
      `PATH=${shellQuote(`${join(this.cwd, "bin")}:${SYSTEM_PATH}`)}`,
      `TMPDIR=${shellQuote(this.#environment.TMPDIR!)}`,
      ...argv.map(shellQuote),
    ].join(" ");
    const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", undefined, signal, { commandId: crypto.randomUUID() });
    return supervisedExecution(this.#runner[0]!, this.cwd, this.#environment, {
      command: ["/bin/bash", "--noprofile", "--norc", "-c", wrapped],
      ...(input === undefined ? {} : { input }), timeoutMilliseconds, combineOutput,
    }, signal);
  }

  /**
   * Proves the boundary through the same runner before the model gets the
   * tools: worker state is neither readable nor writable, a direct connection
   * is refused by the OS, and the proxy refuses what policy forbids. The probe
   * needs no internet and fails closed on any other outcome.
   */
  async #verifyBoundary(protectedDirectory: string): Promise<void> {
    let connections = 0;
    const listener = createServer((socket) => { connections++; socket.destroy(); });
    await new Promise<void>((resolve, reject) => { listener.once("error", reject).listen(0, "127.0.0.1", resolve); });
    const target = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/`;
    const probe = join(protectedDirectory, `.mochi-sandbox-probe-${crypto.randomUUID()}`);
    try {
      const result = await this.execute("bash", {
        command: [
          `ls ${shellQuote(protectedDirectory)} >/dev/null 2>&1; read=$?`,
          `{ : > ${shellQuote(probe)}; } 2>/dev/null; write=$?`,
          `curl --noproxy '*' --silent --output /dev/null --max-time 5 ${shellQuote(target)}; direct=$?`,
          `proxy=$(curl --noproxy '' --silent --output /dev/null --max-time 5 --write-out '%{http_code}' ${shellQuote(target)})`,
          `printf 'read=%s write=%s direct=%s proxy=%s' "$read" "$write" "$direct" "$proxy"`,
        ].join("\n"),
      }) as { content?: Array<{ text?: string }>; isError?: boolean };
      const output = (result.content ?? []).map((item) => item.text ?? "").join("").trim();
      const outcome = /^read=(\d+) write=(\d+) direct=(\d+) proxy=(\d+)$/.exec(output);
      // curl 7: the OS refused the connection; 403: the proxy refused the destination.
      const holds = !result.isError && outcome !== null && outcome[1] !== "0" && outcome[2] !== "0"
        && outcome[3] === "7" && outcome[4] === "403" && connections === 0 && !existsSync(probe);
      if (!holds) throw new Error(`Execution sandbox self-check failed: ${output.slice(0, 500)}; direct connections: ${connections}`);
      // Run as a nonleader so setsid would succeed without the syscall filter.
      // posix_spawn has its own internal setpgid/setsid path and must also fail.
      const processProbe = `import {dlopen} from 'bun:ffi';
const {symbols:s}=dlopen('/usr/lib/libSystem.B.dylib',{
getpgrp:{args:[],returns:'i32'},setsid:{args:[],returns:'i32'},setpgid:{args:['i32','i32'],returns:'i32'}});
const nonleader=process.pid!==s.getpgrp();
const sid=s.setsid(),pgid=s.setpgid(0,0);
let spawnDenied=false;
try{const p=Bun.spawn(['/usr/bin/true'],{detached:true,stdin:'ignore',stdout:'ignore',stderr:'ignore'});await p.exited;}
catch(e){spawnDenied=e.code==='EPERM';}
console.log(nonleader&&sid===-1&&pgid===-1&&spawnDenied?'confined':'unconfined');`;
      const processResult = await this.execute("bash", { command: `bun -e ${shellQuote(processProbe)} & wait` }) as { content?: Array<{ text?: string }>; isError?: boolean };
      if (processResult.isError || processResult.content?.map((item) => item.text ?? "").join("").trim() !== "confined") {
        throw new Error("Execution sandbox cannot confine process groups");
      }
    } finally {
      listener.close();
      await rm(probe, { force: true });
    }
  }

  #refuseFakeIp(error: PublicNetworkUnavailableError): void {
    this.#fakeIpRefusals++;
    if (this.#publicNetworkError) return;
    this.#publicNetworkError = error;
    console.error(JSON.stringify({ event: "runtime.execution.fake_ip_refused", host: error.hostname }));
  }

  close(): Promise<void> {
    return this.#closing ??= this.#close();
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    await Promise.allSettled([...this.#pending]);
    try { await SandboxManager.reset(); }
    finally {
      if (sandboxOwner === this.#owner) sandboxOwner = undefined;
      await rm(this.cwd, { recursive: true, force: true });
    }
  }
}

export function executionTools(current: () => TurnExecution, policy: () => "interactive" | "scheduled" = () => "interactive"): ToolDefinition[] {
  const nativeTools: ToolDefinition[] = executionToolDefinitions("/").map((tool) => ({
    name: tool.name, label: tool.label, parameters: tool.parameters,
    description: `${tool.description}\nRuns in the current turn's private workspace. Tools include bash, curl, system utilities and Bun (JavaScript/TypeScript). Public HTTP/HTTPS uses the provided proxy. Commands are limited to 120 seconds; background jobs end with each command. Process detachment and posix_spawn-based child APIs (including Bun.spawn and Node child_process) are unavailable; launch system commands directly from bash. Input materials are read-only. Files are removed when the turn ends.`,
    executionMode: "sequential" as const,
    execute: async (_id: string, args: unknown, signal: AbortSignal | undefined) => {
      assertExecutionToolAllowed(tool.name, policy());
      return await current().execute(tool.name, args, signal) as Awaited<ReturnType<typeof tool.execute>>;
    },
  }));
  return [...nativeTools, ...webResearchTools(current)];
}
export function assertExecutionToolAllowed(name: string, policy: "interactive" | "scheduled"): void {
  // Public research uses closed GET-only commands in webResearchTools. A
  // general shell would also allow outbound writes with no current human.
  if (policy === "scheduled" && name !== "read") throw new Error("Scheduled work cannot run shell commands or write scratch files; use read-only connectors or web research");
}

export function executionSandboxConfig(cwd: string, materials: string, executable: string): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [], deniedDomains: [], allowLocalBinding: false,
      deniedResolvedAddresses: [...NON_PUBLIC_ADDRESS_RANGES],
    },
    filesystem: {
      denyRead: ["/"], allowRead: [...SYSTEM_READ_PATHS, executable, cwd, materials],
      allowWrite: [cwd], denyWrite: [materials, "/private/tmp", "/private/var"],
    },
    allowAppleEvents: false,
  };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
