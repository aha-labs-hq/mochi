import { motion } from "motion/react";

/** One quiet reading surface, with complete paws resting on its unframed edge. */
export function FeltSurface() {
  return (
    <motion.div
      data-testid="felt-frame"
      aria-hidden
      layout
      initial={false}
      transition={{ layout: { duration: 0.92, ease: [0.22, 1, 0.36, 1] } }}
      className="pointer-events-none absolute top-(--felt-top) left-[calc(50%-var(--felt-width)/2)] z-0 h-(--felt-height) w-(--felt-width) translate-y-[calc((1-var(--frame-reveal,1))*28px)] overflow-hidden rounded-2xl bg-surface opacity-(--frame-reveal) shadow-surface"
    />
  );
}
