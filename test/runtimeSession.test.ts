import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaterialWorkspace } from "../src/attachments/materialWorkspace.ts";
import { AgentToolExecutor } from "../src/agent/tools.ts";
import { BOT_ID, fixedSelection, githubBroker } from "./connectorFixture.ts";
import type { MessageContext } from "../src/domain.ts";
import { IssueWorkflow } from "../src/issueWorkflow.ts";
import type { HydratedFeishuMessage } from "../src/lark/messageHydrator.ts";
import {
  RuntimeSessionAgent,
  type RuntimeSessionClient,
  type RuntimeSessionObserver,
  type RuntimeToolExecutor,
} from "../src/runtime/sessionAgent.ts";
import type { RuntimeContextUsage, RuntimeTurnInput } from "../src/runtime/protocol.ts";
import { StateStore } from "../src/state.ts";
import { repositoryScope } from "./githubFixtures.ts";

const directories: string[] = [];
const ABI = `sha256:${"c".repeat(64)}`;
const SESSION = "permanent-pi-session";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("permanent Pi Runtime Session", () => {
  test("queued evidence is fetched at dequeue instead of admission", async () => {
    const fixture = setup();
    const release = Promise.withResolvers<string>();
    const queued = Promise.withResolvers<void>();
    const client = new class extends FakeRuntimeClient {
      override async startTurn(input: RuntimeTurnInput) {
        this.inputs.push(input);
        return { turnId: `turn-${this.inputs.length}`, completed: this.inputs.length === 1 ? release.promise : Promise.resolve("done") };
      }
    };
    const agent = createAgent(fixture, client, undefined, {
      runtimeStateChanged: (state) => { if (state.queueDepth === 2) queued.resolve(); },
      contextUsageChanged: () => undefined,
    });
    let revision = "before waiting";
    let prepared = 0;
    try {
      const first = agent.respond(context("om_active", "topic-a"), () => message("first"));
      const second = agent.respond(context("om_queued", "topic-b"), () => { prepared++; return message(revision); });
      const third = agent.respond(context("om_cancelled", "topic-c"), () => { prepared++; return message("cancelled"); });
      await queued.promise;
      expect(prepared).toBe(0);
      revision = "current evidence after waiting";
      release.resolve("done");
      await first;
      await second;
      // Turn B uses the value read at its actual start, not the admission time.
      expect(client.inputs[1]!.text).toContain(revision);
      await third;
      expect(prepared).toBe(2);
    } finally { release.resolve("done"); await agent.close(); fixture.state.close(); }
  });

  test("a queued message that cannot start fails alone and the queue behind it continues", async () => {
    const fixture = setup();
    const release = Promise.withResolvers<string>();
    const queued = Promise.withResolvers<void>();
    const client = new class extends FakeRuntimeClient {
      override async startTurn(input: RuntimeTurnInput) {
        this.inputs.push(input);
        return { turnId: `turn-${this.inputs.length}`,
          completed: this.inputs.length === 1 ? release.promise : Promise.resolve(`reply ${input.sourceMessageId}`) };
      }
    };
    const agent = createAgent(fixture, client, undefined, {
      runtimeStateChanged: (state) => { if (state.queueDepth === 2) queued.resolve(); },
      contextUsageChanged: () => undefined,
    });
    try {
      const first = agent.respond(context("om_active", "topic-a"), () => message("first"));
      // Evidence is fetched at dequeue; a recalled message is refused there.
      const recalled = agent.respond(context("om_recalled", "topic-b"), () => { throw new Error("message was recalled"); })
        .then(() => undefined, (error: unknown) => error);
      const next = agent.respond(context("om_next", "topic-c"), () => message("next"));
      await queued.promise;
      release.resolve("done");
      await expect(first).resolves.toMatchObject({ kind: "reply" });
      expect(await recalled).toMatchObject({ message: "message was recalled" });
      await expect(next).resolves.toEqual({ kind: "reply", text: "reply om_next", issueOutcome: null });
      expect(client.inputs.map((input) => input.sourceMessageId)).toEqual(["om_active", "om_next"]);
    } finally { release.resolve("done"); await agent.close(); fixture.state.close(); }
  });

  test("a goal-only request supports dependent tool composition through the real executor", async () => {
    const fixture = setup();
    const requests: string[] = [];
    const { broker } = githubBroker({
      state: fixture.state,
      issues: new IssueWorkflow(fixture.state, async () => {
        throw new Error("Unexpected Issue write");
      }),
      available: [20, 21],
      selection: fixedSelection(async (id) => {
        if (id !== 20) throw new Error("Repository is not selected");
        return { scope: repositoryScope, fullName: "customer/project", request: async (path, method) => {
          expect(method).toBe("GET");
          requests.push(path);
          if (path === "/repos/customer/project") return { default_branch: "release" };
          if (path.startsWith("/search/code?")) return { items: [{ path: "src/billing.ts" }] };
          if (path === "/repos/customer/project/contents/src/billing.ts?ref=release") {
            return { type: "file", encoding: "base64", content: Buffer.from("export const refundDays = 14;").toString("base64") };
          }
          throw new Error(`Unexpected read: ${path}`);
        } };
      }),
    });
    const tools = new AgentToolExecutor(broker, BOT_ID);
    // This scripts model choices to verify the host path, not model initiative.
    const client = new class extends FakeRuntimeClient {
      override async startTurn(input: RuntimeTurnInput, handler: Parameters<RuntimeSessionClient["startTurn"]>[1]) {
        this.inputs.push(input);
        const call = async (name: string, args: unknown) => {
          const output = await handler(input.sourceMessageId, name, args);
          if (!Array.isArray(output) || output[0]?.type !== "text") throw new Error("Expected tool evidence");
          return JSON.parse(output[0].text);
        };
        return { turnId: "composed-turn", completed: (async () => {
          // The catalog is the only source of the identifiers every later call
          // needs, so this proves the model can compose without a per-provider tool.
          const catalog = await call("connector_catalog", {});
          const revision = catalog.revision;
          const connection = catalog.connections[0];
          const resources = connection.resources as readonly {
            resource_id: string;
            type: string;
            name: string;
            selected: boolean;
            writable: boolean | null;
          }[];
          expect(resources).toEqual([
            { resource_id: "repository:20", type: "repository", name: "customer/mochi", selected: true, writable: true },
            { resource_id: "repository:21", type: "repository", name: "customer/project-21", selected: false, writable: true },
          ]);
          const resource = resources.find((entry) => entry.resource_id === "repository:20");
          if (!resource) throw new Error("Expected the selected repository in the catalog");
          const call_ = async (capabilityId: string, input: unknown) => call("connector_read", {
            connection_id: connection.connection_id,
            resource_id: resource.resource_id,
            capability_id: capabilityId,
            catalog_revision: revision,
            input: JSON.stringify(input),
          });
          const overview = await call_("repository.overview", {});
          const matches = await call_("search.code", { query: "refundDays", limit: 5 });
          // An authorized but unselected resource remains visible as an option;
          // the Broker still refuses it before any provider read.
          await expect(call("connector_read", {
            connection_id: connection.connection_id,
            resource_id: "repository:21",
            capability_id: "get.content",
            catalog_revision: revision,
            input: JSON.stringify({ path: matches[0].path, ref: overview.default_branch }),
          })).rejects.toThrow();
          const file = await call_("get.content", { path: matches[0].path, ref: overview.default_branch });
          expect(file.content_truncated).toBe(false);
          return file.content;
        })() };
      }
    }();
    const agent = createAgent(fixture, client, tools);
    try {
      const goal = "根据当前实现，帮我核对合作方材料中关于退款期限的承诺。";
      expect(await agent.respond(context("om_composition", "topic-a"), () => message(goal))).toEqual({
        kind: "reply", text: "export const refundDays = 14;", issueOutcome: null,
      });
      expect(client.inputs).toHaveLength(1);
      expect(client.inputs[0]?.text).toContain(goal);
      expect(requests).toHaveLength(3);
      expect(fixture.state.runtimeSession()).toMatchObject({ sessionId: SESSION, turnCount: 1 });
    } finally { await agent.close(); fixture.state.close(); }
  });

  for (const reply of ["无法读取实时商品价格。", "已经核对，这三个候选中第二个总价最低。", "请确认要更新的 Issue。", "DONE"]) {
    test(`a natural-language reply does not manufacture a workflow result: ${reply}`, async () => {
      const fixture = setup();
      const client = new FakeRuntimeClient();
      client.replyText = reply;
      const agent = createAgent(fixture, client);
      try {
        expect(await agent.respond(context("om_reply", "topic-a"), () => message("查一下")))
          .toEqual({ kind: "reply", text: reply, issueOutcome: null });
        expect(fixture.state.runtimeSession()?.turnCount).toBe(1);
      } finally { await agent.close(); fixture.state.close(); }
    });
  }

  for (const issueOutcome of ["completed", "waiting", "blocked"] as const) {
    test(`preserves a verified ${issueOutcome} Issue outcome through steering without leaking it to another topic`, async () => {
      const fixture = setup();
      const client = new FakeRuntimeClient();
      const agent = createAgent(fixture, client, { execute: async (_name, _args, context, turn) => {
        if (context.sourceMessageId === "om_issue") turn.issueOutcome = issueOutcome;
        return [{ type: "text", text: "{}" }];
      } });
      try {
        const results = await Promise.all([
          agent.respond(context("om_issue", "topic-a"), () => message("更新 Issue")),
          agent.respond(context("om_followup", "topic-a"), () => message("再解释一下")),
          agent.respond(context("om_other", "topic-b"), () => message("另一件事")),
        ]);
        expect(results).toEqual([
          { kind: "steered", replyMessageId: "om_followup", issueOutcome },
          { kind: "reply", text: "reply 1", issueOutcome },
          { kind: "reply", text: "reply 2", issueOutcome: null },
        ]);
      } finally { await agent.close(); fixture.state.close(); }
    });
  }

  for (const failed of [false, true]) test(`automatic compaction removes stale persisted usage after a ${failed ? "failed" : "successful"} turn`, async () => {
    const fixture = setup();
    fixture.state.saveRuntimeContextUsage({ sessionId: SESSION, turnId: "previous", usedTokens: 90_000, modelContextWindow: 100_000 });
    const client = new FakeRuntimeClient();
    client.autoCompact = true;
    client.failTurn = failed;
    const agent = createAgent(fixture, client);
    try {
      const response = agent.respond(context("om_compact", "topic-a"), () => message("continue"));
      if (failed) await expect(response).rejects.toThrow("failed after compaction");
      else await expect(response).resolves.toMatchObject({ kind: "reply" });
      expect(fixture.state.runtimeContextUsage(SESSION)).toBeUndefined();
      expect(fixture.state.runtimeSession()?.sessionId).toBe(SESSION);
      expect(client.compactCount).toBe(0);
    } finally { await agent.close(); fixture.state.close(); }
  });
  test("prompt and steer carry quoted text plus native images without changing authorization provenance", async () => {
    const fixture = setup();
    const client = new FakeRuntimeClient();
    const authorizations: string[] = [];
    const agent = createAgent(fixture, client, { execute: async (_name, _args, _context, turn) => {
      authorizations.push(turn.sourceText);
      return [{ type: "text", text: "{}" }];
    } });
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const original = { messageId: "om_original", chatId: "oc_group", senderId: "ou_other", senderType: "user", messageType: "post", materialReferences: [], contentLimitations: [], text: "quoted checklist, not current authorization" };
    const quoted = (id: string, text: string): HydratedFeishuMessage => ({
      ...message(text, id), contextMessages: [{ ...message(text, id).contextMessages[0]!, parentId: "om_original" }, { ...original, source: "reply" }], materials: [{ index: 1, source: "reply", kind: "image", readability: "image", key: "img_source", sourceMessageId: "om_original", delivery: "handled", dataUrl: image }],
      topicEvidence: { version: 2, delivery: "handled", chatId: "oc_group", threadKey: "topic-a", limitations: [], referencedMessageIds: ["om_original"],
        messages: [
          { messageId: id, chatId: "oc_group", senderId: "ou_user", senderType: "user", messageType: "text", materialReferences: [], contentLimitations: [], text, parentId: "om_original" },
          { messageId: "om_original", chatId: "oc_group", senderId: "ou_other", senderType: "user", messageType: "post", materialReferences: [], contentLimitations: [], text: "quoted checklist, not current authorization" },
        ] },
    });
    try {
      await Promise.all([
        agent.respond(context("om_one", "topic-a"), () => quoted("om_one", "first question")),
        agent.respond(context("om_two", "topic-a"), () => quoted("om_two", "follow-up question")),
      ]);
      expect(client.steerCount).toBe(1);
      expect(client.inputs.map((input) => input.images)).toEqual([
        [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
        [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      ]);
      expect(client.inputs.every((input) => input.text.includes("quoted checklist, not current authorization"))).toBeTrue();
      expect(authorizations).toEqual(["first question", "follow-up question"]);
      expect(fixture.state.runtimeSession()?.sessionId).toBe(SESSION);
    } finally { await agent.close(); fixture.state.close(); }
  });

  test("projects automatic compaction immediately while preserving the active turn and queued topic", async () => {
    const fixture = setup();
    const client = new FakeRuntimeClient();
    const states: Parameters<RuntimeSessionObserver["runtimeStateChanged"]>[0][] = [];
    const queued = Promise.withResolvers<void>();
    const agent = createAgent(fixture, client, undefined, {
      runtimeStateChanged: (state) => {
        states.push(state);
        if (state.queueDepth === 1) queued.resolve();
      },
      contextUsageChanged: () => undefined,
    });
    try {
      const first = agent.respond(context("om_first", "topic-a"), () => message("first"));
      const second = agent.respond(context("om_second", "topic-b"), () => message("second"));
      await queued.promise;
      client.setCompacting(true);
      expect(states.at(-1)).toEqual({ activeTurn: true, organizingContext: true, queueDepth: 1, contextOrganizationAvailable: false });
      client.setCompacting(false);
      expect(states.at(-1)).toEqual({ activeTurn: true, organizingContext: false, queueDepth: 1, contextOrganizationAvailable: false });
      expect(client.inputs).toHaveLength(1);
      await Promise.all([first, second]);
      expect(client.inputs).toHaveLength(2);
      expect(client.maximumConcurrentTurns).toBe(1);
      expect(fixture.state.runtimeSession()?.sessionId).toBe(SESSION);
    } finally { await agent.close(); fixture.state.close(); }
    const count = states.length;
    client.setCompacting(true);
    expect(states).toHaveLength(count);
  });

  test("different groups share the permanent Session but never steer into each other's topic", async () => {
    const fixture = setup();
    const client = new FakeRuntimeClient();
    const agent = createAgent(fixture, client);
    const responses = await Promise.all([
      agent.respond({ ...context("om_one", "same-topic-key"), chatId: "oc_first" }, () => message("first group")),
      agent.respond({ ...context("om_two", "same-topic-key"), chatId: "oc_second" }, () => message("second group")),
    ]);
    expect(responses).toEqual([
      { kind: "reply", text: "reply 1", issueOutcome: null },
      { kind: "reply", text: "reply 2", issueOutcome: null },
    ]);
    expect(client.steerCount).toBe(0);
    expect(client.maximumConcurrentTurns).toBe(1);
    expect(client.resumeCount).toBe(1);
    expect(fixture.state.runtimeSession()).toMatchObject({ sessionId: SESSION, capabilityAbi: ABI, turnCount: 2 });
    await agent.close();
    fixture.state.close();
  });
  test("steers the active topic and serializes another topic", async () => {
    const fixture = setup();
    const client = new FakeRuntimeClient();
    const observedContexts: string[] = [];
    const agent = createAgent(fixture, client, {
      execute: async (_name, _args, context) => {
        observedContexts.push(context.sourceMessageId);
        return [{ type: "text", text: "{}" }];
      },
    });
    const responses = await Promise.all([
      agent.respond(context("om_one", "topic-a"), () => message("first")),
      agent.respond(context("om_two", "topic-a"), () => message("second")),
      agent.respond(context("om_three", "topic-b"), () => message("third")),
    ]);
    expect(responses).toEqual([
      { kind: "steered", replyMessageId: "om_two", issueOutcome: null },
      { kind: "reply", text: "reply 1", issueOutcome: null },
      { kind: "reply", text: "reply 2", issueOutcome: null },
    ]);
    expect(client.maximumConcurrentTurns).toBe(1);
    expect(client.steerCount).toBe(1);
    expect(client.inputs.map((input) => input.text)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
      expect.stringContaining("third"),
    ]);
    expect(observedContexts).toEqual(["om_one", "om_two"]);
    expect(fixture.state.runtimeSession()).toMatchObject({
      sessionId: SESSION,
      turnCount: 2,
      lastSourceMessageId: "om_three",
    });
    await agent.close();
    fixture.state.close();
  });

  test("fails closed when a tool call lacks accepted Feishu provenance", async () => {
    const fixture = setup();
    const client = new FakeRuntimeClient();
    client.invalidSteerProvenance = true;
    const agent = createAgent(fixture, client);
    const first = agent.respond(context("om_one", "topic-a"), () => message("first"));
    await expect(agent.respond(context("om_two", "topic-a"), () => message("second")))
      .rejects.toThrow("unknown Feishu source message provenance");
    await first;
    await agent.close();
    fixture.state.close();
  });

  test("fails before connecting when the capability ABI has drifted", async () => {
    const fixture = setup(`sha256:${"d".repeat(64)}`);
    const client = new FakeRuntimeClient();
    const agent = createAgent(fixture, client);
    await expect(agent.initialize()).rejects.toThrow("capability ABI mismatch");
    expect(client.resumeCount).toBe(0);
    await agent.close();
    fixture.state.close();
  });

  test("restores context usage and only organizes beyond three quarters", async () => {
    const fixture = setup();
    fixture.state.saveRuntimeContextUsage({
      sessionId: SESSION,
      turnId: "turn-before-restart",
      usedTokens: 76_000,
      modelContextWindow: 100_000,
    });
    const client = new FakeRuntimeClient();
    const states: Parameters<RuntimeSessionObserver["runtimeStateChanged"]>[0][] = [];
    const agent = createAgent(fixture, client, undefined, {
      runtimeStateChanged: (state) => states.push(state),
      contextUsageChanged: () => undefined,
    });
    await agent.initialize();
    expect(client.contextUsage()?.fractionUsed).toBe(0.76);
    expect(states.at(-1)?.contextOrganizationAvailable).toBeTrue();
    await agent.organizeContext();
    expect(client.compactCount).toBe(1);
    expect(fixture.state.runtimeContextUsage(SESSION)).toBeUndefined();
    expect(states.at(-1)?.contextOrganizationAvailable).toBeFalse();
    await agent.close();
    fixture.state.close();
  });

  test("revalidates the exact same permanent Session after an account change", async () => {
    const fixture = setup();
    const client = new FakeRuntimeClient();
    const agent = createAgent(fixture, client);
    await agent.initialize();
    await agent.revalidatePermanentSession();
    expect(client.resumeCount).toBe(2);
    await agent.close();
    fixture.state.close();
  });

  test("holds admission during manual compaction recovery and removes uncertain persisted usage", async () => {
    const fixture = setup();
    fixture.state.saveRuntimeContextUsage({ sessionId: SESSION, turnId: "previous", usedTokens: 90_000, modelContextWindow: 100_000 });
    const client = new FakeRuntimeClient();
    const compact = client.compactSession.bind(client);
    const started = Promise.withResolvers<void>();
    const recovered = Promise.withResolvers<void>();
    client.compactSession = async () => {
      client.setCompacting(true);
      started.resolve();
      await recovered.promise;
      client.setCompacting(false);
      expect(states.at(-1)?.organizingContext).toBeTrue();
      await compact();
      throw new Error("manual compaction timed out; original Session recovered");
    };
    const states: Parameters<RuntimeSessionObserver["runtimeStateChanged"]>[0][] = [];
    const agent = createAgent(fixture, client, undefined, {
      runtimeStateChanged: (state) => states.push(state),
      contextUsageChanged: () => undefined,
    });
    try {
      const organization = agent.organizeContext();
      const outcome = organization.then(() => undefined, (error: unknown) => error);
      await started.promise;
      const next = agent.respond(context("om_after_recovery", "topic-a"), () => message("new message"));
      expect(client.inputs).toHaveLength(0);
      expect(states.at(-1)?.organizingContext).toBeTrue();
      recovered.resolve();
      expect(await outcome).toMatchObject({ message: "麻薯这次没有整理好思绪，请稍后再试。" });
      await expect(next).resolves.toMatchObject({ kind: "reply" });
      expect(fixture.state.runtimeContextUsage(SESSION)).toBeUndefined();
      expect(fixture.state.runtimeSession()?.sessionId).toBe(SESSION);
      expect(states.at(-1)?.organizingContext).toBeFalse();
    } finally { recovered.resolve(); await agent.close(); fixture.state.close(); }
  });
});

function setup(capabilityAbi = ABI): { directory: string; state: StateStore } {
  const directory = mkdtempSync(join(tmpdir(), "mochi-runtime-session-"));
  directories.push(directory);
  const state = new StateStore(join(directory, "state.sqlite"));
  state.initializeRuntimeSession(SESSION, capabilityAbi);
  return { directory, state };
}

function createAgent(
  fixture: ReturnType<typeof setup>,
  client: RuntimeSessionClient,
  tools: RuntimeToolExecutor = { execute: async () => [{ type: "text", text: "{}" }] },
  observer?: RuntimeSessionObserver,
): RuntimeSessionAgent {
  return new RuntimeSessionAgent({
    config: {
      botId: "11111111-2222-4333-8444-555555555555",
      workerPath: "/usr/local/libexec/mochi-pi-runtime",
      sudoPath: "/usr/bin/sudo",
      runtimeUser: "_mochi",
      runtimeHome: "/Users/_mochi",
      runtimeCwd: "/Users/_mochi/empty-workspace",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      turnTimeoutMilliseconds: 1_000,
      sessionId: SESSION,
    },
    capabilityAbi: ABI,
    state: fixture.state,
    tools,
    client,
    ...(observer ? { observer } : {}),
    createMaterialWorkspace: materialWorkspaceFactory(fixture.directory),
  });
}

class FakeRuntimeClient implements RuntimeSessionClient {
  inputs: RuntimeTurnInput[] = [];
  resumeCount = 0;
  steerCount = 0;
  compactCount = 0;
  maximumConcurrentTurns = 0;
  invalidSteerProvenance = false;
  autoCompact = false;
  failTurn = false;
  replyText: string | undefined;
  #active = 0;
  #activeSourceMessageId: string | undefined;
  #toolHandler: ((sourceMessageId: string, name: string, args: unknown) => Promise<unknown>) | undefined;
  #usage: RuntimeContextUsage | undefined;
  #compacting = false;
  readonly #compactionListeners = new Set<() => void>();

  isCompacting(): boolean { return this.#compacting; }
  onCompactionChanged(listener: () => void): () => void {
    this.#compactionListeners.add(listener);
    return () => { this.#compactionListeners.delete(listener); };
  }
  setCompacting(active: boolean): void {
    this.#compacting = active;
    for (const listener of this.#compactionListeners) listener();
  }

  async resumeSession() {
    this.resumeCount += 1;
    return { sessionId: SESSION, capabilityAbi: ABI };
  }
  contextUsage(): RuntimeContextUsage | undefined { return this.#usage; }
  restoreContextUsage(usage: RuntimeContextUsage): void { this.#usage = usage; }
  async compactSession(): Promise<void> { this.compactCount += 1; this.#usage = undefined; }
  async startTurn(
    input: RuntimeTurnInput,
    toolHandler: (sourceMessageId: string, name: string, args: unknown) => Promise<unknown>,
  ) {
    this.inputs.push(input);
    this.#toolHandler = toolHandler;
    this.#activeSourceMessageId = input.sourceMessageId;
    this.#active += 1;
    this.maximumConcurrentTurns = Math.max(this.maximumConcurrentTurns, this.#active);
    const number = this.inputs.length - this.steerCount;
    return {
      turnId: `turn-${number}`,
      completed: new Promise<string>((resolve, reject) => setTimeout(() => {
        this.#active -= 1;
        if (this.autoCompact) this.#usage = undefined;
        if (this.failTurn) reject(new Error("failed after compaction"));
        else resolve(this.replyText ?? `reply ${number}`);
      }, 20)),
    };
  }
  async steerTurn(_turnId: string, input: RuntimeTurnInput): Promise<void> {
    this.steerCount += 1;
    this.inputs.push(input);
    if (this.invalidSteerProvenance) {
      await this.#toolHandler?.("om_unknown", "probe", {});
      return;
    }
    if (!this.#activeSourceMessageId) throw new Error("Fake runtime has no active provenance");
    await this.#toolHandler?.(this.#activeSourceMessageId, "probe", {});
    this.#activeSourceMessageId = input.sourceMessageId;
    await this.#toolHandler?.(input.sourceMessageId, "probe", {});
  }
  async close(): Promise<void> {}
}

function context(sourceMessageId: string, threadKey: string): MessageContext {
  return { chatId: "oc_group", sourceMessageId, threadKey, requesterId: "ou_user" };
}

function message(text: string, id = "om_current"): HydratedFeishuMessage {
  return {
    chatName: "研发群",
    messageType: "text",
    text,
    delivery: "handled",
    limitations: [],
    materials: [],
    contextMessages: [{
      messageId: id, chatId: "oc_group", senderId: "ou_user", senderType: "user", senderName: "林夏",
      messageType: "text", text, materialReferences: [], contentLimitations: [], source: "current",
    }],
  };
}

function materialWorkspaceFactory(directory: string): () => MaterialWorkspace {
  const root = join(directory, "materials");
  mkdirSync(root, { recursive: true });
  return () => new MaterialWorkspace(root);
}

test("scheduled work keeps the permanent Session and never steers with a human in its original topic", async () => {
  const fixture = setup();
  const client = new class extends FakeRuntimeClient {
    override async startTurn(input: RuntimeTurnInput, handler: Parameters<RuntimeSessionClient["startTurn"]>[1]) {
      const turn = await super.startTurn(input, handler);
      await handler(input.sourceMessageId, "probe", {});
      return turn;
    }
  }();
  const sources: { requester: string; scheduled: boolean }[] = [];
  const agent = createAgent(fixture, client, { execute: async (_name, _args, source, turn) => {
    sources.push({ requester: source.requesterId, scheduled: turn.scheduledResources !== undefined });
    return [{ type: "text", text: "{}" }];
  } });
  try {
    const schedule = fixture.state.schedules.create(`schedule:${"f".repeat(64)}`, {
      title: "发布进展", task: "检查项目中的 Issue 20", rule: { kind: "daily", time: "09:00", timeZone: "UTC" },
      appId: "cli_test", chatId: "oc_group", threadKey: "topic-a", replyMessageId: "om_origin", requesterId: "ou_original",
      resources: [], delivery: "group", sourceMessageLink: null, threadTarget: null,
    }, Date.parse("2026-10-01T00:00Z"));
    const scheduled = agent.respondToSchedule({ schedule, dueAt: schedule.nextDueAt!, startedAt: schedule.nextDueAt!, coalesced: false }, "研发群");
    while (client.inputs.length === 0) await Bun.sleep(1);
    const human = agent.respond(context("om_new_human", "topic-a"), () => message("请把刚才的 Issue 关闭。"));
    const responses = await Promise.all([scheduled, human]);
    expect(responses.map((item) => item.kind)).toEqual(["reply", "reply"]);
    expect(client.steerCount).toBe(0); expect(client.maximumConcurrentTurns).toBe(1);
    expect(client.inputs[0]?.executionPolicy).toBe("scheduled");
    expect(client.inputs[0]?.text).toContain("<scheduled_work>"); expect(client.inputs[0]?.text).not.toContain("<feishu_turn>");
    // Both turn kinds open with where and when; the scheduled one also carries its own rules.
    expect(client.inputs[0]?.text).toContain("群：研发群");
    expect(client.inputs[0]?.text).toContain("不继承安排或原话题的写入授权");
    expect(client.inputs[1]?.sourceMessageId).toBe("om_new_human");
    expect(client.inputs[1]?.text).toContain("群：研发群");
    for (const input of client.inputs) expect(input.text).toMatch(/时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周.（[^，]+，UTC[+-]\d{2}:\d{2}）/);
    expect(sources).toEqual([{ requester: "schedule", scheduled: true }, { requester: "ou_user", scheduled: false }]);
    expect(fixture.state.runtimeSession()).toMatchObject({ sessionId: SESSION, turnCount: 2 });
  } finally { await agent.close(); fixture.state.close(); }
});

test("schedule admission rejects an already busy human Session without queueing or borrowing its authority", async () => {
  const fixture = setup(); const client = new FakeRuntimeClient(); const agent = createAgent(fixture, client);
  try {
    const human = agent.respond(context("om_active", "topic-a"), () => message("正在讨论"));
    while (client.inputs.length === 0) await Bun.sleep(1);
    const schedule = fixture.state.schedules.create(`schedule:${"f".repeat(64)}`, {
      title: "发布进展", task: "检查项目中的 Issue 20", rule: { kind: "daily", time: "09:00", timeZone: "UTC" },
      appId: "cli_test", chatId: "oc_group", threadKey: "topic-a", replyMessageId: "om_origin", requesterId: "ou_original",
      resources: [], delivery: "thread", sourceMessageLink: null,
      threadTarget: { threadKey: "topic-a", replyMessageId: "om_origin", sourceMessageLink: null },
    }, Date.parse("2026-10-01T00:00Z"));
    await expect(agent.respondToSchedule({ schedule, dueAt: schedule.nextDueAt!, startedAt: schedule.nextDueAt!, coalesced: false }, "研发群")).rejects.toThrow("idle");
    await human; expect(client.inputs).toHaveLength(1); expect(client.steerCount).toBe(0);
  } finally { await agent.close(); fixture.state.close(); }
});
