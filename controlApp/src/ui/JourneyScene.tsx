import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useLayoutEffect, useRef } from "react";

/** A new task resets reading and focus without remounting its connection form. */
export function JourneyScene({
  id,
  focusKey,
  children,
}: {
  id: string;
  focusKey: string;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: A task change intentionally resets reading without remounting the form or discarding drafts.
  useLayoutEffect(() => {
    // Each task starts at its heading, even after a long previous task was scrolled.
    const scroll = element.current?.closest<HTMLElement>(
      "[data-journey-scroll]",
    );
    if (scroll) scroll.scrollTop = 0;
    if (!document.querySelector('[role="dialog"]'))
      element.current?.querySelector("h1")?.focus({ preventScroll: true });
  }, [focusKey]);
  return (
    <motion.div
      data-chapter={id}
      ref={element}
      initial={{ opacity: 0, y: reduced ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.2 }}
    >
      {children}
    </motion.div>
  );
}
