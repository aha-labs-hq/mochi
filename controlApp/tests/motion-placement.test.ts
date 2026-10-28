import { expect, test } from "bun:test";
import manifest from "../../motion/manifest.json";
import { MotionCatalog } from "../src/motion/catalog.ts";
import { posePlacement } from "../src/motion/placement.ts";

const fixture = structuredClone(manifest);
for (const sequence of fixture.sequences)
  if (["encounter-small-hop-m", "encounter-stage-i"].includes(sequence.id))
    Object.assign(sequence, {
      bundledForPreview: true,
      assetSha256: "0".repeat(64),
    });
const catalog = new MotionCatalog(fixture);
const character = catalog.defaultCharacter;

test("padding a travelling actor never shrinks its optical size or moves its landing baseline", () => {
  const root = catalog.asset(character, character.rootAsset).geometry;
  for (const id of ["encounter-small-hop-m", "encounter-stage-i"]) {
    const stage = catalog.sequence(id).stage!;
    for (const pose of [
      { type: "sequence", id, position: 0 },
      { type: "sequence", id, position: 20.5 },
      { type: "sequence", id, position: 39 },
      { type: "asset", id: character.rootAsset, stage, end: true },
    ] as const) {
      const placement = posePlacement(catalog, character, pose);
      for (const rootHeight of [108, 220, 380, 512]) {
        const canvasHeight = rootHeight * placement.scale;
        const pixelScale = canvasHeight / stage.size;
        expect(pixelScale).toBeCloseTo(rootHeight / root.canvasHeight, 10);
        const bottom = canvasHeight * placement.overhang;
        const top = bottom - canvasHeight;
        expect(top + (stage.end.y + root.bodyBottom) * pixelScale).toBeCloseTo(
          0,
          10,
        );
        const left = -canvasHeight * placement.anchorX;
        expect(
          left + (stage.end.x + root.canvasWidth / 2) * pixelScale,
        ).toBeCloseTo(0, 10);
      }
    }
  }
});

test("the ordinary root retains its existing centered body-baseline placement", () => {
  expect(
    posePlacement(catalog, character, {
      type: "asset",
      id: character.rootAsset,
    }),
  ).toEqual({
    scale: 1,
    anchorX: 0.5,
    overhang: (512 - 476) / 512,
  });
});
