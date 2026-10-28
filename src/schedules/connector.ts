import { createHash } from "node:crypto";
import type {
  ConnectorAdapter,
  ConnectorCatalog,
  ConnectorJsonSchemaProperty,
  ConnectorProviderManifest,
  ConnectorRequestContext,
  JsonValue,
} from "../connectors/protocol.ts";
import type { ConnectorSelectionStore } from "../connectors/selectionStore.ts";
import {
  bindScheduleResources,
  type ScheduleResourceReference,
} from "./authority.ts";
import {
  isScheduleSourceLink,
  type ScheduleDefinition,
  type ScheduleRecord,
  type ScheduleStore,
} from "./store.ts";
import { parseScheduleRule } from "./time.ts";

export const SCHEDULE_PROVIDER = "mochi-schedules";
export const SCHEDULE_CONNECTION = "mochi:schedules";
export const SCHEDULE_RESOURCE = "arrangements";

const text = (maximum: number): ConnectorJsonSchemaProperty => ({
  type: "string",
  minLength: 1,
  maxLength: maximum,
});
const identity = {
  schedule_id: text(128),
  revision: { type: "integer", minimum: 1 } as const,
};
const definition = {
  title: text(120),
  task: text(4_000),
  rule: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["once", "daily", "weekly"] },
      timeZone: text(100),
      time: text(5),
      at: text(64),
      weekdays: {
        type: "array",
        minItems: 1,
        maxItems: 7,
        items: { type: "integer", minimum: 1, maximum: 7 },
      },
    },
    required: ["kind", "timeZone"],
    additionalProperties: false,
  } as const,
  delivery: {
    type: "string",
    enum: ["group", "thread", "original_thread"],
    description:
      "group: 同一群的一条新消息；thread: 当前发话所在的话题；original_thread: 最初交代时的话题。创建时必须回读去向；修改时仅在用户明确改去向时传此字段，否则保留已有去向。目标由 Bridge 绑定，不接受指定消息或群。",
  } as const,
  resources: {
    type: "array",
    maxItems: 20,
    items: {
      type: "object",
      properties: {
        connectionId: text(128),
        resourceId: text(128),
      },
      required: ["connectionId", "resourceId"],
      additionalProperties: false,
    },
  } as const,
};
function capability(
  id: string,
  displayName: string,
  description: string,
  properties: Record<string, ConnectorJsonSchemaProperty>,
  required = Object.keys(properties),
) {
  const write = id !== "list";
  return {
    id: `schedule.${id}`,
    displayName,
    description,
    operation: write ? ("write" as const) : ("read" as const),
    resourceTypes: ["schedule_scope"],
    inputSchema: {
      type: "object" as const,
      properties,
      required,
      additionalProperties: false as const,
    },
    resourceSelection: "required" as const,
    requestAuthorization: write
      ? ("current_message" as const)
      : ("none" as const),
    requiredScopes: [],
    idempotency: write ? ("required" as const) : ("none" as const),
    readback: write ? ("required" as const) : ("none" as const),
  };
}
const manifest: ConnectorProviderManifest = {
  id: SCHEDULE_PROVIDER,
  version: "1.0.0",
  displayName: "安排",
  resourceTypes: [{ id: "schedule_scope", displayName: "当前话题的安排" }],
  capabilities: [
    capability(
      "list",
      "查看安排",
      "返回当前话题或安排结果下的安排，以及当前准确时间和本机时区。",
      {},
    ),
    capability(
      "create",
      "交代未来工作",
      "支持一次性、每天、指定星期。task 必须自包含，写明具体事项、查什么、交付什么，不能只说‘这个’；资源仅绑定明确选中的目录引用。时间有歧义先询问；Bridge 不猜自然语言。到点只调查、总结或提醒，不修改外部服务。",
      definition,
    ),
    capability(
      "update",
      "修改安排",
      "替换工作、时间和明确资源；delivery 可省略以保留约定去向，只有明确改变交付位置时提供。保留原群和原讨论关联；只影响以后接受的工作。",
      { ...identity, ...definition },
      [
        ...Object.keys(identity),
        ...Object.keys(definition).filter((key) => key !== "delivery"),
      ],
    ),
    capability(
      "pause",
      "暂停安排",
      "阻止以后开始，已接受的工作仍会交付。",
      identity,
    ),
    capability(
      "resume",
      "恢复安排",
      "从下个未来时点开始；过期的一次性安排须修改时间。",
      identity,
    ),
    capability(
      "cancel",
      "取消安排",
      "移除安排，已接受的工作仍会交付。",
      identity,
    ),
  ],
};

/** An internal capability, not another account or an alternative scheduler. */
export class ScheduleConnector implements ConnectorAdapter {
  readonly manifest = manifest;
  constructor(
    private readonly botId: string,
    private readonly store: ScheduleStore,
    private readonly selections: ConnectorSelectionStore,
    private readonly catalog: () => Promise<ConnectorCatalog>,
    private readonly appId: () => string | undefined,
    private readonly now = Date.now,
  ) {}

  async snapshot(botId: string) {
    if (botId !== this.botId)
      throw new Error("Schedule connector belongs to another Bot");
    return [
      {
        botId,
        providerId: SCHEDULE_PROVIDER,
        connectionId: SCHEDULE_CONNECTION,
        status: "ready" as const,
        account: null,
        grantedScopes: [],
        resourceScope: { status: "ready" as const, selectedCount: 1 },
        resources: [
          {
            id: SCHEDULE_RESOURCE,
            type: "schedule_scope",
            displayName: "当前话题",
            selected: true,
            writable: true,
          },
        ],
      },
    ];
  }
  async read(
    request: Parameters<ConnectorAdapter["read"]>[0],
  ): Promise<JsonValue> {
    const scope = this.#scope(request.context);
    return {
      current_time: new Date(this.now()).toISOString(),
      local_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      schedules: this.store
        .inTopic(scope.appId, scope.chatId, request.context.topicKey)
        .map(scheduleSummary),
    };
  }
  async write(request: Parameters<ConnectorAdapter["write"]>[0]) {
    const scope = this.#scope(request.context);
    const input = request.input as Record<string, JsonValue>;
    const operation = request.capability.id.slice("schedule.".length);
    const now = this.now();
    if (operation === "create" || operation === "update") {
      const current =
        operation === "update"
          ? this.#current(
              scope,
              request.context,
              input.schedule_id,
              input.revision,
            )
          : undefined;
      const resources = bindScheduleResources(
        this.botId,
        input.resources as unknown as ScheduleResourceReference[],
        await this.catalog(),
        this.selections,
      );
      const delivery = deliveryDefinition(
        input.delivery,
        current,
        request.context,
      );
      const content = {
        title: input.title as string,
        task: input.task as string,
        rule: parseScheduleRule(input.rule),
        ...delivery,
        resources,
      };
      const result = current
        ? this.store.update(
            current.id,
            current.revision,
            { ...origin(current), ...content },
            now,
          )
        : this.store.create(
            `schedule:${createHash("sha256").update(request.idempotencyKey!).digest("hex")}`,
            {
              ...content,
              ...scope,
              threadKey: request.context.topicKey,
              replyMessageId: request.context.sourceMessageId,
              requesterId: request.context.requesterId,
              sourceMessageLink: isScheduleSourceLink(
                request.context.provenance?.sourceMessageLink,
              )
                ? request.context.provenance!.sourceMessageLink
                : null,
            },
            now,
          );
      return { status: "applied" as const, readback: scheduleSummary(result) };
    }
    const current = this.#current(
      scope,
      request.context,
      input.schedule_id,
      input.revision,
    );
    if (operation === "cancel") {
      this.store.cancel(current.id, current.revision);
      return {
        status: "applied" as const,
        readback: {
          schedule_id: current.id,
          cancelled: !this.store.list().some((item) => item.id === current.id),
        },
      };
    }
    if (operation !== "pause" && operation !== "resume")
      throw new Error("Unknown schedule operation");
    return {
      status: "applied" as const,
      readback: scheduleSummary(
        this.store.setEnabled(
          current.id,
          current.revision,
          operation === "resume",
          now,
        ),
      ),
    };
  }
  #scope(context: ConnectorRequestContext) {
    const appId = this.appId();
    if (context.botId !== this.botId || !appId || !context.conversationId)
      throw new Error("安排只能由当前群的人类消息管理。");
    return { appId, chatId: context.conversationId };
  }
  #current(
    scope: { appId: string; chatId: string },
    context: ConnectorRequestContext,
    id: JsonValue | undefined,
    revision: JsonValue | undefined,
  ) {
    const current = this.store
      .inTopic(scope.appId, scope.chatId, context.topicKey)
      .find((item) => item.id === id);
    if (!current || current.revision !== revision)
      throw new Error("请先查看当前话题的安排，再操作同一版本。");
    return current;
  }
}
/** Position comes from the actual speaker; a content/time edit preserves it. */
function deliveryDefinition(
  value: JsonValue | undefined,
  current: ScheduleRecord | undefined,
  context: ConnectorRequestContext,
): Pick<ScheduleDefinition, "delivery" | "threadTarget"> {
  if (value === undefined && current)
    return { delivery: current.delivery, threadTarget: current.threadTarget };
  if (value === "group") return { delivery: "group", threadTarget: null };
  if (value !== "thread" && value !== "original_thread")
    throw new Error("安排交付去向无效。");
  if (value === "original_thread" && current)
    return {
      delivery: "thread",
      threadTarget: {
        threadKey: current.threadKey,
        replyMessageId: current.replyMessageId,
        sourceMessageLink: current.sourceMessageLink,
      },
    };
  return {
    delivery: "thread",
    threadTarget: {
      threadKey: context.topicKey,
      replyMessageId: context.sourceMessageId,
      sourceMessageLink: isScheduleSourceLink(
        context.provenance?.sourceMessageLink,
      )
        ? context.provenance!.sourceMessageLink
        : null,
    },
  };
}
function origin(value: ScheduleDefinition): ScheduleDefinition {
  return {
    title: value.title,
    task: value.task,
    rule: value.rule,
    delivery: value.delivery,
    resources: value.resources,
    appId: value.appId,
    chatId: value.chatId,
    threadKey: value.threadKey,
    replyMessageId: value.replyMessageId,
    requesterId: value.requesterId,
    sourceMessageLink: value.sourceMessageLink,
    threadTarget: value.threadTarget,
  };
}
export function scheduleSummary(value: ScheduleRecord): JsonValue {
  return {
    schedule_id: value.id,
    revision: value.revision,
    title: value.title,
    task: value.task,
    rule: value.rule as unknown as JsonValue,
    delivery: value.delivery,
    source_message_link: value.sourceMessageLink,
    delivery_message_link: value.threadTarget?.sourceMessageLink ?? null,
    resources: value.resources.map(({ connectionId, resourceId }) => ({
      connectionId,
      resourceId,
    })),
    enabled: value.enabled,
    next_due_at:
      value.nextDueAt === null ? null : new Date(value.nextDueAt).toISOString(),
    last_run: value.lastRun as unknown as JsonValue,
  };
}
