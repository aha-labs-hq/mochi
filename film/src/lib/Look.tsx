import { AbsoluteFill, useCurrentFrame } from "remotion";
import { usePlate } from "./Shot.tsx";
import { exposure, noise } from "./time.ts";

/** The plate grades: night, the remembered day, and a plate behind a card. */
export const grade = {
  night: "saturate(0.92) contrast(1.04)",
  memory: "saturate(0.8) sepia(0.12) brightness(1.04) contrast(0.96)",
  behindCard: (under = "") => `blur(28px) brightness(0.4) saturate(0.85) ${under}`,
};

/**
 * The film's lens: a soft vignette and a fine grain that changes with each
 * stop-motion exposure, never every frame, so it reads as film rather than
 * television noise.
 */
export function Look({ grain = 0.07, vignette = 0.42 }: { grain?: number; vignette?: number }) {
  const frame = useCurrentFrame();
  const seed = exposure(frame) % 97;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 95% at 50% 46%, transparent 52%, rgba(6,8,14,${vignette}) 100%)`,
        }}
      />
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, opacity: grain, mixBlendMode: "overlay" }}>
        <filter id={`grain-${seed}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={seed} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#grain-${seed})`} />
      </svg>
    </AbsoluteFill>
  );
}

/**
 * A warm or cool light that lives in the set: a lamp, a window, a screen.
 * `size` is its diameter on a plate 1920 pixels wide; it scales with the plate.
 */
export function Glow({
  colour,
  size: base,
  strength,
}: {
  colour: string;
  size: number;
  strength: number;
}) {
  const size = (base * usePlate().width) / 1920;
  return (
    <div
      style={{
        position: "absolute",
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${colour} 0%, transparent 68%)`,
        opacity: strength,
        mixBlendMode: "screen",
      }}
    />
  );
}

/** A light that flickers a little at each exposure, like a real bulb on a set. */
export function Breathing({ colour, size, strength }: { colour: string; size: number; strength: number }) {
  const frame = useCurrentFrame();
  const flicker = 1 + noise(exposure(frame), 9) * 0.06;
  return <Glow colour={colour} size={size} strength={strength * flicker} />;
}
