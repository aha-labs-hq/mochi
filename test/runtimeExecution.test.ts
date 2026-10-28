import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { executionSandboxConfig, TurnExecution } from "../src/runtime/execution.ts";
import { PublicNetworkUnavailableError, type Resolve } from "../src/runtime/executionNetwork.ts";
import { supervisedExecution } from "../src/runtime/executionSupervisor.ts";
import { webResearchTools } from "../src/runtime/webResearch.ts";

describe.skipIf(process.platform !== "darwin")("Pi tools in the macOS execution sandbox", () => {
  let root: string, executable: string, materials: string;
  let execution: TurnExecution | undefined;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(homedir(), ".mochi-execution-test-")));
    executable = join(root, "tool-runner");
    materials = join(root, "materials");
    mkdirSync(materials, { mode: 0o700 });
    writeFileSync(join(materials, "input.txt"), "ORIGINAL_INPUT");
    writeFileSync(join(materials, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY5kAAAAASUVORK5CYII=", "base64"));
    writeFileSync(join(root, "credential.txt"), "PRIVATE_SENTINEL");
    const build = Bun.spawn([process.execPath, "build", "--compile", "src/runtime/worker.ts", `--outfile=${executable}`], { stdout: "ignore", stderr: "pipe" });
    const error = await new Response(build.stderr).text();
    if (await build.exited !== 0) throw new Error(error);
  }, 30_000);

  test("native read returns image input from the standalone executable", async () => {
    const tool = await start();
    const result = await tool.execute("read", { path: join(materials, "pixel.png") }) as { content: { type: string; mimeType?: string }[] };
    expect(result.content.some((item) => item.type === "image" && item.mimeType === "image/png")).toBeTrue();
  }, 30_000);
  afterEach(async () => { await execution?.close(); execution = undefined; });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  async function start(resolve?: Resolve) {
    execution = await TurnExecution.create(join(root, "work"), materials, [executable, "--execute-tool"], resolve);
    return execution;
  }
  const text = (value: unknown) => (value as { content: { type: string; text?: string }[] }).content.map((item) => item.text ?? "").join("\n");
  // Pi reports a failed command as an error result the model sees, not a thrown error.
  async function denied(tool: TurnExecution, command: string) {
    const result = await tool.execute("bash", { command }) as { isError?: boolean };
    expect(result.isError).toBeTrue();
    expect(text(result)).not.toContain("PRIVATE");
  }

  test("composes native write, edit, read and bash; published input remains readable", async () => {
    const tool = await start();
    await tool.execute("write", { path: "report.txt", content: "one\ntwo\n" });
    await tool.execute("edit", { path: "report.txt", edits: [{ oldText: "two", newText: "three" }] });
    expect(text(await tool.execute("read", { path: "report.txt" }))).toContain("three");
    expect(text(await tool.execute("bash", { command: "wc -l report.txt" }))).toContain("2");
    expect(text(await tool.execute("read", { path: join(materials, "input.txt") }))).toContain("ORIGINAL_INPUT");
    expect(text(await tool.execute("bash", { command: "bun -e 'process.stdout.write(String(JSON.parse(\"{\\\"value\\\":42}\").value))'" }))).toBe("42");
  }, 30_000);

  test("blocks native file access, shell and symlink escapes to credentials and input writes", async () => {
    const tool = await start();
    for (const path of [join(root, "credential.txt"), join(materials, "input.txt")]) {
      await expect(tool.execute("write", { path, content: "REPLACED" })).rejects.toThrow();
    }
    await expect(tool.execute("read", { path: join(root, "credential.txt") })).rejects.toThrow();
    await denied(tool, `cat '${join(root, "credential.txt")}'`);
    await tool.execute("bash", { command: `ln -s '${join(root, "credential.txt")}' link.txt` });
    await expect(tool.execute("read", { path: "link.txt" })).rejects.toThrow();
    await denied(tool, `bun -e 'console.log(await Bun.file(${JSON.stringify(join(root, "credential.txt"))}).text())'`);
    expect(readFileSync(join(root, "credential.txt"), "utf8")).toBe("PRIVATE_SENTINEL");
    expect(readFileSync(join(materials, "input.txt"), "utf8")).toBe("ORIGINAL_INPUT");
  }, 30_000);

  test("a command planted in the turn's bin runs only inside the sandbox", async () => {
    const tool = await start();
    const marker = join(root, "planted-command-ran-outside");
    await tool.execute("write", { path: "bin/env", content: `#!/bin/bash\n: > ${marker}\nexec /usr/bin/env "$@"\n` });
    await tool.execute("bash", { command: "chmod 700 bin/env" });
    // The model's own commands still find its bin first.
    expect(text(await tool.execute("bash", { command: "command -v env" })).trim()).toBe(join(tool.cwd, "bin/env"));
    expect(text(await tool.execute("bash", { command: "echo still-sandboxed" })).trim()).toBe("still-sandboxed");
    expect(existsSync(marker)).toBeFalse();
  }, 30_000);

  test("refuses detached spawn while ordinary shell pipelines remain usable", async () => {
    const tool = await start();
    const result = await tool.execute("bash", { command: "bun -e \"try { Bun.spawn(['/bin/sleep','1'],{detached:true}); console.log('escaped') } catch(e) { console.log(e.code) }\"" });
    expect(text(result).trim()).toBe("EPERM");
    expect(text(await tool.execute("bash", { command: "printf pipeline | wc -c" })).trim()).toBe("8");
  }, 30_000);

  async function gone(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return; throw e; }
      await Bun.sleep(20);
    }
    throw new Error(`Owned fixture process ${pid} survived cleanup`);
  }

  test("reaps background children before returning a successful tool result", async () => {
    const tool = await start();
    const result = await tool.execute("bash", { command: "sleep 15 >/dev/null 2>&1 & echo $!" });
    const pid = Number(text(result).trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBeTrue();
    try { await gone(pid); }
    finally { try { process.kill(pid, "SIGKILL"); } catch {} }
  }, 30_000);

  test("a tool timeout reaps its whole command group and permits the next command", async () => {
    const tool = await start();
    const pidFile = join(tool.cwd, "background.pid");
    await expect(tool.execute("bash", { command: "sleep 15 >/dev/null 2>&1 & echo $! > background.pid; wait", timeout: 1 })).rejects.toThrow("timed out");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try { await gone(pid); }
    finally { try { process.kill(pid, "SIGKILL"); } catch {} }
    expect(text(await tool.execute("bash", { command: "printf recovered" }))).toBe("recovered");
  }, 30_000);

  async function fixturePid(path: string): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (existsSync(path)) {
        const pid = Number(readFileSync(path, "utf8").trim());
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
      }
      await Bun.sleep(20);
    }
    throw new Error("Fixture did not start");
  }

  test("a killed supervisor cannot leave its acknowledged command group running", async () => {
    const pidFile = join(root, "supervisor.pid"), childFile = join(root, "child.pid");
    const task = supervisedExecution(executable, root, { PATH: "/usr/bin:/bin" }, {
      command: ["/bin/bash", "-c", `echo $PPID > '${pidFile}'; sleep 20 & echo $! > '${childFile}'; wait`],
      timeoutMilliseconds: 25_000,
    }, new AbortController().signal);
    void task.catch(() => undefined);
    const supervisor = await fixturePid(pidFile), child = await fixturePid(childFile);
    try {
      process.kill(supervisor, "SIGKILL");
      await expect(task).rejects.toThrow("before cleanup completed");
      await gone(child);
    } finally { for (const pid of [supervisor, child]) { try { process.kill(pid, "SIGKILL"); } catch {} } }
  }, 30_000);

  test("owner death closes the lease and reaps the command without a surviving worker", async () => {
    const childFile = join(root, "orphan.pid"), ownerFile = join(root, "owner.ts");
    writeFileSync(ownerFile, `import { supervisedExecution } from ${JSON.stringify(join(process.cwd(), "src/runtime/executionSupervisor.ts"))};
await supervisedExecution(${JSON.stringify(executable)}, ${JSON.stringify(root)}, {PATH:"/usr/bin:/bin"}, {
command: ["/bin/bash", "-c", ${JSON.stringify(`sleep 20 & echo $! > '${childFile}'; wait`)}], timeoutMilliseconds:25000
},new AbortController().signal);`);
    const owner = Bun.spawn([process.execPath, ownerFile], { stdout: "ignore", stderr: "ignore" });
    let child: number | undefined;
    try {
      child = await fixturePid(childFile);
      owner.kill("SIGKILL"); await owner.exited;
      await gone(child);
    } finally { owner.kill("SIGKILL"); if (child) { try { process.kill(child, "SIGKILL"); } catch {} } }
  }, 30_000);

  test("keeps truncated output readable inside the turn and removes it at close", async () => {
    const tool = await start();
    const result = await tool.execute("bash", { command: "awk 'BEGIN {for (i=0;i<4000;i++) print i}'" }) as { details: { fullOutputPath: string } };
    expect(result.details.fullOutputPath.startsWith(tool.cwd)).toBeTrue();
    expect(text(await tool.execute("read", { path: result.details.fullOutputPath, limit: 2 }))).toContain("0\n1");
    await tool.close();
    expect(() => readFileSync(result.details.fullOutputPath)).toThrow();
  }, 30_000);

  test("output formatting cannot follow a model-planted temporary-directory symlink outside scratch", async () => {
    const tool = await start();
    const before = readdirSync(root).sort();
    await expect(tool.execute("bash", { command: `rmdir tmp && ln -s '${root}' tmp; awk 'BEGIN {for (i=0;i<4000;i++) print i}'` })).rejects.toThrow();
    expect(readdirSync(root).sort()).toEqual(before);
    expect(readFileSync(join(root, "credential.txt"), "utf8")).toBe("PRIVATE_SENTINEL");
  }, 30_000);

  test("denies direct and proxied loopback requests", async () => {
    const tool = await start();
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("PRIVATE"); } });
    try {
      await denied(tool, `curl --fail --max-time 3 http://127.0.0.1:${server.port}`);
      await denied(tool, `curl --noproxy '' --fail --max-time 3 http://localhost:${server.port}`);
      await denied(tool, `curl --noproxy '*' --fail --max-time 3 http://127.0.0.1:${server.port}`);
      expect(requests).toBe(0);
    } finally { server.stop(true); }
  }, 30_000);

  test("closing cancels execution, waits for cleanup and removes scratch", async () => {
    const tool = await start();
    const result = tool.execute("bash", { command: "sleep 30" }).catch((error: Error) => error.message);
    await Bun.sleep(100);
    await Promise.all([tool.close(), tool.close()]);
    expect(await result).toContain("aborted");
    expect(() => readFileSync(tool.cwd)).toThrow();
    await expect(tool.execute("read", { path: "x" })).rejects.toThrow("closed");
  }, 30_000);

  test("cancels a running process and remains usable for the next invocation", async () => {
    const tool = await start();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1_000);
    try { await expect(tool.execute("bash", { command: "sleep 30" }, abort.signal)).rejects.toThrow("aborted"); }
    finally { clearTimeout(timer); }
    expect(text(await tool.execute("bash", { command: "printf resumed" }))).toBe("resumed");
  }, 30_000);

  test("fails closed when the sandboxed runner cannot start", async () => {
    chmodSync(executable, 0o600);
    try { await expect(start()).rejects.toThrow("permission denied"); }
    finally { chmodSync(executable, 0o700); }
  }, 30_000);

  test("fails closed when the sandbox does not enforce its boundary", async () => {
    // A wrapper that stops enforcing must not reach the model; the probe's write is removed.
    const wrap = spyOn(SandboxManager, "wrapWithSandbox").mockImplementation(async (command) => command);
    try { await expect(start()).rejects.toThrow("Execution sandbox self-check failed"); }
    finally { wrap.mockRestore(); }
    expect(readdirSync(root).filter((name) => name.startsWith(".mochi-sandbox-probe"))).toEqual([]);
    expect(text(await (await start()).execute("bash", { command: "printf usable" }))).toBe("usable");
  }, 30_000);

  test("refuses to run behind an inherited upstream proxy, which would skip the address checks", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    try { await expect(start()).rejects.toThrow("upstream proxy"); }
    finally { delete process.env.HTTPS_PROXY; }
  }, 30_000);

  test("refuses a second turn while one owns the process-wide sandbox", async () => {
    const tool = await start();
    await expect(TurnExecution.create(join(root, "work"), materials, [executable, "--execute-tool"])).rejects.toThrow("Another turn");
    expect(existsSync(tool.cwd)).toBeTrue();
    expect(text(await tool.execute("bash", { command: "printf still-mine" }))).toBe("still-mine");
  }, 30_000);

  test("fails closed once the process-wide sandbox no longer holds the turn's policy", async () => {
    const tool = await start();
    await SandboxManager.reset();
    await expect(tool.execute("bash", { command: "true" })).rejects.toThrow("no longer holds");
    // A permissive policy installed by anyone else is refused the same way.
    await SandboxManager.initialize(executionSandboxConfig(tool.cwd, "/", "/"), async () => true, false);
    await expect(tool.execute("read", { path: join(root, "credential.txt") })).rejects.toThrow("no longer holds");
  }, 30_000);

  test("refuses fake-IP destinations and tells the model why", async () => {
    const resolve: Resolve = async (hostname) => hostname === "fake-ip.example" ? ["198.18.0.9"] : [];
    const tool = await start(resolve);
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    let result: { isError?: boolean };
    let logged: unknown[];
    try {
      result = await tool.execute("bash", { command: "curl --fail --silent --show-error --max-time 5 http://fake-ip.example/" }) as { isError?: boolean };
      logged = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    } finally { log.mockRestore(); }
    expect(result.isError).toBeTrue();
    expect(text(result)).toContain("fake-IP");
    expect(tool.publicNetworkError).toBeInstanceOf(PublicNetworkUnavailableError);
    expect(logged).toEqual([{ event: "runtime.execution.fake_ip_refused", host: "fake-ip.example" }]);
    expect(text(await tool.execute("bash", { command: "printf offline-work" }))).toBe("offline-work");
    const fetch = webResearchTools(() => tool).find(({ name }) => name === "web_fetch")!;
    await expect(fetch.execute("call", { url: "https://fake-ip.example/" }, undefined, undefined, undefined as never)).rejects.toBeInstanceOf(PublicNetworkUnavailableError);
  }, 30_000);
});
