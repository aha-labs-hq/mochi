import { createHash } from "node:crypto";
import { isSuccessfulLarkEnvelope, larkCommand, runLarkJson, type LarkContext } from "./process.ts";
import { isFeishuChatId } from "./group.ts";

export interface ScheduleDeliveryTarget { chatId: string; replyMessageId: string; threadKey: string; delivery: "group" | "thread" }
export interface ScheduleDeliveryReceipt { chatId: string; messageId: string; threadKey: string }

export type ReactionEmoji = "OnIt" | "Typing" | "THINKING" | "FROWN" | "ERROR";

export class LarkMessenger {
  readonly #context: LarkContext;

  constructor(context: LarkContext, private readonly read = runLarkJson) {
    this.#context = Object.freeze({ ...context });
  }
  async deliverSchedule(target: ScheduleDeliveryTarget, occurrenceKey: string, markdown: string): Promise<ScheduleDeliveryReceipt> {
    const result = await this.read(this.#context, scheduleDeliveryArguments(target, occurrenceKey,
      truncate(sanitizeMarkdown(markdown.trim()), 20_000)));
    return parseScheduleDeliveryReceipt(result, target);
  }

  async replyInThread(messageId: string, markdownInput: string): Promise<void> {
    const markdown = truncate(sanitizeMarkdown(markdownInput.trim()), 20_000);
    const result = await runLarkJson(
      this.#context,
      replyArguments(messageId, markdown),
    );
    if (!isSuccessfulLarkEnvelope(result)) throw new Error("lark-cli reply did not return ok=true");
  }

  async createReaction(messageId: string, emojiType: ReactionEmoji): Promise<string> {
    const result = await runLarkJson(
      this.#context,
      createReactionArguments(messageId, emojiType),
    );
    const data = larkData(result, "reaction create");
    if (typeof data.reaction_id !== "string" || !data.reaction_id) {
      throw new Error("lark-cli reaction create omitted data.reaction_id");
    }
    return data.reaction_id;
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    const result = await runLarkJson(
      this.#context,
      deleteReactionArguments(messageId, reactionId),
    );
    larkData(result, "reaction delete");
  }
}

export function scheduleDeliveryArguments(target: ScheduleDeliveryTarget, occurrenceKey: string, markdown: string): string[] {
  if (!isFeishuChatId(target.chatId) || !/^om_[A-Za-z0-9]+$/.test(target.replyMessageId)
    || !/^(?:om|omt)_[A-Za-z0-9]+$/.test(target.threadKey)
    || (target.delivery !== "group" && target.delivery !== "thread")
    || !occurrenceKey || occurrenceKey.length > 256) throw new Error("Invalid schedule delivery target");
  // Content can repeat on different days: deduplication identifies the occurrence.
  const key = createHash("sha256").update(occurrenceKey).digest("hex").slice(0, 40);
  return ["im", target.delivery === "group" ? "+messages-send" : "+messages-reply",
    ...(target.delivery === "group" ? ["--chat-id", target.chatId] : ["--message-id", target.replyMessageId, "--reply-in-thread"]),
    "--markdown", markdown, "--idempotency-key", key, "--as", "bot"];
}
export function parseScheduleDeliveryReceipt(value: unknown, target: ScheduleDeliveryTarget): ScheduleDeliveryReceipt {
  const data = larkData(value, "schedule delivery");
  if ((value as Record<string, unknown>).identity !== "bot" || data.chat_id !== target.chatId
    || typeof data.message_id !== "string" || !/^om_[A-Za-z0-9]+$/.test(data.message_id)
    || (data.thread_id !== undefined && data.thread_id !== null && data.thread_id !== ""
      && (typeof data.thread_id !== "string" || !/^omt_[A-Za-z0-9]+$/.test(data.thread_id)
        || (target.delivery === "thread" && target.threadKey.startsWith("omt_") && data.thread_id !== target.threadKey)))) throw new Error("Invalid schedule delivery receipt");
  return { chatId: target.chatId, messageId: data.message_id,
    threadKey: typeof data.thread_id === "string" && data.thread_id ? data.thread_id : target.delivery === "group" ? data.message_id : target.threadKey };
}

export function buildCreateReactionCommand(
  context: LarkContext,
  messageId: string,
  emojiType: ReactionEmoji,
): string[] {
  return larkCommand(context, createReactionArguments(messageId, emojiType));
}

function createReactionArguments(messageId: string, emojiType: ReactionEmoji): string[] {
  return [
    "im",
    "reactions",
    "create",
    "--params",
    JSON.stringify({ message_id: messageId }),
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    "--as",
    "bot",
  ];
}

export function buildDeleteReactionCommand(
  context: LarkContext,
  messageId: string,
  reactionId: string,
): string[] {
  return larkCommand(context, deleteReactionArguments(messageId, reactionId));
}

function deleteReactionArguments(messageId: string, reactionId: string): string[] {
  return [
    "im",
    "reactions",
    "delete",
    "--params",
    JSON.stringify({ message_id: messageId, reaction_id: reactionId }),
    "--as",
    "bot",
  ];
}

function larkData(value: unknown, operation: string): Record<string, unknown> {
  if (!isSuccessfulLarkEnvelope(value)) throw new Error(`lark-cli ${operation} did not return ok=true`);
  const data = (value as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`lark-cli ${operation} omitted data`);
  }
  return data as Record<string, unknown>;
}

export function buildReplyCommand(
  context: LarkContext,
  messageId: string,
  markdown: string,
): string[] {
  return larkCommand(context, replyArguments(messageId, markdown));
}

function replyArguments(messageId: string, markdown: string): string[] {
  const idempotencyKey = createHash("sha256")
    .update(messageId)
    .update("\0")
    .update(markdown)
    .digest("hex")
    .slice(0, 40);
  return [
    "im",
    "+messages-reply",
    "--message-id",
    messageId,
    "--markdown",
    markdown,
    "--reply-in-thread",
    "--idempotency-key",
    idempotencyKey,
    "--as",
    "bot",
  ];
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n\n…输出已截断`;
}

export function sanitizeMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)")
    .replace(/<at\b/gi, "&lt;at")
    .replace(/<img\b/gi, "&lt;img");
}
