/** Pure policy vocabulary shared by the Bridge, worker and desktop. No filesystem authority. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
/**
 * Mochi's one default: the first-run template (config/bot.toml) starts new Bots
 * here and the model catalog offers it when a model supports it. High rather
 * than max keeps group replies prompt; a Bot can still choose more.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";
export interface RuntimePolicy {
  model: string;
  reasoningEffort: ReasoningEffort;
}
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}
