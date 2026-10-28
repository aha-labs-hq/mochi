import { createRoot } from "react-dom/client";
import manifest from "../../motion/manifest.json";
import { DesktopPresentation } from "../src/host/presentation.ts";
import { MotionCatalog } from "../src/motion/catalog.ts";
import type {
  DesktopFrame,
  PreviewRequest,
  SettingsIntent,
} from "../src/shared/model.ts";
import { App } from "../src/ui/App.tsx";
import type { Connection } from "../src/ui/connection.ts";
import { productFixture } from "./productFixture.ts";
import "../src/ui/style.css";
import type { DesktopSurface } from "../src/shared/experience.ts";
import type { ExperiencePreviewCommand } from "../src/shared/experiencePreview.ts";
import type {
  HandoffReceipt,
  WindowHandoff,
} from "../src/shared/windowHandoff.ts";
import { motionEvidence } from "./motionEvidence.ts";
import { stickerEvidence } from "./stickerEvidence.ts";

const product = productFixture(() => {
  void presentation.observe();
});
const listeners = new Set<(value: DesktopFrame) => void>();
const presentation = new DesktopPresentation(() => product.snapshot, {
  hasMet: true,
  rememberMeeting() {},
});
const attach = () =>
  presentation.attach((frame) => {
    for (const listener of listeners) listener(frame);
  });
let renderer = attach();
const painted: HandoffReceipt[] = [];
const settingsRequests: SettingsIntent[] = [];
const connection: Connection = {
  ...product.connection,
  closeWindow: () => {
    element.dataset.windowClosed = "true";
  },
  ready: async () => renderer.ready(),
  endPreview: async () => presentation.setPreview(null),
  previewExperience: (command) => presentation.previewExperience(command),
  present: (intent) => presentation.present(intent),
  showSettings: async (sheet) => {
    await presentation.prepareSettings();
    settingsRequests.push(sheet);
  },
  presentationPainted: async (receipt) => {
    painted.push(receipt);
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
const element = document.getElementById("root")!;
let root = createRoot(element);
const catalog = new MotionCatalog(manifest);
const render = () =>
  root.render(<App connection={connection} catalog={catalog} />);
const initialSurface = new URLSearchParams(location.search).get("surface");
if (initialSurface === "intro" || initialSurface === "encounter") {
  await presentation.present("replayIntro");
  if (initialSurface === "intro") await presentation.present("meet");
}
Object.assign(window, {
  mochiTest: {
    painted,
    beginSetup: () => presentation.present("beginSetup"),
    handoff(handoff: WindowHandoff | null, surface: DesktopSurface) {
      for (const listener of listeners)
        listener({
          snapshot: product.snapshot,
          preview: null,
          surface,
          ...(handoff ? { handoff } : {}),
        });
    },
    stickerEvidence: () => stickerEvidence(catalog),
    motionEvidence: (id: string) => motionEvidence(catalog, id),
    preview(value: PreviewRequest) {
      presentation.setPreview(value);
    },
    previewExperience(command: ExperiencePreviewCommand) {
      return presentation.previewExperience(command);
    },
    sheet(value: SettingsIntent) {
      void connection.showSettings(value);
    },
    reopen(sheet?: SettingsIntent, preview?: PreviewRequest) {
      root.unmount();
      renderer.close();
      if (sheet) void connection.showSettings(sheet);
      if (preview !== undefined) presentation.setPreview(preview);
      renderer = attach();
      root = createRoot(element);
      render();
    },
    settingsRequests,
    actions: product.actions,
    modelRequests: product.modelRequests,
    skillRequests: product.skillRequests,
    skillContent: product.skillContent,
    failAction: product.failAction,
    holdActions: product.holdActions,
    releaseActions: product.releaseActions,
    update: product.update,
    problem: product.problem,
  },
});
render();
