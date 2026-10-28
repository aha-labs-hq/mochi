import type { LarkMessageEvent, Mention, MessageContext } from "./domain.ts";
import { threadKeyFor } from "./domain.ts";

export type EventDecision =
  | {
      accepted: true;
      context: MessageContext;
      text: string;
      route: "activate_topic" | "continue_topic";
    }
  | { accepted: false; reason: string };

export interface EventPolicyConfig {
  chatEnabled: boolean;
  botOpenId: string;
  topicIsActive: boolean;
  activeThreadKey?: string;
}

export function parseMessageEvent(value: unknown): LarkMessageEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type !== "im.message.receive_v1" ||
    typeof value.message_id !== "string" ||
    typeof value.message_type !== "string" ||
    typeof value.chat_id !== "string" ||
    (value.chat_type !== "p2p" && value.chat_type !== "group") ||
    typeof value.sender_id !== "string" ||
    typeof value.sender_type !== "string" ||
    typeof value.content !== "string"
  ) {
    return undefined;
  }

  const mentions = Array.isArray(value.mentions)
    ? value.mentions.flatMap((item): Mention[] => {
        if (!isRecord(item) || typeof item.id !== "string") return [];
        return [{
          id: item.id,
          ...(typeof item.key === "string" ? { key: item.key } : {}),
          ...(typeof item.name === "string" ? { name: item.name } : {}),
        }];
      })
    : [];

  return {
    type: "im.message.receive_v1",
    message_id: value.message_id,
    message_type: value.message_type,
    chat_id: value.chat_id,
    chat_type: value.chat_type,
    sender_id: value.sender_id,
    sender_type: value.sender_type,
    content: value.content,
    mentions,
    ...(typeof value.event_id === "string" ? { event_id: value.event_id } : {}),
    ...(typeof value.root_id === "string" ? { root_id: value.root_id } : {}),
    ...(typeof value.thread_id === "string" ? { thread_id: value.thread_id } : {}),
    ...(typeof value.reply_to === "string" ? { reply_to: value.reply_to } : {}),
    ...(typeof value.create_time === "string" ? { create_time: value.create_time } : {}),
  };
}

export function decideEvent(event: LarkMessageEvent, config: EventPolicyConfig): EventDecision {
  if (event.chat_type !== "group") return { accepted: false, reason: "not_group" };
  if (!config.chatEnabled) return { accepted: false, reason: "chat_not_allowed" };
  if (event.sender_type !== "user") return { accepted: false, reason: "sender_not_user" };
  if (event.message_type === "system") return { accepted: false, reason: "system_message" };

  const botMention = event.mentions.find((mention) => mention.id === config.botOpenId);
  if (!botMention && !config.topicIsActive) {
    return {
      accepted: false,
      reason: event.thread_id || event.root_id ? "topic_not_active" : "bot_not_mentioned",
    };
  }

  const text = (botMention ? stripLeadingMention(event.content, botMention) : event.content).trim();
  if (!text && (event.message_type === "text" || event.message_type === "post")) {
    return { accepted: false, reason: "empty_message" };
  }

  return {
    accepted: true,
    text,
    route: config.topicIsActive ? "continue_topic" : "activate_topic",
    context: {
      chatId: event.chat_id,
      threadKey: config.activeThreadKey ?? threadKeyFor(event),
      requesterId: event.sender_id,
      sourceMessageId: event.message_id,
    },
  };
}

function stripLeadingMention(content: string, mention: Mention): string {
  const candidates = [mention.key, mention.name ? `@${mention.name}` : undefined, mention.name]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length);

  let result = content.trimStart();
  for (const candidate of candidates) {
    if (result.startsWith(candidate)) {
      result = result.slice(candidate.length).trimStart();
      break;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
