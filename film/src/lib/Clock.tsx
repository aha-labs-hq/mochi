import { useCurrentFrame } from "remotion";
import { usePlate } from "./Shot.tsx";
import { exposure, FPS } from "./time.ts";

/**
 * Felt hands on the felt clock face, 23:40 and counting: two wool leaves and
 * a red thread for the seconds, pinned by a felt bead. The thread jumps once
 * a second and settles with a small stop-motion recoil; the fibres boil at
 * every exposure like the rest of the set.
 */
export function ClockHands({ x, y, radius, from = 23 * 3600 + 40 * 60 + 12 }: { x: number; y: number; radius: number; from?: number }) {
  const frame = useCurrentFrame();
  const plate = usePlate();
  const r = (radius / 100) * plate.width;
  const elapsed = frame / FPS;
  const whole = Math.floor(elapsed);
  const within = elapsed - whole;
  const recoil = within < 0.12 ? Math.sin((within / 0.12) * Math.PI) * 1.6 : 0;
  const seconds = from + whole;
  const seed = exposure(frame) % 53;
  const angle = (unit: number, value: number) => ((value % unit) / unit) * 360;
  // A leaf: round at the pin, swelling, then tapering to a soft tip.
  const leaf = (length: number, width: number) => {
    const w = width / 2;
    const tail = length * 0.16;
    return `M 0 ${tail} C ${w * 1.1} ${tail}, ${w * 1.2} ${-length * 0.35}, 0 ${-length} C ${-w * 1.2} ${-length * 0.35}, ${-w * 1.1} ${tail}, 0 ${tail} Z`;
  };
  return (
    <svg
      width={r * 2.4}
      height={r * 2.4}
      viewBox={`${-r * 1.2} ${-r * 1.2} ${r * 2.4} ${r * 2.4}`}
      style={{ position: "absolute", left: (x / 100) * plate.width - r * 1.2, top: (y / 100) * plate.height - r * 1.2, overflow: "visible" }}
    >
      <defs>
        <filter id="wool" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency={0.5} numOctaves={2} seed={seed} result="fibres" />
          <feDisplacementMap in="SourceGraphic" in2="fibres" scale={r * 0.022} xChannelSelector="R" yChannelSelector="G" result="fuzz" />
          <feTurbulence type="fractalNoise" baseFrequency={1.1} numOctaves={3} seed={seed + 11} />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer result="grain">
            <feFuncR type="linear" slope={0.6} intercept={0.2} />
            <feFuncG type="linear" slope={0.6} intercept={0.2} />
            <feFuncB type="linear" slope={0.6} intercept={0.2} />
            <feFuncA type="linear" slope={0} intercept={1} />
          </feComponentTransfer>
          <feBlend in="fuzz" in2="grain" mode="overlay" />
          <feComposite in2="fuzz" operator="in" result="wool" />
          {/* The hands stand off the face; the lamp throws their shadow down and right. */}
          <feGaussianBlur in="fuzz" stdDeviation={r * 0.018} />
          <feOffset dx={r * 0.03} dy={r * 0.04} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.03  0 0 0 0 0.04  0 0 0 0 0.08  0 0 0 0.55 0" result="shadow" />
          <feMerge>
            <feMergeNode in="shadow" />
            <feMergeNode in="wool" />
          </feMerge>
        </filter>
        <radialGradient id="bead" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#5a5f6e" />
          <stop offset="100%" stopColor="#1d2029" />
        </radialGradient>
      </defs>
      <g filter="url(#wool)">
        <path d={leaf(r * 0.5, r * 0.15)} fill="#2a2d37" transform={`rotate(${angle(43200, seconds)})`} />
        <path d={leaf(r * 0.8, r * 0.11)} fill="#2f323d" transform={`rotate(${angle(3600, seconds)})`} />
        <g transform={`rotate(${angle(60, seconds) + recoil})`}>
          <path d={`M 0 ${r * 0.18} Q ${r * 0.012} ${-r * 0.35}, 0 ${-r * 0.86}`} stroke="#b4433a" strokeWidth={r * 0.022} strokeLinecap="round" fill="none" />
        </g>
        <circle r={r * 0.07} fill="url(#bead)" />
      </g>
    </svg>
  );
}
