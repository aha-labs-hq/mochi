import type { Entrance } from "../../controlApp/src/motion/catalog.ts";
import { sequenceTiming } from "../../controlApp/src/motion/timing.ts";
import manifest from "../../motion/manifest.json";
import type { EntranceStage } from "./stage.ts";

/* The companion's motion manifest owns every approved performance. The
   website reads it here, on the server and in the build, and hands browsers
   only the few numbers they need instead of shipping the manifest. */
const mochi = manifest.characters.find((character) => character.id === "mochi");
const cues: Entrance | undefined = mochi?.entrance;
const root = mochi?.assets.find((asset) => asset.id === mochi.rootAsset);
if (!mochi || !cues || !root)
  throw new Error("Mochi's approved entrance is missing from the manifest");

function approved(id: string, character = "mochi") {
  const sequence = manifest.sequences.find((item) => item.id === id);
  if (
    sequence?.character !== character ||
    sequence.acceptance !== "approved" ||
    !sequence.assetSha256
  )
    throw new Error(`${character} has no approved sequence ${id}`);
  const timing = sequenceTiming(manifest.production, sequence);
  return {
    sequence: sequence.id,
    asset: sequence.asset,
    assetSha256: sequence.assetSha256,
    framesPerSecond: timing.framesPerSecond,
    frameCount: timing.frameCount,
  };
}

/**
 * Approved motion the website plays, re-encoded for browsers by
 * `bun run site:motion`. `reverse` plays the source backwards, the way the
 * companion leaves a state: sleep reversed is waking up.
 */
export const clips = {
  entrance: { ...approved(cues.sequence), reverse: false },
  pet: { ...approved("idle-curious"), reverse: false },
  awawa: { ...approved("awawa-idle", "awawa"), reverse: false },
  wake: { ...approved("sleep"), reverse: true },
};
export type ClipName = keyof typeof clips;

const encounter = manifest.sequences.find((item) => item.id === cues.sequence);
if (!encounter || !("stage" in encounter) || !encounter.stage)
  throw new Error("Mochi's entrance has no stage");
const { x, y } = encounter.stage.end;
const { canvasWidth, bodyBottom, visualBounds } = root.geometry;
export const entranceStage: EntranceStage = {
  sequence: cues.sequence,
  peek: cues.peek,
  jump: cues.jump,
  land: cues.land,
  framesPerSecond: clips.entrance.framesPerSecond,
  frameCount: clips.entrance.frameCount,
  size: encounter.stage.size,
  rootX: x,
  rootY: y,
  rootSize: canvasWidth,
  visualLeft: x + visualBounds.x,
  visualTop: y + visualBounds.y,
  visualWidth: visualBounds.width,
  bodyBottom: y + bodyBottom,
};

/** Where each companion's body is cut, so all of them rest on one shelf. */
export const cast = Object.fromEntries(
  manifest.characters.map((character) => {
    const asset = character.assets.find(
      (item) => item.id === character.rootAsset,
    );
    if (!asset) throw new Error(`${character.id} has no root asset`);
    const { canvasHeight, bodyBottom } = asset.geometry;
    return [
      character.id,
      { below: (canvasHeight - bodyBottom) / canvasHeight },
    ];
  }),
) as Record<string, { below: number }>;
