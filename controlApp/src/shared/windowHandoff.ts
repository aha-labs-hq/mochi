import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WindowPlan {
  source: WindowRect;
  target: WindowRect;
  stage: WindowRect;
}
export type HandoffStep = "stage" | "animate" | "land";
/** Rectangles are relative to one transparent stage, not desktop coordinates. */
export interface WindowHandoff {
  id: number;
  step: HandoffStep;
  source: WindowRect;
  target: WindowRect;
  width: number;
  height: number;
}
const schema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    step: Type.Enum(["stage", "animate", "land"]),
  },
  { additionalProperties: false },
);
export type HandoffReceipt = Static<typeof schema>;
const validator = Compile(schema);
export function parseHandoffReceipt(value: unknown): HandoffReceipt {
  if (!validator.Check(value))
    throw new Error("Invalid window handoff receipt");
  return value;
}

/** AppKit uses bottom-left coordinates; CSS uses top-left. Geometry never crosses
 * the renderer boundary until translated into this local stage. */
export function planWindow(source: WindowRect, target: WindowRect): WindowPlan {
  for (const r of [source, target]) {
    if (
      ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.width <= 0 ||
      r.height <= 0
    )
      throw new Error("Invalid native window geometry");
  }
  const x = Math.min(source.x, target.x),
    y = Math.min(source.y, target.y);
  return {
    source,
    target,
    stage: {
      x,
      y,
      width: Math.max(source.x + source.width, target.x + target.width) - x,
      height: Math.max(source.y + source.height, target.y + target.height) - y,
    },
  };
}
export function localHandoff(
  plan: WindowPlan,
  id: number,
  step: HandoffStep,
): WindowHandoff {
  const local = (r: WindowRect): WindowRect => ({
    ...r,
    x: r.x - plan.stage.x,
    y: plan.stage.y + plan.stage.height - r.y - r.height,
  });
  return {
    id,
    step,
    source: local(plan.source),
    target: local(plan.target),
    width: plan.stage.width,
    height: plan.stage.height,
  };
}

/** A responsive freeze keeps a fixed-sized scene at the same physical desktop
 * position when the transparent native stage expands or contracts instantly. */
export function anchoredFrame(handoff: WindowHandoff, end: boolean) {
  const r = end ? handoff.target : handoff.source;
  const x = handoff.width === r.width ? 0 : r.x / (handoff.width - r.width);
  const y = handoff.height === r.height ? 0 : r.y / (handoff.height - r.height);
  return {
    width: r.width,
    height: r.height,
    left: `calc((100vw - ${r.width}px) * ${x})`,
    top: `calc((100vh - ${r.height}px) * ${y})`,
  };
}
