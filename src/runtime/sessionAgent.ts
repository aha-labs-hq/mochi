import type { ToolTurnState } from "../agent/tools.ts";
import type { MessageArtifacts } from "../attachments/artifacts.ts";
import { MaterialWorkspace } from "../attachments/materialWorkspace.ts";
import type { RuntimeConfig } from "../config.ts";
import type { MessageContext } from "../domain.ts";
import { issueProvenance } from "../issueProvenance.ts";
import type { HydratedFeishuMessage } from "../lark/messageHydrator.ts";
import { errorFields, log } from "../log.ts";
import type { StateStore } from "../state.ts";
import { mergeIssueOutcomes, type WorkflowOutcome } from "../issueWorkflow.ts";
import {
  type RuntimeRunningTurn,
  RuntimeTurnNotActiveError,
} from "./client.ts";
import { currentTurnFrame, feishuTurnSources, runtimeUserMessage } from "./instructions.ts";
import type { RuntimeToolOutputItem } from "./toolOutput.ts";
import type { RuntimeContextUsage, RuntimeTurnInput, RuntimeTurnWorkspace } from "./protocol.ts";
import type { ScheduleOccurrence } from "../schedules/dispatcher.ts";
import { schedulePrompt } from "../schedules/prompt.ts";

export type RuntimeAgentResponse =
  | { kind: "reply"; text: string; issueOutcome: WorkflowOutcome | null }
  | { kind: "steered"; replyMessageId: string; issueOutcome: WorkflowOutcome | null };

export const CONTEXT_ORGANIZATION_THRESHOLD = 0.75;

interface Participant {
  context: MessageContext;
  /** Where the turn happens, shown to the model; null is an unknown group name. */
  chatName: string | null;
  input: { kind: "human"; prepare: PrepareMessage; message?: HydratedFeishuMessage } | { kind: "schedule"; occurrence: ScheduleOccurrence };
  toolState: ToolTurnState;
  artifacts?: MessageArtifacts;
  onStarted?: () => void;
  resolve: (response: RuntimeAgentResponse) => void;
  reject: (error: Error) => void;
}

/** Fetch mutable channel evidence when the message is about to reach Pi. */
type PrepareMessage = () => HydratedFeishuMessage | Promise<HydratedFeishuMessage>;

interface ActiveBatch {
  kind: Participant["input"]["kind"];
  chatId: string;
  threadKey: string;
  turn: RuntimeRunningTurn;
  participantsBySourceMessageId: Map<string, Participant>;
  workspace: MaterialWorkspace;
  participants: Participant[];
}

interface Admission {
  result: Promise<RuntimeAgentResponse>;
}

export interface RuntimeSessionObserver {
  runtimeStateChanged(state: {
    activeTurn: boolean;
    organizingContext: boolean;
    queueDepth: number;
    contextOrganizationAvailable: boolean;
  }): void;
  contextUsageChanged(usage: RuntimeContextUsage): void;
  /** Called whenever the admission answer of `idle()` changes. */
  idleChanged?(idle: boolean): void;
}

const NULL_OBSERVER: RuntimeSessionObserver = {
  runtimeStateChanged: () => undefined,
  contextUsageChanged: () => undefined,
};

export class RuntimeSessionAgent {
  readonly #sessionId: string;
  readonly #capabilityAbi: string;
  readonly #state: StateStore;
  readonly #tools: RuntimeToolExecutor;
  readonly #client: RuntimeSessionClient;
  readonly #createMaterialWorkspace: () => MaterialWorkspace;
  readonly #observer: RuntimeSessionObserver;
  readonly #unsubscribeCompaction: () => void;
  readonly #turnTasks = new Set<Promise<void>>();
  #initialized = false;
  #closed = false;
  #contextOrganizationRequested = false;
  #closePromise: Promise<void> | undefined;
  #admissionQueue: Promise<void> = Promise.resolve();
  /** Serialized operations not yet finished, such as a message still being admitted. */
  #serializedOperations = 0;
  #lastIdle = true;
  #activeBatch: ActiveBatch | undefined;
  #pending: Participant[] = [];

  constructor(options: {
    config: RuntimeConfig & { sessionId: string };
    capabilityAbi: string;
    state: StateStore;
    tools: RuntimeToolExecutor;
    client: RuntimeSessionClient;
    observer?: RuntimeSessionObserver;
    createMaterialWorkspace?: () => MaterialWorkspace;
  }) {
    this.#sessionId = options.config.sessionId;
    this.#capabilityAbi = options.capabilityAbi;
    this.#state = options.state;
    this.#tools = options.tools;
    this.#client = options.client;
    this.#observer = options.observer ?? NULL_OBSERVER;
    this.#createMaterialWorkspace = options.createMaterialWorkspace
      ?? (() => new MaterialWorkspace());
    this.#unsubscribeCompaction = this.#client.onCompactionChanged(() => this.#publishRuntimeState());
  }

  async initialize(): Promise<void> {
    if (this.#closed) throw new Error("Runtime Session agent is closed");
    if (this.#initialized) return;
    await this.#resumePermanentSession("runtime.session.ready");
    const persistedUsage = this.#state.runtimeContextUsage(this.#sessionId);
    if (persistedUsage) {
      const usage = {
        ...persistedUsage,
        fractionUsed: Math.min(
          1,
          Math.max(0, persistedUsage.usedTokens / persistedUsage.modelContextWindow),
        ),
      };
      this.#client.restoreContextUsage(usage);
      this.#observer.contextUsageChanged(usage);
      log.info("runtime.context.usage_updated", {
        sessionId: usage.sessionId,
        turnId: usage.turnId,
        contextUsedTokens: usage.usedTokens,
        contextWindowTokens: usage.modelContextWindow,
        contextFractionUsed: usage.fractionUsed,
        contextUsageSource: "persisted_session_state",
      });
    }
    this.#initialized = true;
    this.#publishRuntimeState();
  }

  revalidatePermanentSession(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#closed) throw new Error("Runtime Session agent is closed");
      if (!this.#initialized) {
        await this.initialize();
        return;
      }
      if (this.#activeBatch || this.#pending.length > 0 || this.#contextOrganizationRequested) {
        throw new Error("Cannot revalidate the permanent Runtime Session while work is active");
      }
      await this.#resumePermanentSession("runtime.session.revalidated");
      this.#publishRuntimeState();
    });
  }

  async #resumePermanentSession(
    event: "runtime.session.ready" | "runtime.session.revalidated",
  ): Promise<void> {
    const capabilityStatus = this.#state.assertRuntimeSessionCandidate(this.#sessionId, this.#capabilityAbi);
    const session = await this.#client.resumeSession();
    if (session.sessionId !== this.#sessionId || session.capabilityAbi !== this.#capabilityAbi) {
      throw new Error("Pi worker resumed an unexpected permanent Session");
    }
    this.#state.activateRuntimeSession(session.sessionId, session.capabilityAbi);
    log.info(event, {
      sessionId: session.sessionId,
      capabilityAbi: this.#capabilityAbi,
      capabilityStatus,
    });
  }

  respond(
    context: MessageContext,
    prepare: PrepareMessage,
    onStarted?: () => void,
  ): Promise<RuntimeAgentResponse> {
    if (this.#closed) return Promise.reject(new Error("Runtime Session agent is closed"));
    return this.#serialize(() => this.#admit(context, prepare, onStarted)).then(({ result }) => result);
  }
  respondToSchedule(occurrence: ScheduleOccurrence, chatName: string | null): Promise<RuntimeAgentResponse> {
    if (this.#closed) return Promise.reject(new Error("Runtime Session agent is closed"));
    return this.#serialize(async () => {
      await this.initialize();
      if (this.#activeBatch || this.#pending.length > 0 || this.#contextOrganizationRequested || this.#client.isCompacting()) {
        throw new Error("Scheduled work requires idle Session admission");
      }
      const participant = scheduledParticipant(occurrence, chatName);
      try { await this.#startBatch(participant); }
      catch (error) { participant.reject(asError(error)); }
      return { result: participant.promise };
    }).then(({ result }) => result);
  }

  organizeContext(): Promise<void> {
    if (this.#contextOrganizationRequested) {
      return Promise.reject(new Error("麻薯已经在整理思绪了。"));
    }
    this.#contextOrganizationRequested = true;
    this.#publishRuntimeState(false);
    return this.#serialize(async () => {
      if (this.#closed) throw new Error("Runtime Session agent is closed");
      await this.initialize();
      if (this.#activeBatch || this.#pending.length > 0) {
        throw new Error("麻薯还在处理消息，请等回复完成后再整理思绪。");
      }
      const usage = this.#client.contextUsage();
      if (!usage) throw new Error("暂时还无法确认麻薯记住了多少内容。");
      if (usage.fractionUsed < CONTEXT_ORGANIZATION_THRESHOLD) {
        throw new Error("麻薯现在还很轻松，不需要整理思绪。");
      }

      log.info("runtime.context.organization_started", {
        sessionId: this.#sessionId,
        contextUsedTokens: usage.usedTokens,
        contextWindowTokens: usage.modelContextWindow,
        contextFractionUsed: usage.fractionUsed,
      });
      this.#publishRuntimeState(true);
      try {
        await this.#client.compactSession();
        const refreshedUsage = this.#client.contextUsage();
        if (
          refreshedUsage
          && refreshedUsage.sessionId === this.#sessionId
          && refreshedUsage.usedTokens < usage.usedTokens
        ) this.#persistContextUsage(refreshedUsage);
        else this.#state.clearRuntimeContextUsage(this.#sessionId);
        log.info("runtime.context.organization_completed", {
          sessionId: this.#sessionId,
        });
      } catch (error) {
        this.#persistCurrentContextUsage();
        log.error("runtime.context.organization_failed", {
          sessionId: this.#sessionId,
          ...errorFields(error),
        });
        throw new Error("麻薯这次没有整理好思绪，请稍后再试。", { cause: error });
      }
    }).finally(() => {
      this.#contextOrganizationRequested = false;
      this.#publishRuntimeState();
    });
  }

  async #admit(
    context: MessageContext,
    prepare: PrepareMessage,
    onStarted?: () => void,
  ): Promise<Admission> {
    if (this.#closed) throw new Error("Runtime Session agent is closed");
    await this.initialize();
    const participant = deferredParticipant(context, prepare, onStarted);

    const active = this.#activeBatch;
    if (!active) {
      try {
        await this.#startBatch(participant);
      } catch (error) {
        participant.reject(asError(error));
        disposeParticipant(participant);
      }
      return { result: participant.promise };
    }

    if (active.kind === "schedule" || active.chatId !== context.chatId || active.threadKey !== context.threadKey) {
      this.#enqueue(participant, active);
      return { result: participant.promise };
    }

    try {
      await this.#steer(active, participant);
    } catch (error) {
      if (error instanceof RuntimeTurnNotActiveError) this.#enqueue(participant, active);
      else {
        participant.reject(asError(error));
        disposeParticipant(participant);
      }
    }
    return { result: participant.promise };
  }

  #enqueue(participant: Participant, active: ActiveBatch): void {
    this.#pending.push(participant);
    this.#publishRuntimeState();
    log.info("runtime.turn.queued", {
      sessionId: this.#sessionId,
      activeTurnId: active.turn.turnId,
      activeFeishuThreadKey: active.threadKey,
      queuedFeishuThreadKey: participant.context.threadKey,
      messageId: participant.context.sourceMessageId,
      queueDepth: this.#pending.length,
    });
  }

  async #startBatch(participant: Participant): Promise<ActiveBatch> {
    await prepareParticipant(participant);
    const workspace = this.#createMaterialWorkspace();
    const participantsBySourceMessageId = new Map([[participant.context.sourceMessageId, participant]]);
    let turn: RuntimeRunningTurn;
    try {
      const input = participantInput(participant, workspace);
      turn = await this.#client.startTurn(
        input,
        (sourceMessageId, name, args) => {
          const source = participantsBySourceMessageId.get(sourceMessageId);
          if (!source) {
            throw new Error(`Pi tool call has unknown Feishu source message provenance: ${sourceMessageId}`);
          }
          return this.#tools.execute(name, args, source.context, source.toolState);
        },
        { cwd: workspace.cwd },
      );
    } catch (error) {
      workspace.dispose();
      throw error;
    }
    const batch: ActiveBatch = {
      kind: participant.input.kind,
      threadKey: participant.context.threadKey,
      chatId: participant.context.chatId,
      turn,
      participantsBySourceMessageId,
      workspace,
      participants: [participant],
    };
    this.#activeBatch = batch;
    this.#publishRuntimeState();
    markStarted(participant);
    log.info("runtime.turn.started", {
      sessionId: this.#sessionId,
      turnId: turn.turnId,
      feishuThreadKey: batch.threadKey,
      messageId: participant.context.sourceMessageId,
      queueDepth: this.#pending.length,
    });
    const task = this.#completeBatch(batch);
    this.#turnTasks.add(task);
    void task.then(
      () => this.#turnTasks.delete(task),
      () => this.#turnTasks.delete(task),
    );
    return batch;
  }

  async #steer(active: ActiveBatch, participant: Participant): Promise<void> {
    if (active.kind !== "human" || participant.input.kind !== "human") throw new Error("Schedules and human messages cannot steer each other");
    await prepareParticipant(participant);
    const input = participantInput(participant, active.workspace);
    active.participantsBySourceMessageId.set(participant.context.sourceMessageId, participant);
    try {
      await this.#client.steerTurn(active.turn.turnId, input);
      if (this.#activeBatch !== active) throw new RuntimeTurnNotActiveError();
    } catch (error) {
      active.participantsBySourceMessageId.delete(participant.context.sourceMessageId);
      throw error;
    }
    active.participants.push(participant);
    markStarted(participant);
    log.info("runtime.turn.steered", {
      sessionId: this.#sessionId,
      turnId: active.turn.turnId,
      feishuThreadKey: active.threadKey,
      messageId: participant.context.sourceMessageId,
      participantCount: active.participants.length,
    });
  }

  async #completeBatch(batch: ActiveBatch): Promise<void> {
    let outcome: { text: string } | { error: Error };
    try {
      outcome = { text: await batch.turn.completed };
    } catch (error) {
      outcome = { error: error instanceof Error ? error : new Error(String(error)) };
    }

    await this.#serialize(async () => {
      if (this.#activeBatch !== batch) {
        const error = new Error(`Runtime completed unexpected active turn ${batch.turn.turnId}`);
        for (const participant of batch.participants) participant.reject(error);
        disposeParticipants(batch.participants);
        batch.workspace.dispose();
        return;
      }
      this.#activeBatch = undefined;
      this.#publishRuntimeState();
      try {
        this.#persistCurrentContextUsage();
        if ("error" in outcome) throw outcome.error;
        const latest = batch.participants.at(-1);
        if (!latest) throw new Error("Runtime turn has no Feishu participant");
        const issueOutcome = batch.participants.reduce<WorkflowOutcome | null>(
          (outcome, participant) => mergeIssueOutcomes(outcome, participant.toolState.issueOutcome),
          null,
        );
        this.#state.completeRuntimeTurn(this.#sessionId, latest.context.sourceMessageId);
        for (const participant of batch.participants.slice(0, -1)) {
          participant.resolve({
            kind: "steered",
            replyMessageId: latest.context.sourceMessageId,
            issueOutcome: participant.toolState.issueOutcome,
          });
        }
        latest.resolve({ kind: "reply", text: outcome.text, issueOutcome });
        log.info("runtime.turn.completed", {
          sessionId: this.#sessionId,
          turnId: batch.turn.turnId,
          feishuThreadKey: batch.threadKey,
          replyMessageId: latest.context.sourceMessageId,
          participantCount: batch.participants.length,
          queueDepth: this.#pending.length,
        });
      } catch (error) {
        const failure = asError(error);
        for (const participant of batch.participants) participant.reject(failure);
      } finally {
        disposeParticipants(batch.participants);
        batch.workspace.dispose();
      }
      if (!this.#closed) await this.#startNext();
    });
  }

  async #startNext(): Promise<void> {
    let active: ActiveBatch | undefined;
    while (!active) {
      const participant = this.#pending.shift();
      this.#publishRuntimeState();
      if (!participant) return;
      try {
        active = await this.#startBatch(participant);
      } catch (error) {
        // Only this message failed, for example because its sender recalled it;
        // the messages queued behind it keep their turn.
        const failure = asError(error);
        participant.reject(failure);
        disposeParticipant(participant);
        log.error("runtime.queue.start_failed", {
          sessionId: this.#sessionId,
          messageId: participant.context.sourceMessageId,
          queueDepth: this.#pending.length,
          error: failure.message,
        });
        // A closing agent rejects the rest of the queue itself.
        if (this.#closed) return;
      }
    }

    while (
      !this.#closed
      && this.#activeBatch === active
      && active.kind === "human"
      && this.#pending[0]?.input.kind === "human"
      && this.#pending[0]?.context.chatId === active.chatId
      && this.#pending[0]?.context.threadKey === active.threadKey
    ) {
      const followup = this.#pending.shift();
      if (!followup) break;
      this.#publishRuntimeState();
      try {
        await this.#steer(active, followup);
      } catch (error) {
        if (error instanceof RuntimeTurnNotActiveError) this.#pending.unshift(followup);
        else {
          followup.reject(asError(error));
          disposeParticipant(followup);
        }
        break;
      }
    }
  }

  #persistCurrentContextUsage(): void {
    const usage = this.#client.contextUsage();
    if (usage) this.#persistContextUsage(usage);
    else this.#state.clearRuntimeContextUsage(this.#sessionId);
  }

  #persistContextUsage(usage: RuntimeContextUsage): void {
    if (usage.sessionId !== this.#sessionId) {
      throw new Error(`Runtime context usage belongs to unexpected Session ${usage.sessionId}`);
    }
    this.#state.saveRuntimeContextUsage(usage);
    this.#observer.contextUsageChanged(usage);
    this.#publishRuntimeState();
  }

  #publishRuntimeState(organizingContext = this.#contextOrganizationRequested): void {
    this.#notifyIdle();
    organizingContext ||= this.#client.isCompacting();
    const usage = this.#client.contextUsage();
    this.#observer.runtimeStateChanged({
      activeTurn: this.#activeBatch !== undefined,
      organizingContext,
      queueDepth: this.#pending.length,
      contextOrganizationAvailable: this.#initialized
        && !this.#closed
        && !organizingContext
        && !this.#contextOrganizationRequested
        && this.#activeBatch === undefined
        && this.#pending.length === 0
        && usage?.sessionId === this.#sessionId
        && usage.fractionUsed >= CONTEXT_ORGANIZATION_THRESHOLD,
    });
  }

  /**
   * The one admission answer: no turn, queued message, admission in flight,
   * context organization or compaction. Display state is derived from the same
   * facts but never consulted for admission.
   */
  idle(): boolean {
    return this.#serializedOperations === 0
      && this.#activeBatch === undefined
      && this.#pending.length === 0
      && !this.#contextOrganizationRequested
      && !this.#client.isCompacting();
  }

  #notifyIdle(): void {
    const idle = this.idle();
    if (idle === this.#lastIdle) return;
    this.#lastIdle = idle;
    this.#observer.idleChanged?.(idle);
  }

  #serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    this.#serializedOperations++;
    this.#notifyIdle();
    const result = this.#admissionQueue.then(operation).finally(() => {
      this.#serializedOperations--;
      this.#notifyIdle();
    });
    this.#admissionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#admissionQueue;
      const error = new Error("Runtime Session agent is closed");
      for (const participant of this.#pending.splice(0)) {
        participant.reject(error);
        disposeParticipant(participant);
      }
      this.#publishRuntimeState(false);
      await this.#client.close();
      this.#unsubscribeCompaction();
      await Promise.allSettled(this.#turnTasks);
    })();
    return this.#closePromise;
  }
}

export interface RuntimeToolExecutor {
  execute(
    name: string,
    args: unknown,
    context: MessageContext,
    turn: ToolTurnState,
  ): Promise<RuntimeToolOutputItem[]>;
}

export interface RuntimeSessionClient {
  resumeSession(): Promise<{ sessionId: string; capabilityAbi: string }>;
  contextUsage(): RuntimeContextUsage | undefined;
  isCompacting(): boolean;
  onCompactionChanged(listener: () => void): () => void;
  restoreContextUsage(usage: RuntimeContextUsage): void;
  compactSession(): Promise<void>;
  startTurn(
    input: RuntimeTurnInput,
    toolHandler: (
      sourceMessageId: string,
      name: string,
      args: unknown,
    ) => Promise<readonly RuntimeToolOutputItem[]>,
    workspace: RuntimeTurnWorkspace,
  ): Promise<RuntimeRunningTurn>;
  steerTurn(
    expectedTurnId: string,
    input: RuntimeTurnInput,
  ): Promise<void>;
  close(): Promise<void>;
}

function deferredParticipant(
  context: MessageContext,
  prepare: PrepareMessage,
  onStarted?: () => void,
): Participant & { promise: Promise<RuntimeAgentResponse> } {
  let resolve!: (response: RuntimeAgentResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RuntimeAgentResponse>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    context,
    chatName: null,
    input: { kind: "human", prepare },
    toolState: {
      mutationCount: 0,
      sourceText: "",
      issueOutcome: null,
    },
    ...(onStarted ? { onStarted } : {}),
    promise,
    resolve,
    reject,
  };
}

async function prepareParticipant(participant: Participant): Promise<void> {
  if (participant.input.kind !== "human") return;
  // A steer rejected because its turn ended is queued again. Refresh its
  // evidence too, and release the abandoned material before fetching more.
  disposeParticipant(participant);
  delete participant.artifacts;
  delete participant.input.message;
  const message = await participant.input.prepare();
  participant.input.message = message;
  participant.chatName = message.chatName;
  if (message.artifacts) participant.artifacts = message.artifacts;
  const provenance = message.topicEvidence ? issueProvenance(participant.context, message.topicEvidence) : undefined;
  participant.toolState = { mutationCount: 0, sourceText: message.text, issueOutcome: null,
    ...(provenance ? { provenance } : {}) };
}

function preparedMessage(input: Extract<Participant["input"], { kind: "human" }>): HydratedFeishuMessage {
  if (!input.message) throw new Error("Feishu evidence has not been prepared for this participant");
  return input.message;
}

/** Publishes this participant's files into the turn workspace and renders its message at the moment it enters the turn. */
function participantInput(participant: Participant, workspace: MaterialWorkspace): RuntimeTurnInput {
  const frame = currentTurnFrame(participant.chatName);
  if (participant.input.kind === "schedule") return { sourceMessageId: participant.context.sourceMessageId,
    text: schedulePrompt(participant.input.occurrence, frame), images: [], executionPolicy: "scheduled" };
  const message = preparedMessage(participant.input);
  const materials = workspace.publish(participant.artifacts);
  const topicEvidence = message.topicEvidence ? workspace.publishTopicEvidence(message.topicEvidence) : undefined;
  const sources = workspace.publishSources(feishuTurnSources(participant.context, message));
  return {
    sourceMessageId: participant.context.sourceMessageId,
    text: runtimeUserMessage(message, materials, frame, { sources, ...(topicEvidence ? { topicEvidence } : {}) }),
    images: [
      ...message.materials.flatMap(({ dataUrl }) => dataUrl ? [imageFromDataUrl(dataUrl)] : []),
    ],
  };
}
function scheduledParticipant(occurrence: ScheduleOccurrence, chatName: string | null): Participant & { promise: Promise<RuntimeAgentResponse> } {
  let resolve!: Participant["resolve"];
  let reject!: Participant["reject"];
  const promise = new Promise<RuntimeAgentResponse>((yes, no) => { resolve = yes; reject = no; });
  const context = { chatId: occurrence.schedule.chatId, threadKey: occurrence.schedule.threadKey,
    sourceMessageId: `${occurrence.schedule.id}:${occurrence.dueAt}`, requesterId: "schedule" };
  return { context, chatName, input: { kind: "schedule", occurrence },
    toolState: { mutationCount: 0, sourceText: occurrence.schedule.task, issueOutcome: null, scheduledResources: occurrence.schedule.resources },
    resolve, reject, promise };
}

function disposeParticipant(participant: Participant): void {
  participant.artifacts?.dispose();
}

function disposeParticipants(participants: readonly Participant[]): void {
  for (const participant of participants) disposeParticipant(participant);
}

function markStarted(participant: Participant): void {
  try {
    participant.onStarted?.();
  } catch (error) {
    log.warn("runtime.turn.started_callback_failed", {
      messageId: participant.context.sourceMessageId,
      error: asError(error).message,
    });
  }
}

function imageFromDataUrl(dataUrl: string): { data: string; mimeType: string } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Hydrated image is not a supported base64 data URL");
  return { mimeType: match[1]!, data: match[2]! };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
