import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { decodeAtlas } from "../build/resources.ts";
import { ATLAS_COLUMNS, atlasLayout } from "../src/motion/resources.ts";

test("every page including the final partial row is pixel-identical to its source frames", async () => {
  const width = 1024,
    height = 1024,
    frames = 17;
  const directory = await mkdtemp(join(tmpdir(), "mochi-pages-"));
  try {
    const raw = Buffer.alloc(width * height * frames * 4);
    for (let frame = 0; frame < frames; frame++)
      for (let pixel = 0; pixel < width * height; pixel++) {
        const offset = (frame * width * height + pixel) * 4;
        raw[offset] = frame * 13;
        raw[offset + 1] = pixel % 251;
        raw[offset + 2] = Math.floor(pixel / width) % 239;
        raw[offset + 3] = 192 + (pixel % 64);
      }
    const source = join(directory, "source.webp");
    await sharp(raw, {
      raw: { width, height: height * frames, channels: 4, pageHeight: height },
    })
      .webp({ lossless: true, delay: Array(frames).fill(100), effort: 0 })
      .toFile(source);
    const layout = atlasLayout(width, height, frames);
    expect(layout.pageCount).toBe(3);
    for (let page = 0; page < layout.pageCount; page++) {
      const output = join(directory, `page-${page}.webp`);
      await decodeAtlas(source, output, frames, page);
      const { data, info } = await sharp(output)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(width * ATLAS_COLUMNS);
      expect(info.height).toBe(height);
      for (
        let local = 0;
        local <
        Math.min(layout.framesPerPage, frames - page * layout.framesPerPage);
        local++
      ) {
        const frame = page * layout.framesPerPage + local;
        let identical = true;
        for (let row = 0; row < height; row++) {
          const expected = (frame * height + row) * width * 4;
          const actual = (row * info.width + local * width) * 4;
          if (
            !data
              .subarray(actual, actual + width * 4)
              .equals(raw.subarray(expected, expected + width * 4))
          )
            identical = false;
        }
        expect(identical).toBe(true);
      }
    }
    await expect(
      decodeAtlas(source, join(directory, "bad.webp"), frames, 3),
    ).rejects.toThrow("page");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("lossless WebP projection preserves transparent RGB, partial coverage and empty cells", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mochi-exact-atlas-"));
  try {
    const width = 2,
      height = 1,
      frames = 2;
    const raw = Buffer.from([
      231, 19, 83, 0, 51, 101, 201, 1, 17, 29, 43, 127, 91, 149, 213, 255,
    ]);
    const source = join(directory, "source.webp");
    await sharp(raw, {
      raw: { width, height: height * frames, channels: 4, pageHeight: height },
    })
      .webp({ lossless: true, exact: true, delay: [100, 100] })
      .toFile(source);
    const output = join(directory, "atlas.webp");
    await decodeAtlas(source, output, frames);
    expect((await sharp(output).metadata()).format).toBe("webp");
    const decoded = await sharp(output).ensureAlpha().raw().toBuffer();
    expect(decoded.subarray(0, raw.length).equals(raw)).toBe(true);
    expect(decoded.subarray(raw.length).every((byte) => byte === 0)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
