import type {
  ConnectorCapabilityManifest,
  ConnectorProviderManifest,
  ConnectorResourceType,
} from "../protocol.ts";

/** The provider identifier every stored resource and scope belongs to. */
export const FEISHU_SERVICE_PROVIDER_ID = "feishu-service";

export const FEISHU_SERVICE_RESOURCE_TYPES: readonly ConnectorResourceType[] =
  Object.freeze([
    Object.freeze({ id: "document", displayName: "云文档" }),
    Object.freeze({ id: "wiki", displayName: "知识库" }),
  ]);

/**
 * Only reads are declared. The Bot's tenant grant covers `docx:document` writes
 * and `wiki:node:create`, but a write needs an authorization quote, an
 * idempotency key and an authoritative readback before it can be offered, and
 * that contract does not exist yet. Declaring a capability before it can be
 * honoured would put an option in front of the model that the runtime cannot
 * deliver, so it is left out rather than stubbed.
 */
const CAPABILITIES: readonly ConnectorCapabilityManifest[] = Object.freeze([
  Object.freeze({
    id: "document.read",
    displayName: "读取云文档",
    description:
      "读取一个已固定到 Bot 的飞书云文档正文。群消息中已送达的链接走当前回合材料读取；返回文档正文与可能的完整性说明，说明非空时内容不完整。",
    operation: "read",
    resourceTypes: Object.freeze(["document"]),
    resourceSelection: "optional",
    inputSchema: Object.freeze({
      type: "object" as const,
      properties: Object.freeze({
        scope: Object.freeze({
          type: "string" as const,
          description: "full 读取全文；outline 只读标题大纲。",
          enum: Object.freeze(["full", "outline"]),
        }),
      }),
      required: Object.freeze([]),
      additionalProperties: false as const,
    }),
    requestAuthorization: "none" as const,
    requiredScopes: Object.freeze([
      "docx:document:readonly",
      "drive:drive.metadata:readonly",
    ]),
    idempotency: "none" as const,
    readback: "none" as const,
  }),
  Object.freeze({
    id: "wiki.read",
    displayName: "读取知识库文档",
    description:
      "读取一个已固定到 Bot 的飞书知识库节点正文。群消息中已送达的链接走当前回合材料读取；返回文档正文与可能的完整性说明，说明非空时内容不完整。",
    operation: "read",
    resourceTypes: Object.freeze(["wiki"]),
    resourceSelection: "optional",
    inputSchema: Object.freeze({
      type: "object" as const,
      properties: Object.freeze({
        scope: Object.freeze({
          type: "string" as const,
          description: "full 读取全文；outline 只读标题大纲。",
          enum: Object.freeze(["full", "outline"]),
        }),
      }),
      required: Object.freeze([]),
      additionalProperties: false as const,
    }),
    requestAuthorization: "none" as const,
    requiredScopes: Object.freeze([
      "wiki:node:read",
      "drive:drive.metadata:readonly",
    ]),
    idempotency: "none" as const,
    readback: "none" as const,
  }),
]);

export const FEISHU_SERVICE_MANIFEST: ConnectorProviderManifest = Object.freeze(
  {
    id: FEISHU_SERVICE_PROVIDER_ID,
    version: "1.0.0",
    displayName: "飞书服务",
    resourceTypes: FEISHU_SERVICE_RESOURCE_TYPES,
    capabilities: CAPABILITIES,
  },
);
