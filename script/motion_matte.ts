import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { sequenceTiming } from "../controlApp/src/motion/timing.ts";

export interface ChromaMatteOptions {
  background: readonly [number, number, number];
  coreDistance: number;
  erosionRadius: number;
  supportRadius: number;
  noiseFloor: number;
}

/** Coverage is visible below 50% opacity. A perimeter taken at the opaque core
 * measures the body silhouette, not the fine translucent fibers around it. */
export function alphaMetrics(
  alpha: Uint8Array,
  width: number,
  visibleThreshold: number,
) {
  if (
    !Number.isInteger(width) ||
    width < 2 ||
    !alpha.length ||
    alpha.length % width ||
    !(visibleThreshold > 0 && visibleThreshold < 1)
  )
    throw new Error("Invalid alpha metric input");
  const cutoff = visibleThreshold * 255;
  let nonzero = 0,
    soft = 0,
    area = 0,
    edge = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i]!;
    if (a > 0) {
      nonzero++;
      if (a <= 252) soft++;
    }
    if (a <= cutoff) continue;
    area++;
    if (
      i < width ||
      i >= alpha.length - width ||
      i % width === 0 ||
      i % width === width - 1 ||
      alpha[i - width]! <= cutoff ||
      alpha[i + width]! <= cutoff ||
      alpha[i - 1]! <= cutoff ||
      alpha[i + 1]! <= cutoff
    )
      edge++;
  }
  return {
    softAlphaRatio: nonzero ? soft / nonzero : 0,
    perimeterComplexity: area ? edge / Math.sqrt(area) : 0,
  };
}

/** Pixel width of the partial-coverage transition, excluding an illustration's
 * near-opaque interior quantisation. A broad translucent halo increases this
 * even when its RGB is perfectly neutral. */
export function edgeSpread(alpha: Uint8Array, width: number) {
  if (width < 2 || !alpha.length || alpha.length % width)
    throw new Error("Invalid edge spread input");
  const possible = Uint8Array.from(alpha, (a) => (a < 128 ? 1 : 0));
  const exterior = connectedBackground(possible, width);
  if (!exterior.some(Boolean)) throw new Error("No exterior in matte");
  const distance = nearestSeeds(exterior, width).distance;
  let coverage = 0,
    perimeter = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i]! / 255;
    if (distance[i]! <= 8) coverage += a * (1 - a);
    if (alpha[i]! >= 128 && distance[i] === 1) perimeter++;
  }
  if (!perimeter) throw new Error("No solid foreground in matte");
  return coverage / perimeter;
}

/** Compare the fine contour with the same silhouette at a coarser scale.
 * Normalising against area alone confuses genuine legs/tails/props with noisy
 * fur. Box coverage preserves that anatomy while averaging tiny fringe detail. */
export function contourRoughness(
  alpha: Uint8Array,
  width: number,
  visibleThreshold: number,
) {
  const fine = alphaMetrics(alpha, width, visibleThreshold).perimeterComplexity;
  if (!fine) throw new Error("No foreground contour in matte");
  const height = alpha.length / width,
    scale = 8,
    coarseWidth = Math.ceil(width / scale),
    coarseHeight = Math.ceil(height / scale);
  const coarse = new Uint8Array(coarseWidth * coarseHeight);
  for (let y = 0; y < coarseHeight; y++)
    for (let x = 0; x < coarseWidth; x++) {
      let total = 0,
        count = 0;
      for (let dy = 0; dy < scale && y * scale + dy < height; dy++)
        for (let dx = 0; dx < scale && x * scale + dx < width; dx++) {
          total += alpha[(y * scale + dy) * width + x * scale + dx]!;
          count++;
        }
      coarse[y * coarseWidth + x] = Math.round(total / count);
    }
  const reference = alphaMetrics(
    coarse,
    coarseWidth,
    visibleThreshold,
  ).perimeterComplexity;
  if (!reference) throw new Error("No foreground contour in matte");
  return fine / reference;
}

export function parseBackground(hex: string): [number, number, number] {
  if (!/^[\da-f]{6}$/i.test(hex)) throw new Error("Invalid chroma plate color");
  return [0, 2, 4].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  ) as [number, number, number];
}

/** Four empty corners must agree on a saturated blue plate. Sampling every
 * frame prevents a changing video plate from becoming a changing alpha halo. */
export function samplePlate(
  rgb: Uint8Array,
  width: number,
  height: number,
): [number, number, number] {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width * height > 4096 ** 2 ||
    rgb.length !== width * height * 3
  )
    throw new Error("Invalid plate sample image");
  const size = Math.max(
    2,
    Math.min(32, Math.floor(Math.min(width, height) / 16)),
  );
  const inset = Math.min(8, size);
  const corners: number[][] = [];
  for (const y0 of [inset, height - inset - size])
    for (const x0 of [inset, width - inset - size]) {
      const color = [0, 0, 0];
      for (let y = y0; y < y0 + size; y++)
        for (let x = x0; x < x0 + size; x++)
          for (let c = 0; c < 3; c++)
            color[c]! += rgb[(y * width + x) * 3 + c]! / (size * size * 255);
      corners.push(color);
    }
  const color = [0, 1, 2].map(
    (c) =>
      corners.reduce((sum, corner) => sum + corner[c]!, 0) / corners.length,
  ) as [number, number, number];
  if (
    corners.some((corner) =>
      corner.some((c, i) => Math.abs(c - color[i]!) > 0.025),
    )
  )
    throw new Error("Nonuniform video plate or foreground in sampling corners");
  return color;
}

export function matteOptions(
  settings: Omit<ChromaMatteOptions, "background">,
  width: number,
  background: ChromaMatteOptions["background"],
): ChromaMatteOptions {
  return {
    background,
    coreDistance: settings.coreDistance,
    noiseFloor: settings.noiseFloor,
    erosionRadius: Math.max(
      1,
      Math.round((settings.erosionRadius * width) / 512),
    ),
    supportRadius: Math.max(
      2,
      Math.round((settings.supportRadius * width) / 512),
    ),
  };
}

/** Four-connected distance/nearest-seed transform. Every pixel enters once. */
function nearestSeeds(seeds: Uint8Array, width: number) {
  const nearest = new Int32Array(seeds.length).fill(-1);
  const distance = new Int32Array(seeds.length).fill(-1);
  const queue = new Int32Array(seeds.length);
  let read = 0,
    write = 0;
  for (let i = 0; i < seeds.length; i++) {
    if (!seeds[i]) continue;
    nearest[i] = i;
    distance[i] = 0;
    queue[write++] = i;
  }
  if (write === 0) throw new Error("Matte contains no classified seed pixels");
  const visit = (from: number, to: number) => {
    if (to < 0 || to >= seeds.length || nearest[to] !== -1) return;
    nearest[to] = nearest[from]!;
    distance[to] = distance[from]! + 1;
    queue[write++] = to;
  };
  while (read < write) {
    const i = queue[read++]!;
    visit(i, i - width);
    visit(i, i + width);
    if (i % width) visit(i, i - 1);
    if (i % width < width - 1) visit(i, i + 1);
  }
  return { nearest, distance };
}

/** Background-like colour alone cannot identify background: green irises and
 * blue controls can fall inside the key radius. Grow background from the frame
 * border instead. A genuinely empty enclosed gap still contains the measured
 * plate itself, so strict plate samples may seed that gap independently. */
function connectedBackground(
  possible: Uint8Array,
  width: number,
  strict?: Uint8Array,
) {
  const background = new Uint8Array(possible.length);
  const queue = new Int32Array(possible.length);
  let read = 0,
    write = 0;
  const visit = (i: number) => {
    if (!possible[i] || background[i]) return;
    background[i] = 1;
    queue[write++] = i;
  };
  for (let i = 0; i < possible.length; i++)
    if (
      strict?.[i] ||
      i < width ||
      i >= possible.length - width ||
      i % width === 0 ||
      i % width === width - 1
    )
      visit(i);
  while (read < write) {
    const i = queue[read++]!;
    if (i >= width) visit(i - width);
    if (i < possible.length - width) visit(i + width);
    if (i % width) visit(i - 1);
    if (i % width < width - 1) visit(i + 1);
  }
  return background;
}

/** Curling fibres can enclose tiny, codec-shifted pieces of plate. They are
 * outside the solid silhouette, even when a four-connected flood cannot reach
 * them. Release only small chroma pockets close to the already known exterior;
 * enclosed eyes and controls remain protected foreground. */
function releaseFringePockets(
  possible: Uint8Array,
  outside: Uint8Array,
  width: number,
  erosionRadius: number,
) {
  const distance = nearestSeeds(outside, width).distance;
  const visited = new Uint8Array(possible.length);
  const queue = new Int32Array(possible.length);
  const limit = (erosionRadius * 4) ** 2;
  for (let start = 0; start < possible.length; start++) {
    if (!possible[start] || outside[start] || visited[start]) continue;
    let read = 0,
      write = 0,
      nearEdge = true;
    const visit = (i: number) => {
      if (!possible[i] || outside[i] || visited[i]) return;
      visited[i] = 1;
      queue[write++] = i;
      if (distance[i]! > erosionRadius * 4) nearEdge = false;
    };
    visit(start);
    while (read < write) {
      const i = queue[read++]!;
      if (i >= width) visit(i - width);
      if (i < possible.length - width) visit(i + width);
      if (i % width) visit(i - 1);
      if (i % width < width - 1) visit(i + 1);
    }
    if (nearEdge && write <= limit)
      for (let j = 0; j < write; j++) outside[queue[j]!] = 1;
  }
}

/**
 * Recover coverage before replacing blue-contaminated edge RGB.
 * C = a F + (1-a) B, hence a = dot(C-B,F-B) / |F-B|².
 * F is the nearest eroded foreground sample, not a guessed white constant.
 * The core keeps source RGB exactly, including eyes and shadowed underarms.
 * Unlike a similarity-radius key, faint fibers are not discarded before solving
 * their coverage. Bounded support and the quantization floor reject plate noise.
 * This does not reconstruct missing anatomy or invent fibers absent in the video.
 */
export function chromaMatte(
  rgb: Uint8Array,
  width: number,
  height: number,
  options: ChromaMatteOptions,
): Uint8Array {
  const { background, coreDistance, erosionRadius, supportRadius, noiseFloor } =
    options;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width * height > 4096 ** 2 ||
    rgb.length !== width * height * 3 ||
    background.length !== 3 ||
    background.some((c) => !Number.isFinite(c) || c < 0 || c > 1) ||
    !(coreDistance > 0 && coreDistance < 1) ||
    !Number.isInteger(erosionRadius) ||
    erosionRadius < 1 ||
    !Number.isInteger(supportRadius) ||
    supportRadius <= erosionRadius ||
    !(noiseFloor > 0 && noiseFloor < 1)
  )
    throw new Error("Invalid chroma matte input");
  const count = width * height,
    possible = new Uint8Array(count),
    strict = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    let squared = 0;
    for (let c = 0; c < 3; c++)
      squared += (rgb[i * 3 + c]! / 255 - background[c]!) ** 2;
    const distance = Math.sqrt(squared / 3);
    possible[i] = distance <= coreDistance ? 1 : 0;
    strict[i] = distance <= noiseFloor * 3 ? 1 : 0;
  }
  const outside = connectedBackground(possible, width, strict);
  releaseFringePockets(possible, outside, width, erosionRadius);
  const inward = nearestSeeds(outside, width).distance;
  const core = new Uint8Array(count);
  for (let i = 0; i < count; i++) core[i] = inward[i]! > erosionRadius ? 1 : 0;
  // Protection and colour estimation have different evidence. Protected blue
  // interiors must remain solid, but cannot supply a foreground colour to the
  // neighbouring uncertain fibres.
  const chromaDistance = nearestSeeds(possible, width).distance;
  const samples = new Uint8Array(count);
  for (let i = 0; i < count; i++)
    samples[i] = chromaDistance[i]! > erosionRadius ? 1 : 0;
  const { nearest, distance } = nearestSeeds(samples, width);
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    if (!core[i] && distance[i]! > supportRadius) continue;
    const sample = nearest[i]!;
    let dot = 0,
      magnitude = 0;
    for (let c = 0; c < 3; c++) {
      const vector = rgb[sample * 3 + c]! / 255 - background[c]!;
      dot += (rgb[i * 3 + c]! / 255 - background[c]!) * vector;
      magnitude += vector * vector;
    }
    let alpha = core[i] ? 1 : Math.max(0, Math.min(1, dot / magnitude));
    if (alpha < noiseFloor) alpha = 0;
    if (!alpha) continue;
    // Source texture is untouched in the opaque interior. In the uncertain band
    // use the estimated F directly; division by tiny alpha amplifies codec noise.
    for (let c = 0; c < 3; c++)
      rgba[i * 4 + c] = rgb[(core[i] ? i : sample) * 3 + c]!;
    // Chroma-plate spill can survive in the sampled foreground even after
    // coverage recovery, especially in pale felt fibers. Keep the edge
    // neutral/warm before any Lanczos or WebP resampling can spread that cast.
    // The clamp applies only outside the opaque core; the character interior
    // remains byte-identical.
    if (!core[i] || inward[i]! <= erosionRadius + 3) {
      const offset = i * 4;
      rgba[offset + 2] = Math.min(
        rgba[offset + 2]!,
        Math.max(rgba[offset]!, rgba[offset + 1]!) + 6,
      );
    }
    rgba[i * 4 + 3] = Math.round(alpha * 255);
  }
  return rgba;
}

/** Recover only the external matte's RGB. Interior colours (including blue
 * props) are immutable; invisible RGB is cleared before premultiplied filtering.
 * The bounded distance transform avoids frame-time or scan-order dependence. */
export function cleanEdgeRgba(rgba: Uint8Array, width: number, height: number) {
  if (rgba.length !== width * height * 4 || width < 2 || height < 2)
    throw new Error("Invalid edge cleanup input");
  const copy = new Uint8Array(rgba),
    count = width * height;
  const empty = new Uint8Array(count),
    clean = new Uint8Array(count);
  const plateTint = (offset: number) => rgba[offset + 2]! > rgba[offset]! + 3;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    // Measure the exterior from visible coverage. Near-invisible codec haze
    // can extend tens of pixels beyond the fibres; exact-zero distance would
    // leave coloured pixels on the visible contour outside the cleanup band.
    empty[i] = rgba[o + 3]! < 26 ? 1 : 0;
    if (!rgba[o + 3]) copy[o] = copy[o + 1] = copy[o + 2] = 0;
    if (rgba[o + 3]! >= 252 && !plateTint(o)) clean[i] = 1;
  }
  if (!empty.some(Boolean) || !clean.some(Boolean)) return copy;
  const exterior = connectedBackground(empty, width);
  if (!exterior.some(Boolean)) return copy;
  const edgeDistance = nearestSeeds(exterior, width).distance;
  const samples = nearestSeeds(clean, width);
  const radius = Math.max(2, Math.round((width * 16) / 512));
  for (let i = 0; i < count; i++) {
    const o = i * 4,
      alpha = rgba[o + 3]!;
    if (!alpha || edgeDistance[i]! > radius) continue;
    const blue = plateTint(o);
    if (alpha >= 252 && !blue) continue;
    const sample = samples.nearest[i]! * 4;
    if (samples.distance[i]! <= radius * 2) {
      copy[o] = rgba[sample]!;
      copy[o + 1] = rgba[sample + 1]!;
      copy[o + 2] = rgba[sample + 2]!;
    }
  }
  return copy;
}

/**
 * Lock neutral felt to the canonical root palette without touching alpha or
 * saturated facial/prop colors. Generation sources often change exposure while
 * the cat moves; this bounded transfer keeps every frame in one material grade.
 */
export function lockNeutralPaletteRgba(
  rgba: Uint8Array,
  reference: Uint8Array,
): Uint8Array {
  if (
    !rgba.length ||
    !reference.length ||
    rgba.length % 4 !== 0 ||
    reference.length % 4 !== 0
  )
    throw new Error("Palette lock inputs must contain RGBA pixels");
  const isFelt = (data: Uint8Array, offset: number) => {
    const alpha = data[offset + 3]!;
    const red = data[offset]!,
      green = data[offset + 1]!,
      blue = data[offset + 2]!;
    return (
      alpha >= 245 &&
      Math.max(red, green, blue) - Math.min(red, green, blue) < 52 &&
      Math.min(red, green, blue) > 120
    );
  };
  const mean = (data: Uint8Array) => {
    const sum = [0, 0, 0];
    let count = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (!isFelt(data, offset)) continue;
      count++;
      for (let channel = 0; channel < 3; channel++)
        sum[channel]! += data[offset + channel]!;
    }
    if (!count) throw new Error("Palette lock found no neutral felt pixels");
    return sum.map((value) => value / count);
  };
  const target = mean(reference);
  const current = mean(rgba);
  const delta = target.map((value, channel) =>
    Math.max(-24, Math.min(24, value - current[channel]!)),
  );
  const copy = new Uint8Array(rgba);
  for (let offset = 0; offset < copy.length; offset += 4) {
    if (!isFelt(copy, offset)) continue;
    for (let channel = 0; channel < 3; channel++)
      copy[offset + channel] = Math.max(
        0,
        Math.min(255, Math.round(copy[offset + channel]! + delta[channel]!)),
      );
  }
  return copy;
}

/** Colour grading must precede the final edge repair: channel offsets can
 * otherwise reintroduce a blue cast in already neutralised opaque fibres. */
export function finishMatteRgba(
  rgba: Uint8Array,
  reference: Uint8Array,
  width: number,
  height: number,
) {
  return cleanEdgeRgba(lockNeutralPaletteRgba(rgba, reference), width, height);
}

if (import.meta.main) {
  const [mode, id, first, second] = process.argv.slice(2);
  if (
    !id ||
    !first ||
    (mode === "extract" && !second) ||
    !["extract", "verify", "cleanup", "finish"].includes(mode ?? "") ||
    process.argv.length !== (mode === "extract" ? 6 : mode === "finish" ? 6 : 5)
  )
    throw new Error(
      "Usage: motion_matte.ts extract <sequence-id> <RGB-directory> <RGBA-directory> | verify <sequence-id> <RGBA-directory> | cleanup <input.png> <output.png> | finish <input.png> <reference.png> <output.png>",
    );
  if (mode === "cleanup") {
    const { data, info } = await sharp(id)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cleaned = cleanEdgeRgba(data, info.width, info.height);
    await sharp(cleaned, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toFile(first);
    process.exit(0);
  }
  if (mode === "finish") {
    const input = await sharp(id)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const reference = await sharp(first)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const locked = finishMatteRgba(
      input.data,
      reference.data,
      input.info.width,
      input.info.height,
    );
    await sharp(locked, {
      raw: { width: input.info.width, height: input.info.height, channels: 4 },
    })
      .png()
      .toFile(process.argv[5]!);
    process.exit(0);
  }
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dir, "../motion/manifest.json"), "utf8"),
  );
  const production = manifest.production;
  const sequence = manifest.sequences.find((s: { id: string }) => s.id === id);
  if (!sequence) throw new Error("Unknown motion sequence");
  const character = manifest.characters.find(
    (c: { id: string }) => c.id === sequence.character,
  );
  const rootAsset = character.assets.find(
    (a: { id: string }) => a.id === character.rootAsset,
  );
  const reference = await sharp(
    resolve(import.meta.dir, "..", rootAsset.source),
  )
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const referenceRoughness = contourRoughness(
    reference.data,
    reference.info.width,
    production.matting.perimeterAlphaThreshold,
  );
  const referenceSpread = edgeSpread(reference.data, reference.info.width);
  const { frameCount } = sequenceTiming(production, sequence);
  const input = first;
  const frames = (await readdir(input))
    .filter((name) => /^frame-\d+\.png$/.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (
    frames.length !== frameCount ||
    frames.some((name, i) => name !== `frame-${String(i).padStart(2, "0")}.png`)
  )
    throw new Error("Incomplete source frame sequence");
  let soft = 0,
    perimeter = 0,
    minimumSpreadRatio = Infinity,
    maximumSpreadRatio = 0,
    minimumRoughnessRatio = Infinity,
    maximumRoughnessRatio = 0;
  for (const frame of frames) {
    if (mode === "extract") {
      const { data, info } = await sharp(join(input, frame))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const background = samplePlate(data, info.width, info.height);
      const [r, g, b] = background,
        low = Math.min(r, g, b),
        high = Math.max(r, g, b);
      const hue = (4 + (r - g) / (high - low)) / 6;
      if (
        high !== b ||
        hue < production.minimumChromaHue ||
        hue > production.maximumChromaHue ||
        high === 0 ||
        (high - low) / high < production.minimumChromaSaturation
      )
        throw new Error(`${frame}: video plate is not saturated blue`);
      const result = chromaMatte(
        data,
        info.width,
        info.height,
        matteOptions(production.matting, info.width, background),
      );
      await sharp(result, {
        raw: { width: info.width, height: info.height, channels: 4 },
      })
        .png()
        .toFile(join(second!, frame));
    } else {
      const { data, info } = await sharp(join(input, frame))
        .ensureAlpha()
        .extractChannel(3)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const metrics = alphaMetrics(
        data,
        info.width,
        production.matting.perimeterAlphaThreshold,
      );
      soft += metrics.softAlphaRatio;
      perimeter += metrics.perimeterComplexity;
      const spreadRatio = edgeSpread(data, info.width) / referenceSpread;
      const roughnessRatio =
        contourRoughness(
          data,
          info.width,
          production.matting.perimeterAlphaThreshold,
        ) / referenceRoughness;
      minimumSpreadRatio = Math.min(minimumSpreadRatio, spreadRatio);
      maximumSpreadRatio = Math.max(maximumSpreadRatio, spreadRatio);
      minimumRoughnessRatio = Math.min(minimumRoughnessRatio, roughnessRatio);
      maximumRoughnessRatio = Math.max(maximumRoughnessRatio, roughnessRatio);
      const material = production.material;
      if (
        spreadRatio < material.minimumEdgeSpreadRatio ||
        spreadRatio > material.maximumEdgeSpreadRatio ||
        roughnessRatio < material.minimumContourRoughnessRatio ||
        roughnessRatio > material.maximumContourRoughnessRatio
      )
        throw new Error(
          `${id} ${frame} differs from root material: edge-spread ratio=${spreadRatio.toFixed(4)}, contour-roughness ratio=${roughnessRatio.toFixed(4)}`,
        );
    }
  }
  if (mode === "verify") {
    soft /= frames.length;
    perimeter /= frames.length;
    console.error(
      `${id} matte: diagnostic soft-alpha=${soft.toFixed(8)}, visible-perimeter=${perimeter.toFixed(8)} (alpha>${production.matting.perimeterAlphaThreshold}); per-frame root-relative edge-spread=${minimumSpreadRatio.toFixed(4)}..${maximumSpreadRatio.toFixed(4)}, contour-roughness=${minimumRoughnessRatio.toFixed(4)}..${maximumRoughnessRatio.toFixed(4)}`,
    );
    console.log(`${soft.toFixed(8)} ${perimeter.toFixed(8)}`);
  }
}
