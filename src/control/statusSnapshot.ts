import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAXIMUM_BOTS } from "../product/fleet.ts";
import { isReasoningEffort, type RuntimePolicy } from "../runtime/policy.ts";
import { isBotId } from "../product/layout.ts";
import { BRIDGE_VERSION, productVersion } from "../product/version.ts";
import { OPENAI_CODEX_PROVIDER, type RuntimeAccountSummary } from "../runtime/protocol.ts";
import { isByokAccountSummary, MODEL_API_MAX_CONNECTIONS } from "../runtime/byok.ts";
import {
  parseProductProblem,
  productProblem,
  type ProductProblemCode,
  type ProductProblemSnapshot,
} from "./productProblem.ts";
import { MOCHI_CONTROL_PROTOCOL_VERSION } from "./protocol.ts";
import { isFeishuGroups, type FeishuGroup } from "../lark/group.ts";
import { emptyFeishuSnapshot, isFeishuConnectionSnapshot, type FeishuConnectionSnapshot } from "../lark/connectionState.ts";
import {
  isConnectorCapabilityAvailability,
  type ConnectorCatalogProjection,
} from "./connectorSnapshot.ts";
import { CONNECTOR_MAX_PROBLEM_LENGTH } from "../connectors/protocol.ts";

export const STATUS_VERSION = 30;
/** Defensive reader ceiling: 16 MiB per Bot covers both maximum catalogs,
 * UTF-8 and JSON escaping. This is not a working-set or performance guarantee. */
export const MAXIMUM_STATUS_BYTES = MAXIMUM_BOTS * 16 * 1_024 * 1_024;
const STATUS_VALIDITY_MILLISECONDS = 15_000;
const STATUS_HEARTBEAT_MILLISECONDS = 5_000;
const MAXIMUM_STATUS_FUTURE_MILLISECONDS = 20_000;
const MAXIMUM_LABEL_LENGTH = 60;

export type BotLifecycle =
  | "paused"
  | "starting"
  | "setup"
  | "awaitingLogin"
  | "awaitingConnection"
  | "listening"
  | "blocked"
  | "stopping"
  | "failed";

export type RuntimeAccountSnapshot =
  | { status: "unknown" }
  | { status: "signedOut" }
  | { status: "signingIn" }
  | {
    status: "signedIn";
    account: RuntimeAccountSummary;
    connections: readonly RuntimeAccountSummary[];
    /**
     * A ChatGPT browser login that has not finished yet. The connections above
     * stay in service, so only Bots that use ChatGPT wait for it.
     */
    pendingLogin?: typeof OPENAI_CODEX_PROVIDER;
  };

/** Whether a ChatGPT browser login is waiting for the customer, alone or beside other connections. */
export function chatGPTLoginPending(account: RuntimeAccountSnapshot): boolean {
  return account.status === "signingIn" || (account.status === "signedIn" && account.pendingLogin !== undefined);
}

export interface BotRuntimeState {
  activeTurn: boolean;
  organizingContext: boolean;
  queueDepth: number;
  contextOrganizationAvailable: boolean;
}

export type ProductSetupStage = "checking" | "signIn" | "signingIn" | "ready" | "initializing";

export interface ProductSetupSnapshot {
  stage: ProductSetupStage;
}

/** Mutable business facts belonging to exactly one Bot. */
export interface BotStatus extends BotRuntimeState {
  botId: string;
  label: string;
  characterId: string;
  enabled: boolean;
  lifecycle: BotLifecycle;
  eventStreamReady: boolean;
  feishuGroups: readonly FeishuGroup[] | null;
  feishu: FeishuConnectionSnapshot;
  /**
   * This Bot's connectors: their connections, selected resources and
   * capabilities, projected to what a renderer may see. `null` means the Bot has
   * not published one yet; an empty connection list means it has none.
   */
  connectorCatalog: ConnectorCatalogProjection | null;
  botPolicy: RuntimePolicy;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  setup?: ProductSetupSnapshot;
  problem?: ProductProblemSnapshot;
}

/**
 * The host's atomic publication of all independently owned Bot facts.
 */
export interface FleetStatusSnapshot {
  version: typeof STATUS_VERSION;
  productVersion: string;
  bridgeVersion: typeof BRIDGE_VERSION;
  runId: string;
  processId: number;
  updatedAt: string;
  validUntil: string;
  controlProtocolVersion: typeof MOCHI_CONTROL_PROTOCOL_VERSION;
  controlAvailable: boolean;
  /**
   * The Bridge's own answer to "may the shared account change now": control is
   * available and every Bot's admission is idle. The desktop only reads it.
   */
  accountChangeReady: boolean;
  runtimeAccount: RuntimeAccountSnapshot;
  bots: readonly BotStatus[];
  /** A deployment-level failure, never a single Bot's problem. */
  problem?: ProductProblemSnapshot;
}

/**
 * The single writer of the deployment's status file.
 *
 * Every Bot publishes through a `BotStatusProjection` handed out here, so one
 * atomic write always describes the whole deployment. A Bot can never partially
 * overwrite another Bot's entry, and a reader never sees a half-updated roster.
 */
export class FleetStatusProjection {
  readonly #path: string;
  readonly #bots = new Map<string, BotStatus>();
  /** Each hosted Bot's admission answer; it is not a published Bot field. */
  readonly #idle = new Map<string, boolean>();
  #order: readonly string[] = [];
  #snapshot: FleetStatusSnapshot;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(path: string) {
    this.#path = path;
    const now = Date.now();
    this.#snapshot = {
      version: STATUS_VERSION,
      productVersion: productVersion(),
      bridgeVersion: BRIDGE_VERSION,
      runId: crypto.randomUUID(),
      processId: process.pid,
      updatedAt: new Date(now).toISOString(),
      validUntil: new Date(now + STATUS_VALIDITY_MILLISECONDS).toISOString(),
      controlProtocolVersion: MOCHI_CONTROL_PROTOCOL_VERSION,
      controlAvailable: false,
      accountChangeReady: false,
      runtimeAccount: { status: "unknown" },
      bots: [],
    };
  }

  /** Publishes the roster shape before any Bot starts, so the desktop can render it. */
  roster(bots: readonly { id: string; label: string; characterId: string; enabled: boolean }[]): void {
    this.#order = bots.map((bot) => bot.id);
    for (const identity of [...this.#bots.keys()]) {
      if (!this.#order.includes(identity)) {
        this.#bots.delete(identity);
        this.#idle.delete(identity);
      }
    }
    for (const bot of bots) {
      const existing = this.#bots.get(bot.id);
      const next = existing ? { ...existing, label: bot.label, characterId: bot.characterId, enabled: bot.enabled } : startingBotStatus(bot);
      if (existing && existing.enabled !== bot.enabled) {
        next.lifecycle = "starting";
        next.eventStreamReady = false;
        delete next.setup;
        delete next.problem;
      }
      this.#bots.set(bot.id, next);
    }
    this.#publish();
    this.#startHeartbeat();
  }

  /** One Bot's private handle. It can only ever change its own entry. */
  bot(botId: string): BotStatusProjection {
    if (!this.#bots.has(botId)) throw new Error(`Bot ${botId} is not in the published roster`);
    return new BotStatusProjection(
      botId,
      () => this.#bots.get(botId)!,
      (next) => {
        if (!this.#bots.has(botId)) return;
        this.#bots.set(botId, next);
        this.#publish();
      },
      (idle) => {
        if (!this.#bots.has(botId) || (this.#idle.get(botId) ?? true) === idle) return;
        this.#idle.set(botId, idle);
        this.#publish();
      },
    );
  }

  controlReady(): void {
    this.#update({ controlAvailable: true }, true);
  }

  /**
   * One account fact and every immediate lifecycle consequence in one write.
   * A Bot whose published state still agrees with the new account keeps it: a
   * change to one connection must not pull Bots on another connection offline.
   * Each affected Bot then publishes its own settled lifecycle.
   */
  accountChanged(runtimeAccount: RuntimeAccountSnapshot): void {
    if (JSON.stringify(this.#snapshot.runtimeAccount) === JSON.stringify(runtimeAccount)) return;
    for (const [id, current] of this.#bots) {
      if (current.lifecycle === "failed" || current.lifecycle === "stopping") continue;
      if (runtimeAccount.status !== "unknown" && isAccountLifecyclePair(current, runtimeAccount)) continue;
      const next: BotStatus = { ...current, lifecycle: current.lifecycle === "paused" ? "paused" : runtimeAccount.status === "unknown" ? "blocked" : "starting", eventStreamReady: false };
      delete next.setup;
      if (next.lifecycle === "blocked") next.problem = productProblem("account_status_unavailable");
      else delete next.problem;
      this.#bots.set(id, next);
    }
    this.#update({ runtimeAccount });
  }

  /** A deployment-level failure. Bot lifecycles keep their own last published state. */
  failed(problemCode: ProductProblemCode): void {
    this.#stopHeartbeat();
    this.#update({ controlAvailable: false, problem: productProblem(problemCode) });
  }

  /**
   * Gives up authorship for good: the lock that made this process the one
   * writer is gone, so another Bridge may already own the file.
   */
  close(): void {
    this.#closed = true;
    this.#stopHeartbeat();
  }

  stopping(): void {
    this.#stopHeartbeat();
    for (const [identity, status] of this.#bots) {
      this.#bots.set(identity, { ...status, lifecycle: "stopping", eventStreamReady: false, activeTurn: false, organizingContext: false, queueDepth: 0, contextOrganizationAvailable: false });
    }
    this.#update({ controlAvailable: false }, true);
  }

  snapshot(): FleetStatusSnapshot {
    return this.#snapshot;
  }

  #update(changes: Partial<FleetStatusSnapshot>, clearProblem = false): void {
    const next = { ...this.#snapshot, ...changes };
    if (clearProblem) delete next.problem;
    this.#snapshot = next;
    this.#publish();
  }

  #publish(): void {
    if (this.#closed) return;
    const now = Date.now();
    this.#snapshot = {
      ...this.#snapshot,
      updatedAt: new Date(now).toISOString(),
      validUntil: new Date(now + STATUS_VALIDITY_MILLISECONDS).toISOString(),
      accountChangeReady: this.#snapshot.controlAvailable
        && this.#order.every((identity) => this.#idle.get(identity) ?? true),
      bots: this.#order.flatMap((identity) => {
        const status = this.#bots.get(identity);
        return status ? [status] : [];
      }),
    };
    const directory = dirname(this.#path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporaryPath = `${this.#path}.${process.pid}.${this.#snapshot.runId}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.#snapshot)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.#path);
    chmodSync(this.#path, 0o600);
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => this.#publish(), STATUS_HEARTBEAT_MILLISECONDS);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }
}

function startingBotStatus(bot: { id: string; label: string; characterId: string; enabled: boolean }): BotStatus {
  return {
    botId: bot.id,
    label: bot.label,
    characterId: bot.characterId,
    enabled: bot.enabled,
    lifecycle: "starting",
    eventStreamReady: false,
    feishuGroups: null,
    feishu: emptyFeishuSnapshot(),
    connectorCatalog: null,
    botPolicy: { model: "", reasoningEffort: "medium" },
    activeTurn: false,
    organizingContext: false,
    queueDepth: 0,
    contextOrganizationAvailable: false,
  };
}

/**
 * One Bot's view of the deployment status. It holds no file and no timer: the
 * fleet projection it came from owns both, so a Bot cannot publish alone.
 */
export class BotStatusProjection {
  readonly #read: () => BotStatus;
  readonly #write: (next: BotStatus) => void;
  readonly #idle: (idle: boolean) => void;

  constructor(
    readonly botId: string,
    read: () => BotStatus,
    write: (next: BotStatus) => void,
    idle: (idle: boolean) => void,
  ) {
    this.#read = read;
    this.#write = write;
    this.#idle = idle;
  }

  /**
   * This Bot's admission answer for a shared account change. The Bot owns it;
   * the fleet only combines every Bot's answer into `accountChangeReady`.
   */
  idleChanged(idle: boolean): void {
    this.#idle(idle);
  }

  policy(policy: RuntimePolicy): void {
    this.#update({ botPolicy: { model: policy.model, reasoningEffort: policy.reasoningEffort } });
  }

  starting(): void {
    this.#update({
      lifecycle: "starting",
      eventStreamReady: false,
      activeTurn: false,
      organizingContext: false,
      queueDepth: 0,
      contextOrganizationAvailable: false,
    }, true, true);
  }

  groupsChanged(groups: readonly FeishuGroup[] | null): void {
    if (!isFeishuGroups(groups)) throw new Error("Invalid group inventory");
    this.#update({ feishuGroups: groups?.map((group) => ({ ...group })) ?? null });
  }

  feishuChanged(feishu: FeishuConnectionSnapshot): void {
    if (!isFeishuConnectionSnapshot(feishu)) throw new Error("Invalid Feishu connection snapshot");
    this.#update({ feishu: structuredClone(feishu) });
  }

  awaitingConnection(): void {
    this.#update({ lifecycle: "awaitingConnection", eventStreamReady: false }, true, true);
  }

  setup(stage: ProductSetupStage, problemCode?: ProductProblemCode): void {
    this.#update({
      lifecycle: "setup",
      eventStreamReady: false,
      activeTurn: false,
      organizingContext: false,
      queueDepth: 0,
      contextOrganizationAvailable: false,
      setup: { stage },
      ...(problemCode ? { problem: productProblem(problemCode) } : {}),
    }, !problemCode);
  }

  /** This Bot's connector catalog, already projected to a renderer-safe shape. */
  connectorCatalogChanged(catalog: ConnectorCatalogProjection | null): void {
    if (catalog !== null && !isConnectorCatalogProjection(catalog)) {
      throw new Error("Invalid connector catalog projection");
    }
    this.#update({ connectorCatalog: catalog === null ? null : structuredClone(catalog) });
  }

  paused(): void {
    this.#update({ lifecycle: "paused", enabled: false, eventStreamReady: false,
      activeTurn: false, organizingContext: false, queueDepth: 0, contextOrganizationAvailable: false }, true, true);
  }

  awaitingLogin(problemCode?: ProductProblemCode): void {
    this.#update({
      lifecycle: "awaitingLogin",
      eventStreamReady: false,
      activeTurn: false,
      organizingContext: false,
      queueDepth: 0,
      contextOrganizationAvailable: false,
      ...(problemCode ? { problem: productProblem(problemCode) } : {}),
    }, !problemCode, true);
  }

  blocked(problemCode: ProductProblemCode): void {
    this.#update({
      lifecycle: "blocked",
      eventStreamReady: false,
      activeTurn: false,
      organizingContext: false,
      queueDepth: 0,
      contextOrganizationAvailable: false,
      problem: productProblem(problemCode),
    }, false, true);
  }

  eventStreamReady(): void {
    this.#update({ lifecycle: "listening", eventStreamReady: true }, true, true);
  }

  eventStreamUnavailable(problemCode: ProductProblemCode = "event_stream_unavailable"): void {
    this.#update({ eventStreamReady: false, problem: productProblem(problemCode) });
  }

  runtimeStateChanged(state: BotRuntimeState): void {
    this.#update({ ...state });
  }

  contextUsageChanged(usage: { usedTokens: number; modelContextWindow: number }): void {
    this.#update({ contextUsedTokens: usage.usedTokens, contextWindowTokens: usage.modelContextWindow });
  }

  stopping(): void {
    this.#update({
      lifecycle: "stopping",
      eventStreamReady: false,
      activeTurn: false,
      organizingContext: false,
      queueDepth: 0,
      contextOrganizationAvailable: false,
    }, true, true);
  }

  failed(problemCode: ProductProblemCode = "bridge_startup_failed"): void {
    this.#update({
      lifecycle: "failed",
      eventStreamReady: false,
      activeTurn: false,
      organizingContext: false,
      queueDepth: 0,
      contextOrganizationAvailable: false,
      problem: productProblem(problemCode),
    }, false, true);
  }

  snapshot(): BotStatus {
    return this.#read();
  }

  #update(changes: Partial<BotStatus>, clearProblem = false, clearSetup = false): void {
    const next = { ...this.#read(), ...changes };
    if (clearProblem) delete next.problem;
    if (clearSetup) delete next.setup;
    this.#write(next);
  }
}

export type FleetStatusReadResult =
  | { kind: "current"; snapshot: FleetStatusSnapshot }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "wrong_process"; processId: number }
  | { kind: "expired"; validUntil: string };

export function readFleetStatusSnapshot(
  path: string,
  expectedProcessId?: number,
  now = new Date(),
): FleetStatusReadResult {
  let value: unknown;
  try {
    if (statSync(path).size > MAXIMUM_STATUS_BYTES) return { kind: "invalid", reason: "status exceeds size limit" };
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  const parsed = parseFleetStatusSnapshot(value);
  if (parsed.kind !== "current") return parsed;
  if (expectedProcessId !== undefined && parsed.snapshot.processId !== expectedProcessId) {
    return { kind: "wrong_process", processId: parsed.snapshot.processId };
  }
  const nowMilliseconds = now.getTime();
  const validUntilMilliseconds = Date.parse(parsed.snapshot.validUntil);
  if (validUntilMilliseconds > nowMilliseconds + MAXIMUM_STATUS_FUTURE_MILLISECONDS) {
    return { kind: "invalid", reason: "status validity deadline is implausibly far in the future" };
  }
  if (validUntilMilliseconds <= nowMilliseconds) {
    return { kind: "expired", validUntil: parsed.snapshot.validUntil };
  }
  return parsed;
}

function parseFleetStatusSnapshot(value: unknown): FleetStatusReadResult {
  if (!isRecord(value)) return { kind: "invalid", reason: "status root must be an object" };
  const requiredKeys = [
    "version", "productVersion", "bridgeVersion", "runId", "processId", "updatedAt", "validUntil",
    "controlProtocolVersion", "controlAvailable", "accountChangeReady", "runtimeAccount", "bots",
  ];
  const allowed = new Set([...requiredKeys, "problem"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { kind: "invalid", reason: "status contains unsupported fields" };
  }
  if (requiredKeys.some((key) => !(key in value))) {
    return { kind: "invalid", reason: "status is missing required fields" };
  }
  const datesValid = isIsoDate(value.updatedAt) && isIsoDate(value.validUntil)
    && Date.parse(value.validUntil) > Date.parse(value.updatedAt)
    && Date.parse(value.validUntil) - Date.parse(value.updatedAt) <= 20_000;
  const problem = value.problem === undefined ? undefined : parseProductProblem(value.problem);
  if (
    value.version !== STATUS_VERSION
    || typeof value.productVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.productVersion)
    || value.bridgeVersion !== BRIDGE_VERSION
    || value.controlProtocolVersion !== MOCHI_CONTROL_PROTOCOL_VERSION
    || typeof value.runId !== "string" || value.runId.length === 0
    || !isPositiveInteger(value.processId)
    || !datesValid
    || typeof value.controlAvailable !== "boolean"
    || typeof value.accountChangeReady !== "boolean"
    || (value.accountChangeReady && !value.controlAvailable)
    || (value.problem !== undefined && problem === undefined)
    || !Array.isArray(value.bots)
    || value.bots.length > MAXIMUM_BOTS
    || !isRuntimeAccountSnapshot(value.runtimeAccount)
    || !value.bots.every((bot) => isBotStatus(bot, value.runtimeAccount))
    || new Set(value.bots.map((bot) => (bot as BotStatus).botId)).size !== value.bots.length
  ) {
    return { kind: "invalid", reason: `status fields violate the version ${STATUS_VERSION} contract` };
  }
  return { kind: "current", snapshot: value as unknown as FleetStatusSnapshot };
}

function isBotStatus(value: unknown, runtimeAccount: unknown): value is BotStatus {
  if (!isRecord(value)) return false;
  const requiredKeys = [
    "characterId", "botId", "label", "enabled", "lifecycle", "eventStreamReady", "feishuGroups", "feishu",
    "connectorCatalog", "botPolicy", "activeTurn", "organizingContext", "queueDepth",
    "contextOrganizationAvailable",
  ];
  const allowed = new Set([...requiredKeys, "contextUsedTokens", "contextWindowTokens", "setup", "problem"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (requiredKeys.some((key) => !(key in value))) return false;
  const lifecycle = value.lifecycle;
  const validLifecycle = lifecycle === "paused" || lifecycle === "starting" || lifecycle === "setup" || lifecycle === "awaitingLogin"
    || lifecycle === "listening" || lifecycle === "blocked" || lifecycle === "awaitingConnection"
    || lifecycle === "stopping" || lifecycle === "failed";
  const contextUsageValid = (
    value.contextUsedTokens === undefined && value.contextWindowTokens === undefined
  ) || (
    isNonnegativeInteger(value.contextUsedTokens) && isPositiveInteger(value.contextWindowTokens)
  );
  const contextAvailabilityValid = value.contextOrganizationAvailable !== true || (
    value.activeTurn === false
    && value.organizingContext === false
    && value.queueDepth === 0
    && value.contextUsedTokens !== undefined
    && value.contextWindowTokens !== undefined
  );
  const setupValid = lifecycle === "setup"
    ? isProductSetupSnapshot(value.setup) && isSetupAccountPair(value.setup, runtimeAccount)
    : value.setup === undefined;
  const problem = value.problem === undefined ? undefined : parseProductProblem(value.problem);
  const problemValid = value.problem === undefined || problem !== undefined;
  const lifecycleProblemValid = lifecycle === "blocked" || lifecycle === "failed"
    ? problem !== undefined
    : lifecycle === "listening" && value.eventStreamReady === false
      ? problem !== undefined
      : lifecycle === "setup" || lifecycle === "awaitingLogin"
        ? problemValid
        : value.problem === undefined;
  const accountLifecycleValid = isRuntimeAccountSnapshot(runtimeAccount)
    && isAccountLifecyclePair(value as Pick<BotStatus, "lifecycle" | "setup">, runtimeAccount, false);
  return isBotId(value.botId)
    && typeof value.characterId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.characterId)
    && (value.connectorCatalog === null || isConnectorCatalogProjection(value.connectorCatalog))
    && isRuntimeAccountSnapshot(runtimeAccount)
    && typeof value.label === "string"
    && value.label.trim().length > 0
    && value.label.length <= MAXIMUM_LABEL_LENGTH
    && typeof value.enabled === "boolean"
    && (lifecycle !== "paused" || (value.enabled === false && value.activeTurn === false && value.organizingContext === false && value.queueDepth === 0))
    && validLifecycle
    && typeof value.eventStreamReady !== "undefined"
    && typeof value.eventStreamReady === "boolean"
    && (lifecycle === "listening" || value.eventStreamReady === false)
    && (value.feishuGroups === null || isFeishuGroups(value.feishuGroups))
    && isFeishuConnectionSnapshot(value.feishu)
    && isBotPolicy(value.botPolicy)
    && typeof value.activeTurn === "boolean"
    && typeof value.organizingContext === "boolean"
    && isNonnegativeInteger(value.queueDepth)
    && typeof value.contextOrganizationAvailable === "boolean"
    && contextUsageValid
    && contextAvailabilityValid
    && setupValid
    && problemValid
    && lifecycleProblemValid
    && accountLifecycleValid;
}

/**
 * Whether a Bot's published lifecycle agrees with the shared account. A pending
 * ChatGPT login only keeps the Bots that wait for it in `awaitingLogin`; Bots on
 * another connection keep listening.
 */
function isAccountLifecyclePair(
  bot: Pick<BotStatus, "lifecycle" | "setup">,
  account: RuntimeAccountSnapshot,
  includeSetup = true,
): boolean {
  if (bot.lifecycle === "listening" || bot.lifecycle === "awaitingConnection") return account.status === "signedIn";
  if (bot.lifecycle === "awaitingLogin") {
    return account.status === "signedOut" || account.status === "signingIn"
      || (account.status === "signedIn" && account.pendingLogin !== undefined);
  }
  if (includeSetup && bot.lifecycle === "setup") return isSetupAccountPair(bot.setup, account);
  return true;
}

function isProductSetupSnapshot(value: unknown): value is ProductSetupSnapshot {
  return isRecord(value)
    && Object.keys(value).length === 1
    && (value.stage === "checking" || value.stage === "signIn" || value.stage === "signingIn"
      || value.stage === "ready" || value.stage === "initializing");
}

function isSetupAccountPair(setup: unknown, account: unknown): boolean {
  if (!isRecord(setup) || !isRecord(account)) return false;
  if (setup.stage === "checking") return account.status === "unknown";
  if (setup.stage === "signIn") return account.status === "signedOut";
  if (setup.stage === "signingIn") return account.status === "signingIn";
  return (setup.stage === "ready" || setup.stage === "initializing")
    && account.status === "signedIn";
}

/** A starting Bot has not read its policy yet, so an empty model is the honest value. */
function isBotPolicy(value: unknown): value is RuntimePolicy {
  return isRecord(value)
    && Object.keys(value).sort().join(",") === "model,reasoningEffort"
    && typeof value.model === "string"
    && value.model.length <= 128
    && typeof value.reasoningEffort === "string"
    && isReasoningEffort(value.reasoningEffort);
}

function isRuntimeAccountSnapshot(value: unknown): value is RuntimeAccountSnapshot {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "unknown" || value.status === "signedOut" || value.status === "signingIn") {
    return Object.keys(value).length === 1;
  }
  const keys = Object.keys(value).sort().join(",");
  if (value.status !== "signedIn" || (keys !== "account,connections,status" && keys !== "account,connections,pendingLogin,status")) {
    return false;
  }
  if (value.pendingLogin !== undefined && value.pendingLogin !== OPENAI_CODEX_PROVIDER) return false;
  if (!Array.isArray(value.connections) || value.connections.length < 1 || value.connections.length > MODEL_API_MAX_CONNECTIONS + 1) return false;
  if (!value.connections.every(isRuntimeAccountSummary)) return false;
  return isRuntimeAccountSummary(value.account)
    && value.account.provider === value.connections[0]?.provider
    && new Set(value.connections.map((connection) => connection.provider)).size === value.connections.length
    // A pending login is for a connection that is not signed in yet.
    && !(value.pendingLogin !== undefined && value.connections.some((connection) => connection.provider === value.pendingLogin));
}

function isRuntimeAccountSummary(value: unknown): value is RuntimeAccountSummary {
  if (!isRecord(value)) return false;
  if (Object.keys(value).sort().join(",") === "authType,provider,subscription"
    && value.provider === "openai-codex" && value.authType === "oauth" && value.subscription === true) return true;
  return isByokAccountSummary(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONNECTOR_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONNECTOR_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CONNECTOR_SELECTION_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Bounded, control-character-free display text. */
function isConnectorText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum
    && !/\p{Cc}/u.test(value);
}

function isConnectorScope(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 160
    && /^[a-z][a-z0-9_.:]*$/.test(value);
}

function isConnectorResourceProjection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).sort().join(",")
    !== "displayName,ownerId,resourceId,resourceType,selected,selectionId,visibility,writable") {
    return false;
  }
  // Only a selected resource carries authority; an option must carry null.
  return typeof value.resourceId === "string" && CONNECTOR_IDENTIFIER_PATTERN.test(value.resourceId)
    && typeof value.resourceType === "string" && CONNECTOR_IDENTIFIER_PATTERN.test(value.resourceType)
    && isConnectorText(value.displayName, 256)
    && typeof value.selected === "boolean"
    && (value.selected ? typeof value.selectionId === "string" && CONNECTOR_SELECTION_ID_PATTERN.test(value.selectionId) : value.selectionId === null)
    && (value.ownerId === null || isConnectorText(value.ownerId, 128))
    && (value.visibility === null || value.visibility === "public" || value.visibility === "private")
    && (value.writable === null || typeof value.writable === "boolean");
}

function isConnectorResourceScopeProjection(value: unknown): value is {
  status: "ready" | "checking" | "unavailable";
  selectedCount: number;
  problem?: string;
} {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  return (keys === "selectedCount,status" || keys === "problem,selectedCount,status")
    && (value.status === "ready" || value.status === "checking" || value.status === "unavailable")
    && isNonnegativeInteger(value.selectedCount) && value.selectedCount <= 1_000
    && (value.status === "ready"
      ? value.problem === undefined
      : isConnectorText(value.problem, CONNECTOR_MAX_PROBLEM_LENGTH));
}

function isConnectorCapabilityProjection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).sort().join(",") === "availability,description,displayName,id,operation,resourceSelection"
    && isConnectorText(value.id, 128)
    && isConnectorText(value.displayName, 120)
    && isConnectorText(value.description, 2_000)
    && (value.operation === "read" || value.operation === "write")
    && (value.resourceSelection === "required" || value.resourceSelection === "optional")
    && isConnectorCapabilityAvailability(value.availability);
}

function isConnectorConnectionProjection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).sort().join(",")
      === "accountDisplayName,capabilities,connectionId,grantedScopes,problem,providerDisplayName,providerId,resourceScope,resources,status"
    && typeof value.connectionId === "string" && CONNECTOR_IDENTIFIER_PATTERN.test(value.connectionId)
    && typeof value.providerId === "string" && CONNECTOR_IDENTIFIER_PATTERN.test(value.providerId)
    && isConnectorText(value.providerDisplayName, 120)
    && (value.status === "ready" || value.status === "authorizing"
      || value.status === "reauthorization_required" || value.status === "unavailable")
    && (value.accountDisplayName === null || isConnectorText(value.accountDisplayName, 120))
    && (value.problem === null || isConnectorText(value.problem, CONNECTOR_MAX_PROBLEM_LENGTH))
    && (value.status === "ready" || value.status === "authorizing"
      ? value.problem === null
      : isConnectorText(value.problem, CONNECTOR_MAX_PROBLEM_LENGTH))
    && Array.isArray(value.grantedScopes) && value.grantedScopes.length <= 256 && value.grantedScopes.every(isConnectorScope)
    && Array.isArray(value.resources) && value.resources.length <= 1_000
    && value.resources.every(isConnectorResourceProjection)
    && isConnectorResourceScopeProjection(value.resourceScope)
    && value.resourceScope.selectedCount === value.resources.filter((resource) => resource.selected).length
    && Array.isArray(value.capabilities) && value.capabilities.length <= 256
    && value.capabilities.every(isConnectorCapabilityProjection);
}

function isConnectorCatalogProjection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).sort().join(",") === "connections,revision"
    && typeof value.revision === "string" && CONNECTOR_REVISION_PATTERN.test(value.revision)
    && Array.isArray(value.connections) && value.connections.length <= 256
    && value.connections.every(isConnectorConnectionProjection);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonnegativeInteger(value) && value > 0;
}
