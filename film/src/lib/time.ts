import { Easing, interpolate } from "remotion";

export const FPS = 30;
/** Seconds to frames. Every cue in the film is written in seconds. */
export const s = (seconds: number) => Math.round(seconds * FPS);

/** The settle the website and the companion use for things arriving. */
export const settle = Easing.bezier(0.2, 0.7, 0.2, 1);
/** A camera that starts and stops like a dolly on a slow motor. */
export const dolly = Easing.bezier(0.45, 0, 0.25, 1);

export const ramp = (
  frame: number,
  from: number,
  to: number,
  easing: (t: number) => number = settle,
) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/** A deterministic hash in [-1, 1]: the same "random" on every render. */
export const noise = (n: number, salt = 0) => {
  const x = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

/** Stop-motion steps: twelve exposures a second, each held for its frames. */
export const exposure = (frame: number) => Math.floor(frame / (FPS / 12));
