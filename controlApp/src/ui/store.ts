import { createStore } from "zustand/vanilla";
import type { DesktopSurface } from "../shared/experience.ts";
import type { ExperiencePreview } from "../shared/experiencePreview.ts";
import {
  type DesktopSnapshot,
  initialSnapshot,
  type PreviewRequest,
} from "../shared/model.ts";
import {
  type DesktopProblem,
  problem,
  reconcileActionProblem,
} from "../shared/problem.ts";
import type { WindowHandoff } from "../shared/windowHandoff.ts";
import type { Connection } from "./connection.ts";

/** Host facts and transient window state; no persistence or query cache. */
export function createDesktopStore() {
  return createStore<{
    snapshot: DesktopSnapshot;
    preview: PreviewRequest;
    experiencePreview: ExperiencePreview | null;
    connectionProblem: DesktopProblem | null;
    actionProblem: DesktopProblem | null;
    surface: DesktopSurface;
    handoff: WindowHandoff | null;
    receivedFrame: boolean;
  }>(() => ({
    snapshot: initialSnapshot("", false),
    preview: null,
    experiencePreview: null,
    connectionProblem: null,
    actionProblem: null,
    surface: "companion",
    handoff: null,
    receivedFrame: false,
  }));
}
export type DesktopStore = ReturnType<typeof createDesktopStore>;

/** Subscribe before declaring readiness. Facts and menu intent arrive atomically;
 * recovery of the channel never dismisses an unrelated failed user action. */
export function observeDesktop(
  store: DesktopStore,
  connection: Connection,
): () => void {
  let active = true;
  let received = false;
  const unsubscribe = connection.subscribe((frame) => {
    if (!active) return;
    received = true;
    store.setState({
      snapshot: frame.snapshot,
      surface: frame.surface,
      handoff: frame.handoff ?? null,
      receivedFrame: true,
      preview: frame.preview,
      experiencePreview: frame.experiencePreview ?? null,
      connectionProblem: null,
      actionProblem: reconcileActionProblem(
        store.getState().actionProblem,
        frame.snapshot,
      ),
    });
  });
  void connection.ready().catch(() => {
    if (active && !received)
      store.setState({ connectionProblem: problem("control_unavailable") });
  });
  return () => {
    active = false;
    unsubscribe();
  };
}
