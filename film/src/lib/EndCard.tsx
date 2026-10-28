import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import lockup from "../../brand/lockup.json";
import { palette } from "../palette.gen.ts";
import { useSpeech } from "./Language.tsx";
import { FPS, ramp, s } from "./time.ts";

/**
 * The last beats, in two parts. First the product, the way the website
 * opens: its icon, its name and what it is, on the app's paper. Then, from
 * `makerAt`, the maker: the Aha Labs lockup in its celadon colourway, its
 * ring turning forward by one "ah" as it arrives and then drifting, as the
 * brand's own page moves it.
 */
export function EndCard({ makerAt }: { makerAt: number }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { product, sans } = useSpeech();
  const tall = height > width;
  const icon = ramp(frame, 0, s(0.9));
  const name = ramp(frame, s(0.35), s(1.2));
  const line = ramp(frame, s(0.7), s(1.6));
  const size = tall ? 260 : 210;
  return (
    <AbsoluteFill style={{ background: palette.surface, fontFamily: sans }}>
      <AbsoluteFill style={{ background: `radial-gradient(60% 55% at 50% 50%, ${palette.card}, transparent 72%)` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", paddingBottom: tall ? 60 : 30 }}>
        <Img
          src={staticFile("mochi/MochiAppIcon.png")}
          style={{
            width: size,
            height: size,
            opacity: icon,
            transform: `translateY(${(1 - icon) * 16}px) scale(${0.94 + 0.06 * icon})`,
          }}
        />
        <p
          style={{
            margin: tall ? "56px 0 0" : "44px 0 0",
            fontFamily: 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif',
            fontSize: tall ? 104 : 88,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: palette.ink,
            opacity: name,
            transform: `translateY(${(1 - name) * 14}px)`,
          }}
        >
          {product.name}
        </p>
        <p style={{ margin: "14px 0 0", fontSize: tall ? 40 : 34, color: palette.muted, letterSpacing: "0.06em", opacity: line }}>
          {product.line}
        </p>
      </AbsoluteFill>
      <Maker at={makerAt} width={tall ? 660 : 640} />
    </AbsoluteFill>
  );
}

/* The brand page's spring for a turn of the ring (stiffness 120, damping 14),
   and its drift: a full turn every 40 seconds. */
const TURN = { stiffness: 120, damping: 14, mass: 1 };
const DRIFT = 360 / 40;

/**
 * The Aha Labs lockup, `width` pixels wide, arriving at `at`. Its background
 * opens as a solid circle from the centre and covers the product cleanly;
 * the lockup arrives inside it.
 */
function Maker({ at, width }: { at: number; width: number }) {
  const frame = useCurrentFrame() - at;
  const { width: frameWidth, height: frameHeight } = useVideoConfig();
  if (frame < 0) return null;
  const field = ramp(frame, 0, s(0.6)) * Math.hypot(frameWidth, frameHeight) / 2;
  const shown = ramp(frame, s(0.3), s(0.85));
  const k = width / lockup.width;
  const turn = -90 + 90 * spring({ frame: frame - s(0.3), fps: FPS, config: TURN }) + (DRIFT * frame) / FPS;
  const place = (part: { x: number; y: number; width: number; height: number }) => ({
    position: "absolute" as const,
    left: part.x * k,
    top: part.y * k,
    width: part.width * k,
    height: part.height * k,
  });
  return (
    <AbsoluteFill style={{ background: lockup.background, clipPath: `circle(${field}px at 50% 50%)`, alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width, height: lockup.height * k, opacity: shown }}>
        <Img src={staticFile("brand/ring.svg")} style={{ ...place(lockup.ring), transform: `rotate(${turn}deg)` }} />
        <Img src={staticFile("brand/wordmark.svg")} style={place(lockup.wordmark)} />
      </div>
    </AbsoluteFill>
  );
}
