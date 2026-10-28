import { isFeishuScopeApplyUrl, isFeishuSettingsUrl } from "../lark/connectionLinks.ts";
import { FEISHU_MAIL_USER_SCOPES } from "../connectors/feishu-mail/manifest.ts";
import { parseFeishuRegistrationUrl } from "../lark/registration.ts";
import { isLarkAuthorizationUrl } from "../lark/platform.ts";
import { parseSkillCatalog, type SkillDocument } from "../agent/skillCatalog.ts";
import { parseInstructionDocument, type InstructionDocument } from "../agent/instructionDocument.ts";
import type { RuntimeModelOption } from "../runtime/protocol.ts";
import { parseScheduleViews, type ScheduleView } from "../schedules/view.ts";
import { isScheduleId } from "../schedules/store.ts";
import { isFeishuChatId } from "../lark/group.ts";
import { isBotId } from "../product/layout.ts";
import { isGitHubId } from "../github/repository.ts";
import {
  parseProductProblem,
  type ProductProblemSnapshot,
} from "./productProblem.ts";

import { parseByokConnection, parseByokProvider, parseByokSetupRecord, type ByokSetupRecord } from "../runtime/byok.ts";
export const MOCHI_CONTROL_PROTOCOL_VERSION = 28;
// Fifty bounded 4,000-character work definitions can exceed 256 KiB in UTF-8.
export const MAXIMUM_CONTROL_MESSAGE_BYTES = 1_048_576;
export const MAXIMUM_BOT_LABEL_LENGTH = 60;

/**
 * Commands that address one Bot. They carry `botId` on the wire because the
 * deployment now serves several Bots over one socket, and a command that cannot
 * name its Bot has no defensible default once a second Bot exists.
 */
export const BOT_SCOPED_COMMANDS = [
  "organize_context", "model_catalog", "update_model_policy",
  "read_instructions", "save_instructions", "read_skills",
  "read_schedules", "set_schedule_enabled", "cancel_schedule",
  "recheck_connections", "update_group_participation",
  "start_feishu_connection", "cancel_feishu_connection", "discard_feishu_candidate",
  "check_feishu_candidate", "activate_feishu_connection", "disconnect_feishu", "feishu_settings",
  "start_feishu_mail_authorization", "cancel_feishu_mail_authorization",
  "feishu_mail_settings", "disconnect_feishu_mail",
  "rename_bot", "set_bot_enabled", "set_bot_character", "recover_bot",
  "start_github_login", "start_github_installation", "cancel_github_login", "disconnect_github",
  "add_connector_resources", "remove_connector_resource",
] as const;

export type BotScopedCommand = (typeof BOT_SCOPED_COMMANDS)[number];

export function isBotScopedCommand(value: string): value is BotScopedCommand {
  return (BOT_SCOPED_COMMANDS as readonly string[]).includes(value);
}

export type MochiControlRequest =
  | { version: number; command: "start_chatgpt_login" | "cancel_chatgpt_login" | "logout_chatgpt" | "switch_chatgpt_account"; }
  | { version: number; command: "remove_byok"; connectionId?: string }
  | { version: number; command: "read_byok" }
  | { version: number; command: "configure_byok"; apiKey: string; baseUrl: string; label: string; model: string; connectionId?: string }
  | { version: number; botId: string; command: Exclude<BotScopedCommand,
      "update_model_policy" | "save_instructions" | "update_group_participation" | "rename_bot" | "set_bot_enabled" | "set_bot_character"
      | "add_connector_resources" | "remove_connector_resource" | "set_schedule_enabled" | "cancel_schedule"> }
  | { version: number; botId: string; command: "set_schedule_enabled"; scheduleId: string; revision: number; enabled: boolean }
  | { version: number; botId: string; command: "cancel_schedule"; scheduleId: string; revision: number }
  | { version: number; botId: string; command: "update_model_policy"; model: string; reasoningEffort: string }
  | { version: number; botId: string; command: "update_group_participation"; chatId: string; enabled: boolean }
  | { version: number; botId: string; command: "save_instructions"; document: InstructionDocument }
  | { version: number; botId: string; command: "rename_bot"; label: string }
  | { version: number; botId: string; command: "set_bot_enabled"; enabled: boolean }
  | { version: number; botId: string; command: "set_bot_character"; characterId: string }
  /** A Bot's name is optional on the wire: the Bridge owns the default label. */
  | { version: number; command: "create_bot"; label?: string }
  | { version: number; command: "select_projects"; botId: string; repositoryIds: number[] }
  /**
   * The caller supplies Feishu references itself: a document link the user
   * pasted, or the address of a shared mailbox from the published options. The
   * adapter resolves and proves each one before anything is stored.
   */
  | { version: number; botId: string; command: "add_connector_resources";
      connectionId: string; references: string[] }
  | { version: number; botId: string; command: "remove_connector_resource";
      connectionId: string; resourceId: string; selectionId: string };

export interface MochiControlResponse {
  version: number;
  ok: boolean;
  problem?: ProductProblemSnapshot;
  authorizationUrl?: string;
  models?: readonly RuntimeModelOption[];
  document?: InstructionDocument;
  skills?: readonly SkillDocument[];
  schedules?: readonly ScheduleView[];
  /** Credential-free declarations used only to prefill the native editor. */
  connections?: readonly ByokSetupRecord[];
  botId?: string;
}

/** Both ends share the wire contract. Successful payloads are command-specific. */
export function parseControlResponse(
  line: string,
  command: MochiControlRequest["command"],
): MochiControlResponse {
  const value: unknown = JSON.parse(line);
  if (
    !record(value) ||
    value.version !== MOCHI_CONTROL_PROTOCOL_VERSION ||
    typeof value.ok !== "boolean"
  )
    invalidResponse();
  const keys = value.ok
    ? command === "read_instructions" || command === "save_instructions"
      ? "document,ok,version"
      : command === "read_skills"
      ? "ok,skills,version"
      : command === "read_schedules"
      ? "ok,schedules,version"
      : command === "create_bot"
      ? "botId,ok,version"
      : command === "model_catalog"
      ? "models,ok,version"
      : command === "read_byok"
      ? "connections,ok,version"
      : command === "start_chatgpt_login" || command === "start_github_login" || command === "start_github_installation" || command === "start_feishu_connection" || command === "feishu_settings" || command === "start_feishu_mail_authorization" ||
          command === "feishu_mail_settings" || command === "switch_chatgpt_account"
        ? "authorizationUrl,ok,version"
        : "ok,version"
    : "ok,problem,version";
  if (Object.keys(value).sort().join(",") !== keys) invalidResponse();
  if (!value.ok) {
    const problem = parseProductProblem(value.problem);
    if (!problem) invalidResponse();
    return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: false, problem };
  }
  if ("botId" in value) {
    if (!isBotId(value.botId)) invalidResponse();
    return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, botId: value.botId };
  }
  if ("schedules" in value) return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, schedules: parseScheduleViews(value.schedules) };
  if ("authorizationUrl" in value) {
    if (
      typeof value.authorizationUrl !== "string" ||
      value.authorizationUrl.length > 8192
    )
      invalidResponse();
    const url = new URL(value.authorizationUrl);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    )
      invalidResponse();
    if (command === "start_github_login" && (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize")) invalidResponse();
    if (command === "start_github_installation" && (url.origin !== "https://github.com" || url.pathname !== "/apps/mochi-companion/installations/new")) invalidResponse();
    if (command === "start_feishu_connection" && parseFeishuRegistrationUrl(value.authorizationUrl) !== value.authorizationUrl) invalidResponse();
    if (command === "feishu_settings" && !isFeishuSettingsUrl(value.authorizationUrl)) invalidResponse();
    if (command === "feishu_mail_settings" && !isFeishuScopeApplyUrl(value.authorizationUrl, FEISHU_MAIL_USER_SCOPES)) invalidResponse();
    if (command === "start_feishu_mail_authorization") {
      const url = new URL(value.authorizationUrl);
      if (!isLarkAuthorizationUrl(url.href)) invalidResponse();
    }
    return {
      version: MOCHI_CONTROL_PROTOCOL_VERSION,
      ok: true,
      authorizationUrl: value.authorizationUrl,
    };
  }
  if ("document" in value) {
    return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, document: parseInstructionDocument(value.document) };
  }
  if ("skills" in value) {
    return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, skills: parseSkillCatalog(value.skills) };
  }
  if ("models" in value) {
    if (
      !Array.isArray(value.models) ||
      !value.models.length ||
      value.models.length > 100
    )
      invalidResponse();
    const models = value.models.map((model: unknown): RuntimeModelOption => {
      if (
        !record(model) ||
        Object.keys(model).sort().join(",") !==
          "defaultEffort,description,displayName,id,supportedEfforts" ||
        !label(model.id, 128) ||
        !label(model.displayName, 256) ||
        typeof model.description !== "string" ||
        model.description.length > 4096 ||
        !label(model.defaultEffort, 32) ||
        !Array.isArray(model.supportedEfforts) ||
        !model.supportedEfforts.length ||
        model.supportedEfforts.length > 32
      )
        invalidResponse();
      const supportedEfforts = model.supportedEfforts.map((effort: unknown) => {
        if (
          !record(effort) ||
          Object.keys(effort).sort().join(",") !== "description,id" ||
          !label(effort.id, 32) ||
          typeof effort.description !== "string" ||
          effort.description.length > 4096
        )
          invalidResponse();
        return { id: effort.id, description: effort.description };
      });
      if (
        new Set(supportedEfforts.map((effort) => effort.id)).size !==
          supportedEfforts.length ||
        !supportedEfforts.some((effort) => effort.id === model.defaultEffort)
      )
        invalidResponse();
      return {
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        defaultEffort: model.defaultEffort,
        supportedEfforts,
      };
    });
    if (new Set(models.map((model) => model.id)).size !== models.length)
      invalidResponse();
    return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, models };
  }
  if ("connections" in value) {
    if (!Array.isArray(value.connections) || value.connections.length > 16) invalidResponse();
    const connections = value.connections.map(parseByokSetupRecord);
    if (new Set(connections.map((connection) => connection.provider)).size !== connections.length) invalidResponse();
    return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, connections };
  }
  return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function label(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}
function invalidResponse(): never {
  throw new Error("Invalid control response");
}

export function parseControlRequest(line: string): MochiControlRequest {
  const value = JSON.parse(line) as unknown;
  if (!record(value)) throw new Error("操作请求格式不正确。");
  const request = value;
  if (request.version !== MOCHI_CONTROL_PROTOCOL_VERSION || typeof request.command !== "string") {
    throw new Error("操作请求版本不受支持。");
  }
  const command = request.command;
  const keys = Object.keys(request).sort().join(",");
  // A Bot-scoped command must name its Bot. There is no implicit current Bot on
  // the wire: the desktop's selection is a view concern, and inferring it here
  // would let a stale window act on a Bot the customer is no longer looking at.
  if (isBotScopedCommand(command) && !isBotId(request.botId)) {
    throw new Error("操作请求缺少有效的 Bot 标识。");
  }
  switch (command) {
    case "set_schedule_enabled":
    case "cancel_schedule": {
      if (keys !== (command === "cancel_schedule" ? "botId,command,revision,scheduleId,version" : "botId,command,enabled,revision,scheduleId,version")
        || !isScheduleId(request.scheduleId) || !Number.isSafeInteger(request.revision) || (request.revision as number) < 1
        || (command === "set_schedule_enabled" && typeof request.enabled !== "boolean")) throw new Error("安排操作格式不正确。");
      return { version: request.version, botId: request.botId as string, command, scheduleId: request.scheduleId, revision: request.revision as number,
        ...(command === "set_schedule_enabled" ? { enabled: request.enabled as boolean } : {}) } as MochiControlRequest;
    }
    case "start_chatgpt_login":
    case "cancel_chatgpt_login":
    case "logout_chatgpt":
    case "switch_chatgpt_account":
    case "remove_byok": {
      if (keys !== "command,version" && keys !== "command,connectionId,version") throw new Error("模型 API 连接操作格式不正确。");
      const connectionId = request.connectionId === undefined ? undefined : parseByokProvider(request.connectionId);
      return connectionId === undefined
        ? { version: request.version, command }
        : { version: request.version, command, connectionId };
    }
    case "read_byok": {
      if (keys !== "command,version") throw new Error("模型 API 连接操作格式不正确。");
      return { version: request.version, command };
    }
    case "configure_byok": {
      if (keys !== "apiKey,baseUrl,command,label,model,version" && keys !== "apiKey,baseUrl,command,connectionId,label,model,version") throw new Error("模型 API 连接格式不正确。");
      return { version: request.version, command, ...parseByokConnection({ apiKey: request.apiKey, baseUrl: request.baseUrl, label: request.label, model: request.model, ...(request.connectionId === undefined ? {} : { connectionId: request.connectionId }) }) };
    }
    case "update_group_participation": {
      if (keys !== "botId,chatId,command,enabled,version" || !isFeishuChatId(request.chatId)
        || typeof request.enabled !== "boolean") throw new Error("群聊设置格式不正确。");
      return { version: request.version, botId: request.botId as string, command, chatId: request.chatId, enabled: request.enabled };
    }
    case "save_instructions": {
      if (keys !== "botId,command,document,version") throw new Error("Invalid instructions request");
      return { version: request.version, botId: request.botId as string, command, document: parseInstructionDocument(request.document) };
    }
    case "select_projects": {
      if (keys !== "botId,command,repositoryIds,version" || !isBotId(request.botId)
        || !Array.isArray(request.repositoryIds) || request.repositoryIds.length > 1000
        || !request.repositoryIds.every(isGitHubId)
        || new Set(request.repositoryIds).size !== request.repositoryIds.length) {
        throw new Error("项目选择格式不正确。");
      }
      return { version: request.version, botId: request.botId, command, repositoryIds: request.repositoryIds };
    }
    case "remove_connector_resource": {
      if (keys !== "botId,command,connectionId,resourceId,selectionId,version" || !isBotId(request.botId)
        || typeof request.connectionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.connectionId)
        || typeof request.resourceId !== "string" || request.resourceId.length < 1 || request.resourceId.length > 256 || /\p{Cc}/u.test(request.resourceId)
        || typeof request.selectionId !== "string" || !/^[a-f0-9]{32}$/.test(request.selectionId)) throw new Error("连接器资源格式不正确。");
      return { version: request.version, botId: request.botId, command, connectionId: request.connectionId, resourceId: request.resourceId, selectionId: request.selectionId };
    }
    case "add_connector_resources": {
      if (keys !== "botId,command,connectionId,references,version" || !isBotId(request.botId)
        || typeof request.connectionId !== "string"
        || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.connectionId)
        || !Array.isArray(request.references) || request.references.length > 1000
        || !request.references.every((reference) =>
          typeof reference === "string" && reference.length > 0 && reference.length <= 2048
          && !/\p{Cc}/u.test(reference))
        || new Set(request.references).size !== request.references.length) {
        throw new Error("连接器资源格式不正确。");
      }
      return {
        version: request.version, botId: request.botId, command,
        connectionId: request.connectionId, references: request.references,
      };
    }
    case "update_model_policy": {
      if (keys !== "botId,command,model,reasoningEffort,version") throw new Error("操作请求包含未支持的内容。");
      if (!label(request.model, 128) || !label(request.reasoningEffort, 32)) throw new Error("模型设置格式不正确。");
      return {
        version: request.version, botId: request.botId as string, command,
        model: request.model, reasoningEffort: request.reasoningEffort,
      };
    }
    case "create_bot": {
      if (keys === "command,version") return { version: request.version, command };
      if (keys !== "command,label,version" || !isBotLabel(request.label)) throw new Error("Bot 名称格式不正确。");
      return { version: request.version, command, label: request.label };
    }
    case "rename_bot": {
      if (keys !== "botId,command,label,version" || !isBotLabel(request.label)) throw new Error("Bot 名称格式不正确。");
      return { version: request.version, botId: request.botId as string, command, label: request.label };
    }
    case "set_bot_character": {
      if (keys !== "botId,characterId,command,version" || typeof request.characterId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.characterId)) throw new Error("Invalid character");
      return { version: request.version, botId: request.botId as string, command, characterId: request.characterId };
    }
    case "set_bot_enabled": {
      if (keys !== "botId,command,enabled,version" || typeof request.enabled !== "boolean") {
        throw new Error("Bot 开关格式不正确。");
      }
      return { version: request.version, botId: request.botId as string, command, enabled: request.enabled };
    }
    default: break;
  }
  if (isBotScopedCommand(command)) {
    if (keys !== "botId,command,version") throw new Error("操作请求包含未支持的内容。");
    return { version: request.version, botId: request.botId as string, command } as MochiControlRequest;
  }
  throw new Error("无法识别这个操作。");
}

/** One line, trimmed, bounded. The roster and the wire share one rule. */
export function isBotLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= MAXIMUM_BOT_LABEL_LENGTH && !/[\r\n\t\0]/.test(value);
}
