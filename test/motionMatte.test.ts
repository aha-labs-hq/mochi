import { describe, expect, test } from "bun:test";
import { interiorTransparency } from "../script/audit_motion_frames.ts";
import {
  alphaMetrics,
  type ChromaMatteOptions,
  chromaMatte,
  cleanEdgeRgba,
  contourRoughness,
  edgeSpread,
  finishMatteRgba,
  lockNeutralPaletteRgba,
  parseBackground,
  samplePlate,
} from "../script/motion_matte.ts";

const key = [8 / 255, 120 / 255, 202 / 255] as const;

test("the colour audit distinguishes a covered inner shadow from an exposed blue fringe", () => {
  const size = 64;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 8; y < 56; y++)
    for (let x = 8; x < 56; x++)
      rgba.set([230, 225, 220, 255], (y * size + x) * 4);
  for (let x = 8; x <= 40; x++) rgba[(30 * size + x) * 4 + 3] = 240;
  rgba.set([205, 215, 225, 240], (30 * size + 40) * 4);
  expect(interiorTransparency(rgba, size).edgeTintPixels).toBe(0);
  rgba.set([205, 215, 225, 128], (40 * size + 8) * 4);
  expect(interiorTransparency(rgba, size).edgeTintPixels).toBe(1);
});

test("final palette grading cannot reintroduce cold opaque edges", () => {
  const size = 15;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 2; y < 13; y++)
    for (let x = 2; x < 13; x++)
      rgba.set([250, 235, 205, 255], (y * size + x) * 4);
  const edge = (7 * size + 2) * 4;
  rgba.set([235, 233, 229, 255], edge);
  const reference = new Uint8Array([225, 224, 221, 255]);
  const graded = lockNeutralPaletteRgba(rgba, reference);
  expect(graded[edge + 2]!).toBeGreaterThan(graded[edge]! + 3);
  const finished = finishMatteRgba(rgba, reference, size, size);
  expect(finished[edge + 2]!).toBeLessThanOrEqual(finished[edge]! + 3);
  expect(finished.slice((7 * size + 7) * 4, (7 * size + 7) * 4 + 4)).toEqual(
    graded.slice((7 * size + 7) * 4, (7 * size + 7) * 4 + 4),
  );
  for (let i = 3; i < rgba.length; i += 4) expect(finished[i]).toBe(rgba[i]);
});
const options: ChromaMatteOptions = {
  background: key,
  coreDistance: 0.26,
  erosionRadius: 2,
  supportRadius: 12,
  noiseFloor: 2 / 255,
};
const size = 64;
function composite(alpha: Uint8Array, colors?: Uint8Array) {
  const rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < alpha.length; i++)
    for (let c = 0; c < 3; c++) {
      const foreground = colors?.[i * 3 + c] ?? 240;
      rgb[i * 3 + c] = Math.round(
        (foreground * alpha[i]!) / 255 + key[c]! * (255 - alpha[i]!),
      );
    }
  return rgb;
}
function subject() {
  const alpha = new Uint8Array(size * size);
  for (let y = 16; y < 48; y++)
    for (let x = 16; x < 48; x++) alpha[y * size + x] = 255;
  return alpha;
}

describe("coverage-preserving chroma matte", () => {
  test("short felt accepts a coherent antialiased edge and exposes both halos and ragged fragments", () => {
    const clean = subject(),
      halo = subject(),
      ragged = subject();
    for (let y = 15; y < 49; y++)
      for (let x = 15; x < 49; x++)
        if (!clean[y * size + x]) clean[y * size + x] = 128;
    for (let y = 8; y < 56; y++)
      for (let x = 8; x < 56; x++)
        if (!halo[y * size + x]) halo[y * size + x] = 51;
    for (let y = 18; y < 46; y += 3)
      for (let x = 8; x < 16; x++) {
        ragged[y * size + x] = 128;
        ragged[y * size + size - x - 1] = 128;
      }
    const reference = alphaMetrics(clean, size, 0.1).perimeterComplexity;
    expect(reference).toBeLessThan(6);
    expect(
      alphaMetrics(ragged, size, 0.1).perimeterComplexity / reference,
    ).toBeGreaterThan(1.35);
    expect(edgeSpread(halo, size) / edgeSpread(clean, size)).toBeGreaterThan(2);
    expect(edgeSpread(subject(), size)).toBe(0);
    const padded = new Uint8Array(128 * 128);
    for (let y = 0; y < size; y++)
      padded.set(clean.subarray(y * size, (y + 1) * size), (y + 32) * 128 + 32);
    expect(edgeSpread(padded, 128)).toBeCloseTo(edgeSpread(clean, size), 12);
    expect(alphaMetrics(padded, 128, 0.1).perimeterComplexity).toBe(reference);
    expect(
      contourRoughness(ragged, size, 0.1) / contourRoughness(clean, size, 0.1),
    ).toBeGreaterThan(1.35);
    expect(contourRoughness(padded, 128, 0.1)).toBeCloseTo(
      contourRoughness(clean, size, 0.1),
      12,
    );
  });
  test("contour roughness distinguishes fine fringe from a smooth articulated silhouette", () => {
    const width = 256,
      clean = new Uint8Array(width * width);
    // A body, two thick arms and two separated legs: more anatomical perimeter
    // than a square, without any fine hair or disconnected fragments.
    for (const [left, top, right, bottom] of [
      [72, 40, 184, 168],
      [24, 64, 88, 104],
      [168, 64, 232, 104],
      [72, 152, 112, 224],
      [144, 152, 184, 224],
    ])
      for (let y = top!; y < bottom!; y++)
        for (let x = left!; x < right!; x++) clean[y * width + x] = 255;
    const ragged = clean.slice();
    for (let y = 112; y < 152; y += 3)
      for (let x = 56; x < 72; x++) {
        ragged[y * width + x] = 128;
        ragged[y * width + width - x - 1] = 128;
      }
    const reference = contourRoughness(subject(), size, 0.1);
    expect(contourRoughness(clean, width, 0.1) / reference).toBeLessThan(1.35);
    expect(
      contourRoughness(ragged, width, 0.1) /
        contourRoughness(clean, width, 0.1),
    ).toBeGreaterThan(1.35);
    expect(() => contourRoughness(new Uint8Array(64), 8, 0.1)).toThrow(
      "No foreground",
    );
  });
  test("codec-shifted plate enclosed by an exterior wool curl is not opaque foreground", () => {
    const alpha = subject();
    for (let y = 27; y <= 33; y++)
      for (let x = 10; x <= 16; x++)
        if (x === 10 || x === 16 || y === 27 || y === 33)
          alpha[y * size + x] = 255;
    const rgb = composite(alpha);
    for (let y = 28; y <= 32; y++)
      for (let x = 11; x <= 15; x++)
        rgb.set([18, 115, 190], (y * size + x) * 3);
    const rgba = chromaMatte(rgb, size, size, options);
    for (let y = 28; y <= 32; y++)
      for (let x = 11; x <= 15; x++)
        expect(rgba[(y * size + x) * 4 + 3]!).toBeLessThanOrEqual(8);
    expect(rgba[(30 * size + 10) * 4 + 3]).toBe(255);
    expect(rgba[(30 * size + 25) * 4 + 3]).toBe(255);
  });
  test("cyan-contaminated opaque edge pixels cannot become foreground colour seeds", () => {
    const rgba = new Uint8Array(size * size * 4);
    // Almost invisible halo coverage must not push the visible contour outside
    // the bounded colour-cleanup band. Alpha itself remains untouched.
    for (let y = 8; y < 56; y++)
      for (let x = 8; x < 56; x++)
        rgba.set([190, 210, 220, 1], (y * size + x) * 4);
    for (let y = 16; y < 48; y++)
      for (let x = 16; x < 48; x++)
        rgba.set([239, 235, 222, 255], (y * size + x) * 4);
    rgba.set([197, 216, 218, 255], (32 * size + 16) * 4);
    rgba.set([197, 216, 218, 96], (32 * size + 15) * 4);
    rgba.set([20, 100, 170, 255], (32 * size + 32) * 4);
    const cleaned = cleanEdgeRgba(rgba, size, size);
    for (const [x, alpha] of [
      [15, 96],
      [16, 255],
    ] as const)
      expect([
        ...cleaned.slice((32 * size + x) * 4, (32 * size + x) * 4 + 4),
      ]).toEqual([239, 235, 222, alpha]);
    expect([
      ...cleaned.slice((32 * size + 32) * 4, (32 * size + 32) * 4 + 4),
    ]).toEqual([20, 100, 170, 255]);
    expect(cleaned[(32 * size + 8) * 4 + 3]).toBe(1);
  });
  test("per-frame sampling removes temporal plate changes instead of admitting a breathing halo", () => {
    const alpha = subject();
    for (let y = 16; y < 48; y++) alpha[y * size + 15] = 51;
    for (const blue of [
      [8, 120, 202],
      [0, 100, 181],
      [0, 113, 197],
    ]) {
      const rgb = composite(alpha);
      for (let i = 0; i < alpha.length; i++)
        for (let c = 0; c < 3; c++)
          rgb[i * 3 + c] = Math.round(
            (240 * alpha[i]!) / 255 + blue[c]! * (1 - alpha[i]! / 255),
          );
      const result = chromaMatte(rgb, size, size, {
        ...options,
        background: samplePlate(rgb, size, size),
      });
      for (let i = 0; i < alpha.length; i++)
        expect(Math.abs(result[i * 4 + 3]! - alpha[i]!)).toBeLessThanOrEqual(1);
    }
    const bad = composite(subject());
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++)
        bad.fill(255, (y * size + x) * 3, (y * size + x) * 3 + 3);
    expect(() => samplePlate(bad, size, size)).toThrow("Nonuniform");
  });
  test("visible perimeter distinguishes known translucent fibers from a smooth soft halo", () => {
    const fibers = subject(),
      halo = subject();
    for (let y = 18; y < 46; y += 3)
      for (let x = 8; x < 16; x++) {
        fibers[y * size + x] = 51;
        fibers[y * size + size - x - 1] = 51;
      }
    for (let y = 14; y < 50; y++)
      for (let x = 14; x < 50; x++)
        if (!halo[y * size + x]) halo[y * size + x] = 51;
    // The old core-only score cannot see a single one of these real fibers.
    expect(alphaMetrics(fibers, size, 0.5).perimeterComplexity).toBeLessThan(6);
    expect(alphaMetrics(fibers, size, 0.1).perimeterComplexity).toBeGreaterThan(
      6,
    );
    expect(alphaMetrics(halo, size, 0.1).perimeterComplexity).toBeLessThan(6);
    expect(alphaMetrics(subject(), size, 0.1).perimeterComplexity).toBeLessThan(
      6,
    );
    expect(parseBackground("0878CA")).toEqual([...key]);
    expect(() => parseBackground("oops")).toThrow("Invalid");
  });
  test("recovers fine translucent fibers rather than turning a color-distance radius into zero coverage", () => {
    const alpha = subject();
    for (const y of [18, 24, 30, 36, 42])
      for (let x = 9; x < 16; x++) alpha[y * size + x] = 51;
    const rgba = chromaMatte(composite(alpha), size, size, options);
    for (let i = 0; i < alpha.length; i++) {
      expect(Math.abs(rgba[i * 4 + 3]! - alpha[i]!)).toBeLessThanOrEqual(1);
      if (alpha[i])
        expect(Array.from(rgba.slice(i * 4, i * 4 + 3))).toEqual([
          240, 240, 240,
        ]);
    }
  });

  test("keeps opaque eyes and original core RGB, but leaves visible underarm/background gaps empty", () => {
    const alpha = subject(),
      colors = new Uint8Array(alpha.length * 3).fill(240);
    for (let y = 26; y < 38; y++)
      for (let x = 27; x < 37; x++) {
        colors.set(x < 31 ? [20, 130, 10] : [0, 0, 0], (y * size + x) * 3);
      }
    for (let y = 38; y < 48; y++)
      for (let x = 28; x < 36; x++) alpha[y * size + x] = 0;
    const rgb = composite(alpha, colors),
      rgba = chromaMatte(rgb, size, size, options);
    for (const [x, y] of [
      [29, 30],
      [33, 30],
      [20, 20],
    ]) {
      const i = y! * size + x!;
      expect(Array.from(rgba.slice(i * 4, i * 4 + 4))).toEqual([
        ...rgb.slice(i * 3, i * 3 + 3),
        255,
      ]);
    }
    expect(rgba[(43 * size + 31) * 4 + 3]).toBe(0);
  });

  test("rejects invalid images and degenerate classifications explicitly", () => {
    expect(() => chromaMatte(new Uint8Array(4), size, size, options)).toThrow(
      "Invalid",
    );
    expect(() =>
      chromaMatte(composite(subject()), size, size, {
        ...options,
        background: [0, NaN, 1],
      }),
    ).toThrow("Invalid");
    expect(() =>
      chromaMatte(composite(new Uint8Array(size * size)), size, size, options),
    ).toThrow("no classified seed");
    expect(() =>
      chromaMatte(
        new Uint8Array(size * size * 3).fill(255),
        size,
        size,
        options,
      ),
    ).toThrow("no classified seed");
  });

  test("identical frames produce byte-identical results without temporal history or invented detail", () => {
    const rgb = composite(subject());
    expect(chromaMatte(rgb, size, size, options)).toEqual(
      chromaMatte(rgb, size, size, options),
    );
  });

  test("background-like eyes and a blue control stay solid while a real enclosed plate gap stays empty", () => {
    const alpha = subject(),
      colors = new Uint8Array(alpha.length * 3).fill(240);
    for (let y = 22; y < 31; y++)
      for (let x = 22; x < 31; x++)
        colors.set([45, 135, 185], (y * size + x) * 3);
    for (let y = 34; y < 41; y++)
      for (let x = 34; x < 41; x++) alpha[y * size + x] = 0;
    const rgb = composite(alpha, colors),
      rgba = chromaMatte(rgb, size, size, options);
    for (let y = 22; y < 31; y++)
      for (let x = 22; x < 31; x++) {
        const i = y * size + x;
        expect(Array.from(rgba.slice(i * 4, i * 4 + 4))).toEqual([
          45, 135, 185, 255,
        ]);
      }
    expect(rgba[(37 * size + 37) * 4 + 3]).toBe(0);
  });
});
