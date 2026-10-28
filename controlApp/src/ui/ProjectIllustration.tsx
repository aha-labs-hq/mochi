import { motion, useReducedMotion } from "motion/react";
import folio from "./assets/introduction/welcome/project-folio.webp";
import { Glyph } from "./Glyph.tsx";
import { participants } from "./introductionContent.ts";

/** A shared project pictured as one open folio; no live state or extra controls. */
export function ProjectIllustration({ active }: { active: boolean }) {
  const still = useReducedMotion();
  const visible = active || still;
  const transition = {
    duration: still ? 0 : 0.85,
    ease: [0.22, 1, 0.36, 1] as const,
  };
  // Disjoint height bands keep the medium rule from overriding short windows.
  return (
    <div
      aria-hidden
      data-testid="project-illustration"
      className="@container/project pointer-events-none relative mx-auto my-5 aspect-[480/172] select-none @max-[440px]/presentation:my-4 [@media(600px<height<=720px)]:w-[72%] [@media(max-height:600px)]:my-1 [@media(max-height:600px)]:w-[64%]"
    >
      <svg
        aria-hidden
        viewBox="0 0 480 172"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible fill-none"
      >
        <motion.path
          d="M 56 52 C 82 48 104 68 138 67 M 92 141 C 126 141 107 103 147 112 M 348 62 C 388 62 369 34 431 34 M 359 108 C 395 113 383 140 433 144"
          className="stroke-action/25"
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: still ? 1 : 0 }}
          animate={{ pathLength: visible ? 1 : 0 }}
          transition={{ ...transition, delay: still ? 0 : 0.12 }}
        />
      </svg>
      <motion.div
        className="absolute top-[17%] left-[7%] w-[8.333%] min-w-7"
        initial={still ? false : { x: -12, rotate: -12, opacity: 0 }}
        animate={{ x: visible ? 0 : -12, rotate: -7, opacity: visible ? 1 : 0 }}
        transition={transition}
      >
        <img
          src={participants.jules.avatar}
          alt=""
          className="block aspect-square w-full rounded-[28%] shadow-control"
        />
        <span className="absolute -top-[30%] -right-[50%] flex h-[clamp(18px,5cqw,24px)] w-[clamp(24px,6.667cqw,32px)] items-center justify-center gap-0.5 rounded-[7px_7px_7px_2px] border border-hairline bg-card text-muted">
          <i className="size-0.5 rounded-full bg-current" />
          <i className="size-0.5 rounded-full bg-current" />
          <i className="size-0.5 rounded-full bg-current" />
        </span>
      </motion.div>
      <motion.img
        src={participants.theo.avatar}
        alt=""
        className="absolute bottom-[7%] left-[15%] aspect-square w-[7.5%] min-w-6 rounded-[24%] shadow-control"
        initial={still ? false : { x: -8, rotate: 12, opacity: 0 }}
        animate={{ x: visible ? 0 : -8, rotate: 6, opacity: visible ? 1 : 0 }}
        transition={transition}
      />
      <motion.img
        src={participants.nora.avatar}
        alt=""
        className="absolute top-[7%] right-[7%] aspect-square w-[7.5%] min-w-6 rounded-[24%] shadow-control"
        initial={still ? false : { x: 10, rotate: 14, opacity: 0 }}
        animate={{ x: visible ? 0 : 10, rotate: 8, opacity: visible ? 1 : 0 }}
        transition={transition}
      />
      <motion.div
        className="absolute right-[6%] bottom-[4%] w-[8.333%] min-w-7"
        initial={still ? false : { x: 12, rotate: -10, opacity: 0 }}
        animate={{ x: visible ? 0 : 12, rotate: -5, opacity: visible ? 1 : 0 }}
        transition={transition}
      >
        <img
          src={participants.evan.avatar}
          alt=""
          className="block aspect-square w-full rounded-[28%] shadow-control"
        />
        <span className="absolute -top-[35%] -left-[45%] flex size-[clamp(18px,5cqw,24px)] items-center justify-center rounded-md border border-hairline bg-card text-action">
          <Glyph name="pullRequest" className="size-[55%]" />
        </span>
      </motion.div>
      <motion.div
        className="absolute top-[3%] left-[23%] aspect-[768/462] w-[56%]"
        initial={still ? false : { y: 8, opacity: 0 }}
        animate={{ y: visible ? 0 : 8, opacity: visible ? 1 : 0 }}
        transition={transition}
      >
        <img
          src={folio}
          alt=""
          width={768}
          height={462}
          className="block size-full"
        />
        <span className="absolute -top-[10%] right-[8%] flex -rotate-6 items-center gap-[0.35em] rounded-md border border-hairline bg-card px-[0.6em] py-[0.2em] text-[clamp(9px,2.083cqw,10px)] leading-[1.4] text-muted shadow-control">
          <Glyph name="folder" className="size-[1.2em]" />
          GitHub
        </span>
      </motion.div>
    </div>
  );
}
