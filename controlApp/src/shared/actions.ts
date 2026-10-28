import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { FEISHU_CHAT_ID_PATTERN } from "../../../src/lark/group.ts";
import { REASONING_EFFORTS } from "../../../src/runtime/policy.ts";

const simple = [
  "uninstall",
  "cancelUninstall",
  "checkUpdate",
  "downloadUpdate",
  "pauseUpdate",
  "installUpdate",
  "cancelUpdate",
  "retryUpdate",
  "login",
  "configureByok",
  "removeByok",
  "cancelLogin",
  "logout",
  "switchAccount",
  "reopenLogin",
  "organize",
  "recoverBot",
  "prepare",
  "openApplications",
  "openLoginItems",
  "exportDiagnostics",
  "clearProblem",
  "connectFeishu",
  "cancelFeishuConnection",
  "discardFeishuCandidate",
  "checkFeishuCandidate",
  "activateFeishuConnection",
  "disconnectFeishu",
  "feishuSettings",
  "copyFeishuApprovalLink",
  "reopenFeishuConnection",
  "authorizeFeishuMail",
  "reopenFeishuMailAuthorization",
  "cancelFeishuMailAuthorization",
  "feishuMailSettings",
  "disconnectFeishuMail",
  "loginGitHub",
  "cancelGitHubLogin",
  "reopenGitHubLogin",
  "disconnectGitHub",
  "manageGitHubAccess",
  "reviewGitHubAuthorization",
  "createBot",
] as const;
/** One closed schema owns both the TypeScript contract and host validation. */
const actionSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("setUpdatePreferences"),
      preferences: Type.Object(
        {
          check: Type.Boolean(),
          download: Type.Boolean(),
          install: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("setScheduleEnabled"),
      scheduleId: Type.String({ pattern: "^schedule:[a-f0-9]{64}$" }),
      revision: Type.Integer({ minimum: 1 }),
      enabled: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("cancelSchedule"),
      scheduleId: Type.String({ pattern: "^schedule:[a-f0-9]{64}$" }),
      revision: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("setBotEnabled"),
      botId: Type.String({ minLength: 1, maxLength: 64 }),
      enabled: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("setBotCharacter"),
      botId: Type.String({ minLength: 1, maxLength: 64 }),
      characterId: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
    },
    { additionalProperties: false },
  ),

  Type.Object(
    {
      type: Type.Literal("openFeishuGroup"),
      chatId: Type.String({ pattern: FEISHU_CHAT_ID_PATTERN }),
    },
    { additionalProperties: false },
  ),
  // Selecting a Bot is a view decision: it changes which Bot Settings describes,
  // never which Bot the deployment runs. The identity is validated in the host
  // against the live roster, not here against a shape alone.
  Type.Object(
    {
      type: Type.Literal("selectBot"),
      botId: Type.String({ minLength: 1, maxLength: 64 }),
    },
    { additionalProperties: false },
  ),
  // A Bot's name is the customer's own word for it, bounded and single-line in
  // the same way the roster and the wire bound it.
  Type.Object(
    {
      type: Type.Literal("renameBot"),
      botId: Type.String({ minLength: 1, maxLength: 64 }),
      label: Type.String({
        minLength: 1,
        maxLength: 60,
        pattern: "^[^\r\n\t\u0000]+$",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("selectProjects"),
      resourceIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        maxItems: 1000,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  /**
   * Feishu resources are addressed by URL rather than chosen from a list: the
   * grant does not permit enumerating a drive or a wiki space, so the owner
   * supplies what the Bot may read and the adapter proves each one before it is
   * stored. The renderer cannot validate a Feishu URL — that rule belongs to the
   * adapter — so this only bounds the value.
   */
  Type.Object(
    {
      type: Type.Literal("removeConnectorResource"),
      connectionId: Type.String({ minLength: 1, maxLength: 128 }),
      resourceId: Type.String({ minLength: 1, maxLength: 256 }),
      selectionId: Type.String({ pattern: "^[a-f0-9]{32}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("addConnectorResources"),
      connectionId: Type.String({ minLength: 1, maxLength: 128 }),
      references: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
        maxItems: 1000,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("updateGroupParticipation"),
      chatId: Type.String({ pattern: FEISHU_CHAT_ID_PATTERN }),
      enabled: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("service"),
      operation: Type.Union([
        Type.Literal("start"),
        Type.Literal("stop"),
        Type.Literal("restart"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Enum(simple) }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("updatePolicy"),
      policy: Type.Object(
        {
          model: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
          reasoningEffort: Type.Enum(REASONING_EFFORTS),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("configureModelApi"),
      connectionId: Type.Optional(
        Type.String({ pattern: "^mochi-byok(?:-[a-z0-9]{8,64})?$" }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("removeModelApi"),
      connectionId: Type.String({
        pattern: "^mochi-byok(?:-[a-z0-9]{8,64})?$",
      }),
    },
    { additionalProperties: false },
  ),
]);
export type DesktopAction = Static<typeof actionSchema>;
const validator = Compile(actionSchema);

export function parseAction(input: unknown): DesktopAction {
  if (!validator.Check(input)) throw new Error("Invalid desktop action");
  return input;
}
