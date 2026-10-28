import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";
import { MotionCatalog } from "../src/motion/catalog.ts";
import {
  ATLAS_COLUMNS,
  atlasFilename,
  atlasGeometry,
  atlasLayout,
} from "../src/motion/resources.ts";
import { frameDuration } from "../src/motion/timing.ts";

const digest = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex");

export async function decodeAtlas(
  source: string,
  output: string,
  frameCount: number,
  page = 0,
): Promise<void> {
  const metadata = await sharp(source, { animated: true }).metadata();
  if (
    metadata.pages !== frameCount ||
    !metadata.pageHeight ||
    !metadata.width ||
    !metadata.hasAlpha
  )
    throw new Error(`Invalid approved sequence: ${basename(source)}`);
  const width = metadata.width,
    height = metadata.pageHeight;
  const layout = atlasLayout(width, height, frameCount);
  if (!Number.isInteger(page) || page < 0 || page >= layout.pageCount)
    throw new Error("Invalid motion atlas page");
  const start = page * layout.framesPerPage;
  const count = Math.min(layout.framesPerPage, frameCount - start);
  const { width: atlasWidth, height: atlasHeight } = atlasGeometry(
    width,
    height,
    count,
  );
  const { data, info } = await sharp(source, { page: start, pages: count })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || info.height !== count * height)
    throw new Error("Invalid decoded motion dimensions");
  const atlas = Buffer.alloc(atlasWidth * atlasHeight * 4),
    rowBytes = width * 4;
  for (let frame = 0; frame < count; frame++)
    for (let row = 0; row < height; row++) {
      const sourceOffset = (frame * height + row) * rowBytes;
      const targetOffset =
        ((Math.floor(frame / ATLAS_COLUMNS) * height + row) * atlasWidth +
          (frame % ATLAS_COLUMNS) * width) *
        4;
      data.copy(atlas, targetOffset, sourceOffset, sourceOffset + rowBytes);
    }
  // Keep all RGBA bytes, including colour under zero alpha. This is a storage
  // projection only: no resampling, quantization or change to the video clock.
  // Effort 3 is the measured size/build-time balance for these accepted frames.
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await sharp(atlas, {
      raw: { width: atlasWidth, height: atlasHeight, channels: 4 },
    })
      .webp({ lossless: true, exact: true, effort: 3 })
      .toFile(temporary);
    // An interrupted encoder must never leave a reusable partial cache entry.
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function prepareResources(
  root: string,
  build: string,
  command: (args: string[]) => Promise<string>,
): Promise<void> {
  const views = join(build, "views"),
    resources = join(build, "resources"),
    assets = join(build, "public/assets");
  await Promise.all([
    rm(views, { recursive: true, force: true }),
    rm(resources, { recursive: true, force: true }),
    rm(join(build, "public"), { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(join(views, "main"), { recursive: true }),
    mkdir(resources, { recursive: true }),
    mkdir(assets, { recursive: true }),
  ]);
  const manifest = await readFile(join(root, "motion/manifest.json"));
  const catalog = new MotionCatalog(JSON.parse(manifest.toString()));
  for (const record of catalog.characters.flatMap((character) => [
    character.backgroundTexture,
    ...character.assets,
  ])) {
    const source = resolve(root, record.source);
    if (!source.startsWith(join(root, "controlApp/Resources/")))
      throw new Error("Motion source escapes Resources");
    const data = await readFile(source);
    if (digest(data) !== record.sha256)
      throw new Error(`Approved resource hash mismatch: ${record.resource}`);
    await writeFile(join(assets, `${record.resource}.png`), data);
  }
  const cache = join(build, "atlases");
  await mkdir(cache, { recursive: true });
  for (const sequence of catalog.sequences) {
    const source = join(root, "controlApp/Resources", `${sequence.asset}.webp`),
      data = await readFile(source);
    if (digest(data) !== sequence.assetSha256)
      throw new Error(`Approved sequence hash mismatch: ${sequence.id}`);
    const geometry = catalog.sequenceGeometry(sequence);
    const metadata = await sharp(source, { animated: true }).metadata();
    if (
      metadata.width !== geometry.canvasWidth ||
      metadata.pageHeight !== geometry.canvasHeight
    )
      throw new Error(
        `Sequence dimensions do not match the manifest: ${sequence.id}`,
      );
    const { frameCount: frames, framesPerSecond } = catalog.timing(sequence.id);
    if (
      metadata.pages !== frames ||
      metadata.delay?.length !== frames ||
      metadata.delay.some(
        (delay, index) => delay !== frameDuration(index, framesPerSecond),
      )
    )
      throw new Error(
        `Sequence cadence does not match the manifest: ${sequence.id}`,
      );
    const layout = atlasLayout(
      geometry.canvasWidth,
      geometry.canvasHeight,
      frames,
    );
    for (let page = 0; page < layout.pageCount; page++) {
      const atlas = join(
        cache,
        `${sequence.assetSha256}-rgba-webp-v4-${page}.webp`,
      );
      if (!existsSync(atlas)) await decodeAtlas(source, atlas, frames, page);
      await copyFile(
        atlas,
        join(assets, atlasFilename(sequence.asset, layout.pageCount, page)),
      );
    }
  }
  await writeFile(join(resources, "CharacterMotionManifest.json"), manifest);
  const icon = join(root, "controlApp/Resources/MochiAppIcon.png");
  if (!(await sharp(icon).metadata()).hasAlpha)
    throw new Error("App icon must retain transparent corners");
  const iconset = join(build, "Mochi.iconset");
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      await sharp(icon)
        .resize(size * scale)
        .png()
        .toFile(
          join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
        );
    }
  await command([
    "/usr/bin/iconutil",
    "-c",
    "icns",
    iconset,
    "-o",
    join(resources, "Mochi.icns"),
  ]);
  await command([
    "/usr/bin/clang",
    "-fobjc-arc",
    "-fblocks",
    "-dynamiclib",
    "-framework",
    "AppKit",
    "-framework",
    "ServiceManagement",
    "-framework",
    "QuartzCore",
    "-mmacosx-version-min=14.0",
    "-o",
    join(resources, "libMochiAppKit.dylib"),
    "controlApp/native/appkit.m",
    "controlApp/native/menu_bar.m",
  ]);
}
