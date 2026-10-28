import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { useSpeech } from "./Language.tsx";
import { ramp, s } from "./time.ts";

/**
 * A line of the film's quiet verse. Set in the language's book face (Songti
 * for Chinese) like a printed caption, it arrives by fading up through a soft
 * blur and leaves the same way. It sits at the foot of the frame, wrapping
 * into balanced lines if it is long, unless a shot gives it a place of its
 * own, `at`, the point (in frame percentages) its line is centred on.
 */
export function Subtitle({ text, size, at }: { text: string; size?: number; at?: { x: number; y: number } }) {
  const frame = useCurrentFrame();
  const { durationInFrames, height, width } = useVideoConfig();
  const { serif, tracking } = useSpeech();
  const tall = height > width;
  const inn = ramp(frame, 0, s(0.9));
  const out = 1 - ramp(frame, durationInFrames - s(0.8), durationInFrames);
  const shown = Math.min(inn, out);
  return (
    <AbsoluteFill
      style={
        at
          ? { pointerEvents: "none" }
          : { justifyContent: "flex-end", alignItems: "center", paddingBottom: tall ? 340 : 108, pointerEvents: "none" }
      }
    >
      <p
        style={{
          ...(at
            ? { position: "absolute", left: `${at.x}%`, top: `${at.y}%`, translate: "-50% -50%", whiteSpace: "nowrap" }
            : { maxWidth: "84%", textAlign: "center", textWrap: "balance" }),
          margin: 0,
          fontFamily: serif,
          fontWeight: 500,
          fontSize: size ?? (tall ? 54 : 40),
          letterSpacing: tracking,
          // Tracking trails the last glyph; the same indent keeps the line centred.
          paddingLeft: tracking,
          color: "#f6f1e7",
          opacity: shown,
          filter: `blur(${(1 - shown) * 6}px)`,
          transform: `translateY(${(1 - inn) * 8}px)`,
          textShadow: "0 1px 18px rgba(0,0,0,.55), 0 0 2px rgba(0,0,0,.35)",
        }}
      >
        {text}
      </p>
    </AbsoluteFill>
  );
}
