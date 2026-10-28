import { useEffect, useRef, useState } from "react";
import { art } from "../media.ts";
import { cn, Picture } from "../ui.tsx";
import { Clip, prefersStillness } from "../video.tsx";

/**
 * Mochi naps at the end of the page and wakes when the reader arrives:
 * the companion's own sleep transition, played backwards, as the app does
 * when it leaves that state. Without motion it simply keeps napping.
 */
export function WakingMochi() {
  const frame = useRef<HTMLDivElement>(null);
  const wake = useRef<HTMLVideoElement>(null);
  const [motion, setMotion] = useState(false);
  const [awake, setAwake] = useState(false);

  useEffect(() => {
    if (!prefersStillness()) setMotion(true);
  }, []);

  useEffect(() => {
    if (!motion) return;
    const node = wake.current!;
    // Fetch the clip as the reader approaches; wake once Mochi is fully seen.
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        near.disconnect();
        node.preload = "auto";
        node.load();
      },
      { rootMargin: "800px 0px" },
    );
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        seen.disconnect();
        window.setTimeout(() => void node.play().catch(() => {}), 600);
      },
      { threshold: 0.9 },
    );
    near.observe(frame.current!);
    seen.observe(frame.current!);
    return () => {
      near.disconnect();
      seen.disconnect();
    };
  }, [motion]);

  return (
    <div ref={frame} className="relative">
      <Picture
        picture={art.sleeping}
        alt="趴着打盹的麻薯"
        sizes="240px"
        className={cn("h-auto w-full", awake && "invisible")}
      />
      {motion && (
        <Clip
          name="wake"
          ref={wake}
          preload="none"
          onPlaying={() => setAwake(true)}
          className={cn(
            "absolute inset-0 h-auto w-full",
            !awake && "opacity-0",
          )}
        />
      )}
    </div>
  );
}
