import { describe, expect, test } from "bun:test";
import {
  parseProductProblem,
  productProblem,
  PRODUCT_PROBLEM_CODES,
  RECOVERY_ACTIONS,
} from "../src/control/productProblem.ts";

describe("ProductProblem contract", () => {
  test("assigns exactly one declared recovery action to every stable code", () => {
    expect(new Set(PRODUCT_PROBLEM_CODES).size).toBe(PRODUCT_PROBLEM_CODES.length);
    expect(new Set(RECOVERY_ACTIONS).size).toBe(RECOVERY_ACTIONS.length);
    for (const code of PRODUCT_PROBLEM_CODES) {
      const problem = productProblem(code);
      expect(parseProductProblem(problem)).toEqual(problem);
      expect(RECOVERY_ACTIONS).toContain(problem.recoveryAction);
    }
  });

  test("a single Bot's worker or event-stream failure recovers only that Bot", () => {
    for (const code of ["runtime_session_unavailable", "event_stream_unavailable"] as const) {
      expect(productProblem(code).recoveryAction).toBe("restartBot");
    }
    // A shared account failure is not one Bot's to repair.
    expect(productProblem("account_status_unavailable").recoveryAction).toBe("restartService");
  });

  test("rejects expanded and remapped lower-layer problem payloads", () => {
    const problem = productProblem("runtime_session_unavailable");
    expect(parseProductProblem({ ...problem, version: 3 })).toBeUndefined();
    expect(parseProductProblem({ ...problem, rawError: "/private/credential" })).toBeUndefined();
    expect(parseProductProblem({ ...problem, recoveryAction: "exportDiagnostics" })).toBeUndefined();
    expect(parseProductProblem({ ...problem, recoveryAction: "restartService" })).toBeUndefined();
    expect(parseProductProblem({ ...problem, recoverability: "issuerRequired" })).toBeUndefined();
  });
});
