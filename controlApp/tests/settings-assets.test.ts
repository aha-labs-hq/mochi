import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

test("Settings icons preserve opaque objects, transparent edges and bounded Retina resources", async () => {
  const directory = resolve(import.meta.dir, "../src/ui/assets/settings");
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".png"),
  );
  expect(files).toHaveLength(14);
  for (const name of files) {
    const path = resolve(directory, name);
    const source = sharp(path);
    const meta = await source.metadata();
    expect(meta.width).toBe(192);
    expect(meta.height).toBe(192);
    expect(meta.hasAlpha).toBe(true);
    expect((await source.stats()).isOpaque).toBe(false);
    const alpha = await source.extractChannel("alpha").raw().toBuffer();
    for (const index of [0, 191, 192 * 191, 192 * 192 - 1])
      expect(alpha[index]).toBe(0);
    // Ivory is an opaque material, not white-to-alpha transparency.
    const foreground = alpha.filter((value) => value > 0);
    expect(
      foreground.filter((value) => value === 255).length / foreground.length,
    ).toBeGreaterThan(0.8);
    if (name === "github.png") {
      const { data } = await sharp(path).ensureAlpha().raw().toBuffer({
        resolveWithObject: true,
      });
      let opaqueWhite = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (
          data[index + 3]! > 0 &&
          data[index]! > 245 &&
          data[index + 1]! > 245 &&
          data[index + 2]! > 245
        ) {
          opaqueWhite += 1;
        }
      }
      expect(opaqueWhite).toBeLessThan(400);
    }
    expect(Bun.file(path).size).toBeLessThan(80_000);
  }
});
