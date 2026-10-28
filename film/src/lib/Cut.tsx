import type { ReactNode } from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Subtitle } from "./Subtitle.tsx";
import { ramp, s } from "./time.ts";

/* The editing primitives both cuts are made of. Every time is in seconds of
   the cut's own clock. */

/** A stretch of film between two seconds, crossfading at its ends. */
export function Scene({
  from,
  to,
  fadeIn = 0,
  fadeOut = 0,
  children,
}: {
  from: number;
  to: number;
  fadeIn?: number;
  fadeOut?: number;
  children: ReactNode;
}) {
  return (
    <Sequence from={s(from)} durationInFrames={s(to - from)}>
      <Envelope length={s(to - from)} fadeIn={s(fadeIn)} fadeOut={s(fadeOut)}>
        {children}
      </Envelope>
    </Sequence>
  );
}

function Envelope({ length, fadeIn, fadeOut, children }: { length: number; fadeIn: number; fadeOut: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const inn = fadeIn ? ramp(frame, 0, fadeIn) : 1;
  const out = fadeOut ? 1 - ramp(frame, length - fadeOut, length) : 1;
  return <AbsoluteFill style={{ opacity: Math.min(inn, out) }}>{children}</AbsoluteFill>;
}

/** A line of the verse, on screen between two seconds. */
export function Line({ from, to, text, at }: { from: number; to: number; text: string; at?: { x: number; y: number } }) {
  return (
    <Sequence from={s(from)} durationInFrames={s(to - from)}>
      <Subtitle text={text} at={at} />
    </Sequence>
  );
}

/**
 * A sound from public/audio (the score, or tools/foley.ts's sfx/), placed at
 * `at` and played for its length or until `to`, faded where the picture fades.
 */
export function Sound({
  file,
  at,
  to,
  volume = 1,
  fadeIn = 0,
  fadeOut = 0,
}: {
  file: string;
  at: number;
  to?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}) {
  const length = to === undefined ? undefined : s(to - at);
  return (
    <Sequence from={s(at)} durationInFrames={length}>
      <Audio
        src={staticFile(`audio/${file}`)}
        volume={(frame) =>
          volume *
          Math.min(fadeIn ? Math.min(1, frame / s(fadeIn)) : 1, length && fadeOut ? Math.min(1, (length - frame) / s(fadeOut)) : 1)
        }
      />
    </Sequence>
  );
}

/** The film opens out of black. */
export function FadeFromBlack() {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: "#000", opacity: 1 - ramp(frame, s(0.2), s(2.0)) }} />;
}
