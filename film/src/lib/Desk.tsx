import { Img, staticFile, useCurrentFrame } from "remotion";
import { exposure, s } from "./time.ts";

/* Nora's desk. Its plates (plate-look, plate-up, the key frames and the
   takes generated between them) share one geometry, so what is placed on the
   desk is placed once here. */

/** The lamp's bulb, where its warm light breathes. */
export const lamp = { x: 18, y: 47 };

/** Nora looks up: a replacement head, so the next plate simply takes over at one exposure. */
export function LookUp({ at }: { at: number }) {
  const frame = useCurrentFrame();
  if (exposure(frame) < exposure(s(at))) return null;
  return <Img src={staticFile("stills/plate-up.jpg")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}
