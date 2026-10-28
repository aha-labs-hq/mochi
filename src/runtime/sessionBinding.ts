import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** The Pi Session entry that binds a permanent Session to its capability ABI. */
export const BINDING_ENTRY = "mochi.runtime.binding";

/**
 * Bootstrap completed when a successful assistant reply follows the latest
 * binding. Pi persists the file with the first user message, so an interrupted
 * bootstrap can leave a bound candidate without a reply.
 */
export function bootstrapCompleted(manager: Pick<SessionManager, "getEntries">): boolean {
  const entries = manager.getEntries();
  const binding = entries.findLastIndex((entry) =>
    entry.type === "custom" && entry.customType === BINDING_ENTRY);
  return binding >= 0 && entries.slice(binding + 1).some((entry) =>
    entry.type === "message"
    && entry.message.role === "assistant"
    && entry.message.stopReason === "stop"
    && entry.message.content.some((part) => part.type === "text" && part.text.trim().length > 0));
}
