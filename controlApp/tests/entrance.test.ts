import { expect, test } from "bun:test";
import source from "../../motion/manifest.json";
import { type Manifest, MotionCatalog } from "../src/motion/catalog.ts";
import { entrancePose } from "../src/motion/entrance.ts";
import { MotionTimeline } from "../src/motion/timeline.ts";

function fixture() {
  const document = structuredClone(source) as Manifest;
  const sequence = document.sequences.find((s) => s.id === "encounter")!;
  sequence.acceptance = "approved";
  delete sequence.framesPerSecond;
  sequence.assetSha256 = "a".repeat(64);
  const entrance = { sequence: sequence.id, peek: 7, jump: 14, land: 28 };
  document.characters[0]!.entrance = entrance;
  const catalog = new MotionCatalog(document);
  return { document, entrance, catalog, sequence };
}

test("only an approved same-character event can own autonomous arrival", () => {
  const { document, sequence } = fixture();
  sequence.acceptance = "candidate";
  sequence.bundledForPreview = true;
  expect(() => new MotionCatalog(document)).toThrow("approved entrance");
  sequence.acceptance = "approved";
  delete sequence.bundledForPreview;
  document.characters[0]!.entrance!.land = 40;
  expect(() => new MotionCatalog(document)).toThrow("approved entrance");
});

test("entrance is absent or a complete approved event contract, never a falsy bypass", () => {
  for (const invalid of [null, false, 0, "", {}, []]) {
    const { document } = fixture();
    Object.assign(document.characters[0]!, { entrance: invalid });
    expect(() => new MotionCatalog(document)).toThrow("approved entrance");
  }
  const { document, sequence } = fixture();
  sequence.acceptance = "approved-reference";
  expect(() => new MotionCatalog(document)).toThrow("approved entrance");
});

test("desktop and felt share the actual fractional video clock", () => {
  const { entrance } = fixture();
  expect(entrancePose(0, entrance)).toEqual({
    belowEdge: 1,
    travel: 0,
    rise: 0,
    frameReveal: 0,
    landed: false,
  });
  expect(entrancePose(7, entrance)).toEqual({
    belowEdge: 0.21999999999999997,
    travel: 0,
    rise: 0,
    frameReveal: 0,
    landed: false,
  });
  expect(entrancePose(28, entrance)).toEqual({
    belowEdge: 0,
    travel: 1,
    rise: 1,
    frameReveal: 1,
    landed: true,
  });
  let previous = entrancePose(0, entrance);
  for (let frame = 0.1; frame <= 39; frame += 0.1) {
    const pose = entrancePose(frame, entrance);
    expect(pose.travel).toBeGreaterThanOrEqual(previous.travel);
    expect(pose.frameReveal).toBeGreaterThanOrEqual(previous.frameReveal);
    expect(pose.rise).toBeLessThanOrEqual(1.067);
    if (frame <= entrance.jump)
      expect(pose.belowEdge).toBeLessThanOrEqual(previous.belowEdge);
    previous = pose;
  }
  const apex = entrance.jump + (entrance.land - entrance.jump) * 0.8;
  expect(entrancePose(apex, entrance).rise).toBeGreaterThan(1);
  expect(entrancePose(apex + 1, entrance).rise).toBeLessThan(
    entrancePose(apex, entrance).rise,
  );
});

test("an event request cannot bypass production acceptance or omit replay identity", () => {
  const { catalog, entrance, sequence } = fixture();
  const timeline = new MotionTimeline(catalog, catalog.defaultCharacter);
  expect(() =>
    timeline.setTarget("checking", null, {
      sequence: entrance.sequence,
      nonce: "",
    }),
  ).toThrow("Invalid character event");
  sequence.acceptance = "rejected";
  expect(() =>
    timeline.setTarget("checking", null, {
      sequence: entrance.sequence,
      nonce: "not-approved",
    }),
  ).toThrow("Invalid character event");
});

test("replay segments decode their own page, then continue forward and never catch up hidden time", () => {
  const { catalog, entrance } = fixture();
  const timeline = new MotionTimeline(catalog, catalog.defaultCharacter);
  timeline.setTarget("checking", null, {
    sequence: entrance.sequence,
    nonce: "replay",
    startFrame: entrance.jump,
  });
  expect(timeline.tick(0, () => false)).toMatchObject({
    type: "asset",
    end: false,
  });
  expect(timeline.tick(2000, () => true)).toMatchObject({
    position: entrance.jump,
  });
  timeline.pause();
  expect(timeline.tick(30000, () => true)).toMatchObject({
    position: entrance.jump,
  });
  expect(timeline.tick(30100, () => true)).toMatchObject({
    position: entrance.jump + 1,
  });
  expect(() =>
    timeline.setTarget("checking", null, {
      sequence: entrance.sequence,
      nonce: "invalid",
      startFrame: -1,
    }),
  ).toThrow();
});

test("an explicit replay replaces the old presentation clock; an explicit skip never resumes midair in setup", () => {
  const { catalog, entrance } = fixture();
  const timeline = new MotionTimeline(catalog, catalog.defaultCharacter);
  timeline.setTarget("checking", null, {
    sequence: entrance.sequence,
    nonce: "first",
    startFrame: 20,
  });
  expect(timeline.tick(0, () => true)).toMatchObject({ position: 20 });
  timeline.setTarget("checking", null, {
    sequence: entrance.sequence,
    nonce: "second",
    startFrame: 7,
  });
  expect(timeline.tick(100, () => true)).toMatchObject({ position: 7 });
  timeline.cancelEvent();
  expect(timeline.tick(200, () => true)).toMatchObject({
    type: "asset",
    end: true,
  });
  timeline.setTarget("checking", null);
  expect(timeline.tick(300, () => true)).toEqual({
    type: "asset",
    id: catalog.defaultCharacter.rootAsset,
  });
});
