import { expect, test } from "bun:test";
import { ByokInputError } from "../../src/runtime/byok.ts";
import { byokPromptProblem } from "../src/host/byokPrompt.ts";
import { DesktopFailure, problem } from "../src/shared/problem.ts";

test("native correction focuses invalid fields and never exposes raw provider errors", () => {
  expect(byokPromptProblem(new ByokInputError("baseUrl"))).toMatchObject({
    field: "baseUrl",
  });
  for (const [code, field] of [
    ["byok_auth_rejected", "apiKey"],
    ["byok_model_unsupported", "model"],
    ["byok_endpoint_unavailable", "baseUrl"],
    ["byok_network_unavailable", undefined],
  ] as const) {
    const error = new DesktopFailure(problem(code));
    error.message = "raw-provider-body-fixture";
    const feedback = byokPromptProblem(error);
    expect(feedback.field).toBe(field);
    expect(feedback.message).not.toContain(error.message);
  }
});

test("unknown account outcomes leave the correction loop for shared recovery", () => {
  const error = new DesktopFailure(problem("account_status_unavailable"));
  expect(() => byokPromptProblem(error)).toThrow(error);
});
