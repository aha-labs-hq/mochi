import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { cleanEdgeRgba } from "../../script/motion_matte.ts";
import { decodeAtlas } from "../build/resources.ts";
import {
  approved,
  type Manifest,
  MotionCatalog,
} from "../src/motion/catalog.ts";
import { ATLAS_COLUMNS, atlasLayout } from "../src/motion/resources.ts";
import { type FramePose, MotionTimeline } from "../src/motion/timeline.ts";
import { frameDuration, sequenceTiming } from "../src/motion/timing.ts";
import { PHASES } from "../src/shared/model.ts";

const source = JSON.parse(
  await readFile(
    new URL("../../motion/manifest.json", import.meta.url),
    "utf8",
  ),
) as Manifest;
const catalog = new MotionCatalog(source),
  character = catalog.defaultCharacter;
const ready = () => true;
const position = (frame: FramePose) =>
  frame.type === "sequence" ? frame.position : 0;

test("shared matte cleanup removes blue fringe without changing coverage", () => {
  const rgba = new Uint8Array(7 * 7 * 4);
  for (let y = 1; y < 6; y++)
    for (let x = 1; x < 6; x++) {
      const offset = (y * 7 + x) * 4;
      rgba.set([230, 220, 205, 255], offset);
    }
  const fringe = (x: number, y: number, alpha: number) => {
    const offset = (y * 7 + x) * 4;
    rgba.set([20, 120, 250, alpha], offset);
  };
  fringe(1, 3, 96);
  fringe(1, 2, 255);
  fringe(0, 3, 48);
  const beforeAlpha = Array.from(rgba).filter((_, index) => index % 4 === 3);
  const cleaned = cleanEdgeRgba(rgba, 7, 7);
  expect(Array.from(cleaned).filter((_, index) => index % 4 === 3)).toEqual(
    beforeAlpha,
  );
  expect(cleaned[(3 * 7 + 0) * 4 + 3]).toBe(48);
  expect(cleaned[(3 * 7 + 0) * 4 + 2]).toBeLessThanOrEqual(
    Math.max(cleaned[(3 * 7 + 0) * 4]!, cleaned[(3 * 7 + 0) * 4 + 1]!) + 2,
  );
  expect(cleaned[(3 * 7 + 1) * 4 + 2]).toBeLessThanOrEqual(
    Math.max(cleaned[(3 * 7 + 1) * 4]!, cleaned[(3 * 7 + 1) * 4 + 1]!) + 2,
  );
  expect(cleaned[(2 * 7 + 1) * 4 + 2]).toBeLessThanOrEqual(
    Math.max(cleaned[(2 * 7 + 1) * 4]!, cleaned[(2 * 7 + 1) * 4 + 1]!) + 2,
  );
});

test("source cadence is bounded, exact and shared by decoding and the video clock", () => {
  expect(sequenceTiming(source.production, {})).toEqual({
    frameCount: 40,
    framesPerSecond: 10,
  });
  expect(sequenceTiming(source.production, { framesPerSecond: 24 })).toEqual({
    frameCount: 96,
    framesPerSecond: 24,
  });
  for (const framesPerSecond of [0, -1, 24.5, 61, NaN, Infinity, null, "24"]) {
    const document = structuredClone(source);
    Object.assign(document.sequences[0]!, { framesPerSecond });
    expect(() => new MotionCatalog(document)).toThrow("cadence");
  }
  for (const durationSeconds of [0, -4, NaN, Infinity, null, "4"]) {
    const document = structuredClone(source);
    Object.assign(document.production, { durationSeconds });
    expect(() => new MotionCatalog(document)).toThrow("cadence");
  }
  for (const fps of [10, 24, 30, 60]) {
    const delays = Array.from({ length: fps * 4 }, (_, i) =>
      frameDuration(i, fps),
    );
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(4000);
    expect(Math.max(...delays) - Math.min(...delays)).toBeLessThanOrEqual(1);
  }
});

test("an event retains native cadence and settles only at its own terminal frame", () => {
  const document = structuredClone(source);
  const event = document.sequences.find((s) => s.id === "encounter")!;
  event.framesPerSecond = 24;
  const catalog = new MotionCatalog(document);
  const player = new MotionTimeline(catalog, catalog.defaultCharacter);
  player.setTarget("checking", null, { sequence: event.id, nonce: "cadence" });
  player.tick(0, ready);
  expect(position(player.tick(100, ready))).toBeCloseTo(2.4);
  for (let now = 200; now <= 2000; now += 100) player.tick(now, ready);
  expect(position(player.tick(2000, ready))).toBeCloseTo(48);
  for (let now = 2100; now <= 4500; now += 100) player.tick(now, ready);
  expect(position(player.tick(4600, ready))).toBe(95);
});

test("leaving reduced motion waits for the held state's terminal atlas page", () => {
  const player = new MotionTimeline(catalog, character);
  player.setTarget("stopped", null);
  expect(player.tick(0, ready, true)).toEqual({
    type: "asset",
    id: "sleeping",
  });
  const requested: [string, number | undefined][] = [];
  expect(
    player.tick(100, (id, position) => {
      requested.push([id, position]);
      return false;
    }),
  ).toEqual({ type: "asset", id: "sleeping" });
  const last = catalog.timing("sleep").frameCount - 1;
  expect(requested).toEqual([["sleep", last]]);
  expect(player.tick(200, ready)).toEqual({
    type: "sequence",
    id: "sleep",
    position: last,
  });
});

test("sustained cycles retain fractional time without re-entering the neutral introduction", () => {
  for (const character of catalog.characters)
    for (const state of character.states) {
      const policy = state.motion;
      if (policy.type !== "continuous") continue;
      const sequence = catalog.sequence(policy.sequence);
      const cycle = sequence.cycle!;
      const fps = catalog.timing(sequence.id).framesPerSecond;
      const player = new MotionTimeline(catalog, character);
      player.setTarget(state.id, null);
      player.tick(0, ready);
      for (let now = 20; now <= 30000; now += 20) {
        const frame = player.tick(now, ready);
        expect(frame.type).toBe("sequence");
        if ((now * fps) / 1000 >= cycle.end) {
          expect(position(frame)).toBeGreaterThanOrEqual(cycle.start);
          expect(position(frame)).toBeLessThan(cycle.end);
        }
      }
    }
});

test("source exposure selection is bounded and retains cadence", () => {
  expect(
    sequenceTiming(source.production, {
      framesPerSecond: 24,
      sourceFrames: { start: 8, end: 43 },
    }),
  ).toEqual({ framesPerSecond: 24, frameCount: 36 });
  for (const range of [
    null,
    { start: -1, end: 40 },
    { start: 3, end: 3 },
    { start: 1, end: 96 },
    { start: 1.5, end: 40 },
  ]) {
    const document = structuredClone(source);
    Object.assign(document.sequences[0]!, { sourceFrames: range });
    expect(() => new MotionCatalog(document)).toThrow("source frame range");
  }
});

for (const owner of catalog.characters)
  for (const state of owner.states.filter(
    (state) => state.motion.type === "continuous",
  ))
    test(`${owner.id}/${state.id}: interrupted entry and activity retire forward before re-entry`, () => {
      if (state.motion.type !== "continuous")
        throw new Error("Expected activity");
      const id = state.motion.sequence;
      const last = catalog.timing(id).frameCount - 1;
      for (const exitAt of [500, 6500]) {
        const player = new MotionTimeline(catalog, owner);
        player.setTarget(state.id, null);
        player.tick(0, ready);
        for (let time = 20; time <= exitAt; time += 20)
          player.tick(time, ready);
        let previous = position(player.tick(exitAt, ready));
        player.setTarget("checking", null);
        const retiring = player.tick(exitAt + 20, ready);
        expect(retiring).toMatchObject({ type: "sequence", id });
        expect(position(retiring)).toBeGreaterThan(previous);
        previous = position(retiring);
        player.setTarget(state.id, null);
        let landed = false;
        let restarted = false;
        for (let time = exitAt + 40; time < exitAt + 6000; time += 20) {
          const frame = player.tick(time, ready);
          expect(frame).toMatchObject({ type: "sequence", id });
          const current = position(frame);
          if (landed) {
            expect(current).toBe(0);
            restarted = true;
            break;
          }
          expect(current).toBeGreaterThanOrEqual(previous);
          landed = current === last;
          previous = current;
        }
        expect(landed).toBe(true);
        expect(restarted).toBe(true);
      }
    });

test("continuous ownership rejects neutral-root loops and malformed activity cues", () => {
  const invalid = structuredClone(source);
  invalid.characters[0]!.states.find((s) => s.id === "working")!.motion = {
    type: "continuous",
    sequence: "idle-curious",
  };
  expect(() => new MotionCatalog(invalid)).toThrow("sustained state");
  for (const cycle of [
    null,
    { start: 0, end: 51 },
    { start: 24, end: 25 },
    { start: 24, end: 95 },
    { start: 24.5, end: 51 },
  ]) {
    const document = structuredClone(source);
    Object.assign(document.sequences.find((s) => s.id === "working-console")!, {
      cycle,
    });
    expect(() => new MotionCatalog(document)).toThrow(
      "sustained entry, cycle and exit",
    );
  }
});

function eventFixture() {
  const document = structuredClone(source);
  const event = document.sequences.find((s) => s.id === "encounter-leap-a")!;
  event.acceptance = "candidate";
  event.bundledForPreview = true;
  event.assetSha256 = "a".repeat(64);
  document.characters[0]!.previews.push({
    id: "event",
    title: "Candidate event",
    group: "Review",
    type: "sequence",
    target: event.id,
  });
  const catalog = new MotionCatalog(document);
  const player = new MotionTimeline(catalog, catalog.defaultCharacter);
  player.setTarget("listening", {
    character: "mochi",
    preview: "event",
    nonce: "one",
  });
  return { document, catalog, player, event };
}

describe("explicit one-shot acting stage", () => {
  test("is reviewable without becoming an autonomous state binding", () => {
    const { document } = eventFixture();
    document.characters[0]!.states.find((s) => s.id === "working")!.motion = {
      type: "continuous",
      sequence: "encounter-leap-a",
    };
    expect(() => new MotionCatalog(document)).toThrow();
  });
  test("rejects rescaled, cropped, unbounded or oversized stage endpoints", () => {
    for (const change of [
      { size: 4096 },
      { start: { x: -1, y: 0 } },
      { end: { x: 0, y: 400 } },
      { end: { x: 0.5, y: 0 } },
      { scale: 0.5 },
    ]) {
      const { document, event } = eventFixture();
      Object.assign(event.stage!, change);
      expect(() => new MotionCatalog(document)).toThrow();
    }
  });
  test("waits at the exact start, plays once, and holds its own landed frame", () => {
    const { player, event } = eventFixture();
    expect(player.tick(0, () => false)).toEqual({
      type: "asset",
      id: "root",
      stage: event.stage!,
      end: false,
    });
    expect(position(player.tick(100, ready))).toBe(0);
    for (let t = 200; t <= 5100; t += 100) player.tick(t, ready);
    expect(player.tick(5200, ready)).toEqual({
      type: "sequence",
      id: event.id,
      position: 39,
    });
  });
  test("never reverses an interrupted jump; exits only from its landing", () => {
    const { player } = eventFixture();
    player.tick(0, ready);
    for (let t = 100; t <= 1000; t += 100) player.tick(t, ready);
    player.setTarget("checking", null);
    expect(position(player.tick(1100, ready))).toBe(11);
    for (let t = 1200; t <= 4000; t += 100) player.tick(t, ready);
    expect(player.tick(4100, ready)).toEqual({ type: "asset", id: "root" });
  });
  test("an unavailable page pauses at the last rendered frame without catching up", () => {
    const { player } = eventFixture();
    player.tick(0, ready);
    for (let time = 100; time <= 700; time += 100) player.tick(time, ready);
    for (let time = 800; time <= 2000; time += 100)
      expect(position(player.tick(time, () => false))).toBe(7);
    expect(position(player.tick(2100, ready))).toBe(8);
  });
  test("reduced motion lands directly without downloading a video", () => {
    const { player, event } = eventFixture();
    expect(
      player.tick(
        0,
        () => {
          throw new Error("must not decode");
        },
        true,
      ),
    ).toEqual({ type: "asset", id: "root", stage: event.stage!, end: true });
    expect(player.tick(100, ready, false)).toEqual({
      type: "asset",
      id: "root",
      stage: event.stage!,
      end: true,
    });
  });
});

describe("manifest-driven character protocol", () => {
  test("has complete state and preview coverage with no production rejected binding", () => {
    for (const character of catalog.characters)
      expect(character.states.map((state) => state.id)).toEqual([...PHASES]);
    for (const sequence of catalog.sequences.filter(approved)) {
      const character = catalog.character(sequence.character);
      expect(
        character.previews.some(
          (p) =>
            p.target === sequence.id ||
            character.states.some(
              (s) =>
                p.target === s.id &&
                (s.motion.type === "state" || s.motion.type === "continuous"
                  ? s.motion.sequence === sequence.id
                  : s.motion.type !== "static" &&
                    s.motion.sequences.includes(sequence.id)),
            ),
        ),
      ).toBe(true);
    }
    for (const patch of [
      { schemaVersion: 1 },
      { applicationStates: ["new"] },
      { defaultCharacter: "missing" },
    ])
      expect(
        () => new MotionCatalog({ ...structuredClone(source), ...patch }),
      ).toThrow();
    const incomplete = structuredClone(source);
    incomplete.characters[0]!.states.pop();
    expect(() => new MotionCatalog(incomplete)).toThrow();
    const rejected = structuredClone(source);
    rejected.characters[0]!.states.find((s) => s.id === "working")!.motion = {
      type: "continuous",
      sequence: "working-keyboard",
    };
    expect(() => new MotionCatalog(rejected)).toThrow();
  });
  test("adds a complete second character without changing playback types", () => {
    const next = structuredClone(source),
      second = structuredClone(character);
    second.id = "matcha";
    second.displayName = "抹茶";
    if (second.entrance)
      second.entrance.sequence = `matcha-${second.entrance.sequence}`;
    second.backgroundTexture.resource += "Matcha";
    for (const asset of second.assets) asset.resource += "Matcha";
    const sequences = next.sequences
      .filter((s) => s.character === character.id)
      .map((s) => ({
        ...s,
        id: `matcha-${s.id}`,
        character: second.id,
        asset: `Matcha${s.asset}`,
      }));
    for (const state of second.states) {
      if (state.motion.type === "state" || state.motion.type === "continuous")
        state.motion.sequence = `matcha-${state.motion.sequence}`;
      else if (state.motion.type !== "static")
        state.motion.sequences = state.motion.sequences.map(
          (s) => `matcha-${s}`,
        );
    }
    for (const preview of second.previews)
      if (preview.type === "sequence")
        preview.target = `matcha-${preview.target}`;
    next.characters.push(second);
    next.sequences.push(...sequences);
    expect(new MotionCatalog(next).characters.length).toBe(
      source.characters.length + 1,
    );
    next.characters[1]!.assets[0]!.resource = character.assets[0]!.resource;
    expect(() => new MotionCatalog(next)).toThrow("resource identity");
  });
});

describe("generated-frame choreography", () => {
  // Fixed cadence isolates state-machine timing from the current art recipe.
  // Native 24 fps and repeated activity seams are exercised separately above.
  const document = structuredClone(source);
  for (const sequence of document.sequences)
    if (sequence.kind !== "event") {
      sequence.framesPerSecond = 10;
      delete sequence.sourceFrames;
      if (sequence.kind === "sustained")
        sequence.cycle = { start: 10, end: 28 };
    }
  const catalog = new MotionCatalog(document);
  const character = catalog.defaultCharacter;
  test("interrupted state entry reverses from the currently displayed position", () => {
    const player = new MotionTimeline(catalog, character);
    player.setTarget("stopped", null);
    player.tick(0, ready);
    for (let t = 100; t <= 1700; t += 100) player.tick(t, ready);
    expect(position(player.tick(1750, ready))).toBeCloseTo(17.5);
    player.setTarget("listening", null);
    expect(position(player.tick(1800, ready))).toBeCloseTo(17);
    let rootFrame = false;
    for (let t = 1900; t <= 3700; t += 100) {
      const pose = player.tick(t, ready);
      if (
        pose.type === "sequence" &&
        pose.id === "sleep" &&
        pose.position === 0
      )
        rootFrame = true;
    }
    expect(rootFrame).toBe(true);
    expect(player.tick(3800, ready)).toEqual({
      type: "asset",
      id: character.rootAsset,
    });
  });
  test("continuous playback stays in the activity window", () => {
    const player = new MotionTimeline(catalog, character);
    player.setTarget("working", null);
    player.tick(0, ready);
    for (let t = 100; t <= 3900; t += 100) player.tick(t, ready);
    expect(position(player.tick(4000, ready))).toBeCloseTo(22);
    expect(position(player.tick(4100, ready))).toBeCloseTo(23);
  });
  test("an unavailable cycle page holds the last activity exposure and resumes without skipping", () => {
    const player = new MotionTimeline(catalog, character);
    player.setTarget("working", null);
    player.tick(0, ready);
    for (let t = 100; t <= 2700; t += 100) player.tick(t, ready);
    for (let t = 2800; t <= 3500; t += 100)
      expect(position(player.tick(t, (_id, frame) => frame !== 10))).toBe(27);
    expect(position(player.tick(3600, ready))).toBe(10);
  });
  test("only the last activity cycle retires its prop and renders the root before the next state", () => {
    const player = new MotionTimeline(catalog, character);
    player.setTarget("working", null);
    player.tick(0, ready);
    for (let t = 100; t <= 5000; t += 100) player.tick(t, ready);
    const lastPosition = position(player.tick(5000, ready));
    player.setTarget("attention", null);
    expect(position(player.tick(5100, ready))).toBe(lastPosition + 1);
    let sawRoot = false;
    for (let t = 5200; t <= 9000; t += 100) {
      const frame = player.tick(t, ready);
      if (
        frame.type === "sequence" &&
        frame.id === "working-console" &&
        frame.position === 39
      )
        sawRoot = true;
      if (frame.type === "sequence" && frame.id === "attention")
        expect(sawRoot).toBe(true);
    }
    expect(sawRoot).toBe(true);
  });
  test("loop interruption finishes the video before entering another state", () => {
    const player = new MotionTimeline(catalog, character);
    player.setTarget("working", null);
    player.tick(0, ready);
    for (let t = 100; t <= 1000; t += 100) player.tick(t, ready);
    player.setTarget("attention", null);
    expect(player.tick(1100, ready)).toMatchObject({
      type: "sequence",
      id: "working-console",
      position: 11,
    });
    for (let t = 1200; t <= 3900; t += 100) player.tick(t, ready);
    expect(player.tick(4000, ready)).toMatchObject({
      type: "sequence",
      id: "attention",
      position: 0,
    });
  });
  test("loading holds the exact root and does not fast-forward the video", () => {
    const player = new MotionTimeline(catalog, character);
    player.setTarget("working", null);
    expect(player.tick(0, () => false)).toEqual({
      type: "asset",
      id: character.rootAsset,
    });
    expect(player.tick(10000, ready)).toMatchObject({
      type: "sequence",
      position: 0,
    });
    expect(player.tick(10100, ready)).toMatchObject({
      type: "sequence",
      position: 1,
    });
  });
  test("reduced motion is an explicit stable-asset policy; hidden time never skips video", () => {
    const player = new MotionTimeline(catalog, character);
    player.setTarget("stopped", null);
    expect(player.tick(0, ready, true)).toEqual({
      type: "asset",
      id: "sleeping",
    });
    player.tick(100, ready);
    player.tick(200, ready);
    player.pause();
    expect(position(player.tick(99999, ready))).toBeCloseTo(
      catalog.timing("sleep").frameCount - 1,
    );
  });
  test("intermittent motion waits inside the configured interval", () => {
    const player = new MotionTimeline(catalog, character, () => 0);
    player.setTarget("listening", null);
    expect(player.tick(0, ready)).toEqual({
      type: "asset",
      id: character.rootAsset,
    });
    expect(player.tick(9999, ready)).toEqual({
      type: "asset",
      id: character.rootAsset,
    });
    expect(player.tick(10000, ready)).toMatchObject({
      type: "sequence",
      id: "idle-curious",
      position: 0,
    });
  });
});

describe("lossless approved motion projection", () => {
  test("stable asset geometry matches physical alpha bounds and body baseline", async () => {
    for (const character of catalog.characters)
      for (const asset of character.assets) {
        const { data, info } = await sharp(
          new URL(`../Resources/${asset.resource}.png`, import.meta.url)
            .pathname,
        )
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect([info.width, info.height]).toEqual([
          asset.geometry.canvasWidth,
          asset.geometry.canvasHeight,
        ]);
        let left = info.width,
          top = info.height,
          right = 0,
          bottom = 0,
          bodyBottom = 0;
        const probe = Math.floor((info.width * 2) / 5);
        for (let y = 0; y < info.height; y++)
          for (let x = 0; x < info.width; x++)
            if (data[(y * info.width + x) * 4 + 3]! > 128) {
              left = Math.min(left, x);
              right = Math.max(right, x);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
              if (x === probe) bodyBottom = y + 1;
            }
        expect(asset.geometry.visualBounds).toEqual({
          x: left,
          y: top,
          width: right - left + 1,
          height: bottom - top + 1,
        });
        expect(asset.geometry.bodyBottom).toBe(bodyBottom);
      }
  });
  for (const sequence of catalog.sequences.filter(approved))
    test(`${sequence.id}: RGBA, timing, root and target remain pixel-identical`, async () => {
      const character = catalog.character(sequence.character);
      const path = new URL(
        `../Resources/${sequence.asset}.webp`,
        import.meta.url,
      ).pathname;
      const metadata = await sharp(path, { animated: true }).metadata();
      const { frameCount, framesPerSecond } = catalog.timing(sequence.id);
      expect(metadata.pages).toBe(frameCount);
      expect(
        metadata.delay?.every(
          (delay, index) => delay === frameDuration(index, framesPerSecond),
        ),
      ).toBe(true);
      const decoded = await sharp(path, { animated: true })
        .ensureAlpha()
        .raw()
        .toBuffer();
      const root = await sharp(
        new URL(
          `../Resources/${catalog.asset(character, character.rootAsset).resource}.png`,
          import.meta.url,
        ).pathname,
      )
        .ensureAlpha()
        .raw()
        .toBuffer();
      const width = metadata.width!,
        height = metadata.pageHeight!;
      const placedRoot = (origin: { x: number; y: number }) => {
        const result = Buffer.alloc(width * height * 4);
        const geometry = catalog.asset(character, character.rootAsset).geometry;
        const stride = geometry.canvasWidth * 4;
        for (let y = 0; y < geometry.canvasHeight; y++)
          root.copy(
            result,
            ((y + origin.y) * width + origin.x) * 4,
            y * stride,
            (y + 1) * stride,
          );
        return result;
      };
      const first = sequence.stage ? placedRoot(sequence.stage.start) : root;
      const frameLength = first.length;
      expect(decoded.subarray(0, frameLength).equals(first)).toBe(true);
      const target = sequence.stage
        ? placedRoot(sequence.stage.end)
        : sequence.kind === "loop" || sequence.kind === "sustained"
          ? root
          : await sharp(
              new URL(
                `../Resources/${catalog.asset(character, sequence.targetAsset!).resource}.png`,
                import.meta.url,
              ).pathname,
            )
              .ensureAlpha()
              .raw()
              .toBuffer();
      expect(
        decoded.subarray(decoded.length - frameLength).equals(target),
      ).toBe(true);
      const directory = await mkdtemp(join(tmpdir(), "mochi-atlas-test-"));
      try {
        const layout = atlasLayout(width, height, frameCount);
        const stride = width * 4;
        for (let page = 0; page < layout.pageCount; page++) {
          const output = join(directory, `atlas-${page}.webp`);
          await decodeAtlas(path, output, frameCount, page);
          const atlas = await sharp(output).raw().toBuffer();
          const start = page * layout.framesPerPage;
          const count = Math.min(layout.framesPerPage, frameCount - start);
          for (let frame = 0; frame < count; frame++)
            for (let row = 0; row < height; row++) {
              const offset =
                ((Math.floor(frame / ATLAS_COLUMNS) * height + row) *
                  width *
                  ATLAS_COLUMNS +
                  (frame % ATLAS_COLUMNS) * width) *
                4;
              const original = ((start + frame) * height + row) * stride;
              if (
                !atlas
                  .subarray(offset, offset + stride)
                  .equals(decoded.subarray(original, original + stride))
              )
                throw new Error(`RGBA changed at frame ${frame}, row ${row}`);
            }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);
});
