#!/usr/bin/env bun
import { ProcessLock } from "../processLock.ts";
import { adoptRuntimeAccount, runtimeAccountDirectory, runtimeBotDirectory, requireRuntimeBotId } from "./storage.ts";
import { materialContent } from "../attachments/content.ts";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  getSupportedThinkingLevels,
  type Api,
  type ImageContent,
  type Model,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "./policy.ts";
import { isolatedResourceLoader, isolatedSettings, SESSION_COMPACTION_INSTRUCTIONS } from "./resources.ts";
import { executionTools, TurnExecution } from "./execution.ts";
import { runExecutionTool } from "./executionRunner.ts";
import { runExecutionSupervisor } from "./executionSupervisor.ts";
import {
  boundedString,
  exactKeys,
  OPENAI_CODEX_PROVIDER,
  parseWorkerMessage,
  PI_WORKER_PROTOCOL_VERSION,
  record,
  type RuntimeModelOption,
  type RuntimeToolSpec,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";
import type { RuntimeToolOutputItem } from "./toolOutput.ts";
import { readLines } from "./transport.ts";
import {
  isFixedPiMaterialRoot,
  PI_MATERIAL_ROOT,
  PI_RUNTIME_CWD,
  PI_RUNTIME_HOME,
} from "./constants.ts";
import { SteeredTurnProvenance } from "./turnProvenance.ts";
import { BINDING_ENTRY, bootstrapCompleted } from "./sessionBinding.ts";
import { chatGPTCallbackPages } from "../oauthPage.ts";
import { byokModelReference, isByokProvider, parseModelReference } from "./byok.ts";
import { ByokAccount } from "./byokAccount.ts";

registerBunOAuthFlows({ openaiCodexCallbackPages: chatGPTCallbackPages });

const MAXIMUM_MATERIAL_BYTES = 12 * 1024 * 1024;
const SESSION_BOOTSTRAP_SYSTEM_PROMPT = [
  "You are materializing Mochi's private permanent Pi Session.",
  "No tools are available. This is internal setup, not a Feishu user request.",
].join(" ");
const SESSION_BOOTSTRAP_USER_MESSAGE = "Create the durable Session by replying with READY.";

interface RuntimeInitialization {
  sessionId: string;
  capabilityAbi: string;
  systemPrompt: string;
  tools: readonly RuntimeToolSpec[];
  model: string;
  reasoningEffort: ReasoningEffort;
  materialRoot: string;
}

interface ActiveTurn {
  executionPolicy: "interactive" | "scheduled";
  id: string;
  workspace: string;
  phase: "scheduled" | "running";
  pendingSteers: { sourceMessageId: string; text: string; images: ImageContent[] }[];
  provenance: SteeredTurnProvenance;
  provenanceError?: Error;
  abortRequested?: boolean;
  startTimer?: ReturnType<typeof setTimeout>;
  execution?: TurnExecution;
}

interface PendingBridgeRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class PiWorker {
  readonly #home = homedir();
  #storageLock: ProcessLock | undefined;
  #oauthPortLock: ProcessLock | undefined;
  #agentDirectory!: string;
  #sessionDirectory!: string;
  #modelRuntimePromise!: Promise<ModelRuntime>;
  #byok!: ByokAccount;
  readonly #closing = new AbortController();
  #accountMutation: Promise<{}> | undefined;
  readonly #pendingBridgeRequests = new Map<string, PendingBridgeRequest>();
  #nextBridgeRequestId = 1;
  #initialization: RuntimeInitialization | undefined;
  #session: AgentSession | undefined;
  #activeTurn: ActiveTurn | undefined;
  #login: { id: string; abort: AbortController; settled: Promise<void>; cancelled: boolean } | undefined;
  #closed = false;
  #initializing = false;
  #accountOnly = false;


  async run(): Promise<void> {
    for await (const line of readLines(Bun.stdin.stream())) {
      if (!line.trim()) continue;
      let message;
      try {
        message = parseWorkerMessage(JSON.parse(line) as unknown);
      } catch (error) {
        this.#fatal(error);
        return;
      }
      if (message.type === "response") {
        const pending = this.#pendingBridgeRequests.get(message.id);
        if (!pending) continue;
        this.#pendingBridgeRequests.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        continue;
      }
      if (message.type !== "request") {
        this.#fatal(new Error("Bridge sent an unsupported event to the Pi worker"));
        return;
      }
      void this.#answer(message);
    }
    await this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing.abort();
    await this.#accountMutation?.catch(() => undefined);
    await this.#cancelLogin();
    this.#session?.abortCompaction();
    if (this.#session?.isStreaming) await this.#session.abort().catch(() => undefined);
    await this.#activeTurn?.execution?.close();
    this.#session?.dispose();
    this.#session = undefined;
    for (const pending of this.#pendingBridgeRequests.values()) {
      pending.reject(new Error("Pi worker closed"));
    }
    this.#pendingBridgeRequests.clear();
    await this.#oauthPortLock?.release();
    await this.#storageLock?.release();
  }

  async #createModelRuntime(): Promise<ModelRuntime> {
    await mkdir(this.#agentDirectory, { recursive: true, mode: 0o700 });
    if (!this.#accountOnly) {
    await mkdir(this.#sessionDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#sessionDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!()
      || (directory.mode & 0o077) !== 0 || await realpath(this.#sessionDirectory) !== this.#sessionDirectory) throw protocolError("Invalid Bot Session directory");
    }
    const accountDirectory = runtimeAccountDirectory(this.#home);
    const runtime = await ModelRuntime.create({
      authPath: join(accountDirectory, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    this.#byok = new ByokAccount(runtime, accountDirectory);
    await this.#byok.restore();
    return runtime;
  }

  async #answer(request: WorkerRequest): Promise<void> {
    let response: WorkerResponse;
    try {
      response = {
        version: PI_WORKER_PROTOCOL_VERSION,
        type: "response",
        id: request.id,
        ok: true,
        result: await this.#handle(request.method, request.params),
      };
    } catch (error) {
      response = {
        version: PI_WORKER_PROTOCOL_VERSION,
        type: "response",
        id: request.id,
        ok: false,
        error: {
          code: errorCode(error),
          message: asError(error).message.slice(0, 4_096),
        },
      };
    }
    this.#write(response);
  }

  async #handle(method: string, paramsValue: unknown): Promise<unknown> {
    const accountMethod = [
      "account.read", "account.login.start", "account.login.cancel", "account.logout",
      "account.byok.configure", "account.byok.remove", "account.byok.read",
    ].includes(method);
    if (accountMethod) {
      if (this.#accountMutation) throw protocolError("A model connection change is in progress");
      if (!this.#accountOnly && method !== "account.read") throw protocolError("Account changes require the shared account worker");
      if (!this.#accountOnly) this.#requireInitialization();
    } else if (!["runtime.audit", "runtime.initialize", "account.initialize", "runtime.account.adopt", "runtime.shutdown"].includes(method)) this.#requireInitialization();
    switch (method) {
      case "runtime.account.adopt": {
        if (this.#initialization || this.#initializing || this.#storageLock) throw protocolError("Account adoption requires an offline worker");
        const params = record(paramsValue, "runtime.account.adopt");
        exactKeys(params, ["botId"], "runtime.account.adopt");
        const botId = requireRuntimeBotId(params.botId);
        this.#initializing = true;
        try { return await adoptRuntimeAccount(this.#home, botId); }
        finally { this.#initializing = false; }
      }
      case "runtime.audit": {
        emptyParams(paramsValue, "runtime.audit params");
        return auditRuntimeEnvironment();
      }
      case "runtime.initialize": return this.#initialize(paramsValue);
      case "account.initialize": {
        emptyParams(paramsValue, "account.initialize");
        if (this.#initialization || this.#initializing || this.#accountOnly || this.#closed) throw protocolError("Pi worker is already initialized or closed");
        this.#initializing = true;
        try {
          this.#agentDirectory = runtimeAccountDirectory(this.#home);
          this.#storageLock = await ProcessLock.acquire(join(this.#agentDirectory, "runtime.lock"));
          if (this.#closed) throw protocolError("Pi worker closed during initialization");
          this.#accountOnly = true;
          this.#modelRuntimePromise = this.#createModelRuntime();
          await this.#modelRuntimePromise;
          if (this.#closed) throw protocolError("Pi worker closed during initialization");
          return { protocolVersion: PI_WORKER_PROTOCOL_VERSION };
        } catch (error) {
          this.#accountOnly = false;
          await this.#storageLock?.release();
          this.#storageLock = undefined;
          throw error;
        } finally { this.#initializing = false; }
      }
      case "account.read": {
        emptyParams(paramsValue, "account.read params");
        return this.#accountRead();
      }
      case "account.byok.read": {
        emptyParams(paramsValue, "account.byok.read params");
        await this.#modelRuntimePromise;
        return { connections: this.#byok.readSetups() };
      }
      case "account.login.start": {
        emptyParams(paramsValue, "account.login.start params");
        return this.#loginStart();
      }
      case "account.login.cancel": return this.#loginCancel(paramsValue);
      case "account.logout": {
        emptyParams(paramsValue, "account.logout params");
        return this.#logout();
      }
      case "account.byok.configure": return this.#configureByok(paramsValue);
      case "account.byok.remove": {
        return this.#removeByok(paramsValue);
      }
      case "model.list": {
        emptyParams(paramsValue, "model.list params");
        return this.#modelList();
      }
      case "policy.update": return this.#updatePolicy(paramsValue);
      case "session.create": {
        emptyParams(paramsValue, "session.create params");
        return this.#sessionCreate();
      }
      case "session.bootstrap": {
        emptyParams(paramsValue, "session.bootstrap params");
        return this.#sessionBootstrap();
      }
      case "session.resume": {
        emptyParams(paramsValue, "session.resume params");
        return this.#sessionResume();
      }
      case "session.verify": {
        emptyParams(paramsValue, "session.verify params");
        const init = this.#requireInitialization();
        await this.#verifiedSession();
        return { sessionId: init.sessionId, capabilityAbi: init.capabilityAbi };
      }
      case "session.migrate": return this.#sessionMigrate(paramsValue);
      case "session.compact": {
        emptyParams(paramsValue, "session.compact params");
        return this.#compact();
      }
      case "turn.start": return this.#turnStart(paramsValue);
      case "turn.steer": return this.#turnSteer(paramsValue);
      case "turn.abort": return this.#turnAbort(paramsValue);
      case "runtime.shutdown": {
        emptyParams(paramsValue, "runtime.shutdown params");
        await this.close();
        setTimeout(() => process.exit(0), 0);
        return {};
      }
      default: throw protocolError(`Unsupported worker method: ${method}`);
    }
  }

  async #initialize(value: unknown): Promise<{ protocolVersion: number }> {
    if (this.#initialization || this.#initializing || this.#accountOnly) throw protocolError("Pi worker is already initialized");
    this.#initializing = true;
    try {
    if (this.#closed) throw protocolError("Pi worker is closed");
    const params = record(value, "runtime.initialize params");
    exactKeys(params, [
      "sessionId", "capabilityAbi", "systemPrompt", "tools", "model",
      "reasoningEffort", "materialRoot", "botId",
    ], "runtime.initialize params");
    const botId = requireRuntimeBotId(params.botId);
    const tools = parseToolSpecs(params.tools);
    const reasoningEffort = parseReasoningEffort(params.reasoningEffort);
    const initialization: RuntimeInitialization = {
      sessionId: boundedString(params.sessionId, "sessionId", 128),
      capabilityAbi: capabilityAbi(params.capabilityAbi),
      systemPrompt: boundedString(params.systemPrompt, "systemPrompt", 200_000),
      tools,
      model: boundedString(params.model, "model", 128),
      reasoningEffort,
      materialRoot: await this.#validateMaterialRoot(
        boundedString(params.materialRoot, "materialRoot", 1_024),
      ),
    };
    this.#agentDirectory = runtimeBotDirectory(this.#home, botId);
    this.#storageLock = await ProcessLock.acquire(join(this.#agentDirectory, "runtime.lock"));
    if (this.#closed) throw protocolError("Pi worker closed during initialization");
    this.#sessionDirectory = join(this.#agentDirectory, "sessions");
    this.#modelRuntimePromise = this.#createModelRuntime();
    await this.#modelRuntimePromise;
    if (this.#closed) throw protocolError("Pi worker closed during initialization");
    this.#initialization = initialization;
    return { protocolVersion: PI_WORKER_PROTOCOL_VERSION };
    } catch (error) {
      await this.#storageLock?.release();
      this.#storageLock = undefined;
      throw error;
    } finally { this.#initializing = false; }
  }

  async #accountRead() {
    await this.#modelRuntimePromise;
    return this.#byok.read();
  }

  async #loginStart(): Promise<{ loginId: string; authorizationUrl: string }> {
    if (this.#login) throw protocolError("A ChatGPT login is already in progress");
    const runtime = await this.#modelRuntimePromise;
    const account = await this.#accountRead();
    if (account.status === "signedIn" && account.connections.some((connection) => connection.provider === OPENAI_CODEX_PROVIDER)) {
      throw protocolError("ChatGPT is already signed in");
    }
    // The provider fixes localhost:1455; offline maintenance uses the same lock.
    try { this.#oauthPortLock = await ProcessLock.acquire(join(this.#home, ".pi", "mochi", "oauth-port.lock")); }
    catch { throw taggedError("oauth_listener_busy", "Finish or cancel the other ChatGPT browser login first"); }
    if (this.#closed) { await this.#oauthPortLock.release(); this.#oauthPortLock = undefined; throw protocolError("Pi worker closed during login"); }
    const loginId = crypto.randomUUID();
    const abort = new AbortController();
    const login = { id: loginId, abort, settled: Promise.resolve(), cancelled: false };
    this.#login = login;
    const deadline = setTimeout(() => abort.abort(), 5 * 60_000);

    let resolveAuthorizationUrl!: (url: string) => void;
    let rejectAuthorizationUrl!: (error: Error) => void;
    const authorizationUrl = new Promise<string>((resolve, reject) => {
      resolveAuthorizationUrl = resolve;
      rejectAuthorizationUrl = reject;
    });
    login.settled = runtime.login(OPENAI_CODEX_PROVIDER, "oauth", {
      signal: abort.signal,
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        if (prompt.type === "manual_code") return new Promise<string>((_resolve, reject) => {
          const signal = prompt.signal ? AbortSignal.any([prompt.signal, abort.signal]) : abort.signal;
          const fail = () => reject(new Error("ChatGPT login was cancelled"));
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        });
        throw protocolError(`OpenAI OAuth requested unsupported input: ${prompt.type}`);
      },
      notify: (event) => {
        if (event.type !== "auth_url") return;
        try {
          resolveAuthorizationUrl(safeAuthorizationUrl(event.url));
        } catch (error) {
          rejectAuthorizationUrl(asError(error));
          abort.abort();
        }
      },
    }).then(
      () => this.#finishLogin(loginId, true),
      (error) => {
        rejectAuthorizationUrl(asError(error));
        return this.#finishLogin(loginId, false, asError(error).message);
      },
    ).finally(() => { clearTimeout(deadline); });
    try {
      return { loginId, authorizationUrl: await authorizationUrl };
    } catch (error) {
      await login.settled;
      throw error;
    }
  }

  async #configureByok(value: unknown): Promise<{}> {
    if (this.#login) throw protocolError("Finish or cancel ChatGPT login first");
    const operation = (async () => {
      await this.#modelRuntimePromise;
      await this.#byok.configure(value, AbortSignal.any([this.#closing.signal, AbortSignal.timeout(90_000)]));
      this.#emit("account.updated", { status: "signedIn" });
      return {};
    })();
    this.#accountMutation = operation;
    try { return await operation; } finally { this.#accountMutation = undefined; }
  }

  async #removeByok(value: unknown): Promise<{}> {
    if (this.#login) throw protocolError("Finish or cancel ChatGPT login first");
    const params = record(value, "account.byok.remove params");
    if (params.connectionId !== undefined) exactKeys(params, ["connectionId"], "account.byok.remove params");
    else exactKeys(params, [], "account.byok.remove params");
    const operation = (async () => {
      await this.#modelRuntimePromise;
      await this.#byok.remove(params.connectionId === undefined ? undefined : boundedString(params.connectionId, "connectionId", 128));
      this.#emit("account.updated", { status: "signedOut" });
      return {};
    })();
    this.#accountMutation = operation;
    try { return await operation; } finally { this.#accountMutation = undefined; }
  }

  async #loginCancel(value: unknown): Promise<{}> {
    const params = record(value, "account.login.cancel params");
    exactKeys(params, ["loginId"], "account.login.cancel params");
    const loginId = boundedString(params.loginId, "loginId", 128);
    if (this.#login?.id === loginId) await this.#cancelLogin();
    return {};
  }

  async #cancelLogin(): Promise<void> {
    const login = this.#login;
    if (!login) return;
    login.cancelled = true;
    login.abort.abort();
    // The provider closes its listener in finally; keep the lease until it settles.
    await login.settled;
  }

  async #logout(): Promise<{}> {
    if (this.#activeTurn || this.#session?.isCompacting) {
      throw protocolError("Cannot change ChatGPT account while runtime work is active");
    }
    await this.#cancelLogin();
    const runtime = await this.#modelRuntimePromise;
    const current = await runtime.checkAuth(OPENAI_CODEX_PROVIDER);
    if (current && current.type !== "oauth") throw protocolError("Invalid ChatGPT credential type");
    if (current) await runtime.logout(OPENAI_CODEX_PROVIDER);
    this.#session?.dispose();
    this.#session = undefined;
    this.#emit("account.updated", { status: "signedOut" });
    return {};
  }

  async #modelList(): Promise<readonly RuntimeModelOption[]> {
    this.#requireInitialization();
    const runtime = await this.#modelRuntimePromise;
    const account = await this.#accountRead();
    if (account.status !== "signedIn") throw authError("No model connection is signed in");
    const models: RuntimeModelOption[] = [];
    for (const connection of account.connections) {
      const provider = connection.provider;
      const available = await runtime.getAvailable(provider);
      for (const model of available
        .filter((candidate) => candidate.provider === provider && candidate.input.includes("image"))) {
        const efforts = getSupportedThinkingLevels(model)
          .map(productEffort)
          .filter((value): value is ReasoningEffort => value !== undefined);
        const uniqueEfforts = [...new Set(efforts)];
        const defaultEffort = uniqueEfforts.includes(DEFAULT_REASONING_EFFORT)
          ? DEFAULT_REASONING_EFFORT
          : uniqueEfforts[0] ?? "none";
        models.push({
          id: isByokProvider(provider) ? byokModelReference(provider, model.id) : model.id,
          displayName: `${isByokProvider(provider) ? ((connection as { label?: string }).label ?? "模型 API") : "ChatGPT"} · ${model.name}`,
          description: `${connectionLabel(connection)} · 上下文窗口 ${Math.round(model.contextWindow / 1_000)}K tokens`,
          supportedEfforts: uniqueEfforts.map((id) => ({ id, description: effortDescription(id) })),
          defaultEffort,
        });
      }
    }
    if (models.length === 0) throw authError("The active model provider returned no image-capable models");
    return models;
  }

  async #updatePolicy(value: unknown): Promise<{}> {
    if (this.#activeTurn || this.#session?.isCompacting) {
      throw protocolError("Cannot update policy while runtime work is active");
    }
    const initialization = this.#requireInitialization();
    const params = record(value, "policy.update params");
    exactKeys(params, ["model", "reasoningEffort"], "policy.update params");
    const modelId = boundedString(params.model, "model", 128);
    const effort = parseReasoningEffort(params.reasoningEffort);
    const model = await this.#availableModel(modelId);
    assertModelEffort(model, effort);
    if (this.#session) {
      await this.#session.setModel(model);
      this.#session.setThinkingLevel(piEffort(effort));
    }
    initialization.model = modelId;
    initialization.reasoningEffort = effort;
    return {};
  }

  async #sessionCreate(): Promise<unknown> {
    const initialization = this.#requireInitialization();
    if (this.#session) throw protocolError("A permanent Pi Session is already open");
    const existing = await this.#findSession(initialization.sessionId);
    if (existing) throw sessionError(`Pi Session ${initialization.sessionId} already exists`);
    const manager = SessionManager.create(
      this.#runtimeCwd(),
      this.#sessionDirectory,
      { id: initialization.sessionId },
    );
    manager.appendCustomEntry(BINDING_ENTRY, { capabilityAbi: initialization.capabilityAbi });
    const path = await this.#materializeSession(manager);
    this.#session = await this.#createSession(
      SessionManager.open(path, this.#sessionDirectory, this.#runtimeCwd()),
    );
    return this.#sessionState();
  }

  async #sessionBootstrap(): Promise<unknown> {
    const initialization = this.#requireInitialization();
    if (this.#session) return this.#sessionState();
    const path = await this.#findSession(initialization.sessionId);
    if (!path) return this.#sessionCreate();
    // An interrupted bootstrap continues on the same candidate before resume.
    const manager = SessionManager.open(path, this.#sessionDirectory, this.#runtimeCwd());
    if (!bootstrapCompleted(manager)) await this.#materializeSession(manager);
    return this.#sessionResume();
  }

  async #sessionResume(): Promise<unknown> {
    this.#requireInitialization();
    if (this.#session) return this.#sessionState();
    this.#session = await this.#createSession(await this.#verifiedSession());
    return this.#sessionState();
  }

  /** Reads the real SDK history/cwd/ABI without selecting a model or making a request. */
  async #verifiedSession(): Promise<SessionManager> {
    const initialization = this.#requireInitialization();
    const path = await this.#findSession(initialization.sessionId);
    if (!path) throw sessionError(`Permanent Pi Session ${initialization.sessionId} is missing`);
    const manager = SessionManager.open(path, this.#sessionDirectory, this.#runtimeCwd());
    const bindings = manager.getEntries().filter((entry) => entry.type === "custom")
      .filter((entry) => entry.customType === BINDING_ENTRY);
    if (bindings.length === 0) throw sessionError("Permanent Pi Session has no capability binding");
    const data = record(bindings.at(-1)!.data, "Pi Session capability binding");
    if (data.capabilityAbi !== initialization.capabilityAbi) {
      throw sessionError(
        `Permanent Pi Session capability mismatch: stored ${String(data.capabilityAbi)}, current ${initialization.capabilityAbi}`,
      );
    }
    return manager;
  }

  async #sessionMigrate(value: unknown): Promise<unknown> {
    const initialization = this.#requireInitialization();
    if (this.#session || this.#activeTurn) throw protocolError("Close the active Session before migration");
    const params = record(value, "session.migrate params");
    exactKeys(params, ["sourceSessionId"], "session.migrate params");
    const sourceSessionId = boundedString(params.sourceSessionId, "sourceSessionId", 128);
    if (sourceSessionId === initialization.sessionId) {
      throw protocolError("Migration source and target must be distinct");
    }
    const sourcePath = await this.#findSession(sourceSessionId);
    if (!sourcePath) throw sessionError(`Migration source Pi Session ${sourceSessionId} is missing`);
    const sourceBytes = await readFile(sourcePath);
    const transcriptSha256 = `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`;
    const sourceManager = SessionManager.open(sourcePath, this.#sessionDirectory, this.#runtimeCwd());
    const sourceMessageCount = sourceManager.getEntries()
      .filter((entry) => entry.type === "message").length;
    const existingTarget = await this.#findSession(initialization.sessionId);
    const manager = existingTarget
      ? SessionManager.open(existingTarget, this.#sessionDirectory, this.#runtimeCwd())
      : SessionManager.forkFrom(
        sourcePath,
        this.#runtimeCwd(),
        this.#sessionDirectory,
        { id: initialization.sessionId },
      );
    const bindings = manager.getEntries().filter((entry) => entry.type === "custom")
      .filter((entry) => entry.customType === BINDING_ENTRY);
    const latest = bindings.at(-1);
    const latestData = latest ? record(latest.data, "Pi Session capability binding") : undefined;
    if (existingTarget) {
      if (
        latestData?.capabilityAbi !== initialization.capabilityAbi
        || latestData.migratedFromSessionId !== sourceSessionId
        || latestData.sourceTranscriptSha256 !== transcriptSha256
        || latestData.sourceMessageCount !== sourceMessageCount
      ) {
        throw sessionError("Existing migration target does not match the requested source and capability");
      }
      if (!bootstrapCompleted(manager)) await this.#materializeSession(manager);
    } else {
      manager.appendCustomEntry(BINDING_ENTRY, {
        capabilityAbi: initialization.capabilityAbi,
        migratedFromSessionId: sourceSessionId,
        sourceTranscriptSha256: transcriptSha256,
        sourceMessageCount,
      });
      await this.#materializeSession(manager);
    }
    return {
      sessionId: initialization.sessionId,
      capabilityAbi: initialization.capabilityAbi,
      transcriptSha256,
      sourceMessageCount,
    };
  }

  async #materializeSession(manager: SessionManager): Promise<string> {
    const session = await this.#createSession(manager, "bootstrap");
    try {
      await session.prompt(SESSION_BOOTSTRAP_USER_MESSAGE, { expandPromptTemplates: false });
      if (!session.getLastAssistantText()?.trim()) {
        throw sessionError(session.state.errorMessage ?? "Pi Session bootstrap produced no assistant response");
      }
      const sessionFile = session.sessionFile;
      if (!manager.isPersisted() || !sessionFile) {
        throw sessionError("Pi Session bootstrap did not persist a durable Session file");
      }
      await access(sessionFile);
      const indexedPath = await this.#findSession(manager.getSessionId());
      if (!indexedPath || await realpath(indexedPath) !== await realpath(sessionFile)) {
        throw sessionError("Pi Session bootstrap file is not independently discoverable");
      }
      return sessionFile;
    } finally {
      session.dispose();
    }
  }

  async #createSession(
    manager: SessionManager,
    mode: "runtime" | "bootstrap" = "runtime",
  ): Promise<AgentSession> {
    const initialization = this.#requireInitialization();
    const model = await this.#availableModel(initialization.model);
    assertModelEffort(model, initialization.reasoningEffort);
    const resourceLoader = isolatedResourceLoader(
      () => mode === "bootstrap" ? SESSION_BOOTSTRAP_SYSTEM_PROMPT : initialization.systemPrompt,
    );
    const customTools = mode === "bootstrap"
      ? []
      : [
          ...initialization.tools.map((tool) => this.#relayTool(tool)),
          this.#materialReadTool(),
          this.#materialListTool(),
          ...executionTools(() => {
            const execution = this.#activeTurn?.execution;
            if (!execution) throw turnInactiveError();
            return execution;
          }, () => this.#activeTurn?.executionPolicy ?? "scheduled"),
        ];
    const { session } = await createAgentSession({
      cwd: this.#runtimeCwd(),
      agentDir: this.#agentDirectory,
      modelRuntime: await this.#modelRuntimePromise,
      model,
      thinkingLevel: piEffort(initialization.reasoningEffort),
      noTools: "all",
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager: manager,
      settingsManager: isolatedSettings(mode === "runtime"),
    });
    if (mode === "runtime") session.setSteeringMode("one-at-a-time");
    session.subscribe((event) => this.#handleSessionEvent(event, session.sessionId));
    return session;
  }

  #handleSessionEvent(event: AgentSessionEvent, sessionId: string): void {
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const active = this.#activeTurn;
      if (active && !this.#requireInitialization().tools.some((tool) => tool.name === event.toolName)) {
        console.error(JSON.stringify({
          event: event.type === "tool_execution_start" ? "runtime.local_tool.started" : "runtime.local_tool.completed",
          sessionId, turnId: active.id, toolCallId: event.toolCallId,
          toolName: event.toolName, sourceMessageId: active.provenance.toolSourceMessageId,
          ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
        }));
      }
      return;
    }
    if (event.type === "compaction_start") {
      console.error(JSON.stringify({ event: "runtime.context.compaction_started", sessionId, reason: event.reason }));
      this.#emit("context.compaction", { sessionId, active: true });
      return;
    }
    if (event.type === "compaction_end") {
      console.error(JSON.stringify({
        event: "runtime.context.compaction_finished", sessionId, reason: event.reason,
        completed: event.result !== undefined, aborted: event.aborted, willRetry: event.willRetry,
        failed: event.errorMessage !== undefined,
      }));
      if (event.result) this.#emit("context.compacted", { sessionId });
      this.#emit("context.compaction", { sessionId, active: false });
      return;
    }
    if (
      event.type !== "message_start"
      || (event.message.role !== "user" && event.message.role !== "assistant")
    ) return;
    const active = this.#activeTurn;
    if (!active) return;
    try {
      if (event.message.role === "user") active.provenance.userMessageStarted();
      else active.provenance.assistantMessageStarted();
    } catch (error) {
      active.provenanceError = asError(error);
      if (this.#session?.isStreaming) void this.#session.abort().catch(() => undefined);
    }
  }

  async #compact(): Promise<{}> {
    const session = this.#requireSession();
    if (this.#activeTurn || session.isStreaming) throw protocolError("A turn is active");
    if (session.isCompacting) throw protocolError("Context organization is already active");
    await session.compact(SESSION_COMPACTION_INSTRUCTIONS);
    return {};
  }

  async #turnStart(value: unknown): Promise<{ turnId: string }> {
    const session = this.#requireSession();
    if (this.#activeTurn || session.isStreaming || session.isCompacting) {
      throw protocolError("Runtime already has active work");
    }
    const params = record(value, "turn.start params");
    exactKeys(params, ["sourceMessageId", "text", "images", "workspace", "systemPrompt", "executionPolicy"], "turn.start params");
    if (params.executionPolicy !== "interactive" && params.executionPolicy !== "scheduled") throw protocolError("Unknown execution policy");
    const workspace = await this.#validateWorkspace(boundedString(params.workspace, "workspace", 1_024));
    const sourceMessageId = boundedString(params.sourceMessageId, "sourceMessageId", 128);
    const text = boundedString(params.text, "text", 400_000);
    const images = parseImages(params.images);
    const systemPrompt = boundedString(params.systemPrompt, "systemPrompt", 200_000);
    const turnId = crypto.randomUUID();
    const active: ActiveTurn = {
      id: turnId, workspace, phase: "scheduled", pendingSteers: [], executionPolicy: params.executionPolicy,
      provenance: new SteeredTurnProvenance(sourceMessageId),
    };
    this.#activeTurn = active;
    const initialization = this.#requireInitialization();
    if (systemPrompt !== initialization.systemPrompt) {
      initialization.systemPrompt = systemPrompt;
      try {
        // Pi reloads our isolated loader, not ambient files. History and tool authority stay intact.
        await session.reload();
        session.setSteeringMode("one-at-a-time");
      } catch (error) {
        this.#activeTurn = undefined;
        session.dispose();
        this.#session = undefined;
        throw error;
      }
    }
    if (this.#closed || this.#activeTurn !== active || this.#session !== session) {
      throw protocolError("Runtime work was cancelled during preparation");
    }
    try {
      active.execution = await TurnExecution.create(join(this.#agentDirectory, "execution"), workspace);
    } catch (error) {
      this.#activeTurn = undefined;
      throw error;
    }
    if (this.#closed || this.#activeTurn !== active) {
      await active.execution.close();
      throw turnInactiveError();
    }
    active.startTimer = setTimeout(() => {
      delete active.startTimer;
      void this.#runTurn(turnId, text, images);
    }, 0);
    return { turnId };
  }

  async #runTurn(turnId: string, text: string, images: ImageContent[]): Promise<void> {
    const session = this.#requireSession();
    let prompt: Promise<void> | undefined;
    try {
      const active = this.#activeTurn;
      if (!active || active.id !== turnId) throw turnInactiveError();
      prompt = session.prompt(`${text}\n\n<execution_environment>${JSON.stringify({
        cwd: active.execution!.cwd, input_directory: active.workspace,
        network: "Public HTTP/HTTPS via the provided proxy. No account credentials or local network access.",
        lifetime: "Scratch files last for this turn only. Include your findings in the final reply.",
      })}</execution_environment>`, { images, expandPromptTemplates: false });
      active.phase = "running";
      for (const steer of active.pendingSteers.splice(0)) {
        await this.#queueSteer(session, active, steer);
      }
      await prompt;
      // Pi may retain the previous assistant text when an aborted stream yields
      // no text. An accepted cancellation cannot deliver that old answer as new.
      if (active.abortRequested) throw new Error("Turn aborted");
      if (active.provenanceError) throw active.provenanceError;
      active.provenance.assertSettled();
      const lastMessage = session.messages.at(-1);
      if (lastMessage?.role !== "assistant" || lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
        throw new Error(session.state.errorMessage ?? "Pi completed without a successful assistant response");
      }
      const finalText = session.getLastAssistantText()?.trim();
      if (!finalText) {
        throw new Error(session.state.errorMessage ?? "Pi completed without a final assistant message");
      }
      await this.#finishTurn(turnId, { status: "completed", text: finalText }, true);
    } catch (error) {
      session.abortCompaction();
      if (session.isStreaming) await session.abort().catch(() => undefined);
      await prompt?.catch(() => undefined);
      await this.#finishTurn(turnId, {
        status: session.state.errorMessage ? "failed" : "interrupted",
        error: asError(error).message.slice(0, 4_096),
      });
    }
  }

  async #finishTurn(
    turnId: string,
    result: { status: string; text?: string; error?: string },
    publishContextUsage = false,
  ): Promise<void> {
    if (this.#activeTurn?.id === turnId) {
      if (this.#activeTurn.startTimer) clearTimeout(this.#activeTurn.startTimer);
      try { await this.#activeTurn.execution?.close(); }
      catch { result = { status: "failed", error: "Execution workspace cleanup failed" }; }
      this.#activeTurn = undefined;
    }
    if (publishContextUsage) this.#publishContextUsage(turnId);
    this.#emit("turn.completed", { turnId, ...result });
  }

  async #turnSteer(value: unknown): Promise<{}> {
    const session = this.#requireSession();
    const params = record(value, "turn.steer params");
    exactKeys(params, ["turnId", "sourceMessageId", "text", "images"], "turn.steer params");
    const turnId = boundedString(params.turnId, "turnId", 128);
    const active = this.#activeTurn;
    if (active?.id !== turnId) {
      throw turnInactiveError();
    }
    if (active.executionPolicy === "scheduled") throw protocolError("Scheduled work cannot accept steering");
    const steer = {
      sourceMessageId: boundedString(params.sourceMessageId, "sourceMessageId", 128),
      text: boundedString(params.text, "text", 400_000),
      images: parseImages(params.images),
    };
    if (active.phase === "scheduled") active.pendingSteers.push(steer);
    else {
      if (!session.isStreaming) throw turnInactiveError();
      await this.#queueSteer(session, active, steer);
    }
    return {};
  }

  async #queueSteer(
    session: AgentSession,
    active: ActiveTurn,
    steer: { sourceMessageId: string; text: string; images: ImageContent[] },
  ): Promise<void> {
    active.provenance.enqueue(steer.sourceMessageId);
    try {
      // Provenance advances per delivered user message; input Pi consumed elsewhere would desync it.
      if (await session.steer(steer.text, steer.images) !== "queued") {
        throw protocolError("Pi did not queue the steered message");
      }
    } catch (error) {
      active.provenance.rollback(steer.sourceMessageId);
      throw error;
    }
  }

  async #turnAbort(value: unknown): Promise<{}> {
    const session = this.#requireSession();
    const params = record(value, "turn.abort params");
    exactKeys(params, ["turnId"], "turn.abort params");
    const turnId = boundedString(params.turnId, "turnId", 128);
    const active = this.#activeTurn;
    if (active?.id !== turnId) throw turnInactiveError();
    if (active.phase === "scheduled") {
      await this.#finishTurn(turnId, { status: "interrupted", error: "Turn aborted before execution" });
      return {};
    }
    // Pi abort() waits for idle but does not cancel its separate compaction request.
    active.abortRequested = true;
    session.abortCompaction();
    await session.abort();
    return {};
  }

  #relayTool(spec: RuntimeToolSpec): ToolDefinition {
    return {
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: Type.Unsafe(spec.inputSchema as TSchema),
      executionMode: "sequential",
      execute: async (toolCallId, params) => {
        const active = this.#activeTurn;
        if (!active) throw turnInactiveError();
        if (active.executionPolicy === "scheduled" && spec.name === "connector_write") throw protocolError("Scheduled work cannot invoke writes");
        if (active.provenanceError) throw active.provenanceError;
        const sourceMessageId = active.provenance.toolSourceMessageId;
        const result = record(await this.#bridgeRequest("tool.execute", {
          turnId: active.id,
          toolCallId,
          sourceMessageId,
          name: spec.name,
          arguments: params,
        }), "tool.execute result");
        exactKeys(result, ["content"], "tool.execute result");
        if (!Array.isArray(result.content)) throw protocolError("Bridge tool result omitted content");
        return {
          content: parseToolOutput(result.content),
          details: { source: "mochi-bridge" },
        };
      },
    };
  }

  #materialReadTool(): ToolDefinition {
    return {
      name: "material_read",
      label: "Read material",
      description: "Read text or an image from the current Feishu material workspace. Continue large text with the returned offset. Paths must come from this turn.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1_024 }), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        this.#assertToolProvenance();
        const input = record(params, "material_read params");
        const path = await this.#materialPath(boundedString(input.path, "path", 1_024));
        const entry = await stat(path);
        if (!entry.isFile()) throw new Error("Material path is not a regular file");
        if (entry.size > MAXIMUM_MATERIAL_BYTES) throw new Error("Material exceeds the per-turn size boundary");
        exactKeys(input, ["path", "offset"], "material_read params");
        const offset = input.offset === undefined ? 0 : input.offset;
        if (typeof offset !== "number") throw new Error("Material offset must be a number");
        return materialContent(await readFile(path), offset);
      },
    };
  }

  #materialListTool(): ToolDefinition {
    return {
      name: "material_list",
      label: "List materials",
      description: "List one directory inside the current Feishu material workspace.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ maxLength: 1_024 })) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        this.#assertToolProvenance();
        const input = record(params, "material_list params");
        const relativePath = input.path === undefined ? "." : boundedString(input.path, "path", 1_024);
        const path = await this.#materialPath(relativePath);
        const entry = await stat(path);
        if (!entry.isDirectory()) throw new Error("Material path is not a directory");
        const names = (await readdir(path)).sort().slice(0, 500);
        return {
          content: [{ type: "text", text: names.length ? names.join("\n") : "(empty)" }],
          details: { count: names.length },
        };
      },
    };
  }

  #assertToolProvenance(): void {
    const active = this.#activeTurn;
    if (!active) throw turnInactiveError();
    if (active.provenanceError) throw active.provenanceError;
    active.provenance.toolSourceMessageId;
  }

  async #materialPath(value: string): Promise<string> {
    const active = this.#activeTurn;
    if (!active) throw turnInactiveError();
    const candidate = isAbsolute(value) ? resolve(value) : resolve(active.workspace, value);
    if (!isWithin(active.workspace, candidate)) throw new Error("Material path escapes the active workspace");
    await access(candidate);
    const resolved = await realpath(candidate);
    if (!isWithin(active.workspace, resolved)) throw new Error("Material symlink escapes the active workspace");
    const entry = await lstat(candidate);
    if (entry.isSymbolicLink() && !isWithin(active.workspace, resolved)) {
      throw new Error("Material symlink escapes the active workspace");
    }
    return resolved;
  }

  async #validateWorkspace(value: string): Promise<string> {
    if (!isAbsolute(value)) throw protocolError("Material workspace must be absolute");
    const resolved = await realpath(value);
    if (!isWithin(this.#requireInitialization().materialRoot, resolved)) {
      throw protocolError("Material workspace is outside the fixed material root");
    }
    const entry = await stat(resolved);
    if (!entry.isDirectory()) throw protocolError("Material workspace is not a directory");
    return resolved;
  }

  async #validateMaterialRoot(value: string): Promise<string> {
    return validateFixedMaterialRoot(value);
  }

  async #model(modelId: string): Promise<Model<Api>> {
    const runtime = await this.#modelRuntimePromise;
    const reference = parseModelReference(modelId);
    const model = runtime.getModel(reference.provider, reference.model);
    if (!model) throw taggedError("model_policy_unavailable", "Choose a model from the active connection");
    if (!model.input.includes("image")) {
      throw protocolError(`${modelId} cannot satisfy Mochi's image-input contract`);
    }
    return model;
  }

  async #availableModel(modelId: string): Promise<Model<Api>> {
    const reference = parseModelReference(modelId);
    const account = await this.#accountRead();
    if (account.status !== "signedIn" || !account.connections.some((connection) => connection.provider === reference.provider)) throw taggedError("model_policy_unavailable", "Choose a model from a connected provider");
    const model = await this.#model(modelId);
    const available = await (await this.#modelRuntimePromise).getAvailable(reference.provider);
    if (!available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      throw taggedError("model_policy_unavailable", "Choose a model from the active connection");
    }
    return model;
  }

  async #findSession(sessionId: string): Promise<string | undefined> {
    const matches = (await SessionManager.list(this.#runtimeCwd(), this.#sessionDirectory))
      .filter((session) => session.id === sessionId);
    if (matches.length > 1) throw sessionError(`Permanent Pi Session ${sessionId} is ambiguous`);
    return matches[0]?.path;
  }

  #sessionState(): { sessionId: string; capabilityAbi: string } {
    const initialization = this.#requireInitialization();
    const session = this.#requireSession();
    if (session.sessionId !== initialization.sessionId) {
      throw sessionError(`Pi opened unexpected Session ${session.sessionId}`);
    }
    return { sessionId: session.sessionId, capabilityAbi: initialization.capabilityAbi };
  }

  #publishContextUsage(turnId: string): void {
    const session = this.#requireSession();
    const usage = session.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) return;
    this.#emit("context.usage", {
      sessionId: session.sessionId,
      turnId,
      usedTokens: Math.max(0, Math.round(usage.tokens)),
      modelContextWindow: usage.contextWindow,
      fractionUsed: Math.min(1, Math.max(0, usage.percent / 100)),
    });
  }

  async #finishLogin(loginId: string, success: boolean, error?: string): Promise<void> {
    if (this.#login?.id !== loginId) return;
    const login = this.#login;
    const portLock = this.#oauthPortLock;
    this.#oauthPortLock = undefined;
    await portLock?.release();
    this.#login = undefined;
    if (login.cancelled || this.#closed) return;
    this.#emit("account.login.completed", {
      loginId,
      success,
      ...(error ? { error: error.slice(0, 2_000) } : {}),
    });
    this.#emit("account.updated", { status: success ? "signedIn" : "signedOut" });
  }

  #runtimeCwd(): string {
    return process.cwd();
  }

  #requireInitialization(): RuntimeInitialization {
    if (!this.#initialization) throw protocolError("Pi worker is not initialized");
    return this.#initialization;
  }

  #requireSession(): AgentSession {
    if (!this.#session) throw sessionError("Permanent Pi Session is not open");
    return this.#session;
  }

  #bridgeRequest(method: string, params: unknown): Promise<unknown> {
    const id = `worker-${this.#nextBridgeRequestId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pendingBridgeRequests.set(id, { resolve, reject });
    });
    this.#write({ version: PI_WORKER_PROTOCOL_VERSION, type: "request", id, method, params });
    return promise;
  }

  #emit(event: string, params: unknown): void {
    this.#write({ version: PI_WORKER_PROTOCOL_VERSION, type: "event", event, params });
  }

  #write(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }

  #fatal(value: unknown): void {
    console.error(asError(value).stack ?? asError(value).message);
    void this.close().finally(() => process.exit(1));
  }
}

function connectionLabel(connection: { provider: string; label?: string }): string {
  return isByokProvider(connection.provider) ? connection.label ?? "模型 API" : "ChatGPT";
}

function parseToolSpecs(value: unknown): readonly RuntimeToolSpec[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw protocolError("runtime.initialize tools must contain 1-64 entries");
  }
  const tools = value.map((entry): RuntimeToolSpec => {
    const tool = record(entry, "tool");
    exactKeys(tool, ["type", "name", "description", "inputSchema"], "tool");
    const inputSchema = record(tool.inputSchema, "tool.inputSchema");
    exactKeys(
      inputSchema,
      ["type", "properties", "required", "additionalProperties"],
      "tool.inputSchema",
    );
    if (
      tool.type !== "function"
      || inputSchema.type !== "object"
      || !Array.isArray(inputSchema.required)
      || inputSchema.additionalProperties !== false
      || typeof inputSchema.properties !== "object"
      || inputSchema.properties === null
      || Array.isArray(inputSchema.properties)
    ) throw protocolError("Runtime tool schema is invalid");
    const properties = inputSchema.properties as Record<string, unknown>;
    const required = inputSchema.required.map((key) => boundedString(key, "tool.required", 128));
    if (
      new Set(required).size !== required.length
      || required.some((key) => !(key in properties))
    ) throw protocolError("Runtime tool required fields do not match its properties");
    return {
      type: "function",
      name: boundedString(tool.name, "tool.name", 128),
      description: boundedString(tool.description, "tool.description", 8_192),
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw protocolError("Runtime tool names must be unique");
  }
  return tools;
}

function emptyParams(value: unknown, label: string): void {
  const params = record(value, label);
  exactKeys(params, [], label);
}

function parseImages(value: unknown): ImageContent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw protocolError("images must contain at most eight images");
  return value.map((entry): ImageContent => {
    const image = record(entry, "image");
    const mimeType = boundedString(image.mimeType, "image.mimeType", 128);
    if (!mimeType.startsWith("image/")) throw protocolError("image MIME type is invalid");
    return {
      type: "image",
      data: boundedString(image.data, "image.data", 20_000_000),
      mimeType,
    };
  });
}

function parseToolOutput(value: unknown[]): RuntimeToolOutputItem[] {
  if (value.length === 0 || value.length > 32) throw protocolError("Bridge tool output is invalid");
  return value.map((entry): RuntimeToolOutputItem => {
    const item = record(entry, "tool output");
    if (item.type === "text") {
      return { type: "text", text: boundedString(item.text, "tool output text", 120_000) };
    }
    if (item.type === "image") {
      const mimeType = boundedString(item.mimeType, "tool output mimeType", 128);
      if (!mimeType.startsWith("image/")) throw protocolError("Tool image MIME type is invalid");
      return {
        type: "image",
        data: boundedString(item.data, "tool output data", 20_000_000),
        mimeType,
      };
    }
    throw protocolError("Bridge tool output type is invalid");
  });
}

function parseReasoningEffort(value: unknown): ReasoningEffort {
  if (
    value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
  ) return value;
  throw protocolError(`Unsupported reasoning effort: ${String(value)}`);
}

function piEffort(value: ReasoningEffort): ThinkingLevel {
  return value === "none" ? "off" : value;
}

function productEffort(value: string): ReasoningEffort | undefined {
  if (value === "off") return "none";
  return value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function assertModelEffort(model: Model<Api>, effort: ReasoningEffort): void {
  if (!getSupportedThinkingLevels(model).includes(piEffort(effort))) {
    throw protocolError(`${model.id} does not support reasoning effort ${effort}`);
  }
}

function effortDescription(effort: ReasoningEffort): string {
  switch (effort) {
    case "none": return "No additional reasoning";
    case "minimal": return "Minimal reasoning";
    case "low": return "Light reasoning";
    case "medium": return "Balanced reasoning";
    case "high": return "Deep reasoning";
    case "xhigh": return "Very deep reasoning";
    case "max": return "Maximum supported reasoning";
  }
}

function safeAuthorizationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw authError("Pi returned an unsafe ChatGPT authorization URL");
  }
  return url.toString();
}

function capabilityAbi(value: unknown): string {
  const parsed = boundedString(value, "capabilityAbi", 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) throw protocolError("Capability ABI is invalid");
  return parsed;
}

function isWithin(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function taggedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function protocolError(message: string): Error & { code: string } {
  return taggedError("invalid_request", message);
}

function sessionError(message: string): Error & { code: string } {
  return taggedError("session_invalid", message);
}

function authError(message: string): Error & { code: string } {
  return taggedError("auth_required", message);
}

function turnInactiveError(): Error & { code: string } {
  return taggedError("turn_not_active", "No matching active turn");
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "internal_error";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function auditRuntimeEnvironment(): Promise<{ userId: number; home: string; cwd: string }> {
  const userId = process.getuid?.();
  if (userId === undefined || !Number.isInteger(userId) || userId === 0) {
    throw new Error("Pi worker must run as a non-root service user");
  }
  if (homedir() !== PI_RUNTIME_HOME) throw new Error(`Pi worker HOME must be ${PI_RUNTIME_HOME}`);
  if (process.cwd() !== PI_RUNTIME_CWD) throw new Error(`Pi worker cwd must be ${PI_RUNTIME_CWD}`);
  for (const path of [PI_RUNTIME_HOME, PI_RUNTIME_CWD]) {
    const entry = await stat(path);
    if (!entry.isDirectory() || entry.uid !== userId || (entry.mode & 0o077) !== 0) {
      throw new Error(`${path} must be a mode-700 directory owned by the Pi service user`);
    }
  }
  const cwdEntries = (await readdir(PI_RUNTIME_CWD)).filter((entry) => entry !== ".DS_Store");
  if (cwdEntries.length !== 0) throw new Error(`Pi runtime cwd must be empty; found ${cwdEntries.join(", ")}`);
  const stateRoot = join(PI_RUNTIME_HOME, ".pi", "mochi");
  for (const forbidden of ["AGENTS.md", "memories", "plugins", "skills", "extensions"]) {
    if (await pathExists(join(PI_RUNTIME_HOME, forbidden)) || await pathExists(join(stateRoot, forbidden))) {
      throw new Error(`Pi runtime home contains forbidden ambient ${forbidden}`);
    }
  }
  await validateFixedMaterialRoot(PI_MATERIAL_ROOT);
  return { userId, home: PI_RUNTIME_HOME, cwd: PI_RUNTIME_CWD };
}

async function validateFixedMaterialRoot(value: string): Promise<string> {
  if (!isFixedPiMaterialRoot(value)) {
    throw protocolError(`Material root must be the fixed ${PI_MATERIAL_ROOT} boundary`);
  }
  const declared = await lstat(value);
  if (!declared.isDirectory() || declared.isSymbolicLink()) {
    throw protocolError("Material root must be a real directory");
  }
  const resolved = await realpath(value);
  if (resolved !== PI_MATERIAL_ROOT) {
    throw protocolError(`Material root must resolve to the fixed ${PI_MATERIAL_ROOT} boundary`);
  }
  const entry = await stat(resolved);
  if (!entry.isDirectory()) throw protocolError("Material root is not a directory");
  return resolved;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

if (process.argv.includes("--version")) {
  process.stdout.write(`mochi-pi-runtime ${PI_WORKER_PROTOCOL_VERSION}\n`);
} else if (process.argv.length === 3 && process.argv[2] === "--execute-tool") {
  await runExecutionTool();
} else if (process.argv.length === 3 && process.argv[2] === "--supervise-execution") {
  await runExecutionSupervisor();
} else {
  process.umask(0o077);
  await auditRuntimeEnvironment();
  const worker = new PiWorker();
  process.on("SIGTERM", () => void worker.close().finally(() => process.exit(0)));
  process.on("SIGINT", () => void worker.close().finally(() => process.exit(0)));
  await worker.run();
}
