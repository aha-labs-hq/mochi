import { expect, test } from "bun:test";
import { alphaRoundTrip } from "../script/audit_motion_key.ts";

test("known-alpha audit distinguishes discarded fibers from a preserved matte", () => {
  const expected = new Uint8Array([0, 1, 128, 252, 253, 255]);
  expect(alphaRoundTrip(expected, expected)).toEqual({
    expectedSoftRatio: 3 / 5, recoveredSoftRatio: 3 / 5,
    alphaRmse: 0, lostSoftPixels: 0, expectedSoftPixels: 3,
  });
  const loss = alphaRoundTrip(expected, new Uint8Array([0, 0, 0, 255, 255, 255]));
  expect(loss.lostSoftPixels).toBe(2);
  expect(loss.recoveredSoftRatio).toBe(0);
  expect(loss.alphaRmse).toBeGreaterThan(0);
});

test("alpha audit rejects mismatched planes and handles a genuinely empty matte", () => {
  expect(() => alphaRoundTrip(new Uint8Array(), new Uint8Array())).toThrow();
  expect(() => alphaRoundTrip(new Uint8Array(2), new Uint8Array(1))).toThrow();
  expect(alphaRoundTrip(new Uint8Array(2), new Uint8Array(2))).toEqual({
    expectedSoftRatio: 0, recoveredSoftRatio: 0,
    alphaRmse: 0, lostSoftPixels: 0, expectedSoftPixels: 0,
  });
});
