import type { Entrance } from "./catalog.ts";

const unit = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const x = unit(value);
  return x * x * (3 - 2 * x);
};

/** Spatial staging only. The source video owns gaze, crouch, limbs and contact.
 * Its fractional frame clock also owns the reveal, so decoding or pausing the
 * actor cannot leave the scenery running ahead. All coordinates are optical. */
export function entrancePose(frame: number, cues: Entrance) {
  const peek = smooth(frame / cues.peek);
  const flight = unit((frame - cues.jump) / (cues.land - cues.jump));
  // A ballistic spatial arc reaches its apex before contact. A monotonic
  // smoothstep instead drags the actor upward THROUGH the destination panel.
  // The shallow overshoot leaves headroom; the video owns the landing crouch.
  const rise = (flight * (8 - 5 * flight)) / 3;
  return {
    // Initially below the physical desktop, then ears, eyes and shoulders peek.
    // Leave the torso below the screen, but expose BOTH eyes before takeoff.
    // A 0.43-root offset hid the eyes: only ear tips appeared until the jump.
    belowEdge: (1 - peek * 0.78) * (1 - rise),
    travel: smooth(flight),
    rise,
    frameReveal: smooth((flight - 0.5) * 2),
    landed: frame >= cues.land,
  };
}
