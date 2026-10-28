import { type CSSProperties, createContext, type ReactNode, useContext } from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { clips } from "../clips.gen.ts";
import { dolly, exposure, noise, ramp } from "./time.ts";

/** The plate's size in pixels, for anything placed in plate space. */
const Plate = createContext<{ width: number; height: number } | null>(null);
export function usePlate() {
  const plate = useContext(Plate);
  if (!plate) throw new Error("usePlate belongs inside a Shot");
  return plate;
}

/** Where the camera looks: scale, and the point of the plate kept centred. */
export type Frame = { scale: number; x: number; y: number };

/**
 * A generated take as a moving plate: its name in clips.json, and the frame
 * of the shot it starts on. It holds its first exposure before that and its
 * last after it ends. `first` skips opening exposures: a take opens on its
 * key frame, and one that regrades on the next exposure would flicker there.
 */
export type Clip = { name: keyof typeof clips; at?: number; first?: number };

function clipExposure({ name, at = 0, first = 0 }: Clip, frame: number) {
  const index = Math.min(clips[name].exposures - 1, Math.max(first, exposure(frame - at)));
  return staticFile(`clips/${name}/${String(index).padStart(3, "0")}.jpg`);
}

/**
 * One plate of the felt world, filmed: a still, or a generated take played
 * at twelve exposures a second. The camera eases between two framings over
 * the shot; the plate itself breathes a little at each exposure, the way a
 * handmade set never sits perfectly still. Children are drawn in plate space
 * (percentages of the plate) and move with it.
 */
export function Shot({
  still,
  clip,
  from,
  to,
  breathe = true,
  grade,
  children,
}: {
  still?: string;
  clip?: Clip;
  from: Frame;
  to: Frame;
  breathe?: boolean;
  /** A CSS filter for the whole plate, for day, night and memory. */
  grade?: string;
  children?: ReactNode;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  if (!still === !clip) throw new Error("a Shot films exactly one still or one clip");
  const p = ramp(frame, 0, durationInFrames, dolly);
  const scale = from.scale + (to.scale - from.scale) * p;
  const cx = from.x + (to.x - from.x) * p;
  const cy = from.y + (to.y - from.y) * p;
  const step = exposure(frame);
  const jitter = breathe
    ? `translate(${noise(step, 1) * 0.6}px, ${noise(step, 2) * 0.6}px) rotate(${noise(step, 3) * 0.04}deg)`
    : "";
  // The plate covers the frame, then the camera frames its point. Stills are
  // 16:9; a take keeps its own shape.
  const aspect = clip ? clips[clip.name].width / clips[clip.name].height : 16 / 9;
  const plateH = Math.max(height, width / aspect);
  const plateW = plateH * aspect;
  // Never let a framing reveal the edge of the set.
  const clamp = (value: number, size: number, frameSize: number) =>
    Math.min(0, Math.max(frameSize - size * scale, value));
  const style: CSSProperties = {
    position: "absolute",
    width: plateW,
    height: plateH,
    left: clamp(width / 2 - plateW * (cx / 100) * scale, plateW, width),
    top: clamp(height / 2 - plateH * (cy / 100) * scale, plateH, height),
    transformOrigin: "0 0",
    transform: `scale(${scale}) ${jitter}`,
    filter: grade,
  };
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#0b0d12" }}>
      <div style={style}>
        <Img
          src={clip ? clipExposure(clip, frame) : staticFile(`stills/${still}.jpg`)}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
        <Plate.Provider value={{ width: plateW, height: plateH }}>{children}</Plate.Provider>
      </div>
    </AbsoluteFill>
  );
}

/** A point in plate space, for overlays placed inside a Shot. */
export function At({
  x,
  y,
  children,
  style,
}: {
  x: number;
  y: number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ position: "absolute", left: `${x}%`, top: `${y}%`, ...style }}>{children}</div>
  );
}
