import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { AgentToolExecutor, type ToolTurnState } from "../src/agent/tools.ts";
import { ConnectorBroker } from "../src/connectors/broker.ts";
import type {
  ConnectorAdapter,
  ConnectorRequestContext,
  JsonValue,
} from "../src/connectors/protocol.ts";
import { ConnectorRegistry } from "../src/connectors/registry.ts";
import {
  parseControlRequest,
  parseControlResponse,
  MOCHI_CONTROL_PROTOCOL_VERSION as version,
} from "../src/control/protocol.ts";
import {
  executionTools,
  type TurnExecution,
} from "../src/runtime/execution.ts";
import {
  SCHEDULE_CONNECTION,
  SCHEDULE_RESOURCE,
  ScheduleConnector,
} from "../src/schedules/connector.ts";
import { parseScheduleViews, projectSchedule } from "../src/schedules/view.ts";
import { StateStore } from "../src/state.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const now = Date.parse("2026-10-01T00:00Z");
const context: ConnectorRequestContext = {
  botId: "bot-a",
  sourceMessageId: "om_source",
  topicKey: "omt_origin",
  conversationId: "oc_group",
  requesterId: "ouHuman",
  sourceText: "每天下午三点检查事项20，把结果发到群里。",
};
const content = {
  title: "发布进展",
  task: "核对项目中 Issue 20 的关联 PR 和阻塞，给出原始依据。",
  rule: { kind: "daily", time: "15:00", timeZone: "Asia/Shanghai" },
  delivery: "group",
  resources: [{ connectionId: "service:one", resourceId: "document:one" }],
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mochi-schedule-connector-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const state = new StateStore(join(root, "state.sqlite"));
  cleanup.push(() => state.close());
  state.replaceConnectorSelections("service:one", [
    {
      connectionId: "service:one",
      resourceId: "document:one",
      resourceType: "document",
      displayName: "selected",
      address: "provider-proof",
      selectionId: "a".repeat(32),
    },
  ]);
  let reads = 0;
  const provider: ConnectorAdapter = {
    manifest: {
      id: "service",
      version: "1.0.0",
      displayName: "Service",
      resourceTypes: [{ id: "document", displayName: "Document" }],
      capabilities: [
        {
          id: "document.read",
          displayName: "Read",
          description: "Read current evidence",
          operation: "read",
          resourceTypes: ["document"],
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          resourceSelection: "required",
          requestAuthorization: "none",
          requiredScopes: [],
          idempotency: "none",
          readback: "none",
        },
      ],
    },
    snapshot: async (botId) => [
      {
        botId,
        providerId: "service",
        connectionId: "service:one",
        status: "ready",
        account: null,
        grantedScopes: [],
        resourceScope: { status: "ready" as const, selectedCount: 2 },
        resources: ["document:one", "document:two"].map((id) => ({
          id,
          type: "document",
          displayName: id,
          selected: true,
        })),
      },
    ],
    read: async () => {
      reads++;
      return { evidence: "current" };
    },
    write: async () => {
      throw Error("Unexpected write");
    },
  };
  const registry = new ConnectorRegistry();
  registry.register(provider);
  const broker = new ConnectorBroker(registry, state);
  registry.register(
    new ScheduleConnector(
      context.botId,
      state.schedules,
      state,
      () => broker.catalog(context.botId),
      () => "cliApp",
      () => now,
    ),
  );
  const request = async (
    capabilityId: string,
    input: JsonValue,
    scope = context,
  ) => ({
    connectionId: SCHEDULE_CONNECTION,
    resourceId: SCHEDULE_RESOURCE,
    capabilityId: `schedule.${capabilityId}`,
    catalogRevision: (await broker.catalog(scope.botId)).revision,
    input,
    authorizationQuote: scope.sourceText,
    idempotencyKey: `operation:${capabilityId}:${scope.sourceMessageId}`,
  });
  return { state, broker, request, reads: () => reads };
}

test("human creation, readback and replay use the real connector ledger without changing the tool ABI", async () => {
  const f = fixture();
  const request = await f.request("create", content);
  await expect(
    f.broker.write(context, { ...request, authorizationQuote: "其他群的授权" }),
  ).rejects.toMatchObject({ code: "authorization_missing" });
  const first = await f.broker.write(context, request);
  expect(first.readback).toMatchObject({
    title: content.title,
    delivery: "group",
    enabled: true,
    next_due_at: "2026-10-01T07:00:00.000Z",
  });
  expect((await f.broker.write(context, request)).status).toBe(
    "already_applied",
  );
  expect(f.state.schedules.list()).toHaveLength(1);
  const saved = f.state.schedules.list()[0]!;
  expect(saved.resources[0]?.selectionId).toBe("a".repeat(32));
  await expect(
    f.broker.write(
      context,
      await f.request("create", { ...content, chatId: "another" }),
    ),
  ).rejects.toMatchObject({ code: "input_invalid" });
});

test("original discussion and a delivered result manage the same arrangement, without merging topics or human authorization", async () => {
  const f = fixture();
  await f.broker.write(context, await f.request("create", content));
  let saved = f.state.schedules.list()[0]!;
  const run = f.state.schedules.claim(
    saved.id,
    saved.revision,
    Date.parse("2026-10-01T07:00Z"),
  )!;
  f.state.recordScheduleDelivery(saved, run.dueAt, {
    chatId: "oc_group",
    messageId: "om_result",
    threadKey: "om_result",
  });
  const canonical = f.state.resolveTopicIdentity("oc_group", "omt_result", [
    "om_result",
  ]);
  expect(canonical.active).toBe(true);
  expect(f.state.topicIsActive("oc_group", "omt_other")).toBe(false);
  expect(
    f.state.schedules.inTopic("cliApp", "oc_group", "omt_result")[0]?.id,
  ).toBe(saved.id);
  expect(f.state.schedules.inTopic("cliApp", "oc_other", "omt_result")).toEqual(
    [],
  );
  const newHuman = {
    ...context,
    sourceMessageId: "om_later",
    topicKey: "omt_result",
    requesterId: "ouTeammate",
    sourceText: "改到每天四点，在原话题安静跟进。",
  };
  saved = f.state.schedules.get(saved.id);
  const modified = await f.broker.write(
    newHuman,
    await f.request(
      "update",
      {
        ...content,
        schedule_id: saved.id,
        revision: saved.revision,
        rule: { ...content.rule, time: "16:00" },
        delivery: "original_thread",
      },
      newHuman,
    ),
  );
  expect(modified.readback).toMatchObject({
    rule: { time: "16:00" },
    delivery: "thread",
  });
  saved = f.state.schedules.get(saved.id);
  expect(saved.replyMessageId).toBe(context.sourceMessageId);
  expect(saved.threadTarget?.replyMessageId).toBe(context.sourceMessageId);
  const foreign = { ...newHuman, topicKey: "omt_other" };
  await expect(
    f.broker.write(
      foreign,
      await f.request(
        "pause",
        { schedule_id: saved.id, revision: saved.revision },
        foreign,
      ),
    ),
  ).rejects.toMatchObject({ code: "adapter_failed" });
  // The human message that asked for the arrangement activated its topic;
  // Feishu later reports the canonical thread for the same discussion.
  f.state.claimEvent(
    "om_source",
    {
      chatId: "oc_group",
      threadKey: "omt_origin",
      requesterId: "ouHuman",
      sourceMessageId: "om_source",
    },
    true,
  );
  f.state.resolveTopicIdentity("oc_group", "omt_canonical", [
    "omt_origin",
    "om_source",
  ]);
  expect(
    f.state.schedules.inTopic("cliApp", "oc_group", "omt_canonical")[0]?.id,
  ).toBe(saved.id);
});

test("this discussion means the actual current discussion, while a time-only change preserves delivery", async () => {
  const f = fixture();
  await f.broker.write(context, await f.request("create", content));
  let saved = f.state.schedules.list()[0]!;
  const run = f.state.schedules.claim(
    saved.id,
    saved.revision,
    Date.parse("2026-10-01T07:00Z"),
  )!;
  f.state.recordScheduleDelivery(saved, run.dueAt, {
    chatId: "oc_group",
    messageId: "om_result",
    threadKey: "omt_result",
  });
  const human = {
    ...context,
    sourceMessageId: "om_later",
    topicKey: "omt_result",
    sourceText: "以后留在这个话题里，不单独发群消息。",
  };
  saved = f.state.schedules.get(saved.id);
  await f.broker.write(
    human,
    await f.request(
      "update",
      {
        ...content,
        schedule_id: saved.id,
        revision: saved.revision,
        delivery: "thread",
      },
      human,
    ),
  );
  saved = f.state.schedules.get(saved.id);
  expect(saved.threadKey).toBe(context.topicKey);
  expect(saved.threadTarget).toEqual({
    threadKey: "omt_result",
    replyMessageId: "om_later",
    sourceMessageLink: null,
  });
  const timeOnly = {
    ...context,
    sourceMessageId: "om_newtime",
    sourceText: "时间改成每天四点。",
  };
  const { delivery: _delivery, ...unchangedContent } = content;
  await f.broker.write(
    timeOnly,
    await f.request(
      "update",
      {
        ...unchangedContent,
        schedule_id: saved.id,
        revision: saved.revision,
        rule: { ...content.rule, time: "16:00" },
      },
      timeOnly,
    ),
  );
  expect(f.state.schedules.get(saved.id).threadTarget).toEqual(
    saved.threadTarget,
  );
  f.state.resolveTopicIdentity("oc_group", "omt_canonical", [
    "omt_result",
    "om_result",
  ]);
  expect(f.state.schedules.get(saved.id).threadTarget?.threadKey).toBe(
    "omt_canonical",
  );
});

test("scheduled tools expose only pinned reads and fail closed after a new selection identity", async () => {
  const f = fixture();
  await f.broker.write(context, await f.request("create", content));
  const tools = new AgentToolExecutor(f.broker, context.botId, f.state);
  const turn: ToolTurnState = {
    mutationCount: 0,
    sourceText: content.task,
    issueOutcome: null,
    scheduledResources: f.state.schedules.list()[0]!.resources,
  };
  const source = {
    chatId: "oc_group",
    threadKey: "omt_origin",
    requesterId: "schedule",
    sourceMessageId: "schedule:occurrence",
  };
  const output = (
    await tools.execute("connector_catalog", {}, source, turn)
  )[0]!;
  if (output.type !== "text") throw Error("Expected connector catalog text");
  const catalog = JSON.parse(output.text) as {
    revision: string;
    connections: { resources: unknown[] }[];
  };
  expect(catalog.connections).toHaveLength(1);
  expect(catalog.connections[0]?.resources).toHaveLength(1);
  const read = {
    connection_id: "service:one",
    capability_id: "document.read",
    catalog_revision: catalog.revision,
    input: "{}",
    resource_id: "document:one",
  };
  await tools.execute("connector_read", read, source, turn);
  expect(f.reads()).toBe(1);
  await expect(
    tools.execute(
      "connector_read",
      { ...read, resource_id: "document:two" },
      source,
      turn,
    ),
  ).rejects.toThrow("指定");
  await expect(
    tools.execute("connector_write", {}, source, turn),
  ).rejects.toThrow("写入");
  await expect(
    tools.execute(
      "connector_describe",
      {
        ...read,
        connection_id: SCHEDULE_CONNECTION,
        capability_id: "schedule.create",
      },
      source,
      turn,
    ),
  ).rejects.toThrow("只读");
  f.state.replaceConnectorSelections(
    "service:one",
    f.state
      .connectorSelections("service:one")
      .map((item) => ({ ...item, selectionId: "b".repeat(32) })),
  );
  await expect(
    tools.execute("connector_read", read, source, turn),
  ).rejects.toThrow("授权已变化");
  expect(f.reads()).toBe(1);
});

test("scheduled native tools cannot use scratch writes to replace the public research command", async () => {
  const calls: string[] = [];
  const execution = {
    execute: async (name: string) => {
      calls.push(name);
      return { content: [] };
    },
  } as unknown as TurnExecution;
  const tools = executionTools(
    () => execution,
    () => "scheduled",
  );
  const unusedContext = {} as ExtensionToolContext;
  for (const name of ["bash", "edit", "write"])
    await expect(
      tools
        .find((tool) => tool.name === name)!
        .execute("call", {}, undefined, undefined, unusedContext),
    ).rejects.toThrow("Scheduled work");
  await tools
    .find((tool) => tool.name === "read")!
    .execute("call", {}, undefined, undefined, unusedContext);
  expect(calls).toEqual(["read"]);
});

test("private control projection omits source identity and rejects unknown, crossed or malformed fields", async () => {
  const f = fixture();
  await f.broker.write(context, await f.request("create", content));
  const saved = f.state.schedules.list()[0]!;
  const view = projectSchedule(saved, "项目协作", null);
  expect(JSON.stringify(view)).not.toContain("om_source");
  expect(JSON.stringify(view)).not.toContain("selectionId");
  expect(parseScheduleViews([view])).toEqual([view]);
  expect(() => parseScheduleViews([{ ...view, appId: "private" }])).toThrow();
  expect(
    parseControlResponse(
      JSON.stringify({ version, ok: true, schedules: [view] }),
      "read_schedules",
    ).schedules,
  ).toEqual([view]);
  for (const request of [
    { version, command: "read_schedules" },
    {
      version,
      command: "cancel_schedule",
      botId: "11111111-1111-4111-8111-111111111111",
      scheduleId: saved.id,
      revision: saved.revision,
      chatId: "arbitrary",
    },
    {
      version,
      command: "set_schedule_enabled",
      botId: "11111111-1111-4111-8111-111111111111",
      scheduleId: saved.id,
      revision: 0,
      enabled: true,
    },
  ])
    expect(() => parseControlRequest(JSON.stringify(request))).toThrow();
});
