import type { RuntimeToolSpec } from "../runtime/protocol.ts";

/**
 * The stable, provider-neutral connector tools.
 *
 * These are written as literals rather than generated from a builder, because
 * their parameters are the same for every provider and carry no provider
 * vocabulary: a capability is named by an opaque catalog identity and its own
 * fields arrive as validated input.
 *
 * The set is deliberately fixed rather than filtered by what exists: the
 * capability ABI is a session-binding contract, so a tool that appeared and
 * disappeared with Bot state would make the binding depend on that state. A tool
 * whose provider has nothing to offer answers with a closed `capability_unavailable`
 * error, which teaches the model what exists without moving the ABI.
 */

/**
 * Capability input is the one place the ABI cannot carry a schema, because the
 * real schema belongs to the capability and is fetched on demand through
 * `connector_describe`. It is therefore passed as a JSON object string and the
 * Broker validates it against the declared schema afterwards; declaring an empty
 * closed object here would invite the model to pass fields the Broker rejects.
 */
const capabilityInput = {
  type: "string",
  description:
    "能力参数的 JSON 对象字符串。先调用 connector_describe 取得该能力的准确 schema；没有参数时传 \"{}\"。",
} as const;

export const CONNECTOR_CATALOG_TOOL: RuntimeToolSpec = {
  type: "function",
  name: "connector_catalog",
  description:
    "列出这位 Bot 当前可见的连接、连接 problem、provider 已授予的 granted_scopes、资源及每个资源的 selected/writable 状态、能力的 resource_selection/required_scopes/availability 摘要和目录 revision。problem 是连接恢复原因，granted_scopes 是 provider 授权事实；二者都不等于 Mochi 已实现的能力，也不等于资源选择。selected=true 只表示已保存到 Mochi 的持久范围；只有对应能力 availability=ready 且 resource_scope.status=ready 时，已选资源才是当前可调用的范围。resource_selection=required 表示没有持久选择就不能调用该能力；resource_selection=optional 表示持久选择只是跨消息扩展，当前消息已有材料仍走 material_read。authorization_required 表示能力已实现但 provider 尚未证明所需 scope；connection_unavailable 表示连接本身未就绪。目录可以包含已获授权但未选定的资源；未选资源不能调用。读取或调用能力前先取得目录，不要凭名称或 URL 推断访问权。资源未出现在目录里只表示当前不能通过连接器调用，不等于 provider 授权不存在；按 provider 的确认流程补齐证据。",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

export const CONNECTOR_DESCRIBE_TOOL: RuntimeToolSpec = {
  type: "function",
  name: "connector_describe",
  description:
    "按目录中的标识返回一个能力的完整参数 schema、当前消息请求授权要求与回读约定。目录只给出摘要，调用前用它确认参数。",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "目录中的连接标识。" },
      capability_id: { type: "string", description: "目录中的能力标识。" },
      catalog_revision: { type: "string", description: "当前目录 revision。" },
    },
    required: ["connection_id", "capability_id", "catalog_revision"],
    additionalProperties: false,
  },
};

export const CONNECTOR_READ_TOOL: RuntimeToolSpec = {
  type: "function",
  name: "connector_read",
  description:
    "调用一个只读能力。参数必须是目录中已固定资源的资源标识，不接受任意 URL 或路径；当前回合已经送达的材料直接用 material_read，不要为了调用它再创建固定资料。",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "目录中的连接标识。" },
      resource_id: { type: "string", description: "目录中已固定资源的标识。" },
      capability_id: { type: "string", description: "目录中的能力标识。" },
      catalog_revision: { type: "string", description: "当前目录 revision。" },
      input: capabilityInput,
    },
    required: ["connection_id", "resource_id", "capability_id", "catalog_revision"],
    additionalProperties: false,
  },
};

export const CONNECTOR_WRITE_TOOL: RuntimeToolSpec = {
  type: "function",
  name: "connector_write",
  description:
    "调用一个写入能力。authorization_quote 必须是当前对话中授权这次操作的原文片段；没有明确授权时不要调用，改为追问。重复提交同一操作不会产生第二次副作用。",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "目录中的连接标识。" },
      resource_id: { type: "string", description: "目录中已固定资源的标识。" },
      capability_id: { type: "string", description: "目录中的能力标识。" },
      catalog_revision: { type: "string", description: "当前目录 revision。" },
      authorization_quote: {
        type: "string",
        description: "当前用户消息中授权这次操作的原话片段。",
      },
      input: capabilityInput,
    },
    required: [
      "connection_id", "resource_id", "capability_id", "catalog_revision",
      "authorization_quote",
    ],
    additionalProperties: false,
  },
};

export const CONNECTOR_TOOLS: readonly RuntimeToolSpec[] = Object.freeze([
  CONNECTOR_CATALOG_TOOL,
  CONNECTOR_DESCRIBE_TOOL,
  CONNECTOR_READ_TOOL,
  CONNECTOR_WRITE_TOOL,
]);

export const CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set(
  CONNECTOR_TOOLS.map((tool) => tool.name),
);
