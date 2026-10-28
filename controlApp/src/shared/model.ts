import type {
  InstructionDocument,
  InstructionsRequest,
} from "../../../src/agent/instructionDocument.ts";
import type { SkillDocument } from "../../../src/agent/skillCatalog.ts";
import type { ConnectorCatalogProjection } from "../../../src/control/connectorSnapshot.ts";
import type {
  ProductSetupStage,
  RuntimeAccountSnapshot,
} from "../../../src/control/statusSnapshot.ts";
import {
  emptyFeishuSnapshot,
  type FeishuConnectionSnapshot,
} from "../../../src/lark/connectionState.ts";
import type { FeishuGroup } from "../../../src/lark/group.ts";
import type { RuntimePolicy } from "../../../src/runtime/policy.ts";
import type { RuntimeModelOption } from "../../../src/runtime/protocol.ts";
import type { DesktopBotView } from "../host/fleet.ts";
import type { DesktopAction } from "./actions.ts";
import type { DesktopSurface, ExperienceIntent } from "./experience.ts";
import type {
  ExperiencePreview,
  ExperiencePreviewCommand,
} from "./experiencePreview.ts";
import type { DesktopProblem } from "./problem.ts";
import { initialUpdateView, type UpdateView } from "./updates.ts";
import type { HandoffReceipt, WindowHandoff } from "./windowHandoff.ts";

export type { DesktopAction } from "./actions.ts";

export const PHASES = [
  "checking",
  "notInstalled",
  "stopped",
  "starting",
  "listening",
  "working",
  "contextFull",
  "organizingContext",
  "attention",
] as const;
export type Phase = (typeof PHASES)[number];
/** App/menu destinations. Settings owns the Bot navigation. */
export const SETTINGS_INTENTS = [
  "settings",
  "account",
  "model",
  "groups",
  "projects",
  "instructions",
  "diagnostics",
  "about",
  "help",
] as const;
export type SettingsIntent = (typeof SETTINGS_INTENTS)[number];
export type ServiceOperation = "start" | "stop" | "restart";

/** The renderer receives product facts, never process identities, file paths or OAuth URLs. */
export interface DesktopSnapshot {
  update: UpdateView;
  phase: Phase;
  installed: boolean;
  loaded: boolean;
  controlReady: boolean;
  eventStreamReady: boolean;
  /** Every Bot this deployment runs, in roster order. */
  bots: readonly DesktopBotView[];
  /** The Bot the renderer currently shows; every per-Bot fact below describes it. */
  selectedBotId: string | null;
  feishuGroups: readonly FeishuGroup[] | null;
  /** This Bot's connectors, their selected resources and their capabilities. */
  connectorCatalog: ConnectorCatalogProjection | null;
  feishu: FeishuConnectionSnapshot;
  feishuVerificationQr: string | null;
  canReopenFeishuConnection: boolean;
  feishuMailVerificationQr: string | null;
  canReopenFeishuMailAuthorization: boolean;
  locationReady: boolean;
  development: boolean;
  productVersion: string;
  setup: ProductSetupStage | "install" | null;
  account: RuntimeAccountSnapshot;
  accountChangeReady: boolean;
  policy: RuntimePolicy | null;
  queueDepth: number | null;
  contextPercent: number | null;
  canOrganize: boolean;
  busy: string | null;
  canReopenLogin: boolean;
  canReopenGitHubLogin: boolean;
  problem: DesktopProblem | null;
  activity: Activity[];
}

export interface Activity {
  id: string;
  time: string;
  title: string;
  kind: "normal" | "warning";
}
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; problem: DesktopProblem };
export type PreviewRequest = {
  character: string;
  preview: string;
  nonce: string;
} | null;

/** Current facts plus an optional, one-shot menu intent. */
export interface DesktopFrame {
  snapshot: DesktopSnapshot;
  preview: PreviewRequest;
  experiencePreview?: ExperiencePreview;
  surface: DesktopSurface;
  handoff?: WindowHandoff;
}

import type { ScheduleView } from "../../../src/schedules/view.ts";
export type DesktopRPC = {
  bun: {
    requests: {
      ready: { params: undefined; response: undefined };
      perform: {
        params: { action: DesktopAction; botId: string | null };
        response: Result<null>;
      };
      models: {
        params: { botId: string | null };
        response: Result<readonly RuntimeModelOption[]>;
      };
      instructions: {
        params: { request: InstructionsRequest; botId: string | null };
        response: Result<InstructionDocument>;
      };
      skills: {
        params: { botId: string | null };
        response: Result<readonly SkillDocument[]>;
      };
      schedules: {
        params: { botId: string | null };
        response: Result<readonly ScheduleView[]>;
      };
      endPreview: { params: undefined; response: undefined };
      previewExperience: {
        params: ExperiencePreviewCommand;
        response: undefined;
      };
      present: { params: ExperienceIntent; response: undefined };
      showSettings: { params: SettingsIntent; response: undefined };
      presentationPainted: { params: HandoffReceipt; response: undefined };
    };
    messages: { closeWindow: undefined };
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      frame: DesktopFrame;
    };
  };
};

export function initialSnapshot(
  version: string,
  development: boolean,
): DesktopSnapshot {
  return {
    update: initialUpdateView(),
    phase: "checking",
    installed: false,
    loaded: false,
    controlReady: false,
    eventStreamReady: false,
    bots: [],
    selectedBotId: null,
    feishuGroups: null,
    connectorCatalog: null,
    feishu: emptyFeishuSnapshot(),
    feishuVerificationQr: null,
    canReopenFeishuConnection: false,
    feishuMailVerificationQr: null,
    canReopenFeishuMailAuthorization: false,
    locationReady: true,
    development,
    productVersion: version,
    setup: null,
    account: { status: "unknown" },
    accountChangeReady: false,
    policy: null,
    queueDepth: null,
    contextPercent: null,
    canOrganize: false,
    busy: null,
    canReopenLogin: false,
    canReopenGitHubLogin: false,
    problem: null,
    activity: [],
  };
}
