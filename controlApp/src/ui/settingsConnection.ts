import { Electroview } from "electrobun/view";
import type {
  SettingsCloseState,
  SettingsFrame,
  SettingsRoute,
  SettingsRPC,
} from "../shared/settings.ts";
import { DESKTOP_RPC_TIMEOUT_MILLISECONDS } from "../shared/timing.ts";
import type { ProductConnection } from "./connection.ts";

export interface SettingsConnection extends ProductConnection {
  ready(): Promise<void>;
  rendered(): Promise<void>;
  rememberRoute(route: SettingsRoute): Promise<void>;
  showCompanion(): Promise<void>;
  subscribe(listener: (frame: SettingsFrame) => void): () => void;
  onCloseState(read: () => SettingsCloseState): () => void;
}

export function connectSettings(): SettingsConnection {
  const listeners = new Set<(frame: SettingsFrame) => void>();
  let closeState: (() => SettingsCloseState) | null = null;
  const rpc = Electroview.defineRPC<SettingsRPC>({
    maxRequestTime: DESKTOP_RPC_TIMEOUT_MILLISECONDS,
    handlers: {
      requests: {
        closeState: () => {
          if (!closeState) throw new Error("Settings has not subscribed");
          return closeState();
        },
      },
      messages: {
        frame: (frame) => {
          for (const listener of listeners) listener(frame);
        },
      },
    },
  });
  new Electroview({ rpc });
  return {
    ready: () => rpc.request.ready(),
    rendered: () => rpc.request.rendered(),
    rememberRoute: (route) => rpc.request.rememberRoute(route),
    showCompanion: () => rpc.request.showCompanion(),
    perform: (action, botId = null) => rpc.request.perform({ action, botId }),
    models: (botId = null) => rpc.request.models({ botId }),
    skills: (botId = null) => rpc.request.skills({ botId }),
    schedules: (botId = null) => rpc.request.schedules({ botId }),
    instructions: (request, botId = null) =>
      rpc.request.instructions({ request, botId }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onCloseState: (read) => {
      closeState = read;
      return () => {
        if (closeState === read) closeState = null;
      };
    },
  };
}
