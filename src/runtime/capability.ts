import { createHash } from "node:crypto";
import { canonicalJson } from "../connectors/canonical.ts";
import type { RuntimeToolSpec } from "./protocol.ts";

export function runtimeCapabilityAbi(tools: readonly RuntimeToolSpec[]): string {
  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new Error("Runtime tool names must be unique");
  const digest = createHash("sha256").update(canonicalJson(tools)).digest("hex");
  return `sha256:${digest}`;
}
