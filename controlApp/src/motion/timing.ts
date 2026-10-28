export interface ProductionTiming {
  durationSeconds: number;
  framesPerSecond: number;
  frameCount: number;
}

/** The recipe owns source duration; editing retains contiguous native exposures. */
export function sequenceTiming(
  production: ProductionTiming,
  sequence: {
    framesPerSecond?: number;
    sourceFrames?: { start: number; end: number };
  },
) {
  const framesPerSecond =
    sequence.framesPerSecond ?? production.framesPerSecond;
  const sourceFrameCount = production.durationSeconds * framesPerSecond;
  if (
    !Number.isFinite(production.durationSeconds) ||
    production.durationSeconds <= 0 ||
    !Number.isSafeInteger(framesPerSecond) ||
    framesPerSecond < 1 ||
    framesPerSecond > 60 ||
    !Number.isSafeInteger(sourceFrameCount) ||
    sourceFrameCount < 2 ||
    sourceFrameCount > 600 ||
    production.frameCount !==
      production.durationSeconds * production.framesPerSecond ||
    sequence.framesPerSecond === null
  )
    throw new Error("Invalid motion cadence");
  const range = sequence.sourceFrames;
  if (
    range !== undefined &&
    (range === null ||
      Object.keys(range).sort().join() !== "end,start" ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end >= sourceFrameCount)
  )
    throw new Error("Invalid source frame range");
  const frameCount = range ? range.end - range.start + 1 : sourceFrameCount;
  return { framesPerSecond, frameCount };
}

/** Integer container timestamps without accumulated rounding drift (e.g. 24 fps). */
export function frameDuration(frame: number, framesPerSecond: number): number {
  return (
    Math.floor(((frame + 1) * 1000) / framesPerSecond) -
    Math.floor((frame * 1000) / framesPerSecond)
  );
}
