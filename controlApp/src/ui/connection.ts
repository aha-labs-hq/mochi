import { Electroview } from "electrobun/view";
import type {
  InstructionDocument,
  InstructionsRequest,
} from "../../../src/agent/instructionDocument.ts";
import type { SkillDocument } from "../../../src/agent/skillCatalog.ts";
import type { RuntimeModelOption } from "../../../src/runtime/protocol.ts";
import type { ScheduleView } from "../../../src/schedules/view.ts";
import type { ExperienceIntent } from "../shared/experience.ts";
import type { ExperiencePreviewCommand } from "../shared/experiencePreview.ts";
import type {
  DesktopAction,
  DesktopFrame,
  DesktopRPC,
  Result,
  SettingsIntent,
} from "../shared/model.ts";
import { DESKTOP_RPC_TIMEOUT_MILLISECONDS } from "../shared/timing.ts";
import type { HandoffReceipt } from "../shared/windowHandoff.ts";

export interface ProductConnection {
  perform(action: DesktopAction, botId?: string | null): Promise<Result<null>>;
  models(botId?: string | null): Promise<Result<readonly RuntimeModelOption[]>>;
  skills(botId?: string | null): Promise<Result<readonly SkillDocument[]>>;
  schedules(botId?: string | null): Promise<Result<readonly ScheduleView[]>>;
  instructions(
    request: InstructionsRequest,
    botId?: string | null,
  ): Promise<Result<InstructionDocument>>;
}
export interface Connection extends ProductConnection {
  ready(): Promise<void>;
  closeWindow(): void;
  endPreview(): Promise<void>;
  previewExperience(command: ExperiencePreviewCommand): Promise<void>;
  present(intent: ExperienceIntent): Promise<void>;
  showSettings(sheet: SettingsIntent): Promise<void>;
  presentationPainted(receipt: HandoffReceipt): Promise<void>;
  subscribe(listener: (frame: DesktopFrame) => void): () => void;
}

export function connect(): Connection {
  const frames = new Set<(frame: DesktopFrame) => void>();
  const rpc = Electroview.defineRPC<DesktopRPC>({
    maxRequestTime: DESKTOP_RPC_TIMEOUT_MILLISECONDS,
    handlers: {
      requests: {},
      messages: {
        frame: (value) =>
          frames.forEach((listener) => {
            listener(value);
          }),
      },
    },
  });
  new Electroview({ rpc });
  return {
    ready: () => rpc.request.ready(),
    closeWindow: () => rpc.send.closeWindow(undefined),
    perform: (action, botId = null) => rpc.request.perform({ action, botId }),
    models: (botId = null) => rpc.request.models({ botId }),
    skills: (botId = null) => rpc.request.skills({ botId }),
    schedules: (botId = null) => rpc.request.schedules({ botId }),
    instructions: (request, botId = null) =>
      rpc.request.instructions({ request, botId }),
    endPreview: () => rpc.request.endPreview(),
    previewExperience: (command) => rpc.request.previewExperience(command),
    present: (intent) => rpc.request.present(intent),
    showSettings: (sheet) => rpc.request.showSettings(sheet),
    presentationPainted: (receipt) => rpc.request.presentationPainted(receipt),
    subscribe: (listener) => {
      frames.add(listener);
      return () => {
        frames.delete(listener);
      };
    },
  };
}

/** Captures the Bot actually rendered by a component, including delayed callbacks. */
export function bindProductConnection(
  connection: ProductConnection,
  botId: string | null,
): ProductConnection {
  return {
    perform: (action) => connection.perform(action, botId),
    models: () => connection.models(botId),
    skills: () => connection.skills(botId),
    schedules: () => connection.schedules(botId),
    instructions: (request) => connection.instructions(request, botId),
  };
}
