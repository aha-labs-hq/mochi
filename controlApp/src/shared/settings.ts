import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { BUILTIN_SKILLS } from "../../../src/agent/skillCatalog.ts";
import type { DesktopRPC, DesktopSnapshot, SettingsIntent } from "./model.ts";

export const SETTINGS_SECTIONS = {
  instructions: { label: "设定" },
  connectors: { label: "连接器" },
  model: { label: "模型" },
  groups: { label: "群聊" },
  schedules: { label: "安排" },
} as const;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;
const routeSchema = Type.Union([
  Type.Object(
    {
      page: Type.Enum([
        "instructions",
        "connectors",
        "model",
        "account",
        "groups",
        "schedules",
        "feishu",
        "feishuServices",
        "feishuMail",
        "projects",
        "about",
        "diagnostics",
        "help",
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      page: Type.Literal("document"),
      id: Type.Enum(BUILTIN_SKILLS.map(({ id }) => id)),
      section: Type.Optional(Type.Enum(["help", "groups", "projects"])),
    },
    { additionalProperties: false },
  ),
]);
export type SettingsRoute = Static<typeof routeSchema>;
const routeValidator = Compile(routeSchema);
export function parseSettingsRoute(value: unknown): SettingsRoute {
  if (!routeValidator.Check(value)) throw new Error("Invalid settings route");
  return value;
}
export function settingsDestination(
  sheet: SettingsIntent,
): SettingsRoute | null {
  return sheet === "settings" ? null : { page: sheet };
}
export function settingsSection(route: SettingsRoute): SettingsSection | null {
  switch (route.page) {
    case "instructions":
      return "instructions";
    case "connectors":
      return "connectors";
    case "feishuServices":
    case "feishuMail":
      return "connectors";
    case "projects":
      return "connectors";
    case "model":
      return "model";
    case "groups":
    case "feishu":
      return "groups";
    case "schedules":
      return "schedules";
    case "document":
      if (route.section === "help") return null;
      if (route.section === "projects") return "connectors";
      if (route.section) return route.section;
      return route.id === "feishu-collaboration" ||
        route.id === "message-contract"
        ? "groups"
        : "connectors";
    case "help":
    case "diagnostics":
    case "about":
    case "account":
      return null;
    default:
      return "connectors";
  }
}
export interface SettingsFrame {
  snapshot: DesktopSnapshot;
  navigation?: SettingsRoute;
}
const closeStateSchema = Type.Object(
  { dirty: Type.Boolean(), busy: Type.Boolean() },
  { additionalProperties: false },
);
export type SettingsCloseState = Static<typeof closeStateSchema>;
const closeValidator = Compile(closeStateSchema);
export function parseSettingsCloseState(value: unknown): SettingsCloseState {
  if (!closeValidator.Check(value))
    throw new Error("Invalid settings close state");
  return value;
}
export type SettingsRPC = {
  bun: {
    requests: Pick<
      DesktopRPC["bun"]["requests"],
      "ready" | "perform" | "models" | "skills" | "instructions" | "schedules"
    > & {
      rendered: { params: undefined; response: undefined };
      rememberRoute: { params: SettingsRoute; response: undefined };
      showCompanion: { params: undefined; response: undefined };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: {
      closeState: { params: undefined; response: SettingsCloseState };
    };
    messages: { frame: SettingsFrame };
  };
};
