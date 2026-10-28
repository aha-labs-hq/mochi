import { expect, test } from "bun:test";
import {
  atlasFilename,
  atlasGeometry,
  atlasLayout,
  BitmapBudget,
  MOTION_BITMAP_BUDGET,
  sequenceBitmapBudget,
} from "../src/motion/resources.ts";

test("atlas dimensions and memory are checked before allocation", () => {
  expect(atlasGeometry(512, 512, 40)).toEqual({
    width: 4096,
    height: 2560,
    bytes: 40 * 1024 * 1024,
  });
  for (const dimensions of [
    [512, 512, 0],
    [1.5, 512, 40],
    [4096, 4096, 40],
  ]) {
    expect(() =>
      atlasGeometry(dimensions[0]!, dimensions[1]!, dimensions[2]!),
    ).toThrow();
  }
});
test("adding stable poses cannot silently overrun the continuous playback budget", () => {
  const geometry = { canvasWidth: 512, canvasHeight: 512 };
  expect(sequenceBitmapBudget([geometry], 40)).toBe(95 * 1024 * 1024);
  expect(() => sequenceBitmapBudget(Array(17).fill(geometry), 40)).toThrow();
  expect(() => sequenceBitmapBudget([], 40)).toThrow();
});
test("larger stages are losslessly paged within the unchanged two-bitmap budget", () => {
  expect(atlasLayout(512, 512, 40)).toEqual({
    framesPerPage: 40,
    pageCount: 1,
    bytes: 40 * 1024 * 1024,
  });
  expect(atlasLayout(1024, 1024, 40)).toEqual({
    framesPerPage: 8,
    pageCount: 5,
    bytes: 32 * 1024 * 1024,
  });
  expect(atlasLayout(768, 768, 40).bytes).toBe(18 * 1024 * 1024);
  expect(() => atlasLayout(4096, 4096, 40)).toThrow();
  expect(atlasFilename("Actor", 1, 0)).toBe("Actor.atlas.png");
  expect(atlasFilename("Actor", 5, 3)).toBe("Actor.atlas.3.png");
  const pool = new BitmapBudget(92 * 1024 * 1024);
  const bytes = 32 * 1024 * 1024;
  const closed: string[] = [];
  for (const id of ["0", "1"])
    pool.put(
      id,
      {
        close: () => {
          closed.push(id);
        },
      },
      bytes,
    );
  expect(() => pool.reserve(bytes, ["0", "1"])).toThrow();
  pool.reserve(bytes, ["1"]);
  expect(closed).toEqual(["0"]);
  expect(pool.get("1")).toBeDefined();
});
test("incoming decode evicts old bitmaps before allocation without touching the displayed frame", () => {
  const closed: string[] = [];
  const pool = new BitmapBudget(MOTION_BITMAP_BUDGET);
  const bytes = 40 * 1024 * 1024;
  const image = (id: string) => ({
    close: () => {
      closed.push(id);
    },
  });
  pool.reserve(bytes, null);
  pool.put("old", image("old"), bytes);
  pool.reserve(bytes, "old");
  pool.put("current", image("current"), bytes);
  pool.reserve(bytes, "current");
  expect(closed).toEqual(["old"]);
  expect(pool.bytes).toBe(bytes);
  pool.put("next", image("next"), bytes);
  expect(pool.get("current")).toBeDefined();
  expect(() => pool.reserve(MOTION_BITMAP_BUDGET, "current")).toThrow();
  pool.clear();
  expect(closed).toEqual(["old", "next", "current"]);
  expect(pool.bytes).toBe(0);
});
