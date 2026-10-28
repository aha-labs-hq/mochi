import type { MochiControlRequest } from "../../../src/control/protocol.ts";
import {
  CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS,
  WORKER_RECOVERY_TIMEOUT_MILLISECONDS,
} from "../../../src/runtime/timing.ts";

const CONTEXT_CONTROL_TIMEOUT_MILLISECONDS =
  CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS +
  WORKER_RECOVERY_TIMEOUT_MILLISECONDS +
  5_000;

export function controlRequestTimeout(
  command: MochiControlRequest["command"],
): number {
  return command === "organize_context"
    ? CONTEXT_CONTROL_TIMEOUT_MILLISECONDS
    : 125_000;
}

// Includes both the longest Bridge operation and the native installer.
export const DESKTOP_RPC_TIMEOUT_MILLISECONDS = Math.max(
  650_000,
  CONTEXT_CONTROL_TIMEOUT_MILLISECONDS + 5_000,
);
