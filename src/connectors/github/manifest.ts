import type {
  ConnectorCapabilityManifest,
  ConnectorJsonSchema,
  ConnectorJsonSchemaProperty,
  ConnectorResourceType,
} from "../protocol.ts";
import { ISSUE_ACTION_TOOL, READ_ONLY_TOOLS } from "./operations.ts";

export const GITHUB_PROVIDER_ID = "github";

export const GITHUB_RESOURCE_TYPE = "repository";

/** The one capability that mutates. */
const WRITE_CAPABILITY_ID = "manage.issue";

/**
 * Short labels for the catalog.
 *
 * The tool description is the model's instruction and runs long; a capability's
 * display name is what a person reads in a list, so it is declared here rather
 * than restating that instruction.
 */
const SHORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "repository.overview": "查看项目概况",
  "list.issues": "列出 Issue",
  "get.issue": "读取 Issue",
  "list.issue-comments": "读取 Issue 评论",
  "list.labels": "列出标签",
  "list.milestones": "列出里程碑",
  "list.assignees": "列出可指派成员",
  "list.pull-requests": "列出 Pull Request",
  "get.pull-request": "读取 Pull Request",
  "get.pull-request-files": "读取 PR 改动文件",
  "get.commit-checks": "读取提交检查",
  "list.actions-runs": "列出 Actions 运行",
  "get.actions-run": "读取 Actions 运行",
  "list.actions-jobs": "读取 Actions 作业",
  "get.content": "读取文件或目录",
  "list.commits": "列出提交",
  "search.code": "搜索代码",
  [WRITE_CAPABILITY_ID]: "管理 Issue",
});

export const GITHUB_RESOURCE_TYPES: readonly ConnectorResourceType[] =
  Object.freeze([
    Object.freeze({ id: GITHUB_RESOURCE_TYPE, displayName: "项目" }),
  ]);

/**
 * The capability list is generated from the operations themselves.
 *
 * The model sees these exact schemas, and the catalog publishes the same ones,
 * so a capability can never advertise something the runtime does not accept or
 * omit something it does. That is the whole reason GitHub's operations live
 * beside this manifest rather than in the general tool layer: a provider's
 * vocabulary belongs to the provider.
 */
export const GITHUB_CAPABILITIES: readonly ConnectorCapabilityManifest[] =
  Object.freeze([
    ...READ_ONLY_TOOLS.map(
      (spec): ConnectorCapabilityManifest =>
        Object.freeze({
          id: capabilityIdFor(spec.name),
          displayName: shortNameFor(capabilityIdFor(spec.name)),
          description: spec.description,
          operation: "read" as const,
          resourceTypes: Object.freeze([GITHUB_RESOURCE_TYPE]),
          resourceSelection: "required" as const,
          inputSchema: capabilitySchema(spec.inputSchema),
          requestAuthorization: "none" as const,
          // GitHub's OAuth exchange deliberately returns no scope string. Read
          // access is proven by the selected repository's installation grant.
          requiredScopes: Object.freeze([]),
          idempotency: "none" as const,
          readback: "none" as const,
        }),
    ),
    Object.freeze({
      id: WRITE_CAPABILITY_ID,
      displayName: shortNameFor(WRITE_CAPABILITY_ID),
      description: ISSUE_ACTION_TOOL.description,
      operation: "write" as const,
      resourceTypes: Object.freeze([GITHUB_RESOURCE_TYPE]),
      resourceSelection: "required" as const,
      inputSchema: capabilitySchema(ISSUE_ACTION_TOOL.inputSchema),
      // An Issue write happens because a person asked for it in a message, so the
      // exact authorization travels with the call and the Broker checks it against
      // that message. It also carries an idempotency key, because a repeated
      // submission must be the same operation rather than a second Issue, and a
      // readback, because the recorded result is what the caller is told it did.
      requestAuthorization: "current_message" as const,
      // Issue write access is proven per selected repository by the App
      // installation and the resource's writable fact, not by an OAuth scope.
      requiredScopes: Object.freeze([]),
      idempotency: "required" as const,
      readback: "required" as const,
    }),
  ]);

/**
 * `github_list_issue_comments` becomes `list.issue-comments`.
 *
 * A tool name is `<verb>_<noun>` and a capability id keeps that order across the
 * dot: the verb says what is done and the noun says to what, which is how the
 * operation reads aloud. Hyphens keep a multi-word noun legible within a segment,
 * where the id contract does not allow underscores.
 */
export function capabilityIdFor(toolName: string): string {
  const bare = toolName.startsWith("github_")
    ? toolName.slice("github_".length)
    : toolName;
  if (bare === "manage_issue") return WRITE_CAPABILITY_ID;
  const separator = bare.indexOf("_");
  if (separator <= 0)
    throw new Error(`GitHub operation has no verb: ${toolName}`);
  return `${bare.slice(0, separator)}.${bare.slice(separator + 1).replaceAll("_", "-")}`;
}

/** The tool name a capability dispatches to, the inverse of `capabilityIdFor`. */
export function toolNameFor(capabilityId: string): string {
  if (capabilityId === WRITE_CAPABILITY_ID) return ISSUE_ACTION_TOOL.name;
  const separator = capabilityId.indexOf(".");
  if (separator <= 0)
    throw new Error(`GitHub capability id has no verb: ${capabilityId}`);
  return `github_${capabilityId.slice(0, separator)}_${capabilityId.slice(separator + 1).replaceAll("-", "_")}`;
}

function shortNameFor(capabilityId: string): string {
  const name = SHORT_NAMES[capabilityId];
  if (!name)
    throw new Error(`GitHub capability has no display name: ${capabilityId}`);
  return name;
}

/** The declared schema is already the capability schema; only the types align. */
function capabilitySchema(schema: {
  properties: Record<string, unknown>;
  required: readonly string[];
}): ConnectorJsonSchema {
  const properties: Record<string, ConnectorJsonSchemaProperty> = {};
  for (const [name, value] of Object.entries(schema.properties)) {
    properties[name] = value as ConnectorJsonSchemaProperty;
  }
  return Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    required: Object.freeze([...schema.required]),
    additionalProperties: false,
  });
}
