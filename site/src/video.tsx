import type { Ref, SyntheticEvent } from "react";
import { cn } from "../../controlApp/src/ui/styles.ts";
import awawaMov from "./media/awawa.mov?url";
import awawaWebm from "./media/awawa.webm?url";
import entranceMov from "./media/entrance.mov?url";
import entranceWebm from "./media/entrance.webm?url";
import petMov from "./media/pet.mov?url";
import petWebm from "./media/pet.webm?url";
import wakeMov from "./media/wake.mov?url";
import wakeWebm from "./media/wake.webm?url";

/** Browser encodings of the clips `src/motion.ts` names. */
export const videos = {
  entrance: { mov: entranceMov, webm: entranceWebm },
  pet: { mov: petMov, webm: petWebm },
  wake: { mov: wakeMov, webm: wakeWebm },
  awawa: { mov: awawaMov, webm: awawaWebm },
};

/** A transparent clip: Safari alone takes HEVC with alpha; others take VP9. */
export function Clip({
  name,
  ref,
  preload = "auto",
  className,
  onPlaying,
  onEnded,
}: {
  name: keyof typeof videos;
  ref: Ref<HTMLVideoElement>;
  preload?: "auto" | "none";
  className?: string;
  onPlaying?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onEnded?: (event: SyntheticEvent<HTMLVideoElement>) => void;
}) {
  return (
    <video
      ref={ref}
      muted
      playsInline
      preload={preload}
      disablePictureInPicture
      aria-hidden
      tabIndex={-1}
      onPlaying={onPlaying}
      onEnded={onEnded}
      className={cn("pointer-events-none", className)}
    >
      <source src={videos[name].mov} type='video/quicktime; codecs="hvc1"' />
      <source src={videos[name].webm} type="video/webm" />
    </video>
  );
}

export const prefersStillness = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;
