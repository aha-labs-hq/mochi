import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { anchoredFrame, type WindowHandoff } from "../shared/windowHandoff.ts";
import type { Connection } from "./connection.ts";

/** Animate the content on a fixed transparent stage; native resizing happens
 * only after paint receipts. The character component never unmounts. */
export function PresentationViewport({
  handoff,
  fullscreen,
  connection,
  failed,
  children,
}: {
  handoff: WindowHandoff | null;
  fullscreen: boolean;
  connection: Connection;
  failed(): void;
  children: ReactNode;
}) {
  const left = useMotionValue(0),
    top = useMotionValue(0);
  const width = useMotionValue(0),
    height = useMotionValue(0);
  const reduced = useReducedMotion();
  const backdrop = useMotionValue(0);
  const [animating, setAnimating] = useState(false);
  const latest = useRef({ handoff, failed });
  latest.current = { handoff, failed };
  const id = handoff?.id,
    step = handoff?.step;
  useLayoutEffect(() => {
    const current = latest.current.handoff;
    const fade = () =>
      animate(backdrop, fullscreen ? 1 : 0, {
        duration: reduced ? 0 : fullscreen ? 0.72 : 0.6,
        ease: [0.4, 0, 0.2, 1],
      });
    if (!current || id === undefined || step === undefined) {
      setAnimating(false);
      const animation = fade();
      return () => animation.stop();
    }
    let alive = true,
      first = 0,
      second = 0;
    const receipt = () => {
      // Two frames put the committed CSS through layout and paint before the
      // host moves the NSWindow. This is not an animation-duration timeout.
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          if (alive)
            void connection.presentationPainted({ id, step }).catch(() => {
              if (alive) latest.current.failed();
            });
        });
      });
    };
    const controls: Array<{ stop(): void }> = [];
    if (step === "animate") {
      left.set(current.source.x);
      top.set(current.source.y);
      width.set(current.source.width);
      height.set(current.source.height);
      setAnimating(true);
      const options = {
        duration: reduced ? 0 : 0.92,
        ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
      };
      const animations = [
        animate(left, current.target.x, options),
        animate(top, current.target.y, options),
        animate(width, current.target.width, options),
        animate(height, current.target.height, options),
        // The desktop stays full-size while content contracts. Do not let the
        // host shrink the native window until the dimmer has painted clear.
        fade(),
      ];
      controls.push(...animations);
      void Promise.all(animations).then(() => {
        if (alive) receipt();
      });
    } else {
      setAnimating(false);
      if (step === "land") backdrop.set(fullscreen ? 1 : 0);
      receipt();
    }
    return () => {
      alive = false;
      for (const control of controls) control.stop();
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [
    id,
    step,
    fullscreen,
    connection,
    reduced,
    left,
    top,
    width,
    height,
    backdrop,
  ]);
  const moving = handoff?.step === "animate" && animating;
  return (
    <>
      <motion.div
        aria-hidden="true"
        data-testid="fullscreen-backdrop"
        className="pointer-events-none absolute inset-0 bg-scrim/38"
        style={{ opacity: backdrop }}
      />
      <motion.div
        data-testid="presentation-viewport"
        data-handoff={handoff?.step}
        className="absolute isolate overflow-hidden [container-type:size] [container-name:presentation]"
        style={
          handoff
            ? moving
              ? { left, top, width, height }
              : anchoredFrame(handoff, handoff.step === "land")
            : { left: 0, top: 0, width: "100%", height: "100%" }
        }
      >
        {children}
      </motion.div>
    </>
  );
}
