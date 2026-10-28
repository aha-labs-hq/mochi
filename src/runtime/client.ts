import type { RuntimeConfig } from "../config.ts";
import { isByokAccountSummary, isByokProvider, MODEL_API_MAX_CONNECTIONS } from "./byok.ts";
import { createHash } from "node:crypto";
import type { RuntimePolicy } from "./policy.ts";
import { errorFields, log } from "../log.ts";
import { PI_MATERIAL_ROOT } from "./constants.ts";
import type { RuntimeToolOutputItem } from "./toolOutput.ts";
import {
  boundedString,
  exactKeys,
  PI_WORKER_PROTOCOL_VERSION,
  record,
  type RuntimeAccountState,
  type RuntimeContextUsage,
  type RuntimeLoginCompletion,
  type RuntimeModelOption,
  type RuntimeSessionState,
  type RuntimeToolSpec,
  type RuntimeTurnInput,
  type RuntimeTurnWorkspace,
  type RuntimeAccountSummary,
} from "./protocol.ts";
import { runtimeLauncherEnvironment, runtimeWorkerCommand } from "./process.ts";
import { RuntimeRequestError, RuntimeRequestTimedOutError, RuntimeTransport, type WorkerReply } from "./transport.ts";
import { CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS, RUNTIME_REQUEST_TIMEOUT_MILLISECONDS } from "./timing.ts";

type ToolHandler = (
  sourceMessageId: string,
  name: string,
  args: unknown,
) => Promise<readonly RuntimeToolOutputItem[]>;

interface ActiveTurn {
  sessionId: string;
  turnId?: string;
  phase: "running" | "interrupting" | "recovering";
  deadline?: ReturnType<typeof setTimeout>;
  interruptGrace?: ReturnType<typeof setTimeout>;
  terminalError?: Error;
  toolHandler: ToolHandler;
  resolve(value: string): void;
  reject(error: Error): void;
}

interface RuntimeConnection {
  transport: RuntimeTransport;
  preservedTurn?: ActiveTurn;
  expectedExit?: boolean;
}

export interface RuntimeRunningTurn {
  turnId: string;
  completed: Promise<string>;
}

export class RuntimeTurnNotActiveError extends Error {
  constructor() {
    super("Pi worker has no matching active turn to steer");
    this.name = "RuntimeTurnNotActiveError";
  }
}

export class RuntimeTurnTimedOutError extends Error {
  readonly timeoutMilliseconds: number;

  constructor(timeoutMilliseconds: number) {
    super(`Pi turn timed out after ${timeoutMilliseconds}ms`);
    this.name = "RuntimeTurnTimedOutError";
    this.timeoutMilliseconds = timeoutMilliseconds;
  }
}

export interface RuntimeAccountObserver {
  accountUpdated(): void;
  runtimeUnavailable?(): void;
  loginCompleted(completion: RuntimeLoginCompletion): void;
}

export interface PiRuntimeClientOptions {
  interruptGraceMilliseconds?: number;
  contextOrganizationTimeoutMilliseconds?: number;
  accountObserver?: RuntimeAccountObserver;
}

const DEFAULT_INTERRUPT_GRACE_MILLISECONDS = 30_000;

export class PiRuntimeClient {
  readonly #config: RuntimeConfig & { sessionId: string };
  readonly #tools: readonly RuntimeToolSpec[];
  readonly #capabilityAbi: string;
  readonly #systemPrompt: () => string;
  #lastAppliedInstructionsDigest: string | undefined;
  readonly #accountObserver: RuntimeAccountObserver | undefined;
  readonly #interruptGraceMilliseconds: number;
  readonly #contextOrganizationTimeoutMilliseconds: number;
  #connection: RuntimeConnection | undefined;
  #connecting: Promise<void> | undefined;
  #knownSession: RuntimeSessionState | undefined;
  #fatalError: Error | undefined;
  #activeTurn: ActiveTurn | undefined;
  #latestContextUsage: RuntimeContextUsage | undefined;
  #compacting = false;
  readonly #compactionListeners = new Set<() => void>();
  #closed = false;

  constructor(options: {
    config: RuntimeConfig & { sessionId: string };
    tools: readonly RuntimeToolSpec[];
    capabilityAbi: string;
    systemPrompt: string | (() => string);
    client?: PiRuntimeClientOptions;
  }) {
    this.#config = options.config;
    this.#tools = options.tools;
    this.#capabilityAbi = options.capabilityAbi;
    const prompt = options.systemPrompt;
    this.#systemPrompt = typeof prompt === "string" ? () => prompt : prompt;
    this.#accountObserver = options.client?.accountObserver;
    this.#interruptGraceMilliseconds = options.client?.interruptGraceMilliseconds
      ?? DEFAULT_INTERRUPT_GRACE_MILLISECONDS;
    this.#contextOrganizationTimeoutMilliseconds = options.client?.contextOrganizationTimeoutMilliseconds
      ?? CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS;
    if (!Number.isInteger(this.#interruptGraceMilliseconds) || this.#interruptGraceMilliseconds <= 0) {
      throw new Error("interruptGraceMilliseconds must be a positive integer");
    }
    if (!Number.isInteger(this.#contextOrganizationTimeoutMilliseconds) || this.#contextOrganizationTimeoutMilliseconds <= 0) {
      throw new Error("contextOrganizationTimeoutMilliseconds must be a positive integer");
    }
  }

  isCompacting(): boolean { return this.#compacting; }

  onCompactionChanged(listener: () => void): () => void {
    this.#compactionListeners.add(listener);
    return () => { this.#compactionListeners.delete(listener); };
  }

  #setCompacting(active: boolean): void {
    if (this.#compacting === active) return;
    this.#compacting = active;
    for (const listener of this.#compactionListeners) listener();
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("Pi runtime client is closed");
    if (this.#fatalError) throw this.#fatalError;
    if (this.#connecting) return this.#connecting;
    if (this.#connection) {
      if (this.#connection.transport.isRunning) return;
      await this.#connection.transport.exited;
      return this.connect();
    }
    const connecting = this.#openConnection();
    this.#connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }

  async #openConnection(): Promise<void> {
    const connection = {} as RuntimeConnection;
    connection.transport = new RuntimeTransport({
      command: runtimeWorkerCommand(this.#config),
      environment: runtimeLauncherEnvironment(),
      onEvent: (event, params) => {
        if (this.#connection === connection) this.#handleEvent(event, params);
      },
      onRequest: (method, params) => {
        if (this.#connection !== connection) {
          return Promise.resolve({
            ok: false,
            error: { code: "stale_connection", message: "Pi worker connection is stale" },
          });
        }
        return this.#handleWorkerRequest(method, params);
      },
      onFatal: (error) => {
        if (this.#connection === connection) this.#fatalError = error;
      },
      onExit: (error) => this.#handleExit(connection, error),
    });
    if (this.#activeTurn?.phase === "recovering") connection.preservedTurn = this.#activeTurn;
    this.#connection = connection;
    connection.transport.start();
    try {
      const result = record(await this.#request("runtime.initialize", {
        botId: this.#config.botId,
        sessionId: this.#config.sessionId,
        capabilityAbi: this.#capabilityAbi,
        systemPrompt: this.#systemPrompt(),
        tools: this.#tools,
        model: this.#config.model,
        reasoningEffort: this.#config.reasoningEffort,
        materialRoot: PI_MATERIAL_ROOT,
      }), "runtime.initialize result");
      exactKeys(result, ["protocolVersion"], "runtime.initialize result");
      if (result.protocolVersion !== PI_WORKER_PROTOCOL_VERSION) {
        throw new Error("Pi worker initialized with an unexpected protocol version");
      }
    } catch (error) {
      await connection.transport.stop(asError(error));
      throw error;
    }
  }

  async accountRead(): Promise<RuntimeAccountState> {
    await this.connect();
    return parseAccountState(await this.#request("account.read", {}));
  }

  async listModels(): Promise<readonly RuntimeModelOption[]> {
    await this.connect();
    const value = await this.#request("model.list", {});
    if (!Array.isArray(value)) throw new Error("Pi worker model.list returned an invalid catalog");
    const models = value.map(parseModelOption);
    if (models.length === 0 || models.length > 128) {
      throw new Error("Pi worker model catalog size is invalid");
    }
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      throw new Error("Pi worker model catalog contains duplicate models");
    }
    return models;
  }

  async updateTurnPolicy(policy: RuntimePolicy, persist: () => void = () => undefined): Promise<void> {
    await this.connect();
    await this.#request("policy.update", policy);
    try { persist(); }
    catch (error) {
      // The next worker must use the last durable policy, even when that model
      // no longer belongs to the current connection and cannot be rolled back live.
      await this.disconnect();
      throw error;
    }
    this.#config.model = policy.model;
    this.#config.reasoningEffort = policy.reasoningEffort;
  }

  async createSession(): Promise<RuntimeSessionState> {
    await this.connect();
    const session = parseSessionState(await this.#request("session.create", {}));
    this.#rememberSession(session);
    return session;
  }

  async bootstrapSession(): Promise<RuntimeSessionState> {
    await this.connect();
    const session = parseSessionState(await this.#request("session.bootstrap", {}));
    this.#rememberSession(session);
    return session;
  }

  async migrateSession(sourceSessionId: string): Promise<{
    session: RuntimeSessionState;
    transcriptSha256: string;
    sourceMessageCount: number;
  }> {
    await this.connect();
    const result = record(
      await this.#request("session.migrate", { sourceSessionId }, 120_000),
      "session.migrate result",
    );
    exactKeys(result, [
      "sessionId", "capabilityAbi", "transcriptSha256", "sourceMessageCount",
    ], "session.migrate result");
    return {
      session: parseSessionState(result, ["transcriptSha256", "sourceMessageCount"]),
      transcriptSha256: digest(result.transcriptSha256, "transcriptSha256"),
      sourceMessageCount: integer(result.sourceMessageCount, "sourceMessageCount", 0),
    };
  }

  async resumeSession(): Promise<RuntimeSessionState> {
    await this.connect();
    const session = parseSessionState(await this.#request("session.resume", {}));
    this.#rememberSession(session);
    return session;
  }

  async verifySession(): Promise<void> {
    await this.connect();
    this.#rememberSession(parseSessionState(await this.#request("session.verify", {})));
  }

  #rememberSession(session: RuntimeSessionState): void {
    if (session.sessionId !== this.#config.sessionId) {
      throw new Error(`Pi worker resumed unexpected Session ${session.sessionId}`);
    }
    if (session.capabilityAbi !== this.#capabilityAbi) {
      throw new Error(`Pi worker capability mismatch: ${session.capabilityAbi}`);
    }
    this.#knownSession = session;
  }

  contextUsage(): RuntimeContextUsage | undefined {
    return this.#latestContextUsage;
  }

  restoreContextUsage(usage: RuntimeContextUsage): void {
    if (this.#activeTurn) throw new Error("Cannot restore context usage while work is active");
    if (usage.sessionId !== this.#config.sessionId) {
      throw new Error(`Context usage belongs to unexpected Session ${usage.sessionId}`);
    }
    this.#latestContextUsage = usage;
  }

  async compactSession(): Promise<void> {
    if (this.#activeTurn) throw new Error("Pi runtime has an active turn");
    await this.#ensureSession();
    try {
      await this.#request("session.compact", {}, this.#contextOrganizationTimeoutMilliseconds);
    } catch (error) {
      if (error instanceof RuntimeRequestTimedOutError) await this.#recoverTimedOutCompaction(error);
      throw error;
    }
  }

  async #recoverTimedOutCompaction(cause: RuntimeRequestTimedOutError): Promise<void> {
    const sessionId = this.#config.sessionId;
    log.warn("runtime.context.recovery_started", { sessionId });
    try {
      // A request timeout only stops waiting. The old worker must exit before
      // admission can resume; its shutdown cancels Pi's separate compaction.
      await this.#connection?.transport.stop(cause);
      await this.connect();
      await this.resumeSession();
      // Compaction may have committed just before the old worker exited.
      // Reusing pre-compaction usage would claim knowledge we no longer have.
      this.#latestContextUsage = undefined;
      log.info("runtime.context.recovery_completed", { sessionId });
    } catch (error) {
      const recoveryError = new Error("Pi worker recovery failed after timed-out context organization", { cause: error });
      this.#fatalError = recoveryError;
      log.error("runtime.context.recovery_failed", { sessionId, ...errorFields(error) });
      throw recoveryError;
    }
  }

  async startTurn(
    input: RuntimeTurnInput,
    toolHandler: ToolHandler,
    workspace: RuntimeTurnWorkspace,
  ): Promise<RuntimeRunningTurn> {
    if (this.#activeTurn) throw new Error("Pi runtime already has an active turn");
    await this.#ensureSession();
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const active: ActiveTurn = {
      sessionId: this.#config.sessionId,
      phase: "running",
      toolHandler,
      resolve,
      reject,
    };
    this.#activeTurn = active;
    void completed.catch(() => undefined);
    try {
      const systemPrompt = this.#systemPrompt();
      const result = record(await this.#request("turn.start", {
        sourceMessageId: input.sourceMessageId,
        executionPolicy: input.executionPolicy ?? "interactive",
        text: input.text,
        images: input.images,
        workspace: workspace.cwd,
        systemPrompt,
      }), "turn.start result");
      exactKeys(result, ["turnId"], "turn.start result");
      active.turnId = boundedString(result.turnId, "turnId", 128);
      const promptDigest = createHash("sha256").update(systemPrompt).digest("hex");
      if (promptDigest !== this.#lastAppliedInstructionsDigest) {
        log.info("runtime.instructions.applied", { promptDigest });
        this.#lastAppliedInstructionsDigest = promptDigest;
      }
      if (this.#activeTurn === active) {
        active.deadline = setTimeout(
          () => void this.#interruptTimedOutTurn(active),
          this.#config.turnTimeoutMilliseconds,
        );
      }
      return { turnId: active.turnId, completed };
    } catch (error) {
      this.#rejectActiveTurn(active, asError(error));
      throw error;
    }
  }

  async steerTurn(expectedTurnId: string, input: RuntimeTurnInput): Promise<void> {
    const active = this.#activeTurn;
    if (!active || active.phase !== "running" || active.turnId !== expectedTurnId) {
      throw new RuntimeTurnNotActiveError();
    }
    try {
      await this.#request("turn.steer", {
        turnId: expectedTurnId,
        sourceMessageId: input.sourceMessageId,
        text: input.text,
        images: input.images,
      });
    } catch (error) {
      if (error instanceof RuntimeRequestError && error.code === "turn_not_active") {
        throw new RuntimeTurnNotActiveError();
      }
      throw error;
    }
  }

  async #interruptTimedOutTurn(active: ActiveTurn): Promise<void> {
    if (this.#activeTurn !== active || active.phase !== "running" || !active.turnId) return;
    active.phase = "interrupting";
    active.terminalError = new RuntimeTurnTimedOutError(this.#config.turnTimeoutMilliseconds);
    clearTimer(active.deadline);
    delete active.deadline;
    log.warn("runtime.turn.interrupt_requested", {
      sessionId: active.sessionId,
      turnId: active.turnId,
      timeoutMilliseconds: this.#config.turnTimeoutMilliseconds,
    });
    try {
      await this.#request("turn.abort", { turnId: active.turnId }, this.#interruptGraceMilliseconds);
    } catch (error) {
      await this.#recoverTimedOutTurn(active, asError(error));
      return;
    }
    if (this.#activeTurn !== active || active.phase !== "interrupting") return;
    active.interruptGrace = setTimeout(
      () => void this.#recoverTimedOutTurn(active, new Error("Pi worker did not confirm the interrupted turn")),
      this.#interruptGraceMilliseconds,
    );
  }

  async #recoverTimedOutTurn(active: ActiveTurn, cause: Error): Promise<void> {
    if (this.#activeTurn !== active || active.phase !== "interrupting") return;
    active.phase = "recovering";
    clearTimer(active.interruptGrace);
    delete active.interruptGrace;
    log.warn("runtime.turn.recovery_started", {
      sessionId: active.sessionId,
      turnId: active.turnId,
      cause: cause.message,
    });
    try {
      const connection = this.#connection;
      if (connection) {
        connection.preservedTurn = active;
        await connection.transport.stop(cause);
      }
      await this.connect();
      await this.resumeSession();
      if (this.#activeTurn !== active) return;
      log.info("runtime.turn.recovery_completed", {
        sessionId: active.sessionId,
        turnId: active.turnId,
      });
      this.#rejectActiveTurn(active, active.terminalError ?? cause);
    } catch (error) {
      const recoveryError = new Error(
        `Pi worker recovery failed after timed-out turn: ${asError(error).message}`,
        { cause: error },
      );
      this.#fatalError = recoveryError;
      log.error("runtime.turn.recovery_failed", {
        sessionId: active.sessionId,
        turnId: active.turnId,
        ...errorFields(recoveryError),
      });
      if (this.#activeTurn === active) this.#rejectActiveTurn(active, recoveryError);
    }
  }

  async disconnect(): Promise<void> {
    if (this.#activeTurn) throw new Error("Cannot disconnect an active runtime turn");
    await this.#connecting?.catch(() => undefined);
    const connection = this.#connection;
    if (connection) {
      connection.expectedExit = true;
      await this.#request("runtime.shutdown", {}, 2_000).catch(() => undefined);
      await connection.transport.stop(new Error("Runtime worker released"));
    }
    this.#connection = undefined;
    this.#connecting = undefined;
    this.#fatalError = undefined;
    this.#knownSession = undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Pi runtime client is closed");
    this.#fatalError = error;
    await this.#connecting?.catch(() => undefined);
    const connection = this.#connection;
    if (connection) {
      connection.expectedExit = true;
      await this.#request("runtime.shutdown", {}, 2_000).catch(() => undefined);
      await connection.transport.stop(error);
    }
    if (this.#activeTurn) this.#rejectActiveTurn(this.#activeTurn, error);
  }

  async #ensureSession(): Promise<void> {
    if (this.#knownSession) return;
    await this.resumeSession();
  }

  async #handleWorkerRequest(method: string, paramsValue: unknown): Promise<WorkerReply> {
    if (method !== "tool.execute") {
      return { ok: false, error: { code: "method_not_found", message: `Unsupported worker request: ${method}` } };
    }
    const params = record(paramsValue, "tool.execute params");
    exactKeys(
      params,
      ["turnId", "toolCallId", "sourceMessageId", "name", "arguments"],
      "tool.execute params",
    );
    const active = this.#activeTurn;
    if (!active || active.phase !== "running" || params.turnId !== active.turnId) {
      return { ok: false, error: { code: "turn_not_active", message: "No matching active Feishu turn" } };
    }
    const toolName = boundedString(params.name, "tool name", 128);
    const toolCallId = boundedString(params.toolCallId, "toolCallId", 128);
    const sourceMessageId = boundedString(params.sourceMessageId, "sourceMessageId", 128);
    const startedAt = performance.now();
    log.info("runtime.tool.started", {
      sessionId: active.sessionId,
      turnId: active.turnId,
      toolCallId,
      toolName,
      sourceMessageId,
    });
    try {
      const content = await active.toolHandler(sourceMessageId, toolName, params.arguments);
      log.info("runtime.tool.completed", {
        sessionId: active.sessionId,
        turnId: active.turnId,
        toolCallId,
        toolName,
        sourceMessageId,
        outputTypes: content.map((item) => item.type),
        outputTextCharacters: content.reduce((total, item) => total + (item.type === "text" ? item.text.length : 0), 0),
        durationMilliseconds: Math.round(performance.now() - startedAt),
      });
      return { ok: true, result: { content } };
    } catch (error) {
      log.warn("runtime.tool.failed", {
        sessionId: active.sessionId,
        turnId: active.turnId,
        toolCallId,
        toolName,
        sourceMessageId,
        durationMilliseconds: Math.round(performance.now() - startedAt),
        ...errorFields(error),
      });
      return {
        ok: false,
        error: {
          code: "tool_execution_failed",
          message: asError(error).message.slice(0, 2_000),
        },
      };
    }
  }

  #handleEvent(event: string, paramsValue: unknown): void {
    if (event === "account.updated") {
      const params = record(paramsValue, "account.updated params");
      exactKeys(params, ["status"], "account.updated params");
      if (params.status !== "signedIn" && params.status !== "signedOut") {
        throw new Error("Pi worker sent an invalid account status");
      }
      this.#accountObserver?.accountUpdated();
      return;
    }
    if (event === "account.login.completed") {
      this.#accountObserver?.loginCompleted(parseLoginCompletion(paramsValue));
      return;
    }
    if (event === "context.usage") {
      const usage = parseContextUsage(paramsValue);
      if (usage.sessionId !== this.#config.sessionId) {
        throw new Error(`Context usage belongs to unexpected Session ${usage.sessionId}`);
      }
      this.#latestContextUsage = usage;
      log.info("runtime.context.usage_updated", {
        sessionId: usage.sessionId,
        turnId: usage.turnId,
        contextUsedTokens: usage.usedTokens,
        contextWindowTokens: usage.modelContextWindow,
        contextFractionUsed: usage.fractionUsed,
      });
      return;
    }
    if (event === "context.compaction") {
      const params = record(paramsValue, "context.compaction params");
      exactKeys(params, ["sessionId", "active"], "context.compaction params");
      if (params.sessionId !== this.#config.sessionId || typeof params.active !== "boolean") {
        throw new Error("Pi worker sent invalid Session compaction state");
      }
      this.#setCompacting(params.active);
      return;
    }
    if (event === "context.compacted") {
      const params = record(paramsValue, "context.compacted params");
      exactKeys(params, ["sessionId"], "context.compacted params");
      if (params.sessionId !== this.#config.sessionId) {
        throw new Error("Pi worker compacted an unexpected Session");
      }
      this.#latestContextUsage = undefined;
      log.info("runtime.context.compacted", { sessionId: params.sessionId });
      return;
    }
    if (event !== "turn.completed") throw new Error(`Pi worker sent unsupported event: ${event}`);

    const params = record(paramsValue, "turn.completed params");
    const status = boundedString(params.status, "turn status", 32);
    if (status !== "completed" && status !== "failed" && status !== "interrupted") {
      throw new Error(`Pi worker sent unsupported turn status: ${status}`);
    }
    exactKeys(
      params,
      status === "completed" ? ["turnId", "status", "text"] : ["turnId", "status", "error"],
      "turn.completed params",
    );
    const active = this.#activeTurn;
    if (!active || params.turnId !== active.turnId || active.phase === "recovering") return;
    if (active.terminalError) {
      log.info("runtime.turn.interrupt_confirmed", {
        sessionId: active.sessionId,
        turnId: active.turnId,
        status,
      });
      this.#rejectActiveTurn(active, active.terminalError);
      return;
    }
    if (status === "completed") {
      this.#resolveActiveTurn(active, boundedString(params.text, "turn text", 400_000));
      return;
    }
    this.#rejectActiveTurn(active, new Error(
      `Pi turn ${status}: ${typeof params.error === "string" ? params.error : "unknown error"}`,
    ));
  }

  async #handleExit(connection: RuntimeConnection, error: Error): Promise<void> {
    if (this.#connection !== connection) return;
    this.#connection = undefined;
    this.#knownSession = undefined;
    this.#setCompacting(false);
    if (!connection.expectedExit && !connection.preservedTurn && !this.#closed) this.#accountObserver?.runtimeUnavailable?.();
    const active = this.#activeTurn;
    if (active && connection.preservedTurn !== active) {
      this.#rejectActiveTurn(active, active.terminalError ?? error);
    }
  }

  #request(method: string, params: unknown, timeoutMilliseconds = RUNTIME_REQUEST_TIMEOUT_MILLISECONDS): Promise<unknown> {
    const connection = this.#connection;
    if (!connection) throw new Error("Pi worker is not connected");
    return connection.transport.request(method, params, timeoutMilliseconds);
  }

  #resolveActiveTurn(active: ActiveTurn, value: string): void {
    if (this.#activeTurn === active) this.#activeTurn = undefined;
    clearActiveTurnTimers(active);
    active.resolve(value);
  }

  #rejectActiveTurn(active: ActiveTurn, error: Error): void {
    if (this.#activeTurn === active) this.#activeTurn = undefined;
    clearActiveTurnTimers(active);
    active.reject(error);
  }
}

export function parseAccountState(value: unknown): RuntimeAccountState {
  const result = record(value, "account.read result");
  if (result.status === "signedOut") {
    exactKeys(result, ["status"], "account.read result");
    return { status: "signedOut" };
  }
  if (result.status !== "signedIn") throw new Error("Pi worker returned an invalid account state");
  exactKeys(result, ["status", "account", "connections"], "account.read result");
  if (!Array.isArray(result.connections) || result.connections.length < 1 || result.connections.length > MODEL_API_MAX_CONNECTIONS + 1) {
    throw new Error("Pi worker returned an invalid model connection list");
  }
  const connections = result.connections.map(parseAccountSummary);
  if (new Set(connections.map((connection) => connection.provider)).size !== connections.length) {
    throw new Error("Pi worker returned duplicate model connections");
  }
  const account = parseAccountSummary(result.account);
  if (account.provider !== connections[0]!.provider) throw new Error("Pi worker returned an invalid primary connection");
  return { status: "signedIn", account, connections };
}

function parseAccountSummary(value: unknown): RuntimeAccountSummary {
  const account = record(value, "account");
  if (account.provider === "openai-codex") {
    exactKeys(account, ["provider", "authType", "subscription"], "account");
    if (account.authType !== "oauth" || account.subscription !== true)
      throw new Error("Pi worker returned an unsupported ChatGPT account");
    return { provider: "openai-codex", authType: "oauth", subscription: true };
  }
  if (isByokProvider(account.provider)) {
    if (!isByokAccountSummary(account)) throw new Error("Pi worker returned an unsupported BYOK account");
    return account;
  }
  throw new Error("Pi worker returned an unsupported account provider");
}

function parseModelOption(value: unknown): RuntimeModelOption {
  const model = record(value, "model");
  exactKeys(model, [
    "id", "displayName", "description", "supportedEfforts", "defaultEffort",
  ], "model");
  if (!Array.isArray(model.supportedEfforts) || model.supportedEfforts.length === 0) {
    throw new Error("Pi worker model omitted supported efforts");
  }
  const supportedEfforts = model.supportedEfforts.map((value) => {
    const effort = record(value, "model effort");
    exactKeys(effort, ["id", "description"], "model effort");
    return {
      id: boundedString(effort.id, "effort.id", 32),
      description: boundedString(effort.description, "effort.description", 1_024),
    };
  });
  if (new Set(supportedEfforts.map((effort) => effort.id)).size !== supportedEfforts.length) {
    throw new Error("Pi worker model contains duplicate efforts");
  }
  const defaultEffort = boundedString(model.defaultEffort, "model.defaultEffort", 32);
  if (!supportedEfforts.some((effort) => effort.id === defaultEffort)) {
    throw new Error("Pi worker model default effort is unsupported");
  }
  return {
    id: boundedString(model.id, "model.id", 128),
    displayName: boundedString(model.displayName, "model.displayName", 128),
    description: boundedString(model.description, "model.description", 2_048),
    supportedEfforts,
    defaultEffort,
  };
}

function parseSessionState(value: unknown, additionalKeys: readonly string[] = []): RuntimeSessionState {
  const result = record(value, "session result");
  exactKeys(result, ["sessionId", "capabilityAbi", ...additionalKeys], "session result");
  return {
    sessionId: boundedString(result.sessionId, "sessionId", 128),
    capabilityAbi: boundedString(result.capabilityAbi, "capabilityAbi", 80),
  };
}

export function parseLoginCompletion(value: unknown): RuntimeLoginCompletion {
  const params = record(value, "account.login.completed params");
  exactKeys(
    params,
    typeof params.error === "string" && params.error
      ? ["loginId", "success", "error"]
      : ["loginId", "success"],
    "account.login.completed params",
  );
  if (typeof params.success !== "boolean") throw new Error("Login completion omitted success");
  return {
    loginId: boundedString(params.loginId, "loginId", 128),
    success: params.success,
    ...(typeof params.error === "string" && params.error ? { error: params.error.slice(0, 2_000) } : {}),
  };
}

function parseContextUsage(value: unknown): RuntimeContextUsage {
  const params = record(value, "context.usage params");
  exactKeys(params, [
    "sessionId", "turnId", "usedTokens", "modelContextWindow", "fractionUsed",
  ], "context.usage params");
  const usedTokens = integer(params.usedTokens, "usedTokens", 0);
  const modelContextWindow = integer(params.modelContextWindow, "modelContextWindow", 1);
  if (typeof params.fractionUsed !== "number" || params.fractionUsed < 0 || params.fractionUsed > 1) {
    throw new Error("Context usage fraction is invalid");
  }
  return {
    sessionId: boundedString(params.sessionId, "sessionId", 128),
    turnId: boundedString(params.turnId, "turnId", 128),
    usedTokens,
    modelContextWindow,
    fractionUsed: params.fractionUsed,
  };
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${label} is invalid`);
  return Number(value);
}

function digest(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

export function safeAuthorizationUrl(value: unknown): string {
  const url = new URL(boundedString(value, "authorizationUrl", 4_096));
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Pi worker returned an unsafe ChatGPT authorization URL");
  }
  return url.toString();
}

function clearActiveTurnTimers(active: ActiveTurn): void {
  clearTimer(active.deadline);
  clearTimer(active.interruptGrace);
  delete active.deadline;
  delete active.interruptGrace;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) clearTimeout(timer);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
