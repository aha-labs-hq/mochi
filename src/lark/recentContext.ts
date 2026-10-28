import type { LarkMessageEvent } from "../domain.ts";

/** Only discovery IDs survive between turns. Content is refreshed by the evidence reader. */
export class RecentFeishuContext {
  readonly #messages = new Map<string, string[]>();
  constructor(
    private readonly maximumMessagesPerChat = 24,
    private readonly maximumPromptMessages = 12,
  ) {
    if (maximumPromptMessages <= 0 || maximumMessagesPerChat < maximumPromptMessages) {
      throw new Error("Recent Feishu context limits are invalid");
    }
  }
  observe(event: LarkMessageEvent): void {
    if (event.chat_type !== "group" || event.sender_type !== "user" || event.message_type === "system")
      return;
    const messages = this.#messages.get(event.chat_id) ?? [];
    if (messages.includes(event.message_id)) return;
    messages.push(event.message_id);
    this.#messages.set(event.chat_id, messages.slice(-this.maximumMessagesPerChat));
  }
  recent(chatId: string, excludingMessageId: string): string[] {
    return (this.#messages.get(chatId) ?? [])
      .filter((id) => id !== excludingMessageId)
      .slice(-this.maximumPromptMessages);
  }
}
