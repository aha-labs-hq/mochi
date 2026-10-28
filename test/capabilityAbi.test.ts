import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS, AGENT_TOOL_CAPABILITY_ABI } from "../src/agent/tools.ts";
import { runtimeCapabilityAbi } from "../src/runtime/capability.ts";
import type { RuntimeToolSpec } from "../src/runtime/protocol.ts";

describe("Runtime capability ABI", () => {
  test("is deterministic across object key ordering", () => {
    const left = sampleTool({ type: "string", description: "value" });
    const right = sampleTool({ description: "value", type: "string" });
    expect(runtimeCapabilityAbi([left])).toBe(runtimeCapabilityAbi([right]));
  });

  test("changes when the persisted dynamic tool contract changes", () => {
    const changed = structuredClone(AGENT_TOOLS) as RuntimeToolSpec[];
    changed[0]!.description = `${changed[0]!.description} changed`;
    expect(runtimeCapabilityAbi(changed)).not.toBe(AGENT_TOOL_CAPABILITY_ABI);
    expect(AGENT_TOOL_CAPABILITY_ABI).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("rejects duplicate tool names", () => {
    const spec = sampleTool({ type: "string" });
    expect(() => runtimeCapabilityAbi([spec, spec])).toThrow("must be unique");
  });
});

function sampleTool(property: Record<string, unknown>): RuntimeToolSpec {
  return {
    type: "function",
    name: "probe",
    description: "Probe.",
    inputSchema: {
      type: "object",
      properties: { value: property },
      required: ["value"],
      additionalProperties: false,
    },
  };
}
