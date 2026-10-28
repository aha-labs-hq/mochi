import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { chromaMatte, matteOptions, parseBackground } from "./motion_matte.ts";

/** Measure a known-alpha round trip, not whether an animation is acceptable. */
export function alphaRoundTrip(expected: Uint8Array, actual: Uint8Array) {
  if (expected.length === 0 || expected.length !== actual.length)
    throw new Error("Alpha planes must have the same nonzero dimensions");
  let expectedForeground = 0,
    actualForeground = 0,
    expectedSoft = 0,
    actualSoft = 0;
  let squaredError = 0,
    lostSoftPixels = 0;
  for (let i = 0; i < expected.length; i++) {
    const before = expected[i]!,
      after = actual[i]!;
    if (before > 0) expectedForeground++;
    if (after > 0) actualForeground++;
    if (before > 0 && before <= 252) {
      expectedSoft++;
      if (after === 0) lostSoftPixels++;
    }
    if (after > 0 && after <= 252) actualSoft++;
    squaredError += (before - after) ** 2;
  }
  return {
    expectedSoftRatio: expectedForeground
      ? expectedSoft / expectedForeground
      : 0,
    recoveredSoftRatio: actualForeground ? actualSoft / actualForeground : 0,
    alphaRmse: Math.sqrt(squaredError / expected.length) / 255,
    lostSoftPixels,
    expectedSoftPixels: expectedSoft,
  };
}

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${error}`);
  return Buffer.from(output);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(
    await readFile(join(root, "motion/manifest.json"), "utf8"),
  );
  const character = manifest.characters.find(
    (entry: { id: string }) => entry.id === manifest.defaultCharacter,
  );
  const asset = character.assets.find(
    (entry: { id: string }) => entry.id === character.rootAsset,
  );
  const input = join(root, asset.source);
  const digest = createHash("sha256")
    .update(await readFile(input))
    .digest("hex");
  if (digest !== asset.sha256) throw new Error("Canonical root hash mismatch");
  const scratch = await mkdtemp(join(tmpdir(), "mochi-key-round-trip-"));
  try {
    const { chromaBackground, matting } = manifest.production;
    const composite = join(scratch, "composite.png"),
      recovered = join(scratch, "recovered.png");
    await command([
      "magick",
      input,
      "-background",
      `#${chromaBackground}`,
      "-alpha",
      "remove",
      "-alpha",
      "off",
      composite,
    ]);
    const { data, info } = await sharp(composite)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgba = chromaMatte(
      data,
      info.width,
      info.height,
      matteOptions(matting, info.width, parseBackground(chromaBackground)),
    );
    await sharp(rgba, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toFile(recovered);
    const alpha = (file: string) =>
      command(["magick", file, "-alpha", "extract", "-depth", "8", "gray:-"]);
    console.log(
      JSON.stringify(
        {
          purpose: "known-alpha diagnostic, not motion acceptance",
          stage:
            "production coverage matte, including foreground estimation, before resampling",
          character: character.id,
          rootSha256: digest,
          chromaBackground,
          matting,
          ...alphaRoundTrip(await alpha(input), await alpha(recovered)),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(scratch, { recursive: true });
  }
}
