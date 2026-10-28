import { createRoot } from "react-dom/client";
import { SettingsPresentation } from "../src/host/settingsPresentation.ts";
import {
  parseSettingsRoute,
  type SettingsCloseState,
  type SettingsFrame,
} from "../src/shared/settings.ts";
import { SettingsApp } from "../src/ui/SettingsApp.tsx";
import type { SettingsConnection } from "../src/ui/settingsConnection.ts";
import { productFixture } from "./productFixture.ts";
import "../src/ui/style.css";

// A browser has no AppKit material. Supply only a neutral backing canvas;
// desktop translucency and blur must be verified in the native app separately.
document.documentElement.style.backgroundColor = "Canvas";

const product = productFixture(() => presentation.publish());
const presentation = new SettingsPresentation(() => product.snapshot);
const listeners = new Set<(frame: SettingsFrame) => void>();
const attachment = presentation.attach((frame) => {
  for (const listener of listeners) listener(frame);
});
let readCloseState: (() => SettingsCloseState) | null = null;
let rendered = 0;
let companionRequests = 0;
const initial =
  new URLSearchParams(location.search).get("page") ?? "instructions";
presentation.remember(
  parseSettingsRoute(
    initial.startsWith("document:")
      ? { page: "document", id: initial.slice(9) }
      : { page: initial },
  ),
);
presentation.open("settings");
const connection: SettingsConnection = {
  ...product.connection,
  ready: async () => attachment.ready(),
  rendered: async () => {
    rendered++;
  },
  rememberRoute: async (route) => presentation.remember(route),
  showCompanion: async () => {
    companionRequests++;
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  onCloseState: (read) => {
    readCloseState = read;
    return () => {
      readCloseState = null;
    };
  },
};
Object.assign(window, {
  mochiTest: {
    ...product,
    navigate: (route: unknown) => {
      presentation.remember(parseSettingsRoute(route));
      presentation.open("settings");
    },
    closeState: () => {
      if (!readCloseState) throw new Error("Settings not subscribed");
      return readCloseState();
    },
    settingsRendered: () => rendered,
    companionRequests: () => companionRequests,
  },
});
createRoot(document.getElementById("root")!).render(
  <SettingsApp connection={connection} />,
);
