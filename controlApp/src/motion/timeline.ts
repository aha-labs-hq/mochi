import type { Phase, PreviewRequest } from "../shared/model.ts";
import type {
  Character,
  EventStage,
  MotionCatalog,
  MotionPolicy,
  Sequence,
} from "./catalog.ts";

export type FramePose =
  | { type: "asset"; id: string; stage?: EventStage; end?: boolean }
  | { type: "sequence"; id: string; position: number };
export interface EventRequest {
  sequence: string;
  nonce: string;
  startFrame?: number;
}
interface Target {
  key: string;
  asset: string;
  motion: MotionPolicy | { type: "event"; sequence: string };
  oneShot: boolean;
  startFrame?: number;
}
interface Performance {
  sequence: Sequence;
  position: number;
  target: string;
  exiting?: boolean;
}

/** Pure video-frame choreography. UI transitions never substitute generated motion. */
export class MotionTimeline {
  private target: Target;
  private performance: Performance | null = null;
  private idleUntil: number | null = null;
  private pending: string | null = null;
  private previousTime: number | null = null;
  private completedPreview: string | null = null;
  private previewHoldUntil: number | null = null;
  private reducedTarget: Target | null = null;

  constructor(
    readonly catalog: MotionCatalog,
    readonly character: Character,
    private readonly random = Math.random,
  ) {
    this.target = this.targetFor("checking", null);
  }
  setTarget(phase: Phase, preview: PreviewRequest, event?: EventRequest): void {
    const target = this.targetFor(phase, preview, event);
    if (target.key === this.target.key) return;
    if (event && this.target.motion.type === "event") {
      // An explicit replay is a new performance, not a queued state change.
      this.performance = null;
      this.previousTime = null;
    }
    this.target = target;
    this.idleUntil = null;
    this.pending = null;
    this.completedPreview = null;
    this.previewHoldUntil = null;
  }
  pause(): void {
    this.previousTime = null;
  }
  cancelEvent(): void {
    if (this.target.motion.type !== "event") return;
    this.performance = null;
    this.pending = null;
    this.previousTime = null;
    this.completedPreview = this.target.key;
  }
  tick(
    now: number,
    ready: (id: string, position?: number) => boolean,
    reducedMotion = false,
  ): FramePose {
    const elapsed =
      this.previousTime === null
        ? 0
        : Math.max(0, Math.min((now - this.previousTime) / 1000, 0.1));
    this.previousTime = now;
    if (reducedMotion) {
      this.performance = null;
      this.reducedTarget = this.target;
      if (this.target.motion.type === "event") {
        this.completedPreview = this.target.key;
        return this.eventRoot(true);
      }
      return { type: "asset", id: this.target.asset };
    }
    if (this.reducedTarget) {
      if (this.reducedTarget.motion.type === "state") {
        const last =
          this.catalog.timing(this.reducedTarget.motion.sequence).frameCount -
          1;
        if (!ready(this.reducedTarget.motion.sequence, last))
          return { type: "asset", id: this.reducedTarget.asset };
        this.performance = {
          sequence: this.catalog.sequence(this.reducedTarget.motion.sequence),
          position: last,
          target: this.reducedTarget.key,
        };
      }
      this.reducedTarget = null;
    }
    const performance = this.performance;
    if (performance) {
      const timing = this.catalog.timing(performance.sequence.id);
      const last = timing.frameCount - 1;
      const step = elapsed * timing.framesPerSecond;
      const sameTarget = performance.target === this.target.key;
      if (performance.sequence.kind === "event") {
        // A presentation event never loops or plays a physically false reverse
        // jump. Its owner can leave only after the terminal frame has landed.
        const next = Math.min(last, performance.position + step);
        if (ready(performance.sequence.id, next)) performance.position = next;
        if (performance.position === last) {
          this.completedPreview = performance.target;
          if (!sameTarget) this.performance = null;
        }
        if (this.performance)
          return {
            type: "sequence",
            id: performance.sequence.id,
            position: performance.position,
          };
      } else if (performance.sequence.kind === "state") {
        const leaving =
          !sameTarget || this.completedPreview === performance.target;
        const next = Math.min(
          last,
          Math.max(0, performance.position + (leaving ? -step : step)),
        );
        if (ready(performance.sequence.id, next)) performance.position = next;
        if (leaving && performance.position === 0) {
          // Render the exact canonical root before replacing the sequence
          // with its static asset, including when the reverse clock reaches
          // zero between display refreshes.
          this.performance = null;
          return {
            type: "sequence",
            id: performance.sequence.id,
            position: 0,
          };
        } else {
          if (
            sameTarget &&
            this.target.oneShot &&
            performance.position === last
          ) {
            this.previewHoldUntil ??= now + 800;
            if (now >= this.previewHoldUntil)
              this.completedPreview = performance.target;
          }
          return {
            type: "sequence",
            id: performance.sequence.id,
            position: performance.position,
          };
        }
      } else if (performance.sequence.kind === "sustained") {
        const cycle = performance.sequence.cycle!;
        // Once exit starts, finish it even if the product state changes back.
        // Re-entering then has the same exact-root ownership as any new action.
        performance.exiting ||= !sameTarget || this.target.oneShot;
        let next = performance.position + step;
        if (!performance.exiting && next >= cycle.end)
          next =
            cycle.start + ((next - cycle.start) % (cycle.end - cycle.start));
        next = Math.min(last, next);
        if (!performance.exiting && performance.position >= cycle.end - 3)
          ready(performance.sequence.id, cycle.start);
        if (ready(performance.sequence.id, next)) performance.position = next;
        if (performance.position === last) {
          if (sameTarget && this.target.oneShot)
            this.completedPreview = performance.target;
          this.performance = null;
        }
        return {
          type: "sequence",
          id: performance.sequence.id,
          position: performance.position,
        };
      } else {
        const next = performance.position + step;
        if (ready(performance.sequence.id, Math.min(last, next)))
          performance.position = next;
        if (performance.position < last)
          return {
            type: "sequence",
            id: performance.sequence.id,
            position: performance.position,
          };
        if (sameTarget && this.target.oneShot)
          this.completedPreview = performance.target;
        this.performance = null;
        this.pending = null;
      }
    }
    if (this.completedPreview === this.target.key)
      return this.target.motion.type === "event"
        ? this.eventRoot(true)
        : { type: "asset", id: this.character.rootAsset };
    const policy = this.target.motion;
    if (policy.type === "static")
      return { type: "asset", id: this.target.asset };
    if (policy.type === "intermittent") {
      this.idleUntil ??=
        now +
        (policy.minimumDelaySeconds +
          this.random() *
            (policy.maximumDelaySeconds - policy.minimumDelaySeconds)) *
          1000;
      if (now < this.idleUntil) return { type: "asset", id: this.target.asset };
    }
    this.pending ??=
      policy.type === "state" ||
      policy.type === "event" ||
      policy.type === "continuous"
        ? policy.sequence
        : policy.sequences[
            Math.min(
              policy.sequences.length - 1,
              Math.floor(this.random() * policy.sequences.length),
            )
          ]!;
    if (!ready(this.pending, this.target.startFrame ?? 0))
      return policy.type === "event"
        ? this.eventRoot(false)
        : { type: "asset", id: this.character.rootAsset };
    this.performance = {
      sequence: this.catalog.sequence(this.pending),
      position: this.target.startFrame ?? 0,
      target: this.target.key,
    };
    this.pending = null;
    this.idleUntil = null;
    return {
      type: "sequence",
      id: this.performance.sequence.id,
      position: this.performance.position,
    };
  }
  private eventRoot(end: boolean): FramePose {
    if (this.target.motion.type !== "event") throw new Error("No event stage");
    const stage = this.catalog.sequence(this.target.motion.sequence).stage;
    if (!stage) throw new Error("Event has no canonical stage");
    return { type: "asset", id: this.character.rootAsset, stage, end };
  }
  private targetFor(
    phase: Phase,
    preview: PreviewRequest,
    event?: EventRequest,
  ): Target {
    if (event) {
      if (preview) throw new Error("Two character performance owners");
      const sequence = this.catalog.sequence(event.sequence);
      if (
        sequence.kind !== "event" ||
        sequence.character !== this.character.id ||
        sequence.acceptance !== "approved" ||
        !event.nonce
      )
        throw new Error("Invalid character event");
      const startFrame = event.startFrame ?? 0;
      if (
        !Number.isSafeInteger(startFrame) ||
        startFrame < 0 ||
        startFrame >= this.catalog.timing(sequence.id).frameCount
      )
        throw new Error("Invalid event starting frame");
      return {
        key: `event:${sequence.id}:${event.nonce}:${startFrame}`,
        asset: this.character.rootAsset,
        motion: { type: "event", sequence: sequence.id },
        oneShot: true,
        startFrame,
      };
    }
    if (preview && preview.character === this.character.id) {
      const item = this.character.previews.find(
        (entry) => entry.id === preview.preview,
      );
      if (!item) throw new Error("Unknown preview");
      if (item.type === "sequence") {
        const sequence = this.catalog.sequence(item.target);
        return {
          key: preview.nonce,
          asset: sequence.targetAsset ?? this.character.rootAsset,
          oneShot: true,
          motion:
            sequence.kind === "event"
              ? { type: "event", sequence: sequence.id }
              : sequence.kind === "state"
                ? { type: "state", sequence: sequence.id }
                : sequence.kind === "sustained"
                  ? { type: "continuous", sequence: sequence.id }
                  : {
                      type: "intermittent",
                      sequences: [sequence.id],
                      minimumDelaySeconds: 0,
                      maximumDelaySeconds: 0,
                    },
        };
      }
      const state = this.catalog.state(this.character, item.target as Phase);
      return {
        key: preview.nonce,
        asset: state.asset,
        motion: state.motion,
        oneShot: state.motion.type === "state",
      };
    }
    const state = this.catalog.state(this.character, phase);
    return {
      key: JSON.stringify([state.asset, state.motion]),
      asset: state.asset,
      motion: state.motion,
      oneShot: false,
    };
  }
}
