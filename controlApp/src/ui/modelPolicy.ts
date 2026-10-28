import type { RuntimeModelOption } from "../../../src/runtime/protocol.ts";

export function chooseModel(
  model: RuntimeModelOption,
  effort: string,
): { model: string; reasoningEffort: string } {
  return {
    model: model.id,
    reasoningEffort: model.supportedEfforts.some((item) => item.id === effort)
      ? effort
      : model.defaultEffort,
  };
}
