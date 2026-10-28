import { MATERIAL_PREPARATION_TIMEOUT_MILLISECONDS } from "./lark/messageHydrator.ts";
import {
  AgentToolExecutor,
  AGENT_TOOLS,
  AGENT_TOOL_CAPABILITY_ABI,
} from "./agent/tools.ts";
import { resetMaterialStaging } from "./attachments/artifacts.ts";
import { InstructionStore } from "./agent/instructionStore.ts";
import type { InstructionDocument } from "./agent/instructionDocument.ts";
import { PiRuntimeClient, RuntimeTurnTimedOutError } from "./runtime/client.ts";
import { RuntimeRequestError } from "./runtime/transport.ts";
import { OPENAI_CODEX_PROVIDER, type RuntimeModelOption } from "./runtime/protocol.ts";
import { parseModelReference } from "./runtime/byok.ts";
import { runtimeSystemPrompt } from "./runtime/instructions.ts";
import { RuntimeSessionAgent, type RuntimeAgentResponse } from "./runtime/sessionAgent.ts";
import { saveBotPolicy, type BotContext, type RuntimeConfig } from "./config.ts";
import { isReasoningEffort, type RuntimePolicy } from "./runtime/policy.ts";
import { ControlRejection } from "./control/controlServer.ts";
import type { BotStatusProjection, RuntimeAccountSnapshot } from "./control/statusSnapshot.ts";
import { threadKeyFor, threadKeysFor, type LarkMessageEvent, type MessageContext } from "./domain.ts";
import { decideEvent, parseMessageEvent, type EventDecision } from "./eventPolicy.ts";
import type { GitHubConnection } from "./github/connection.ts";
import { GitHubClient } from "./github/client.ts";
import { GitHubProjectSelection } from "./github/botSelection.ts";
import { GitHubConnector } from "./connectors/github/adapter.ts";
import { GITHUB_PROVIDER_ID } from "./connectors/github/manifest.ts";
import { ConnectorBroker } from "./connectors/broker.ts";
import { ConnectorRegistry } from "./connectors/registry.ts";
import { FeishuServiceConnector } from "./connectors/feishu-service/adapter.ts";
import { createFeishuServiceReader } from "./connectors/feishu-service/reader.ts";
import { FeishuMailConnector } from "./connectors/feishu-mail/adapter.ts";
import {
  FeishuMailAuthorization,
  FeishuMailAuthorizationError,
} from "./connectors/feishu-mail/authorization.ts";
import { createFeishuMailReader } from "./connectors/feishu-mail/reader.ts";
import { projectConnectorCatalog } from "./control/connectorSnapshot.ts";
import { IssueWorkflow, type WorkflowOutcome } from "./issueWorkflow.ts";
import { MessageFeedback, type ReplyFeedback } from "./lark/messageFeedback.ts";
import type { FeishuConnection, FeishuConnectorBinding } from "./lark/connection.ts";
import { FeishuWorkplace } from "./lark/workplace.ts";
import {
  type FeishuTopicEvidence,
  FeishuEvidenceRejectedError,
  unavailableTopicEvidence,
} from "./lark/messageEvidence.ts";
import { errorFields, log } from "./log.ts";
import { ProcessLock } from "./processLock.ts";
import { BotRuntime } from "./botRuntime.ts";
import { activateVerifiedRuntimeSetup } from "./runtime/setupTransaction.ts";
import { StateStore } from "./state.ts";
import { ScheduleConnector, SCHEDULE_PROVIDER } from "./schedules/connector.ts";
import { ScheduleDispatcher, ScheduleExecutionError, type ScheduleOccurrence, type ScheduleResult } from "./schedules/dispatcher.ts";
import { scheduleResourcesStillSelected } from "./schedules/authority.ts";
import { projectSchedule, type ScheduleView } from "./schedules/view.ts";
import { scheduleDeliveryText } from "./schedules/prompt.ts";
import type { ScheduleProblem, ScheduleRecord } from "./schedules/store.ts";

export interface BotAppOptions {
  bot: BotContext;
  github: GitHubConnection;
  feishu: FeishuConnection;
  status: BotStatusProjection;
  enabled: boolean;
  lock: ProcessLock;
  account: { snapshot(): RuntimeAccountSnapshot };
  /** Host-wide update admission, independent of the persisted duty switch. */
  acceptingWork?: () => boolean;
  /** Bounded automatic recovery after a worker or event-stream failure. */
  recovery?: RecoveryTiming;
}

export interface RecoveryTiming {
  /** One delay per automatic attempt; their count bounds the attempts. */
  delaysMilliseconds: readonly number[];
  /** How long a recovered Bot must stay healthy before its attempts are forgiven. */
  stableMilliseconds: number;
}

const DEFAULT_RECOVERY_TIMING: RecoveryTiming = {
  delaysMilliseconds: [5_000, 30_000, 120_000],
  stableMilliseconds: 300_000,
};

/** A complete Bot: connections, permanent memory, admission and lifecycle. */
export class BotApp {
  readonly #state: StateStore;
  #workplace: FeishuWorkplace | undefined;
  readonly #feishu: FeishuConnection;
  readonly #unsubscribeFeishu: () => void;
  readonly #github: GitHubConnection;
  readonly #botGithub: GitHubProjectSelection;
  readonly #connectorBroker: ConnectorBroker;
  readonly #feishuService: FeishuServiceConnector;
  readonly #feishuMail: FeishuMailConnector;
  readonly #client: PiRuntimeClient;
  readonly #agent: RuntimeSessionAgent;
  readonly #schedules: ScheduleDispatcher;
  #scheduleActive = false;
  #scheduleClockFailed = false;
  #pendingHumanAdmissions = 0;
  #receivingEvents = 0;
  #accountOperations = 0;
  readonly #acceptingWork: () => boolean;
  readonly #status: BotStatusProjection;
  readonly #account: BotAppOptions["account"];
  get #accountSnapshot(): RuntimeAccountSnapshot { return this.#account.snapshot(); }
  #enabled: boolean;
  readonly #unsubscribeGithub: () => void;
  readonly #bot: BotContext;
  readonly #instructions: InstructionStore;
  #agentAdmission: Promise<void> = Promise.resolve();
  #accountAdmission: Promise<void> = Promise.resolve();
  /** The running event stream; its callbacks act only while it is still this one. */
  #consumePromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stateLock: ProcessLock | undefined;
  /** The one owner of where this Bot's runtime is; see `BotRuntimeState`. */
  readonly #runtime: BotRuntime;
  /** Why the Bot stopped on its own, reported by `start()`. */
  #stopFailure: Error | undefined;
  #connectionChanging = false;
  /** Accepted messages being answered; each settles to completed or failed. */
  readonly #acceptedWork = new Set<Promise<void>>();
  #lastIdle = true;
  /** Bounded automatic recovery of this one Bot after a worker or event-stream failure. */
  #recoveryAttempts = 0;
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  #recoveryStableTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #recoveryTiming: RecoveryTiming;
  /** The active App binding the connectors last proved against. */
  #feishuBindingKey: string | undefined;
  #recheckTimer: ReturnType<typeof setInterval> | undefined;
  #rechecking: Promise<void> | undefined;
  #lastRecheckAt = 0;
  readonly #lifetime: Promise<void>;
  readonly #finishLifetime: () => void;

  constructor(options: BotAppOptions) {
    const { bot, status } = options;
    this.#bot = bot;
    this.#runtime = new BotRuntime(bot.botId);
    this.#status = status;
    this.#enabled = options.enabled;
    this.#acceptingWork = options.acceptingWork ?? (() => true);
    this.#recoveryTiming = options.recovery ?? DEFAULT_RECOVERY_TIMING;
    this.#account = options.account;
    this.#stateLock = options.lock;
    void options.lock.lost.then(() => this.#stateLockLost());
    this.#instructions = new InstructionStore(bot.agent.instructionsPath);
    resetMaterialStaging(bot.layout.materialStagingRoot);
    this.#state = new StateStore(bot.layout.stateDatabasePath);
    this.#status.policy(bot.runtime);
    this.#github = options.github;
    this.#feishu = options.feishu;
    this.#botGithub = new GitHubProjectSelection(this.#github, this.#state);
    this.#unsubscribeFeishu = this.#feishu.subscribe((snapshot) => {
      this.#status.feishuChanged(snapshot);
      // A replaced, lost or recovered App cannot keep what was proved against the
      // previous binding. Registering or checking a replacement candidate leaves
      // the active binding untouched, and nothing re-proves after those steps, so
      // they must not invalidate it.
      const bindingKey = feishuBindingKey(this.#feishu.connectorBinding());
      if (bindingKey !== this.#feishuBindingKey) {
        this.#feishuBindingKey = bindingKey;
        this.#feishuService?.invalidateResourceProof();
        this.#feishuMail?.invalidateProof();
      }
      // The catalog is republished from the current binding either way.
      void this.#publishConnectorCatalog().catch((error) => {
        log.warn("connectors.catalog.refresh_failed", { botId: bot.botId, ...errorFields(error) });
      });
    });
    this.#unsubscribeGithub = this.#github.subscribe((snapshot) => {
      void this.#publishConnectorCatalog().catch((error) => {
        log.warn("connectors.catalog.refresh_failed", { botId: bot.botId, ...errorFields(error) });
      });
      if (snapshot.status === "disconnected" || (snapshot.status === "unavailable" && snapshot.account === null)) this.clearProjects();
      if (snapshot.status === "connected") void this.reconcileProjects().catch((error) => {
        log.warn("bot.projects.refresh_failed", { botId: bot.botId, ...errorFields(error) });
      });
    });
    const issues = new IssueWorkflow(this.#state, async (scope) =>
      new GitHubClient(await this.#github.repositoryAccess(scope)));
    // One registry per Bot: a connector catalog is this Bot's own facts, proven
    // against this Bot's connections, and never shared across the fleet.
    const connectors = new ConnectorRegistry();
    this.#feishuService = new FeishuServiceConnector(
      () => {
        const binding = this.#feishu.connectorBinding();
        return binding
          ? {
              cliPath: binding.cliPath,
              configDirectory: binding.configDirectory,
              targetAppId: binding.targetAppId,
              grantedScopes: binding.grantedScopes,
              displayName: binding.displayName,
              status: binding.status,
              problem: binding.problem,
            }
          : undefined;
      },
      this.#state,
      createFeishuServiceReader,
    );
    this.#feishuMail = new FeishuMailConnector(
      () => {
        const binding = this.#feishu.connectorBinding();
        return binding
          ? {
              cliPath: binding.cliPath,
              profile: binding.profile,
              brand: binding.brand,
              configDirectory: binding.configDirectory,
              targetAppId: binding.targetAppId,
              status: binding.status,
              problem: binding.problem,
            }
          : undefined;
      },
      this.#state,
      createFeishuMailReader,
      {
        flow: new FeishuMailAuthorization(),
        // The user answers in Feishu at any time; the connector has already
        // re-proved the grant, so publishing is all that is left here.
        settled: (outcome, proved) => {
          log.info("feishu.mail.authorization_settled", { botId: bot.botId, outcome, proved });
          void this.#publishConnectorCatalog().catch((error) => {
            log.warn("connectors.catalog.refresh_failed", { botId: bot.botId, ...errorFields(error) });
          });
        },
      },
    );
    connectors.register(this.#feishuService);
    connectors.register(this.#feishuMail);
    connectors.register(new GitHubConnector(
      {
        snapshot: () => this.#github.snapshot(),
        selection: this.#botGithub,
        catalogSnapshot: () => this.#botGithub.catalogSnapshot(),
      },
      issues,
    ));
    this.#connectorBroker = new ConnectorBroker(connectors, this.#state);
    connectors.register(new ScheduleConnector(bot.botId, this.#state.schedules, this.#state,
      () => this.#connectorBroker.catalog(bot.botId), () => this.#workplace?.binding.targetAppId));
    const tools = new AgentToolExecutor(this.#connectorBroker, bot.botId, this.#state);
    let finishLifetime!: () => void;
    this.#lifetime = new Promise<void>((resolve) => { finishLifetime = resolve; });
    this.#finishLifetime = finishLifetime;
    this.#client = new PiRuntimeClient({
      config: this.#runtimeConfig(),
      tools: AGENT_TOOLS,
      capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      systemPrompt: () => runtimeSystemPrompt(this.#instructions.read().content),
      client: { accountObserver: {
        accountUpdated: () => {},
        runtimeUnavailable: () => this.#runtimeFailed("runtime_session_unavailable"),
        loginCompleted: () => {},
      } },
    });
    this.#agent = new RuntimeSessionAgent({
      config: this.#runtimeConfig(),
      capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      state: this.#state,
      tools,
      observer: {
        runtimeStateChanged: (state) => this.#status.runtimeStateChanged(state),
        contextUsageChanged: (usage) => this.#status.contextUsageChanged(usage),
        idleChanged: () => this.#publishIdle(),
      },
      client: this.#client,
    });
    this.#schedules = new ScheduleDispatcher({ store: this.#state.schedules,
      canStart: () => this.#canStartSchedule(), execute: (occurrence) => this.#executeSchedule(occurrence),
      executionFailed: (occurrence, error) => log.error("schedule.execution.failed", { botId: bot.botId,
        scheduleId: occurrence.schedule.id, dueAt: occurrence.dueAt,
        problem: error instanceof ScheduleExecutionError ? error.problem : "execution_failed" }),
      failed: () => { this.#scheduleClockFailed = true; log.error("schedule.clock.failed", { botId: bot.botId }); },
    });
  }

  async start(): Promise<void> {
    await this.#serializeAccount(() => this.#start());
    await this.#lifetime;
    if (this.#stopFailure) throw this.#stopFailure;
  }

  /**
   * Offline maintenance takes the same lock, so a Bot that lost it must stop
   * before maintenance can run beside it.
   */
  #stateLockLost(): void {
    if (this.#runtime.stopping) return;
    this.#stopFailure = new Error("The Bot state lock was lost while the Bot was running");
    log.error("bot.lock_lost", { botId: this.#bot.botId });
    void this.stop();
  }

  async #start(): Promise<void> {
    this.#status.starting();
    log.info("bot.starting", {
      botId: this.#bot.botId,
      feishuAccess: "customer_verified_bot_connection",
      groupAdmission: "joined_groups_unless_disabled",
      githubAccess: "this_bot_selected_verified_repository_ids",
      runtime: "pi-sdk",
      runtimeSessionId: this.#bot.runtime.sessionId,
      runtimeModel: this.#bot.runtime.model,
      runtimeReasoningEffort: this.#bot.runtime.reasoningEffort,
      runtimeCapabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      agentInstructionsPath: this.#bot.agent.instructionsPath,
    });
    // The Bot's own state lock is held for as long as the Bot runs. Offline
    // maintenance takes the same lock, so a Session migration or state upgrade
    // cannot run beside a live Bot, and neither can silently skip it.
    if (this.#runtime.stopping) return;
    const interruptedSchedules = this.#schedules.start();
    if (interruptedSchedules > 0) log.warn("schedule.interrupted.recovered", { botId: this.#bot.botId, count: interruptedSchedules });
    const interruptedMessageIds = this.#state.recoverInterruptedEvents();
    if (interruptedMessageIds.length > 0) {
      log.error("bot.events.interrupted_recovered", {
        botId: this.#bot.botId,
        interruptedCount: interruptedMessageIds.length,
        messageIds: interruptedMessageIds,
      });
    }
    await this.#github.restore();
    await this.#feishu.refresh();
    if (this.#runtime.stopping) return;
    await this.#reconcileFeishuResources();
    if (this.#runtime.stopping) return;
    await this.#adoptFeishuWorkplace();
    if (this.#runtime.stopping) return;
    this.#answerInterrupted(interruptedMessageIds);
    await this.reconcileProjects().catch((error) => {
      // A Bot with no GitHub grant has no catalog to publish. That is a
      // missing authorization the customer can add later, not a reason to refuse
      // to listen to Feishu, so the Bot starts with `githubProjects: null`.
      log.warn("bot.projects.unavailable_at_start", { botId: this.#bot.botId, ...errorFields(error) });
    });
    if (this.#runtime.stopping) return;
    await this.#reconcileAccount(this.#accountSnapshot);
    if (this.#runtime.stopping) return;
    // Started last, so the first recheck never races the proofs made above. A
    // connection that failed to prove itself here recovers on its own from now on.
    this.#recheckTimer = setInterval(() => void this.#recheck(), RECHECK_INTERVAL_MILLISECONDS);
    log.info("bot.started", {
      botId: this.#bot.botId,
      runtime: this.#runtime.state,
      accountStatus: this.#accountSnapshot.status,
    });
  }

  /**
   * A restart cannot prove what an interrupted message already did, so it is
   * never replayed; its topic is told once that it was not finished. Its
   * progress reaction stays, because the reaction's ID lived only in the lost
   * process. A notice that cannot be delivered is logged and does not stop the Bot.
   */
  #answerInterrupted(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const workplace = this.#workplace;
    if (!workplace) {
      log.error("bot.events.interrupted_unanswered", { botId: this.#bot.botId, messageIds, reason: "feishu_unavailable" });
      return;
    }
    const work = (async () => {
      for (const messageId of messageIds) {
        try {
          await workplace.messenger.replyInThread(messageId, INTERRUPTED_REPLY);
          log.info("bot.events.interrupted_answered", { botId: this.#bot.botId, messageId });
        } catch (error) {
          log.error("bot.events.interrupted_reply_failed", { botId: this.#bot.botId, messageId, ...errorFields(error) });
        }
      }
    })();
    // Delivery is accepted work: stopping and updates wait for it like any reply.
    this.#acceptedWork.add(work);
    this.#publishIdle();
    void work.finally(() => { this.#acceptedWork.delete(work); this.#publishIdle(); });
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#runtime.move("stopping", "stop");
    this.#cancelRecovery();
    this.#schedules.stopClock();
    clearInterval(this.#recheckTimer);
    this.#unsubscribeGithub();
    this.#unsubscribeFeishu();
    this.#workplace?.stop();
    this.#status.stopping();
    this.#stopPromise = (async () => {
      try {
        await this.#accountAdmission;
        await this.#agentAdmission;
        this.#github.close();
        await this.#agent.close();
        await this.#schedules.close();
        await this.#consumePromise?.catch(() => undefined);
        // Every accepted message has settled to completed or failed before SQLite closes.
        await Promise.allSettled(this.#acceptedWork);
      } finally {
        await this.#feishuMail.close();
        await this.#feishu.close();
        this.#state.close();
        await this.#stateLock?.release();
        this.#stateLock = undefined;
        this.#finishLifetime();
      }
    })();
    return this.#stopPromise;
  }

  fail(): void {
    this.#status.failed();
  }

  /** Only an explicit duty start may promote the durable first Session candidate. */
  async #initializeRuntime(): Promise<void> {
    this.#status.setup("initializing");
    try {
      const session = await activateVerifiedRuntimeSetup({
        state: this.#state,
        bootstrapClient: {
          bootstrapSession: () => this.#client.bootstrapSession(),
          resumeSession: () => this.#client.resumeSession(),
          close: () => this.#client.disconnect(),
        },
        createVerifier: () => this.#createClient(),
      });
      log.info("setup.runtime_initialized", {
        botId: this.#bot.botId,
        sessionId: session.sessionId,
        capabilityAbi: session.capabilityAbi,
      });
      this.#bot.runtime.sessionId = session.sessionId;
    } catch (error) {
      log.error("setup.runtime_initialization_failed", {
        botId: this.#bot.botId,
        ...errorFields(error),
      });
      await this.#client.disconnect().catch((closeError) => {
        log.warn("setup.runtime_cleanup_failed", errorFields(closeError));
      });
      const problemCode = this.#accountSnapshot.status === "signedIn" ? runtimeProblem(error, "setup_failed") : "account_status_unavailable";
      if (!this.#runtime.stopping) {
        // The prepared candidate is durable in SQLite, so the customer can retry
        // the same Session instead of starting over from an unknown identity.
        if (problemCode === "setup_failed") this.#status.setup("ready", problemCode);
        else this.#status.blocked(problemCode);
      }
      throw new ControlRejection(problemCode);
    }
  }

  organizeContext(): Promise<void> {
    return this.#changeConnection(async () => {
      if (this.#accountSnapshot.status !== "signedIn") throw new ControlRejection("account_required");
      await this.#agent.organizeContext();
    });
  }

  async updateGroupParticipation(chatId: string, enabled: boolean): Promise<void> {
    if (!this.#workplace) throw new ControlRejection("group_inventory_unavailable");
    this.#workplace.groups.setEnabled(chatId, enabled);
  }

  modelCatalog(): Promise<readonly RuntimeModelOption[]> {
    return this.#serializeAccount(async () => {
      if (this.#accountSnapshot.status !== "signedIn") throw new ControlRejection("account_required");
      return this.#client.listModels();
    });
  }

  /** Whether this Bot's model policy runs on the given shared model connection. */
  usesConnection(provider: string): boolean { return this.#provider() === provider; }

  /** The host acquires this Bot's admission before changing the connection it uses. */
  withAccountChange<T>(operation: () => Promise<T>): Promise<T> { return this.#changeConnection(operation); }
  async pauseForAccountChange(): Promise<void> {
    if (this.#runtime.serving) this.#status.starting();
    await this.#pauseRuntime("account_change");
  }
  reconcileAccount(): Promise<void> { return this.#reconcileAccount(this.#accountSnapshot); }

  /**
   * A shared account change outside this Bot's gate. Only a change to this Bot's
   * own connection, or to whether any connection is signed in, moves this Bot.
   */
  async accountChanged(previous: RuntimeAccountSnapshot): Promise<void> {
    const next = this.#accountSnapshot;
    if (previous.status === next.status && this.#connectionState(previous) === this.#connectionState(next)) return;
    await this.#serializeAccount(() => this.#reconcileAccount(this.#accountSnapshot)).catch((error) => {
      log.error("runtime.account.reconcile_failed", { botId: this.#bot.botId, ...errorFields(error) });
    });
  }

  /** Admission stops at once; the worker stays, because accepted work still needs it. */
  accountUnavailable(): void {
    this.#cancelRecovery();
    if (this.#runtime.stopping) return;
    this.#runtime.move("standby", "account_unavailable");
    this.#workplace?.consumer.stop();
  }

  #provider(): string { return parseModelReference(this.#bot.runtime.model).provider; }

  /** Where this Bot's own model connection stands in the shared account. */
  #connectionState(account: RuntimeAccountSnapshot = this.#accountSnapshot): "ready" | "missing" | "signingIn" | "signedOut" | "unknown" {
    const provider = this.#provider();
    switch (account.status) {
      case "unknown": return "unknown";
      case "signedOut": return "signedOut";
      case "signingIn": return provider === OPENAI_CODEX_PROVIDER ? "signingIn" : "signedOut";
      case "signedIn":
        return account.connections.some((connection) => connection.provider === provider) ? "ready"
          : account.pendingLogin === provider ? "signingIn" : "missing";
    }
  }

  /** A pause applies only when this Bot is idle; accepted work is never cancelled. */
  setEnabled(enabled: boolean, persist: () => void): Promise<void> {
    return this.#changeConnection(async () => {
      if (enabled === this.#enabled && (!enabled || this.#runtime.serving)) return;
      if (this.#accountSnapshot.status === "signingIn" || this.#connectionState() === "signingIn") {
        throw new ControlRejection("login_must_complete");
      }
      if (enabled) {
        if (this.#accountSnapshot.status !== "signedIn") throw new ControlRejection("account_required");
        if (!this.#state.runtimeSession()) await this.#initializeRuntime();
        this.#status.starting();
        try {
          await this.#agent.revalidatePermanentSession();
        } catch (error) {
          log.error("runtime.activation_failed", { botId: this.#bot.botId, ...errorFields(error) });
          const problemCode = runtimeProblem(error);
          this.#status.blocked(problemCode);
          throw new ControlRejection(problemCode);
        }
        if (this.#runtime.stopping) throw new ControlRejection("bot_not_running");
        if (this.#accountSnapshot.status !== "signedIn") {
          await this.#client.disconnect();
          this.#status.blocked("account_status_unavailable");
          throw new ControlRejection("account_status_unavailable");
        }
        try { persist(); }
        catch (error) {
          log.error("bot.duty_persistence_failed", { botId: this.#bot.botId, ...errorFields(error) });
          await this.#client.disconnect();
          this.#status.blocked("bot_activation_failed");
          throw new ControlRejection("bot_activation_failed");
        }
        this.#enabled = true;
        await this.#activateRuntime();
      } else {
        await this.#pauseRuntime("paused");
        persist();
        this.#enabled = false;
        await this.#reconcileAccount(this.#accountSnapshot);
      }
    });
  }

  readInstructions(): InstructionDocument { return this.#instructions.read(); }
  saveInstructions(document: InstructionDocument): InstructionDocument { return this.#instructions.save(document); }
  async readSchedules(): Promise<ScheduleView[]> {
    if (this.#scheduleClockFailed) throw new ControlRejection("schedules_unavailable");
    const catalog = await this.#connectorBroker.catalog(this.#bot.botId);
    const groups = this.#workplace?.groups.snapshot();
    return this.#state.schedules.list().map((schedule) => {
      const sameApp = schedule.appId === this.#workplace?.binding.targetAppId;
      const group = sameApp ? groups?.find((item) => item.id === schedule.chatId) : undefined;
      const problem = !sameApp ? "channel_changed" : !group?.enabled ? "group_unavailable"
        : !scheduleResourcesStillSelected(this.#bot.botId, schedule.resources, catalog, this.#state) ? "resources_changed" : null;
      return projectSchedule(schedule, group?.name ?? null, problem);
    });
  }
  setScheduleEnabled(id: string, revision: number, enabled: boolean): void {
    this.#state.schedules.setEnabled(id, revision, enabled, Date.now());
  }
  cancelSchedule(id: string, revision: number): void { this.#state.schedules.cancel(id, revision); }

  updateModelPolicy(policy: { model: string; reasoningEffort: string }): Promise<void> {
    return this.#changeConnection(async () => {
      if (this.#accountSnapshot.status !== "signedIn") throw new Error("请先连接模型，再修改模型。");
      if (!isReasoningEffort(policy.reasoningEffort)) {
        throw new Error("这个思考深度不受 Mochi 支持。");
      }
      const catalog = await this.#supportedModelCatalog();
      const selectedModel = catalog.find((model) => model.id === policy.model);
      if (!selectedModel) throw new Error("这个模型当前不可用，请刷新后再试。");
      if (!selectedModel.supportedEfforts.some((effort) => effort.id === policy.reasoningEffort)) {
        throw new Error("这个模型不支持所选的思考深度。");
      }
      const next: RuntimePolicy = {
        model: selectedModel.id,
        reasoningEffort: policy.reasoningEffort,
      };
      const previous = {
        model: this.#bot.runtime.model,
        reasoningEffort: this.#bot.runtime.reasoningEffort,
      };
      if (previous.model === next.model && previous.reasoningEffort === next.reasoningEffort) return;

      try {
        await this.#client.updateTurnPolicy(next, () => saveBotPolicy(this.#bot.layout, next));
      } catch (error) {
        await this.#pauseRuntime("model_policy_failed");
        await this.#reconcileAccount(this.#accountSnapshot);
        throw error;
      }
      this.#bot.runtime.model = next.model;
      this.#bot.runtime.reasoningEffort = next.reasoningEffort;
      this.#status.policy(next);
      log.info("runtime.policy.updated", {
        botId: this.#bot.botId,
        previousModel: previous.model,
        previousReasoningEffort: previous.reasoningEffort,
        model: next.model,
        reasoningEffort: next.reasoningEffort,
        appliesTo: "future_turns",
      });
      if (this.#enabled && this.#state.runtimeSession() && !this.#runtime.serving) {
        await this.#activateRuntime(true).catch((error) => {
          log.error("runtime.policy.reactivation_failed", { botId: this.#bot.botId, ...errorFields(error) });
          const problemCode = runtimeProblem(error);
          this.#status.blocked(problemCode);
          throw new ControlRejection(problemCode);
        });
      } else if (!this.#enabled) {
        await this.#reconcileAccount(this.#accountSnapshot);
      }
    });
  }

  async #supportedModelCatalog(): Promise<readonly RuntimeModelOption[]> {
    const models = (await this.#client.listModels()).flatMap((model): RuntimeModelOption[] => {
      const supportedEfforts = model.supportedEfforts.filter((effort) => isReasoningEffort(effort.id));
      if (supportedEfforts.length === 0) return [];
      const defaultEffort = supportedEfforts.some((effort) => effort.id === model.defaultEffort)
        ? model.defaultEffort
        : supportedEfforts[0]!.id;
      return [{ ...model, supportedEfforts, defaultEffort }];
    });
    if (models.length === 0) throw new Error("当前连接没有返回 Mochi 可用的模型。");
    return models;
  }

  /**
   * Re-proves this Bot's project catalog and publishes it.
   *
   * Reauthentication invalidates this Bot’s selection; other Bots keep their grants.
   */
  async reconcileProjects(): Promise<void> {
    if (this.#runtime.stopping) return;
    await this.#botGithub.discover();
    await this.#publishConnectorCatalog();
  }

  /**
   * Called when the grant is gone: this Bot's catalog is invalid, and its stored
   * selection has nothing left to authorize. Both are dropped together so the
   * published catalog can never outlive the authority that proved it.
   */
  clearProjects(): void {
    this.#botGithub.clear();
    void this.#publishConnectorCatalog().catch((error) => {
      log.warn("connectors.catalog.refresh_failed", { botId: this.#bot.botId, ...errorFields(error) });
    });
  }

  selectProjects(repositoryIds: readonly number[]): Promise<void> {
    return this.#changeConnection(async () => {
      await this.#botGithub.select(repositoryIds);
      await this.#botGithub.discover();
      await this.#publishConnectorCatalog();
    });
  }

  /**
   * Adds verified references to this Bot's Feishu service resources.
   *
   * Every URL is resolved and read before it is stored, so a document the Bot
   * cannot open is refused here rather than becoming a selection that fails at
   * use. Runs behind the same admission gate as a project change.
   */
  addConnectorResources(connectionId: string, references: readonly string[]): Promise<void> {
    return this.#changeConnection(async () => {
      if (connectionId.startsWith("feishu-mail:")) {
        if (this.#feishuMail.connectionId() !== connectionId) {
          throw new ControlRejection("feishu_mail_selection_failed");
        }
        await this.#feishuMail.addMailboxes(references);
      } else {
        if (connectionId !== this.#feishuConnectionId()) {
          throw new ControlRejection("connector_selection_failed");
        }
        await this.#feishuService.add(references);
      }
      await this.#publishConnectorCatalog();
    });
  }

  removeConnectorResource(connectionId: string, resourceId: string, selectionId: string): Promise<void> {
    return this.#changeConnection(async () => {
      if (connectionId.startsWith("feishu-mail:")) {
        if (this.#feishuMail.connectionId() !== connectionId) {
          throw new ControlRejection("feishu_mail_selection_failed");
        }
        await this.#feishuMail.remove(resourceId, selectionId);
      } else {
        if (connectionId !== this.#feishuConnectionId()) throw new ControlRejection("connector_selection_failed");
        this.#feishuService.remove(resourceId, selectionId);
      }
      await this.#publishConnectorCatalog();
    });
  }

  /** Publishes this Bot's connector catalog, projected to a renderer-safe shape. */
  async #publishConnectorCatalog(): Promise<void> {
    const catalog = await this.#connectorBroker.catalog(this.#bot.botId);
    this.#status.connectorCatalogChanged(projectConnectorCatalog(
      { ...catalog, connections: catalog.connections.filter((item) => item.providerId !== SCHEDULE_PROVIDER) },
      (connectionId, resourceId) =>
        this.#state.connectorSelections(connectionId)
          .find((selection) => selection.resourceId === resourceId)?.selectionId,
    ));
    log.info("connectors.catalog.published", {
      botId: this.#bot.botId,
      connectionCount: catalog.connections.length,
      resourceCount: catalog.connections.reduce(
        (total, connection) => total + connection.resources.length, 0,
      ),
    });
  }

  /** The connection id a Feishu service selection belongs to, or an empty string. */
  #feishuConnectionId(): string {
    return this.#feishu.activeConnectionId() ?? "";
  }

  /** Verifies the permanent Session and starts serving: standby or failed becomes unconnected or connecting. */
  async #activateRuntime(revalidatePermanentSession = false): Promise<void> {
    if (this.#runtime.serving || this.#runtime.stopping) return;
    if (!this.#enabled) {
      await this.#reconcileAccount(this.#accountSnapshot);
      return;
    }
    if (this.#accountSnapshot.status !== "signedIn") return;
    if (!this.#state.runtimeSession()) {
      this.#status.setup("ready");
      return;
    }
    if (revalidatePermanentSession) await this.#agent.revalidatePermanentSession();
    else await this.#agent.initialize();
    if (this.#runtime.serving || this.#runtime.stopping) return;
    const workplace = this.#workplace;
    if (!workplace) {
      this.#runtime.move("unconnected", "session_verified");
      this.#status.awaitingConnection();
      this.#runtimeHealthy();
      return;
    }
    this.#runtime.move("connecting", "session_verified");
    const consumePromise = workplace.consumer.consume(
      (event) => this.#handleEvent(event, workplace),
      {
        ready: () => {
          if (this.#consumePromise !== consumePromise || !this.#runtime.serving) return;
          if (this.#accountSnapshot.status !== "signedIn") return;
          this.#runtime.move("listening", "event_stream_connected");
          this.#status.eventStreamReady();
          this.#runtimeHealthy();
        },
        unavailable: () => {
          if (this.#consumePromise !== consumePromise || this.#runtime.state !== "listening") return;
          // The official CLI reconnects on its own; only an exit is this Bot's failure.
          this.#runtime.move("connecting", "event_stream_reconnecting");
          this.#status.eventStreamUnavailable();
        },
      },
    );
    this.#consumePromise = consumePromise;
    void consumePromise.then(
      () => this.#eventStreamEnded(consumePromise),
      (error) => this.#eventStreamEnded(consumePromise, error),
    );
  }

  /** An event stream that ends while the Bot is serving was not asked to; any other end was. */
  #eventStreamEnded(consumePromise: Promise<void>, error?: unknown): void {
    if (this.#consumePromise !== consumePromise) return;
    this.#consumePromise = undefined;
    if (!this.#runtime.serving) return;
    if (error === undefined) log.error("lark.event.stream_ended", { botId: this.#bot.botId });
    else log.error("lark.event.runtime_failed", { botId: this.#bot.botId, ...errorFields(error) });
    this.#runtimeFailed("event_stream_unavailable");
  }

  /**
   * The worker or the event stream ended without being asked to. A serving
   * Bot stops admitting new messages and recovers on its own; accepted work
   * keeps its place, because the worker restarts for it on demand.
   */
  #runtimeFailed(problem: "runtime_session_unavailable" | "event_stream_unavailable"): void {
    if (this.#runtime.serving) {
      if (problem === "runtime_session_unavailable") log.error("runtime.worker.exited_unexpectedly", { botId: this.#bot.botId });
      this.#runtime.move("failed", problem);
      this.#workplace?.consumer.stop();
      this.#status.blocked(problem);
    }
    if (this.#runtime.state === "failed") this.#scheduleRecovery(problem);
  }

  /**
   * A worker or event-stream failure belongs to this Bot alone, so this Bot
   * alone reconnects: a bounded number of attempts with growing delays, each
   * logged. When they are spent, the Bot stays closed with a problem whose
   * action reconnects only this Bot.
   */
  #scheduleRecovery(problem: "runtime_session_unavailable" | "event_stream_unavailable"): void {
    if (this.#runtime.stopping || !this.#enabled || this.#recoveryTimer) return;
    clearTimeout(this.#recoveryStableTimer);
    this.#recoveryStableTimer = undefined;
    const delays = this.#recoveryTiming.delaysMilliseconds;
    if (this.#recoveryAttempts >= delays.length) {
      log.error("bot.recovery.exhausted", { botId: this.#bot.botId, problem, attempts: this.#recoveryAttempts });
      return;
    }
    const attempt = ++this.#recoveryAttempts;
    const delayMilliseconds = delays[attempt - 1]!;
    log.warn("bot.recovery.scheduled", { botId: this.#bot.botId, problem, attempt, delayMilliseconds });
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = undefined;
      void this.#reconnect(problem, attempt).catch((error) => {
        const code = error instanceof ControlRejection ? error.problemCode : undefined;
        // Only the customer can choose another model; retrying cannot.
        if (code === "model_policy_unavailable") return;
        // Accepted work or another change still owns admission; it is not a failed attempt.
        if (code === "connection_change_busy") this.#recoveryAttempts--;
        this.#scheduleRecovery(problem);
      });
    }, delayMilliseconds);
  }

  #cancelRecovery(): void {
    clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
  }

  /**
   * The Bot answers again. Attempts are forgiven only after it stays healthy,
   * so a stream that fails right after each reconnect still exhausts them.
   */
  #runtimeHealthy(): void {
    this.#cancelRecovery();
    if (this.#recoveryAttempts === 0 || this.#recoveryStableTimer) return;
    this.#recoveryStableTimer = setTimeout(() => {
      this.#recoveryStableTimer = undefined;
      if (this.#runtime.state !== "listening" && this.#runtime.state !== "unconnected") return;
      log.info("bot.recovery.stable", { botId: this.#bot.botId, attempts: this.#recoveryAttempts });
      this.#recoveryAttempts = 0;
    }, this.#recoveryTiming.stableMilliseconds);
  }

  /**
   * One reconnect of this Bot's worker and event stream, behind the same idle
   * admission as any change. A failed Bot stays failed until it serves again.
   */
  #reconnect(cause: string, attempt: number | "requested"): Promise<void> {
    return this.#changeConnection(async () => {
      if (!this.#enabled || this.#connectionState() !== "ready") return;
      log.info("bot.recovery.started", { botId: this.#bot.botId, cause, attempt });
      this.#status.starting();
      try {
        await this.#releaseRuntime(cause);
        await this.#activateRuntime(true);
      } catch (error) {
        const failure = runtimeProblem(error);
        log.error("bot.recovery.failed", { botId: this.#bot.botId, cause, problem: failure, attempt, ...errorFields(error) });
        await this.#client.disconnect().catch(() => undefined);
        this.#status.blocked(failure);
        throw new ControlRejection(failure);
      }
      log.info("bot.recovery.completed", { botId: this.#bot.botId, cause, attempt });
    });
  }

  /**
   * The customer's "reconnect" for this Bot: a fresh bounded budget and one
   * attempt now. Other Bots, the shared account and the service keep running.
   */
  async recover(): Promise<void> {
    if (this.#runtime.stopping) throw new ControlRejection("bot_not_running");
    if (!this.#enabled) throw new ControlRejection("bot_not_running");
    if (this.#connectionState() !== "ready") throw new ControlRejection("account_required");
    this.#cancelRecovery();
    this.#recoveryAttempts = 0;
    await this.#reconnect("requested", "requested");
  }

  async #reconcileAccount(snapshot: RuntimeAccountSnapshot): Promise<void> {
    const setupStage = snapshot.status === "signedIn" ? "ready" : snapshot.status === "signingIn" ? "signingIn" : snapshot.status === "unknown" ? "checking" : "signIn";
    if (!this.#enabled) {
      if (!this.#state.runtimeSession()) this.#status.setup(setupStage);
      else this.#status.paused();
      await this.#client.disconnect();
      return;
    }
    const connection = this.#connectionState(snapshot);
    if (connection !== "ready" && connection !== "missing") {
      // This Bot's own connection is unavailable; it keeps its Session and policy.
      if (this.#runtime.state !== "standby") await this.#pauseRuntime("model_connection_unavailable");
      if (this.#runtime.stopping) return;
      if (!this.#state.runtimeSession()) this.#status.setup(setupStage);
      else if (connection === "unknown") this.#status.blocked("account_status_unavailable");
      else this.#status.awaitingLogin();
      return;
    }
    if (!this.#runtime.serving) this.#status.starting();
    log.info("runtime.account.converged", {
      botId: this.#bot.botId,
      runtimeSessionReady: this.#state.runtimeSession() !== undefined,
    });
    try {
      await this.#activateRuntime(true);
    } catch (error) {
      log.error("runtime.activation_failed", { botId: this.#bot.botId, ...errorFields(error) });
      this.#status.blocked(runtimeProblem(error));
    }
  }

  /** An intentional pause: standby supersedes a failure and its scheduled recovery. */
  async #pauseRuntime(reason: string): Promise<void> {
    this.#cancelRecovery();
    if (!this.#runtime.stopping) this.#runtime.move("standby", reason);
    await this.#releaseRuntime(reason);
  }

  /**
   * Stops the event stream and the worker. A serving Bot leaves serving first,
   * so the stream's end reads as asked for; a failed Bot stays failed.
   */
  async #releaseRuntime(reason: string): Promise<void> {
    if (this.#runtime.serving) this.#runtime.move("standby", reason);
    const consumePromise = this.#consumePromise;
    this.#workplace?.consumer.stop();
    await consumePromise?.catch(() => undefined);
    await this.#client.disconnect();
  }

  async #adoptFeishuWorkplace(): Promise<void> {
    this.#workplace?.groups.stop();
    this.#workplace = undefined;
    this.#status.groupsChanged(null);
    this.#status.feishuChanged(this.#feishu.snapshot());
    const binding = this.#feishu.runtimeBinding();
    if (!binding) return;
    const workplace = new FeishuWorkplace(
      binding,
      this.#state,
      this.#bot.layout.materialStagingRoot,
      (groups) => this.#status.groupsChanged(groups),
      log.with({ botId: this.#bot.botId }),
    );
    this.#workplace = workplace;
    if (this.#runtime.stopping) { workplace.stop(); return; }
    void workplace.groups.start();
  }

  /**
   * Re-proves fixed Feishu resources after restoring the Bot connection. A
   * temporary provider failure leaves the stored scope intact; only a response
   * that definitively says an object is unreadable removes it.
   */
  async #reconcileFeishuResources(): Promise<void> {
    try {
      await this.#feishuService.reconcile();
    } catch (error) {
      log.warn("feishu.resources.reconcile_failed", {
        botId: this.#bot.botId,
        ...errorFields(error),
      });
    } finally {
      try {
        await this.#feishuMail.reconcile();
      } catch (error) {
        log.warn("feishu.mail.reconcile_failed", {
          botId: this.#bot.botId,
          ...errorFields(error),
        });
      }
      // Reconcile is also the transition from an unverified stored scope to a
      // callable one. Publish both success and bounded failure so the renderer
      // never keeps an earlier ready catalog by accident.
      await this.#publishConnectorCatalog().catch((error) => {
        log.warn("connectors.catalog.refresh_failed", {
          botId: this.#bot.botId,
          ...errorFields(error),
        });
      });
    }
  }

  async startFeishuConnection(): Promise<{ authorizationUrl: string }> {
    return { authorizationUrl: await this.#feishu.startRegistration() };
  }
  /**
   * Starts the user's mail grant; it completes in the background once the user
   * approves in Feishu. A first grant changes nothing a running turn uses, so it
   * may start while the Bot works. Replacing a proven grant pauses mailbox reads
   * until the user answers, so that waits for the same idle admission as any
   * other connection change.
   */
  startFeishuMailAuthorization(): Promise<{ authorizationUrl: string }> {
    const start = async () => {
      if (this.#feishu.connectorBinding()?.status !== "ready") {
        throw new ControlRejection("feishu_connection_failed");
      }
      let started: { authorizationUrl: string };
      try {
        started = await this.#feishuMail.startAuthorization();
      } catch (error) {
        log.warn("feishu.mail.authorization_start_failed", { botId: this.#bot.botId, ...errorFields(error) });
        throw new ControlRejection(
          error instanceof FeishuMailAuthorizationError && error.code === "app_scope_required"
            ? "feishu_mail_app_scope_required"
            : "feishu_mail_unavailable",
        );
      }
      log.info("feishu.mail.authorization_started", { botId: this.#bot.botId });
      // Published before the URL is returned, so the companion already reads
      // "authorizing" when it shows the code.
      await this.#publishConnectorCatalog();
      return started;
    };
    return this.#feishuMail.hasProvenGrant() ? this.#changeConnection(start) : start();
  }
  async cancelFeishuMailAuthorization(): Promise<void> {
    await this.#feishuMail.cancelAuthorization();
    await this.#publishConnectorCatalog();
  }
  /** Ends this Bot's mail grant and drops its mailbox range; a scope change, so it waits for idle. */
  disconnectFeishuMail(): Promise<void> {
    return this.#changeConnection(async () => {
      if (this.#feishu.connectorBinding()?.status !== "ready") {
        throw new ControlRejection("feishu_connection_failed");
      }
      try {
        await this.#feishuMail.disconnect();
      } catch (error) {
        log.warn("feishu.mail.disconnect_failed", { botId: this.#bot.botId, ...errorFields(error) });
        throw new ControlRejection("feishu_mail_unavailable");
      } finally {
        await this.#publishConnectorCatalog();
      }
      log.info("feishu.mail.disconnected", { botId: this.#bot.botId });
    });
  }
  /** The Feishu consent page for the mail scopes this Bot's app has not enabled. */
  async feishuMailSettings(): Promise<{ authorizationUrl: string }> {
    if (this.#feishu.connectorBinding()?.status !== "ready") {
      throw new ControlRejection("feishu_connection_failed");
    }
    try {
      return { authorizationUrl: await this.#feishuMail.scopeApplyUrl() };
    } catch (error) {
      log.warn("feishu.mail.settings_unavailable", { botId: this.#bot.botId, ...errorFields(error) });
      throw new ControlRejection("feishu_mail_unavailable");
    }
  }
  /**
   * Asks every connection whether anything changed since it was last proved, so
   * no page needs a refresh control: once a minute, and when someone returns to
   * Mochi. A request moments after the last recheck is already answered.
   */
  recheckConnections(): void {
    if (Date.now() - this.#lastRecheckAt < RECHECK_COOLDOWN_MILLISECONDS) return;
    void this.#recheck();
  }

  /** One recheck at a time. Each step changes what is shown only when its answer changed. */
  async #recheck(): Promise<void> {
    if (!this.#acceptingWork()) return;
    if (this.#runtime.stopping || this.#rechecking) return;
    this.#lastRecheckAt = Date.now();
    const recheck = (async () => {
      await this.#recheckFeishuConnection();
      if (this.#runtime.stopping) return;
      await this.#workplace?.groups.refresh();
      if (this.#runtime.stopping) return;
      await this.#recheckConnectors();
    })().catch((error) => {
      log.warn("connections.recheck_failed", { botId: this.#bot.botId, ...errorFields(error) });
    }).finally(() => { this.#rechecking = undefined; });
    this.#rechecking = recheck;
    await recheck;
  }

  /**
   * A quiet proof first; only a different answer is applied, through the same
   * admitted change as connecting, which pauses the Bot for its duration. A Bot
   * in the middle of work keeps its connection until a later recheck finds it idle.
   */
  async #recheckFeishuConnection(): Promise<void> {
    if (this.#connectionChanging || !await this.#feishu.recheck()) return;
    log.info("feishu.connection.recheck_changed", { botId: this.#bot.botId });
    try {
      await this.#changeFeishu(() => this.#feishu.refresh());
    } catch (error) {
      log.info("feishu.connection.recheck_deferred", { botId: this.#bot.botId, ...errorFields(error) });
    }
  }

  /**
   * Re-proves what a connector could now answer differently: a fixed range Feishu
   * did not confirm, the mail grant and its shared mailboxes, and the GitHub
   * projects the grant covers. Failures are recorded by each connector and shown
   * through the catalog; the next recheck asks again.
   */
  async #recheckConnectors(): Promise<void> {
    const catalog = await this.#connectorBroker.catalog(this.#bot.botId);
    const before = JSON.stringify(catalog);
    if (this.#feishuService.needsRecheck()) await this.#feishuService.reconcile().catch(() => undefined);
    if (this.#feishuMail.hasGrantToKeepFresh()) await this.#feishuMail.reconcile().catch(() => undefined);
    // A grant being authorized, or one the customer must renew, has nothing to recheck.
    const github = catalog.connections.find((connection) => connection.providerId === GITHUB_PROVIDER_ID)?.status;
    if (github === "ready" || github === "unavailable") await this.#botGithub.discover().catch(() => undefined);
    const after = await this.#connectorBroker.catalog(this.#bot.botId);
    if (JSON.stringify(after) === before || this.#runtime.stopping) return;
    log.info("connectors.rechecked", {
      botId: this.#bot.botId,
      connections: after.connections.map(({ providerId, status, problem }) => ({ providerId, status, problem: problem ?? null })),
    });
    await this.#publishConnectorCatalog();
  }
  cancelFeishuConnection(): Promise<void> { return this.#feishu.cancelRegistration(); }
  discardFeishuCandidate(): Promise<void> { return this.#feishu.discardCandidate(); }
  async feishuSettings(): Promise<{ authorizationUrl: string }> { return { authorizationUrl: this.#feishu.settingsUrl() }; }
  /** The customer says they finished a step for the replacement App in Feishu. */
  checkFeishuCandidate(): Promise<void> { return this.#feishu.refreshCandidate(); }
  activateFeishuConnection(): Promise<void> {
    return this.#changeFeishu(() => this.#feishu.activateCandidate(), true);
  }
  disconnectFeishu(): Promise<void> {
    return this.#changeFeishu(() => this.#feishu.disconnect(), true);
  }

  #changeFeishu(
    operation: () => Promise<void>,
    invalidatePreviousScope = false,
  ): Promise<void> {
    return this.#changeConnection(async () => {
      await this.#pauseRuntime("feishu_change");
      const previousConnectionId = this.#feishu.activeConnectionId();
      let operationCompleted = false;
      try {
        await operation();
        operationCompleted = true;
      } finally {
        if (operationCompleted) {
          const nextConnectionId = this.#feishu.activeConnectionId();
          if (
            previousConnectionId &&
            (invalidatePreviousScope || previousConnectionId !== nextConnectionId)
          ) {
            // An explicit disconnect or Bot replacement revokes the old
            // connection's future authority. Do not resurrect its fixed scope
            // if the same App is connected again later.
            this.#feishuService.forget(previousConnectionId);
          }
        }
        await this.#reconcileFeishuResources();
        await this.#adoptFeishuWorkplace();
        if (this.#accountSnapshot.status === "signedIn") await this.#activateRuntime(true);
      }
    });
  }

  startGitHubLogin(): Promise<{ authorizationUrl: string }> {
    return this.#changeConnection(() => this.#github.startAuthorization());
  }

  startGitHubInstallation(): Promise<{ authorizationUrl: string }> {
    return this.#changeConnection(() => this.#github.startInstallation());
  }

  cancelGitHubLogin(): Promise<void> { return this.#github.cancelAuthorization(); }

  disconnectGitHub(): Promise<void> {
    return this.#changeConnection(async () => {
      await this.#github.disconnect();
      // The grant is gone, so this Bot's selection has nothing left to authorize.
      // Dropping it here is the only way a disconnect can be complete.
      this.#botGithub.clear();
      await this.#publishConnectorCatalog();
    });
  }

  /**
   * Runs a change only when admission is idle. Messages accepted meanwhile wait
   * behind it in the same admission order and are answered once it ends; the
   * event stream never waits for them, so a change that stops the stream
   * cannot wait on a message that waits on the change.
   */
  #changeConnection<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#acceptingWork() || this.#connectionChanging) return Promise.reject(new ControlRejection("connection_change_busy"));
    this.#connectionChanging = true;
    this.#publishIdle();
    const previousAdmission = this.#agentAdmission;
    const pending = this.#serializeAccount(() => previousAdmission.then(async () => {
      if (this.#runtime.stopping || this.#scheduleActive || this.#acceptedWork.size > 0 || !this.#agent.idle()) {
        throw new ControlRejection("connection_change_busy");
      }
      return operation();
    })).finally(() => {
      this.#connectionChanging = false;
      this.#publishIdle();
    });
    this.#agentAdmission = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /**
   * This Bot's answer to whether the shared account may change now. It is
   * derived from admission itself, never from the published status.
   */
  #idle(): boolean {
    return !this.#connectionChanging && !this.#scheduleActive
      && this.#pendingHumanAdmissions === 0 && this.#acceptedWork.size === 0 && this.#agent.idle();
  }

  /** Includes delivery, startup/configuration and native authorization, not just model work. */
  readyForUpdate(): boolean {
    const feishu = this.#feishu.snapshot();
    return !this.#runtime.stopping && this.#idle() && this.#receivingEvents === 0
      && this.#accountOperations === 0 && !this.#rechecking
      && !this.#feishuMail.authorizing()
      && this.#github.snapshot().status !== "authorizing"
      && feishu.candidate?.state !== "registering" && feishu.candidate?.state !== "checking";
  }

  /** No model request, bootstrap, fork, or change to the user's duty selection. */
  async verifyForUpdate(): Promise<void> {
    if (!this.#state.runtimeSession()) return;
    await this.#client.verifySession();
  }

  #publishIdle(): void {
    const idle = this.#idle();
    if (idle === this.#lastIdle) return;
    this.#lastIdle = idle;
    this.#status.idleChanged(idle);
  }

  #serializeAccount<T>(operation: () => Promise<T>): Promise<T> {
    this.#accountOperations++;
    const result = this.#accountAdmission.then(operation);
    this.#accountAdmission = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.#accountOperations--; });
  }

  /**
   * The Bot's Session identity, read at use time.
   *
   * A Bot that has not finished setup carries the durable first-run candidate
   * here; initialization promotes it to the permanent Session, and this getter is
   * what makes every later worker start on the promoted identity.
   */
  #runtimeConfig(): RuntimeConfig & { sessionId: string } {
    return { ...this.#bot.runtime, sessionId: this.#bot.runtime.sessionId };
  }

  #createClient(): PiRuntimeClient {
    return new PiRuntimeClient({
      config: this.#runtimeConfig(),
      tools: AGENT_TOOLS,
      capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      systemPrompt: () => runtimeSystemPrompt(this.#instructions.read().content),
    });
  }

  /**
   * Decides whether a Feishu event is addressed to this Bot and, if so, claims
   * it, shows it was received and hands it to admission. It returns without
   * waiting for the answer, so stopping the event stream never waits on work
   * that is itself waiting for a connection change.
   */
  async #handleEvent(raw: unknown, workplace: FeishuWorkplace): Promise<void> {
    if (!this.#acceptingWork()) return;
    this.#receivingEvents++;
    try { await this.#receiveEvent(raw, workplace); }
    finally { this.#receivingEvents--; }
  }

  async #receiveEvent(raw: unknown, workplace: FeishuWorkplace): Promise<void> {
    const event = parseMessageEvent(raw);
    if (!event) {
      log.warn("bot.event.invalid_shape", { botId: this.#bot.botId });
      return;
    }
    const threadKeys = threadKeysFor(event);
    const chatEnabled = event.chat_type === "group" && event.sender_type === "user"
      && event.message_type !== "system" && await workplace.groups.accepts(event.chat_id);
    const topic = chatEnabled
      ? this.#state.resolveTopicIdentity(event.chat_id, threadKeyFor(event), threadKeys)
      : { threadKey: threadKeyFor(event), active: false };
    const recentContext = workplace.recentContext.recent(
      event.chat_id,
      event.message_id,
    );
    if (chatEnabled) workplace.recentContext.observe(event);
    const decision = decideEvent(event, {
      chatEnabled,
      botOpenId: workplace.binding.botOpenId,
      topicIsActive: topic.active,
      ...(topic.active ? { activeThreadKey: topic.threadKey } : {}),
    });
    if (!decision.accepted) {
      log.info("bot.event.rejected", {
        botId: this.#bot.botId,
        messageId: event.message_id,
        chatId: event.chat_id,
        threadKeys,
        reason: decision.reason,
      });
      return;
    }
    if (!this.#acceptingWork()) return;
    if (!this.#state.claimEvent(
      event.message_id,
      decision.context,
      decision.route === "activate_topic",
    )) {
      log.info("bot.event.duplicate", { botId: this.#bot.botId, messageId: event.message_id });
      return;
    }
    const feedback = new MessageFeedback(workplace.messenger, {
      botId: this.#bot.botId, messageId: event.message_id,
    });
    if (this.#connectionChanging) {
      log.info("bot.event.waiting_for_change", { botId: this.#bot.botId, messageId: event.message_id });
    }
    const work = this.#answerAcceptedEvent(workplace, event, decision, recentContext, feedback);
    this.#acceptedWork.add(work);
    this.#publishIdle();
    void work.finally(() => { this.#acceptedWork.delete(work); this.#publishIdle(); });
  }

  /** Every claimed message ends completed or failed, and failure is told in its topic. */
  async #answerAcceptedEvent(
    workplace: FeishuWorkplace,
    event: LarkMessageEvent,
    decision: Extract<EventDecision, { accepted: true }>,
    recentContext: readonly string[],
    feedback: MessageFeedback,
  ): Promise<void> {
    try {
      let responseText: string | undefined;
      let path: "rate_limited" | "agent_reply" | "agent_steer";
      let issueOutcome: WorkflowOutcome | null = null;
      let replyFeedback: ReplyFeedback = "replied";
      if (!this.#state.allowRequest(`user:${decision.context.requesterId}`, 10, 60_000)) {
        responseText = "请求过于频繁：每位用户每分钟最多 10 次，请稍后再试。";
        path = "rate_limited";
        replyFeedback = "blocked";
      } else {
        const response = await this.#respondInOrder(
          workplace,
          event,
          decision.context,
          decision.text,
          recentContext,
          () => feedback.started(),
        );
        issueOutcome = response.issueOutcome;
        if (issueOutcome === "waiting" || issueOutcome === "blocked") replyFeedback = issueOutcome;
        if (response.kind === "reply") {
          responseText = response.text;
          path = "agent_reply";
        } else {
          path = "agent_steer";
          log.info("bot.event.steered", {
            botId: this.#bot.botId,
            messageId: event.message_id,
            replyMessageId: response.replyMessageId,
          });
        }
      }
      if (responseText) await workplace.messenger.replyInThread(event.message_id, responseText);
      this.#state.completeEvent(event.message_id);
      await feedback.finish(replyFeedback);
      log.info("bot.event.completed", {
        botId: this.#bot.botId,
        messageId: event.message_id,
        chatId: event.chat_id,
        threadKey: decision.context.threadKey,
        route: decision.route,
        path,
        delivery: responseText ? "replied" : "coalesced",
        issueOutcome,
        feedback: replyFeedback,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#state.failEvent(event.message_id, message);
      log.error("bot.event.failed", {
        botId: this.#bot.botId,
        messageId: event.message_id,
        chatId: event.chat_id,
        ...errorFields(error),
      });
      await feedback.finish("failed");
      try {
        await workplace.messenger.replyInThread(
          event.message_id,
          error instanceof RuntimeTurnTimedOutError
            ? `处理超过 ${formatDuration(error.timeoutMilliseconds)}，已安全停止，本次尚未交付最终答复。已保存的上下文仍保留，你可以在本话题让我继续；排队中的其他问题会继续处理。`
            : "这次没有处理完成。你可以在本话题再说一次。",
        );
      } catch (replyError) {
        log.error("bot.failure_reply.failed", {
          botId: this.#bot.botId,
          messageId: event.message_id,
          ...errorFields(replyError),
        });
      }
    }
  }

  async #respondInOrder(
    workplace: FeishuWorkplace,
    event: LarkMessageEvent,
    context: MessageContext,
    text: string,
    recentContext: readonly string[],
    onStarted: () => void,
  ): Promise<RuntimeAgentResponse> {
    this.#pendingHumanAdmissions++;
    this.#publishIdle();
    const admission = this.#agentAdmission.then(async () => {
      // A change that ran ahead of this message may have paused the Bot, taken
      // its connection away or replaced its Feishu channel.
      const closed = this.#admissionClosedFor(workplace);
      if (closed) throw new AdmissionClosedError(closed);
      return { response: this.#agent.respond(context, async () => {
        // A queued message fetches current evidence only when its turn starts.
        const unavailable = this.#admissionClosedFor(workplace);
        if (unavailable) throw new AdmissionClosedError(unavailable);
        const deadline = Date.now() + MATERIAL_PREPARATION_TIMEOUT_MILLISECONDS;
        const evidence = await this.#readMessageEvidence(workplace, event, context);
        const known = new Set(evidence.messages.map((message) => message.messageId));
        const recent = await workplace.evidence.readRecent(event,
          recentContext.filter((id) => !known.has(id)), Math.min(deadline, Date.now() + 15_000));
        const message = await workplace.messages.hydrate(event, text, workplace.groups.name(event.chat_id), evidence, recent, deadline);
        log.info("lark.message.hydrated", {
          botId: this.#bot.botId,
          messageId: event.message_id,
          messageType: message.messageType,
          delivery: message.delivery,
          materialCount: message.materials.length,
          imageCount: message.materials.filter((item) => item.dataUrl).length,
          materials: message.materials.map(({ index, sourceMessageId, source, kind, delivery, readability, reason }) =>
            ({ index, sourceMessageId, source, kind, delivery, readability, reason,
              sourceMessageType: message.contextMessages.find((item) => item.messageId === sourceMessageId)?.messageType })),
          topicEvidenceDelivery: evidence.delivery,
          topicEvidenceMessageCount: evidence.messages.length,
          referencedMessageIds: evidence.referencedMessageIds,
          topicEvidenceLimitations: evidence.limitations,
          limitations: message.limitations,
        });
        return message;
      }, onStarted) };
    });
    this.#agentAdmission = admission.then(() => undefined, () => undefined);
    try { const { response } = await admission; return response; }
    finally {
      this.#pendingHumanAdmissions--;
      this.#publishIdle();
    }
  }

  /** Why an accepted message can no longer be answered here, if it cannot. */
  #admissionClosedFor(workplace: FeishuWorkplace): AdmissionClosedReason | undefined {
    if (this.#runtime.stopping) return "stopping";
    if (!this.#enabled) return "paused";
    if (workplace !== this.#workplace) return "channel_replaced";
    // A lost account worker leaves the account unknown, not changed: the event
    // stream stops new messages, and accepted ones keep their place.
    const connection = this.#connectionState();
    if (connection !== "ready" && connection !== "unknown") return "model_connection_unavailable";
    return undefined;
  }

  #canStartSchedule(): boolean {
    return this.#acceptingWork() && !this.#scheduleClockFailed && this.#enabled && this.#runtime.state === "listening"
      && this.#connectionState() === "ready" && this.#idle();
  }
  /** One target policy, proved both before model work and before delivery. */
  async #scheduleTargetProblem(workplace: FeishuWorkplace | undefined, schedule: ScheduleRecord): Promise<ScheduleProblem | null> {
    if (!workplace || workplace !== this.#workplace || workplace.binding.targetAppId !== schedule.appId) return "channel_changed";
    if (!await workplace.groups.refresh() || !await workplace.groups.accepts(schedule.chatId)) return "group_unavailable";
    const catalog = await this.#connectorBroker.catalog(this.#bot.botId);
    if (!scheduleResourcesStillSelected(this.#bot.botId, schedule.resources, catalog, this.#state)) return "resources_changed";
    if (schedule.delivery === "thread") {
      try { await workplace.evidence.assertDeliveryTarget(schedule.chatId, schedule.threadTarget!.replyMessageId); }
      catch { return "source_unavailable"; }
    }
    return this.#runtime.stopping || !await workplace.groups.accepts(schedule.chatId) ? "group_unavailable" : null;
  }
  async #executeSchedule(occurrence: ScheduleOccurrence): Promise<ScheduleResult> {
    // Count authority preparation and delivery as accepted work as well as the
    // model turn. Account/connection changes cannot enter either gap.
    this.#scheduleActive = true;
    this.#publishIdle();
    const workplace = this.#workplace;
    const { schedule } = occurrence;
    const deliveryTarget = schedule.delivery === "thread" ? { ...schedule, ...schedule.threadTarget! } : schedule;
    log.info("schedule.claimed", { botId: this.#bot.botId, scheduleId: schedule.id, dueAt: occurrence.dueAt, coalesced: occurrence.coalesced });
    const blocked = (problem: ScheduleProblem): ScheduleResult => {
      log.warn("schedule.blocked", { botId: this.#bot.botId, scheduleId: schedule.id, dueAt: occurrence.dueAt, problem });
      return { status: "blocked", problem };
    };
    try {
      const admission = this.#agentAdmission.then(async () => {
        const problem = await this.#scheduleTargetProblem(workplace, schedule);
        if (problem) return { blocked: problem };
        return { response: this.#agent.respondToSchedule(occurrence, workplace!.groups.name(schedule.chatId)) };
      });
      this.#agentAdmission = admission.then(() => undefined, () => undefined);
      const admitted = await admission;
      if ("blocked" in admitted) return blocked(admitted.blocked!);
      let response: RuntimeAgentResponse;
      try { response = await admitted.response; }
      catch (error) { throw new ScheduleExecutionError("execution_failed", error); }
      if (response.kind !== "reply") throw new ScheduleExecutionError("execution_failed", new Error("Schedule was unexpectedly steered"));
      try {
        // Provider authority can change while the model runs, even though
        // local account/selection changes hold the same admission gate.
        const problem = await this.#scheduleTargetProblem(workplace, schedule);
        if (problem) return blocked(problem);
        const receipt = await workplace!.messenger.deliverSchedule(deliveryTarget,
          `${this.#bot.botId}/${schedule.id}/${occurrence.dueAt}`, scheduleDeliveryText(occurrence, response.text));
        this.#state.recordScheduleDelivery(schedule, occurrence.dueAt, receipt);
      } catch (error) { throw new ScheduleExecutionError("delivery_failed", error); }
      log.info("schedule.delivered", { botId: this.#bot.botId, scheduleId: schedule.id, dueAt: occurrence.dueAt, delivery: schedule.delivery });
      return { status: "delivered", problem: null };
    } finally {
      this.#scheduleActive = false;
      this.#publishIdle();
    }
  }

  async #readMessageEvidence(
    workplace: FeishuWorkplace,
    event: LarkMessageEvent,
    context: MessageContext,
  ): Promise<FeishuTopicEvidence> {
    try {
      return await workplace.evidence.read(event, context.threadKey);
    } catch (error) {
      if (error instanceof FeishuEvidenceRejectedError) throw error;
      log.warn("lark.topic_evidence.degraded", {
        botId: this.#bot.botId,
        messageId: event.message_id,
        chatId: event.chat_id,
        threadKey: context.threadKey,
        ...errorFields(error),
      });
      return unavailableTopicEvidence(event, context.threadKey);
    }
  }

}

type AdmissionClosedReason = "stopping" | "paused" | "channel_replaced" | "model_connection_unavailable";

/** An accepted message whose Bot changed state before it could be admitted. */
class AdmissionClosedError extends Error {
  constructor(readonly reason: AdmissionClosedReason) {
    super(`Bot admission closed before the message could be answered: ${reason}`);
    this.name = "AdmissionClosedError";
  }
}

function runtimeProblem(error: unknown, otherwise: "setup_failed" | "runtime_session_unavailable" = "runtime_session_unavailable") {
  return error instanceof RuntimeRequestError && error.code === "model_policy_unavailable" ? "model_policy_unavailable" : otherwise;
}

const INTERRUPTED_REPLY = "处理这条消息时服务重启了，本次没有完成，也不会自动重试。你可以在本话题再说一次。";

function formatDuration(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000);
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

/** Each recheck is a few official CLI reads and one GitHub catalog read. */
const RECHECK_INTERVAL_MILLISECONDS = 60_000;
/** Returning to Mochi twice in a moment asks once. */
const RECHECK_COOLDOWN_MILLISECONDS = 10_000;

function feishuBindingKey(binding: FeishuConnectorBinding | undefined): string {
  return binding
    ? JSON.stringify([binding.cliPath, binding.profile, binding.configDirectory, binding.targetAppId, binding.botOpenId, binding.status])
    : "";
}
