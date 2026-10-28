import { expect, test } from "bun:test";
import manifest from "../../motion/manifest.json";
import { MotionCanvas } from "../src/motion/canvas.ts";
import { MotionCatalog } from "../src/motion/catalog.ts";
import { atlasGeometry, atlasLayout } from "../src/motion/resources.ts";

function fixture() {
  const value = structuredClone(manifest);
  const event = value.sequences.find(
    (sequence) => sequence.id === "encounter-stage-i",
  )!;
  Object.assign(event, {
    bundledForPreview: true,
    assetSha256: "0".repeat(64),
  });
  const catalog = new MotionCatalog(value);
  const draws: unknown[][] = [],
    closed: string[] = [],
    errors: unknown[] = [];
  const requests: {
    path: string;
    resolve: (image: ImageBitmap) => void;
    reject: (error: Error) => void;
  }[] = [];
  const context = {
    canvas: { width: 1024, height: 1024 },
    clearRect() {},
    drawImage(...args: unknown[]) {
      draws.push(args);
    },
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D;
  const player = new MotionCanvas(
    context,
    catalog,
    catalog.defaultCharacter,
    (error) => errors.push(error),
    (path) =>
      new Promise((resolve, reject) =>
        requests.push({ path, resolve, reject }),
      ),
  );
  const resolve = async (index: number, width = 8192, height = 1024) => {
    const request = requests[index]!;
    const bitmap = {
      width,
      height,
      close: () => {
        closed.push(request.path);
      },
    } as ImageBitmap;
    request.resolve(bitmap);
    await new Promise((done) => setTimeout(done, 0));
    return bitmap;
  };
  return {
    player,
    requests,
    draws,
    closed,
    errors,
    resolve,
    catalog,
    id: event.id,
  };
}

test("event pages prefetch across seams without dissolving two anatomical poses", async () => {
  const f = fixture();
  expect(f.player.ready(f.id, 0)).toBe(false);
  expect(f.requests).toHaveLength(1);
  const first = await f.resolve(0);
  expect(f.player.ready(f.id, 0)).toBe(true);
  f.player.draw({ type: "sequence", id: f.id, position: 5 });
  expect(f.player.ready(f.id, 5)).toBe(true);
  expect(f.requests[1]!.path).toEndWith(".atlas.1.png");
  expect(f.player.ready(f.id, 7.5)).toBe(true);
  expect(f.player.ready(f.id, 8)).toBe(false);
  const second = await f.resolve(1);
  expect(f.player.ready(f.id, 7.5)).toBe(true);
  f.draws.length = 0;
  f.player.draw({ type: "sequence", id: f.id, position: 7.5 });
  expect(f.draws[0]!.slice(0, 5)).toEqual([first, 7168, 0, 1024, 1024]);
  expect(f.draws).toHaveLength(1);
  f.player.draw({ type: "sequence", id: f.id, position: 8 });
  expect(f.draws[1]!.slice(0, 5)).toEqual([second, 0, 0, 1024, 1024]);
  expect(f.requests).toHaveLength(2);
  f.player.draw({ type: "sequence", id: f.id, position: 13 });
  expect(f.player.ready(f.id, 13)).toBe(true);
  expect(f.closed).toEqual([f.requests[0]!.path]);
  await f.resolve(2);
  expect(f.player.ready(f.id, 15.5)).toBe(true);
  expect(f.errors).toEqual([]);
  f.player.dispose();
  expect(f.closed).toHaveLength(3);
});

test("a failed or incorrectly sized page is observable, never treated as ready", async () => {
  const f = fixture();
  f.player.ready(f.id);
  await f.resolve(0, 512, 512);
  expect(f.errors).toHaveLength(1);
  expect(f.closed).toHaveLength(1);
  f.player.dispose();
  expect(f.player.ready(f.id)).toBe(false);
});

test("a native-cadence state prefetches the preceding page before a reverse crossing", async () => {
  const f = fixture();
  const id = "attention";
  const layout = atlasLayout(512, 512, f.catalog.timing(id).frameCount);
  const page = atlasGeometry(512, 512, layout.framesPerPage);
  expect(layout.framesPerPage).toBe(8);
  expect(f.player.ready(id, 12)).toBe(false);
  expect(f.requests[0]!.path).toEndWith(".atlas.1.png");
  await f.resolve(0, page.width, page.height);
  f.player.draw({ type: "sequence", id, position: 12 });
  expect(f.player.ready(id, 10)).toBe(true);
  expect(f.requests[1]!.path).toEndWith(".atlas.0.png");
  expect(f.player.ready(id, 7.9)).toBe(false);
  await f.resolve(1, page.width, page.height);
  expect(f.player.ready(id, 7.9)).toBe(true);
  f.player.draw({ type: "sequence", id, position: 7.9 });
  expect(f.draws.at(-1)!.slice(1, 5)).toEqual([3584, 0, 512, 512]);
  expect(f.errors).toEqual([]);
  f.player.dispose();
});

test("daily prop motion preserves one complete exposure between source timestamps", async () => {
  const f = fixture();
  const id = "working-console";
  const { frameCount } = f.catalog.timing(id);
  const layout = atlasLayout(512, 512, frameCount);
  const page = atlasGeometry(512, 512, layout.framesPerPage);
  expect(f.player.ready(id, 0.5)).toBe(false);
  await f.resolve(0, page.width, page.height);
  expect(f.player.ready(id, 0.5)).toBe(true);
  f.player.draw({ type: "sequence", id, position: 0.5 });
  expect(f.draws).toHaveLength(1);
  expect(f.draws[0]!.slice(1, 5)).toEqual([0, 0, 512, 512]);
  expect(f.player.draw({ type: "sequence", id, position: 0.9 })).toBe(false);
  expect(f.draws).toHaveLength(1);
  f.player.draw({ type: "sequence", id, position: 1 });
  expect(f.draws[1]!.slice(1, 5)).toEqual([512, 0, 512, 512]);
  f.player.dispose();
});

test("disposal closes an in-flight bitmap instead of admitting it after shutdown", async () => {
  const f = fixture();
  f.player.ready(f.id);
  f.player.dispose();
  await f.resolve(0);
  expect(f.closed).toHaveLength(1);
  expect(f.player.ready(f.id)).toBe(false);
  expect(f.errors).toEqual([]);
});

test("invalid frame requests cannot cause an unbounded or missing-page decode", () => {
  const f = fixture();
  for (const position of [-1, 40, NaN, Infinity])
    expect(() => f.player.ready(f.id, position)).toThrow("position");
  expect(f.requests).toHaveLength(0);
  f.player.dispose();
});
