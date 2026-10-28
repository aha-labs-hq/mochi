import type { DesktopSurface } from "../shared/experience.ts";
import {
  type HandoffReceipt,
  type HandoffStep,
  localHandoff,
  type WindowHandoff,
  type WindowPlan,
  type WindowRect,
} from "../shared/windowHandoff.ts";

export interface WindowStagePlan extends WindowPlan {
  visible: boolean;
}
export interface WindowStage {
  plan(surface: DesktopSurface): Promise<WindowStagePlan>;
  place(rect: WindowRect, surface: DesktopSurface | null): Promise<void>;
}

/** Why a transition ended before landing: its window closed, a newer handoff
 * cancelled it, its renderer never painted, or its intent no longer applied.
 * The source scene is already back, so the App keeps running and only the
 * intent is dropped. Any other failure is not a transition's to absorb. */
export class TransitionInterrupted extends Error {
  constructor(
    readonly reason: "closed" | "cancelled" | "unpainted" | "stale",
    message: string,
  ) {
    super(message);
    this.name = "TransitionInterrupted";
  }
}

/** Three paint receipts, one NSWindow. Native geometry never races responsive
 * layout. Missing/stale renderers fail visibly instead of finishing a fake move. */
export class WindowHandoffOwner {
  private serial = 0;
  private waiting: {
    id: number;
    step: HandoffStep;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  constructor(
    private readonly native: WindowStage,
    private readonly timeoutMs = 8_000,
  ) {}

  acknowledge(receipt: HandoffReceipt): void {
    const waiting = this.waiting;
    if (!waiting || receipt.id !== waiting.id || receipt.step !== waiting.step)
      throw new Error("Stale window handoff receipt");
    this.waiting = null;
    waiting.resolve();
  }
  cancel(): void {
    this.serial++;
    this.waiting?.reject(
      new TransitionInterrupted("closed", "Window closed during handoff"),
    );
    this.waiting = null;
  }
  async move(
    from: DesktopSurface,
    to: DesktopSurface,
    publish: (surface: DesktopSurface, handoff: WindowHandoff | null) => void,
  ): Promise<void> {
    const id = ++this.serial;
    const active = () => {
      if (id !== this.serial)
        throw new TransitionInterrupted(
          "cancelled",
          "Window handoff cancelled",
        );
    };
    const plan = await this.native.plan(to);
    const paint = async (step: HandoffStep, surface: DesktopSurface) => {
      active();
      const promise = Promise.withResolvers<void>();
      const timer = setTimeout(
        () =>
          promise.reject(
            new TransitionInterrupted(
              "unpainted",
              `Window ${step} paint timed out`,
            ),
          ),
        this.timeoutMs,
      );
      this.waiting = {
        id,
        step,
        resolve: promise.resolve,
        reject: promise.reject,
      };
      try {
        publish(surface, localHandoff(plan, id, step));
        await promise.promise;
        active();
      } finally {
        clearTimeout(timer);
        if (this.waiting?.id === id && this.waiting.step === step)
          this.waiting = null;
      }
    };
    try {
      active();
      // WebKit suspends paint callbacks for hidden/occluded windows. There is
      // no visible motion to preserve: commit the target geometry and content
      // without requesting paint receipts or bringing the window forward.
      if (!plan.visible) {
        await this.native.place(plan.target, to);
        active();
        publish(to, null);
        return;
      }
      await paint("stage", from);
      await this.native.place(plan.stage, null);
      active();
      await paint("animate", to);
      await paint("land", to);
      await this.native.place(plan.target, to);
      active();
      publish(to, null);
    } catch (error) {
      // Restore exact native geometry, not an independently recomputed location.
      await this.native.place(plan.source, from);
      publish(from, null);
      throw error;
    }
  }
}
