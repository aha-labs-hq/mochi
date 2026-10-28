import {
  type DesktopSurface,
  type ExperienceIntent,
  needsSetup,
} from "../shared/experience.ts";
import {
  EXPERIENCE_SCENES,
  type ExperiencePreviewCommand,
  type PresentationPreview,
  previewDestination,
} from "../shared/experiencePreview.ts";
import type {
  DesktopFrame,
  DesktopSnapshot,
  PreviewRequest,
  Result,
} from "../shared/model.ts";
import { problem } from "../shared/problem.ts";
import type { HandoffReceipt, WindowHandoff } from "../shared/windowHandoff.ts";
import {
  TransitionInterrupted,
  WindowHandoffOwner,
  type WindowStage,
} from "./windowHandoff.ts";

interface ExperienceOwner {
  hasMet: boolean;
  rememberMeeting(): void;
  hasFinishedSetup?: boolean;
  rememberFinishedSetup?(): void;
  window?: WindowStage;
}

/** One window, one atomic delivery channel. Readiness belongs to the subscriber,
 * not WebView loading; only the latest unconsumed menu intent is retained. */
export class DesktopPresentation {
  private renderer: {
    send: (frame: DesktopFrame) => void;
    ready: boolean;
  } | null = null;
  private preview: PresentationPreview = null;
  private previewReturnSurface: DesktopSurface | null = null;
  surface: DesktopSurface;
  private display: {
    surface: DesktopSurface;
    preview: PresentationPreview;
  } | null = null;
  private handoff: WindowHandoff | null = null;
  private readonly windowHandoff: WindowHandoffOwner | null;
  private transition: {
    completion: Promise<void>;
    previewing: boolean;
  } | null = null;

  constructor(
    private readonly snapshot: () => DesktopSnapshot,
    private readonly experience?: ExperienceOwner,
  ) {
    this.windowHandoff = experience?.window
      ? new WindowHandoffOwner(experience.window)
      : null;
    // Existing users may predate the completion preference. A durable activated
    // Session is sufficient evidence that the first setup already happened.
    if (
      experience &&
      !experience.hasFinishedSetup &&
      snapshot().bots.some((bot) =>
        ["listening", "awaitingLogin", "awaitingConnection", "paused"].includes(
          bot.lifecycle,
        ),
      )
    ) {
      experience.hasFinishedSetup = true;
      experience.rememberFinishedSetup?.();
    }
    this.surface = !snapshot().locationReady
      ? "setup"
      : (snapshot().controlReady && snapshot().bots.length === 0) ||
          (experience &&
            !experience.hasFinishedSetup &&
            needsSetup(snapshot()) &&
            snapshot().bots.length <= 1)
        ? experience?.hasMet === false
          ? "encounter"
          : "setup"
        : "companion";
  }

  async present(intent: ExperienceIntent): Promise<void> {
    if (!this.snapshot().locationReady && intent !== "beginSetup")
      throw new Error("Install Mochi in Applications first");
    if (this.preview?.kind === "experience") {
      await this.previewExperience(
        intent === "meet"
          ? "intro"
          : intent === "beginSetup"
            ? "install"
            : intent === "finishSetup"
              ? "companion"
              : "encounter",
      );
      return;
    }
    const next =
      intent === "replayIntro"
        ? "encounter"
        : intent === "meet"
          ? "intro"
          : intent === "beginSetup"
            ? "setup"
            : "companion";
    // Repeated clicks join the same transition. A different user intent waits
    // for its predecessor instead of being silently discarded mid-animation.
    if (this.transition) {
      const pending = this.transition;
      await pending.completion;
      return this.present(intent);
    }
    if (
      intent === "finishSetup" &&
      (needsSetup(this.snapshot()) ||
        !this.snapshot().controlReady ||
        !this.snapshot().bots.some(
          (bot) => bot.botId === this.snapshot().selectedBotId,
        ))
    )
      // Facts changed after the click, as when a status change races the
      // "完成设置" button; setup stays on screen with the current facts.
      throw new TransitionInterrupted("stale", "Setup is not complete");
    if (next === this.surface && !this.preview) return;
    if (intent === "meet" && this.surface !== "encounter")
      throw new TransitionInterrupted("stale", "The encounter is not active");
    await this.move(next, null, null, intent === "beginSetup");
    if (intent === "finishSetup" && this.experience) {
      this.experience.hasFinishedSetup = true;
      this.experience.rememberFinishedSetup?.();
    }
  }

  private async move(
    next: DesktopSurface,
    preview: PresentationPreview,
    returnSurface: DesktopSurface | null,
    rememberMeeting = false,
  ): Promise<void> {
    const previous = this.surface;
    const previousPreview = this.preview;
    const previousExperience = this.previewReturnSurface ?? previous;
    const completion = Promise.withResolvers<void>();
    this.transition = {
      completion: completion.promise,
      previewing: previousPreview !== null || preview !== null,
    };
    // A transition may have no other caller; observe a rejection locally too.
    void completion.promise.catch(() => {});
    try {
      // Arrival and story occupy the same full-desktop window. Publishing the
      // story only reveals content; staging/resizing here would pause the held
      // landing and reconfigure AppKit despite there being nowhere to move.
      const sameDesktop = [previous, next].every(
        (surface) => surface === "encounter" || surface === "intro",
      );
      if (this.windowHandoff && previous !== next && !sameDesktop) {
        await this.windowHandoff.move(previous, next, (surface, handoff) => {
          this.display = {
            surface,
            preview: surface === previous ? previousPreview : preview,
          };
          this.handoff = handoff;
          this.publish();
        });
      }
      this.surface = next;
      this.preview = preview;
      this.previewReturnSurface = returnSurface;
      if (
        rememberMeeting &&
        next === "setup" &&
        (previousExperience === "intro" || previousExperience === "encounter")
      )
        this.experience?.rememberMeeting();
      completion.resolve();
    } catch (error) {
      this.surface = previous;
      this.publish();
      completion.reject(error);
      throw error;
    } finally {
      this.display = null;
      this.handoff = null;
      this.transition = null;
      this.publish();
    }
  }

  /** Daily Bot configuration never restarts the first introduction. */
  async observe(): Promise<void> {
    if (
      (!this.snapshot().locationReady ||
        (this.snapshot().controlReady &&
          this.snapshot().bots.length === 0 &&
          this.surface === "companion")) &&
      !this.preview &&
      !this.transition &&
      this.surface !== "setup"
    ) {
      await this.move("setup", null, null);
      return;
    }
    if (
      this.experience &&
      !this.experience.hasMet &&
      !this.preview &&
      !this.transition &&
      this.surface === "companion" &&
      this.snapshot().bots.length <= 1 &&
      needsSetup(this.snapshot())
    ) {
      await this.present("beginSetup");
    } else this.publish();
  }

  attach(send: (frame: DesktopFrame) => void) {
    if (this.renderer) throw new Error("A renderer is already attached");
    const renderer = { send, ready: false };
    this.renderer = renderer;
    return {
      ready: (): void => {
        if (this.renderer !== renderer) return;
        renderer.ready = true;
        this.publish();
      },
      close: (): void => {
        if (this.renderer === renderer) {
          this.renderer = null;
          this.windowHandoff?.cancel();
        }
      },
    };
  }

  publish(): void {
    if (!this.renderer?.ready) return;
    const preview = this.display ? this.display.preview : this.preview;
    this.renderer.send({
      snapshot: this.snapshot(),
      preview: preview?.kind === "motion" ? preview.request : null,
      ...(preview?.kind === "experience"
        ? { experiencePreview: preview.request }
        : {}),
      surface: this.display?.surface ?? this.surface,
      ...(this.handoff ? { handoff: this.handoff } : {}),
    });
  }

  acknowledge(receipt: HandoffReceipt): void {
    if (!this.windowHandoff) throw new Error("No native handoff is active");
    this.windowHandoff.acknowledge(receipt);
  }

  async prepareSettings(): Promise<void> {
    // Settings needs only a settled window; how a transition ended is reported
    // to the caller that started it.
    if (this.transition) await this.transition.completion.catch(() => {});
    if (!this.preview) return;
    if (this.renderer) await this.setPreview(null);
    else {
      this.surface = this.previewReturnSurface ?? this.surface;
      this.preview = null;
      this.previewReturnSurface = null;
    }
  }

  async setPreview(preview: PreviewRequest): Promise<void> {
    await this.selectPreview(
      preview ? { kind: "motion", request: preview } : null,
    );
  }

  async previewExperience(command: ExperiencePreviewCommand): Promise<void> {
    if (this.transition) {
      await this.transition.completion;
      return this.previewExperience(command);
    }
    const scene = previewDestination(
      command,
      this.preview?.kind === "experience" ? this.preview.request.scene : null,
    );
    await this.selectPreview({
      kind: "experience",
      request: { scene, nonce: crypto.randomUUID() },
    });
  }

  /** Both RPC and native service menus pass this gate. Preview can never grant
   * permission; staging also blocks actions before the new frame is painted. */
  async live<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.preview || this.transition?.previewing)
      return { ok: false, problem: problem("preview_active") };
    return operation();
  }

  private async selectPreview(preview: PresentationPreview): Promise<void> {
    if (this.transition) {
      await this.transition.completion;
      return this.selectPreview(preview);
    }
    if (!preview && !this.preview) return;
    // Preview temporarily owns the normal companion window, not the user's
    // setup progress. Keep the source content frozen until the native stage is
    // ready, and restore the encounter/intro/setup when the preview ends.
    const origin = this.preview ? this.previewReturnSurface : this.surface;
    await this.move(
      preview?.kind === "experience"
        ? EXPERIENCE_SCENES[preview.request.scene].surface
        : preview
          ? "companion"
          : (origin ?? this.surface),
      preview,
      preview ? origin : null,
    );
  }
}
