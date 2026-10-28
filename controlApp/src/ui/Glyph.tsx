import type { ReactNode } from "react";
import { cn } from "./styles.ts";

/*
 * Mochi's own control glyphs. They are drawn on one 20-unit grid with round
 * terminals and softened apexes, so arrows and chevrons read as the same hand
 * as the felt identity icons without imitating their material. Glyphs only
 * accompany text or an accessible name; they never carry state alone.
 */
const chevron = <path d="M8 5.25 11.9 9.3q.7.7 0 1.4L8 14.75" />;
const arrow = (
  <>
    <path d="M4.25 10h11" />
    <path d="M10.75 5.25 14.8 9.3q.7.7 0 1.4l-4.05 4.05" />
  </>
);
const rotate = (degrees: number, glyph: ReactNode) => (
  <g transform={`rotate(${degrees} 10 10)`}>{glyph}</g>
);

const glyphs = {
  chevronRight: chevron,
  chevronLeft: rotate(180, chevron),
  chevronDown: rotate(90, chevron),
  chevronUp: rotate(-90, chevron),
  arrowRight: arrow,
  arrowLeft: rotate(180, arrow),
  arrowDown: rotate(90, arrow),
  external: (
    <>
      <path d="M6.25 13.75 13.5 6.5" />
      <path d="M8 6h4.75q1.25 0 1.25 1.25V12" />
    </>
  ),
  plus: <path d="M10 4.25v11.5M4.25 10h11.5" />,
  check: <path d="m4.75 10.4 3.4 3.35q.45.45.9-.05l6.2-7.2" />,
  close: <path d="m5.5 5.5 9 9m0-9-9 9" />,
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="4.75" cy="10" r="1.35" />
      <circle cx="10" cy="10" r="1.35" />
      <circle cx="15.25" cy="10" r="1.35" />
    </g>
  ),
  undo: (
    <>
      <path d="M7.25 4.75 4.5 7.5l2.75 2.75" />
      <path d="M4.75 7.5h7a3.75 3.75 0 0 1 0 7.5H9" />
    </>
  ),
  search: (
    <>
      <circle cx="8.75" cy="8.75" r="4.75" />
      <path d="m12.4 12.4 3.35 3.35" />
    </>
  ),
  spinner: <path d="M10 3.5a6.5 6.5 0 1 1-6.5 6.5" />,
  mail: (
    <>
      <rect x="3" y="4.75" width="14" height="10.5" rx="2.5" />
      <path d="m3.75 6.75 5.4 3.85q.85.6 1.7 0l5.4-3.85" />
    </>
  ),
  document: (
    <>
      <path d="M11 3.5H6.75Q5 3.5 5 5.25v9.5q0 1.75 1.75 1.75h6.5Q15 16.5 15 14.75V7.5z" />
      <path d="M11 3.75V6.5q0 1 1 1h2.75M7.75 11h4.5m-4.5 2.5h3" />
    </>
  ),
  book: (
    <>
      <path d="M10 5.75Q7.6 4.1 3.75 4.5v10.25q3.85-.3 6.25 1.5 2.4-1.8 6.25-1.5V4.5Q12.4 4.1 10 5.75" />
      <path d="M10 5.75v10.5" />
    </>
  ),
  folder: (
    <path d="M3.5 6.25q0-1.5 1.5-1.5h2.6q.6 0 1 .45l1.15 1.3h5.25q1.5 0 1.5 1.5v6.75q0 1.5-1.5 1.5H5q-1.5 0-1.5-1.5z" />
  ),
  people: (
    <>
      <circle cx="8" cy="7.25" r="2.75" />
      <path d="M3.25 16q.4-4.25 4.75-4.25T12.75 16" />
      <path d="M12.75 4.75a2.6 2.6 0 0 1 0 5M14.5 12q2 .9 2.25 4" />
    </>
  ),
  pullRequest: (
    <>
      <circle cx="6" cy="5.5" r="1.75" />
      <circle cx="6" cy="14.5" r="1.75" />
      <circle cx="14" cy="14.5" r="1.75" />
      <path d="M6 7.25v5.5m8 0V9.25q0-2.75-2.75-2.75H9.5" />
      <path d="M11 5 9.5 6.5 11 8" />
    </>
  ),
  gear: (
    <>
      <path d="M8.6 3.4q1.4-.55 2.8 0l.35 1.75 1.5.85 1.7-.55q1 1.1 1.4 2.45l-1.35 1.2v1.8l1.35 1.2q-.4 1.35-1.4 2.45l-1.7-.55-1.5.85-.35 1.75q-1.4.55-2.8 0l-.35-1.75-1.5-.85-1.7.55q-1-1.1-1.4-2.45l1.35-1.2v-1.8L3.65 7.9q.4-1.35 1.4-2.45l1.7.55 1.5-.85z" />
      <circle cx="10" cy="10" r="2.25" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M10 9.25v4" />
      <circle cx="10" cy="6.6" r=".4" fill="currentColor" />
    </>
  ),
  sparkle: (
    <path d="M10 3.25q.6 6.15 6.75 6.75-6.15.6-6.75 6.75-.6-6.15-6.75-6.75 6.15-.6 6.75-6.75" />
  ),
} satisfies Record<string, ReactNode>;

export type GlyphName = keyof typeof glyphs;

/**
 * Optical weight: smaller glyphs keep a slightly heavier stroke so a 12 px
 * chevron and a 20 px envelope sit beside 12–14 px text with the same colour.
 */
function strokeFor(size: number) {
  return ((0.85 + size * 0.03) * 20) / size;
}

export function Glyph({
  name,
  size,
  className,
  spin = false,
}: {
  name: GlyphName;
  /** Rendered size in points; omit it when the parent sizes the glyph. */
  size?: number;
  className?: string;
  spin?: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={size ? strokeFor(size) : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "shrink-0",
        spin && "animate-spin motion-reduce:animate-none",
        className,
      )}
    >
      {glyphs[name]}
    </svg>
  );
}
