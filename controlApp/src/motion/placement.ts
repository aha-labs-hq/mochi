import type { Character, MotionCatalog } from "./catalog.ts";
import type { FramePose } from "./timeline.ts";

/** The root's scale and landing baseline stay fixed when its canvas gains air. */
export function posePlacement(
  catalog: MotionCatalog,
  character: Character,
  pose: FramePose,
) {
  const root = catalog.asset(character, character.rootAsset).geometry;
  const stage =
    pose.type === "sequence" ? catalog.sequence(pose.id).stage : pose.stage;
  const geometry =
    pose.type === "sequence"
      ? catalog.sequenceGeometry(catalog.sequence(pose.id))
      : stage
        ? { canvasWidth: stage.size, canvasHeight: stage.size }
        : catalog.asset(character, pose.id).geometry;
  // Anchor the entire performance at its landing. Do not move the canvas with
  // the actor: anticipation, flight and landing remain the video's own pixels.
  const origin = stage?.end ?? { x: 0, y: 0 };
  return {
    scale: geometry.canvasHeight / root.canvasHeight,
    anchorX: (origin.x + root.canvasWidth / 2) / geometry.canvasWidth,
    overhang:
      (geometry.canvasHeight - origin.y - root.bodyBottom) /
      geometry.canvasHeight,
  };
}
