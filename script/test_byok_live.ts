import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { BYOK_PROVIDER, parseByokConnection, type ByokConnectionInput } from "../src/runtime/byok.ts";
import { ByokAccount } from "../src/runtime/byokAccount.ts";
import { executionTools, TurnExecution } from "../src/runtime/execution.ts";
import { isolatedResourceLoader } from "../src/runtime/resources.ts";
import { runtimeSystemPrompt } from "../src/runtime/instructions.ts";

// Opt-in, billable integration probe. Read one connection object from stdin;
// never put credentials in argv, the checkout, reports, or the model's context.
let input: ByokConnectionInput;
try { input = parseByokConnection(JSON.parse(await Bun.stdin.text())); }
catch { console.error("Invalid live-test connection input"); process.exit(1); }
const directory = await realpath(await mkdtemp(join(tmpdir(), "mochi-byok-live-")));
await chmod(directory, 0o700);
let session: AgentSession | undefined;
let execution: TurnExecution | undefined;
let phase = "connection";
try {
  const open = async () => {
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const account = new ByokAccount(runtime, directory);
    await account.restore();
    return { runtime, account };
  };
  const initial = await open();
  await initial.account.configure(input, AbortSignal.timeout(90_000));
  const { runtime, account } = await open();
  assert.equal((await account.read()).status, "signedIn");
  console.log(JSON.stringify({ phase, validated: true, restored: true, provider: BYOK_PROVIDER, model: input.model }));

  const materials = join(directory, "materials");
  await mkdir(materials, { mode: 0o700 });
  const tools = executionTools(() => { assert(execution); return execution; });
  const model = runtime.getModel(BYOK_PROVIDER, input.model)!;
  const newSession = async (manager: SessionManager) => (await createAgentSession({
    cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: "low",
    sessionManager: manager,
    noTools: "all", tools: tools.map((tool) => tool.name), customTools: tools,
    resourceLoader: isolatedResourceLoader(() => runtimeSystemPrompt("")),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false }, defaultProjectTrust: "never", enableAnalytics: false, enableInstallTelemetry: false }),
  })).session;
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  session = await newSession(manager);
  const identity = session.sessionId;
  const prompts = [
    "查一下 Node.js 当前最新版本和最新 LTS 版本，分别给出版本号、发布日期和官方依据。",
    "调研 HTTP 429 与 503 的区别，以及客户端如何使用 Retry-After；请查公开官方资料并给出来源链接。",
  ];
  for (const [index, prompt] of prompts.entries()) {
    phase = `research-${index + 1}`;
    execution = await TurnExecution.create(join(directory, "execution"), materials, [resolve(import.meta.dir, "../dist/mochi-pi-runtime"), "--execute-tool"]);
    let successfulTools = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        if (!event.isError) successfulTools++;
        console.log(JSON.stringify({ phase, tool: event.toolName, isError: event.isError }));
      }
    });
    const current = session;
    const deadline = setTimeout(() => { current.abortCompaction(); void current.abort(); }, 180_000);
    try { await session.prompt(prompt); }
    finally { clearTimeout(deadline); unsubscribe(); await execution.close(); execution = undefined; }
    const last = session.messages.at(-1);
    assert(last?.role === "assistant" && last.stopReason === "stop", "No completed answer");
    const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert(successfulTools > 0 && /https:\/\//u.test(text), "Research did not use tools and cite a source");
    assert(!text.includes(input.apiKey), "Credential leaked");
    console.log(JSON.stringify({ phase, successfulTools, text }));
    const file: string | undefined = session.sessionFile;
    assert(file);
    session.dispose();
    session = await newSession(SessionManager.open(file, join(directory, "sessions")));
    assert.equal(session.sessionId, identity);
  }
  phase = "disconnect";
  session.dispose(); session = undefined;
  await account.remove();
  assert.deepEqual(await account.read(), { status: "signedOut" });
  console.log(JSON.stringify({ phase, removed: true, sessionPreservedOnResume: true }));
} catch {
  // Provider failures can echo secrets. Keep the live probe's error surface closed.
  console.error(JSON.stringify({ phase, failed: true }));
  process.exitCode = 1;
} finally {
  session?.dispose();
  await execution?.close();
  await rm(directory, { recursive: true, force: true });
}
