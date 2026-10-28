/**
 * Derives the website's videos from the companion's approved motion: the
 * same lossless frames, re-encoded for browsers.
 *
 *   bun run site:motion
 *
 * Safari plays HEVC with alpha; Chromium and Firefox play VP9 with alpha.
 * `src/media/motion.json` records each source and output digest; the website
 * tests fail when the companion's motion changes without a re-encode.
 * Requires ffmpeg with libvpx-vp9 and hevc_videotoolbox (macOS).
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { clips } from "../src/motion.ts";

const root = resolve(import.meta.dir, "../..");
const media = resolve(import.meta.dir, "../src/media");
const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

function ffmpeg(args: string[]) {
  const run = Bun.spawnSync(
    ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (run.exitCode !== 0) throw new Error(`ffmpeg failed: ${args.at(-1)}`);
}

// Encoder settings, shared by every clip.
const VP9_ALPHA =
  "-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -deadline good -cpu-used 1 -row-mt 1".split(
    " ",
  );
const HEVC_ALPHA =
  "-c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.8 -q:v 62 -tag:v hvc1 -pix_fmt bgra -movflags +faststart".split(
    " ",
  );

const record: Record<string, unknown> = {};
for (const [name, clip] of Object.entries(clips)) {
  const source = join(root, "controlApp/Resources", `${clip.asset}.webp`);
  if ((await sha256(source)) !== clip.assetSha256)
    throw new Error(`${clip.asset} does not match its manifest digest`);
  const { pages } = await sharp(source).metadata();
  if (pages !== clip.frameCount)
    throw new Error(
      `${clip.asset}: expected ${clip.frameCount} frames, found ${pages}`,
    );

  const frames = await mkdtemp(join(tmpdir(), `mochi-${name}-`));
  try {
    for (let page = 0; page < clip.frameCount; page++) {
      const index = clip.reverse ? clip.frameCount - 1 - page : page;
      await sharp(source, { page: index })
        .png()
        .toFile(join(frames, `${String(page).padStart(3, "0")}.png`));
    }
    const input = [
      "-framerate",
      String(clip.framesPerSecond),
      "-i",
      join(frames, "%03d.png"),
      "-an",
    ];
    ffmpeg([...input, ...VP9_ALPHA, join(media, `${name}.webm`)]);
    ffmpeg([...input, ...HEVC_ALPHA, join(media, `${name}.mov`)]);
  } finally {
    await rm(frames, { recursive: true, force: true });
  }
  record[name] = {
    sequence: clip.sequence,
    reverse: clip.reverse,
    sourceAssetSha256: clip.assetSha256,
    webmSha256: await sha256(join(media, `${name}.webm`)),
    movSha256: await sha256(join(media, `${name}.mov`)),
  };
}
await writeFile(
  join(media, "motion.json"),
  `${JSON.stringify(record, null, 2)}\n`,
);
console.log(record);
