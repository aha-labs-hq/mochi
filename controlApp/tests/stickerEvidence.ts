import type { MotionCatalog } from "../src/motion/catalog.ts";
import { StickerSurface } from "../src/motion/sticker.ts";

function isMatteEdge(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  alpha: number,
): boolean {
  if (alpha < 245) return true;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const sampleX = x + dx,
        sampleY = y + dy;
      if (
        sampleX >= 0 &&
        sampleX < width &&
        sampleY >= 0 &&
        sampleY < height &&
        data[(sampleY * width + sampleX) * 4 + 3] === 0
      )
        return true;
    }
  return false;
}

/** Test-only GPU readback. Never linked by the product renderer. */
export async function stickerEvidence(catalog: MotionCatalog) {
  const asset = catalog.asset(
    catalog.defaultCharacter,
    catalog.defaultCharacter.rootAsset,
  );
  const source = document.createElement("canvas");
  source.width = asset.geometry.canvasWidth;
  source.height = asset.geometry.canvasHeight;
  const ctx = source.getContext("2d")!;
  const image = new Image();
  image.src = `./assets/${asset.resource}.png`;
  await image.decode();
  ctx.drawImage(image, 0, 0);
  const original = ctx.getImageData(0, 0, source.width, source.height).data;
  const canvas = document.createElement("canvas");
  let failed = false;
  const surface = new StickerSurface(canvas, source, () => {
    failed = true;
  });
  const gl = canvas.getContext("webgl2")!;
  const pixels = () => {
    const values = new Uint8Array(source.width * source.height * 4);
    gl.readPixels(
      0,
      0,
      source.width,
      source.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      values,
    );
    return values;
  };
  try {
    surface.draw(true, false, false, true, 0);
    const flat = pixels();
    let maximumAlphaError = 0,
      maximumColorError = 0,
      contaminatedBefore = 0,
      contaminatedAfter = 0;
    for (let y = 0; y < source.height; y++)
      for (let x = 0; x < source.width; x++) {
        const from = (y * source.width + x) * 4;
        const to = ((source.height - y - 1) * source.width + x) * 4;
        maximumAlphaError = Math.max(
          maximumAlphaError,
          Math.abs(original[from + 3]! - flat[to + 3]!),
        );
        const alpha = original[from + 3]!;
        const blue =
          original[from + 2]! > original[from]! + 25 &&
          original[from + 2]! > original[from + 1]! + 10;
        if (
          alpha > 10 &&
          blue &&
          isMatteEdge(original, source.width, source.height, x, y, alpha)
        ) {
          contaminatedBefore++;
          if (
            flat[to + 2]! > flat[to]! + (25 * alpha) / 255 &&
            flat[to + 2]! > flat[to + 1]! + (10 * alpha) / 255
          )
            contaminatedAfter++;
        }
        // Preserve every source pixel in premultiplied space, including blue
        // controls and translucent fibres. Runtime does not repair source art.
        for (let channel = 0; channel < 3; channel++) {
          const expected = Math.round(
            (original[from + channel]! * original[from + 3]!) / 255,
          );
          maximumColorError = Math.max(
            maximumColorError,
            Math.abs(expected - flat[to + channel]!),
          );
        }
      }
    surface.draw(false, true, false, true, 1);
    const paper = pixels();
    let addedPaperPixels = 0;
    for (let index = 3; index < flat.length; index += 4)
      if (flat[index] === 0 && paper[index]! > 128) addedPaperPixels++;
    surface.draw(false, true, true, false, 101);
    const curled = pixels();
    let movedPixels = 0;
    for (let index = 0; index < paper.length; index++)
      if (paper[index] !== curled[index]) movedPixels++;
    surface.draw(false, true, true, true, 102);
    const reduced = pixels();
    let reducedMismatch = 0;
    for (let index = 0; index < paper.length; index++)
      if (paper[index] !== reduced[index]) reducedMismatch++;
    // An event stage changes texture dimensions without replacing the canvas
    // or WebGL context. Check actual readback, then return to the daily root.
    const sizes = [768, 1024, asset.geometry.canvasWidth];
    const resolutionChanges: {
      size: number;
      width: number;
      height: number;
      alpha: number;
      sameContext: boolean;
      error: number;
    }[] = [];
    for (const size of sizes) {
      source.width = source.height = size;
      ctx.fillStyle = "#cc8844";
      ctx.fillRect(size - 40, size - 40, 32, 32);
      surface.draw(true, false, false, true, 103);
      const sample = new Uint8Array(4);
      gl.readPixels(size - 24, 24, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sample);
      resolutionChanges.push({
        size,
        width: canvas.width,
        height: canvas.height,
        alpha: sample[3]!,
        sameContext: canvas.getContext("webgl2") === gl,
        error: gl.getError(),
      });
    }
    // A dense alpha pattern with blue in invisible pixels catches incorrect
    // straight-alpha minification and nearest/linear sampling aliasing.
    const pattern = ctx.createImageData(source.width, source.height);
    for (let pixel = 0; pixel < pattern.data.length / 4; pixel++)
      pattern.data.set(
        pixel % 2 ? [10, 30, 250, 0] : [220, 190, 160, 255],
        pixel * 4,
      );
    ctx.putImageData(pattern, 0, 0);
    const minification: { size: number; maximumError: number }[] = [];
    for (const size of [128, 256]) {
      surface.resize(size, size);
      surface.draw(size === 128, false, false, true, 104);
      const values = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, values);
      let maximumError = 0;
      for (let index = 0; index < values.length; index++)
        maximumError = Math.max(
          maximumError,
          Math.abs(values[index]! - [110, 95, 80, 128][index % 4]!),
        );
      minification.push({ size, maximumError });
    }
    // ResizeObserver runs after animation callbacks. A paused player may not
    // draw again before the compositor presents this resized canvas.
    const resizeContinuity: number[] = [];
    ctx.fillStyle = "#cc8844";
    ctx.fillRect(0, 0, source.width, source.height);
    surface.draw(true, false, false, true, 105);
    for (const size of [240, 160, 320]) {
      surface.resize(size, size);
      const sample = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sample);
      resizeContinuity.push(sample[3]!);
    }
    // The root probe above is not sufficient: the companion currently shows
    // the sleep asset, and every static pose must pass the same matte gate.
    const staticAssetContamination: {
      id: string;
      before: number;
      after: number;
    }[] = [];
    for (const candidate of catalog.defaultCharacter.assets) {
      const candidateSource = document.createElement("canvas");
      candidateSource.width = candidate.geometry.canvasWidth;
      candidateSource.height = candidate.geometry.canvasHeight;
      const candidateContext = candidateSource.getContext("2d")!;
      const candidateImage = new Image();
      candidateImage.src = `./assets/${candidate.resource}.png`;
      await candidateImage.decode();
      candidateContext.drawImage(candidateImage, 0, 0);
      const candidateOriginal = candidateContext.getImageData(
        0,
        0,
        candidateSource.width,
        candidateSource.height,
      ).data;
      const candidateCanvas = document.createElement("canvas");
      const candidateSurface = new StickerSurface(
        candidateCanvas,
        candidateSource,
        () => {
          failed = true;
        },
      );
      try {
        candidateSurface.draw(true, false, false, true, 0);
        const candidateGl = candidateCanvas.getContext("webgl2")!;
        const candidatePixels = new Uint8Array(
          candidateSource.width * candidateSource.height * 4,
        );
        candidateGl.readPixels(
          0,
          0,
          candidateSource.width,
          candidateSource.height,
          candidateGl.RGBA,
          candidateGl.UNSIGNED_BYTE,
          candidatePixels,
        );
        let before = 0;
        let after = 0;
        for (let y = 0; y < candidateSource.height; y++)
          for (let x = 0; x < candidateSource.width; x++) {
            const from = (y * candidateSource.width + x) * 4;
            const to =
              ((candidateSource.height - y - 1) * candidateSource.width + x) *
              4;
            const alpha = candidateOriginal[from + 3]!;
            // Canvas unpremultiplication can amplify a one-unit rounding
            // difference into a large RGB tint in almost transparent fibres.
            // Compare the displayed contribution, as the GPU readback does.
            const red = Math.round((candidateOriginal[from]! * alpha) / 255);
            const green = Math.round(
              (candidateOriginal[from + 1]! * alpha) / 255,
            );
            const blue = Math.round(
              (candidateOriginal[from + 2]! * alpha) / 255,
            );
            if (
              alpha > 10 &&
              blue > red + 3 &&
              blue > green + 1 &&
              isMatteEdge(
                candidateOriginal,
                candidateSource.width,
                candidateSource.height,
                x,
                y,
                alpha,
              )
            ) {
              before++;
              if (
                candidatePixels[to + 2]! > candidatePixels[to]! + 3 &&
                candidatePixels[to + 2]! > candidatePixels[to + 1]! + 1
              )
                after++;
            }
          }
        staticAssetContamination.push({ id: candidate.id, before, after });
      } finally {
        candidateSurface.dispose();
      }
    }
    return {
      failed,
      maximumAlphaError,
      maximumColorError,
      contaminatedBefore,
      contaminatedAfter,
      addedPaperPixels,
      movedPixels,
      reducedMismatch,
      cornerAlpha: paper[3],
      resolutionChanges,
      minification,
      resizeContinuity,
      staticAssetContamination,
    };
  } finally {
    surface.dispose();
  }
}
