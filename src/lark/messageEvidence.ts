import type { LarkMessageEvent } from "../domain.ts";
import { log, type Logger } from "../log.ts";
import { decodeFeishuMessageContent, type FeishuMessageContent } from "./messageContent.ts";
import { isSuccessfulLarkEnvelope, runLarkJson, type LarkContext } from "./process.ts";

const MAX_TOPIC_MESSAGES = 200;
const MAX_MESSAGE_CHARACTERS = 8_000;
const MAX_TOPIC_CHARACTERS = 256_000;
const MAX_REFERENCED_MESSAGES = 8;
const EVIDENCE_TIMEOUT_MILLISECONDS = 30_000;

/** A verified rejection must never fall back to stale event content. */
export class FeishuEvidenceRejectedError extends Error {}

export type TopicEvidenceDelivery = "handled" | "degraded";

export interface FeishuEvidenceMessage extends FeishuMessageContent {
  messageId: string;
  chatId: string;
  threadId?: string;
  parentId?: string;
  rootId?: string;
  senderId: string;
  senderType: string;
  senderName?: string;
  messageAppLink?: string;
  createTime?: string;
  deleted?: boolean;
  updateTime?: string;
  messageType: string;
}

export interface FeishuTopicEvidence {
  version: 2;
  delivery: TopicEvidenceDelivery;
  chatId: string;
  threadKey: string;
  limitations: readonly string[];
  /** Nearest-first reply ancestry, never an authorization source. */
  referencedMessageIds: readonly string[];
  messages: readonly FeishuEvidenceMessage[];
}

export interface MessageEvidenceTransport {
  getMessage(messageId: string, timeoutMilliseconds: number): Promise<unknown>;
  getMessageMetadata(messageId: string, timeoutMilliseconds: number): Promise<unknown>;
  listThread(threadId: string, timeoutMilliseconds: number): Promise<unknown>;
}

export class FeishuMessageEvidenceReader {
  readonly #transport: MessageEvidenceTransport;
  readonly #log: Logger;

  constructor(
    context: LarkContext,
    transport: MessageEvidenceTransport = new CliMessageEvidenceTransport(context),
    logger: Logger = log,
  ) {
    this.#transport = transport;
    this.#log = logger;
  }
  async assertDeliveryTarget(chatId: string, messageId: string): Promise<void> {
    const message = await this.#readMessage(messageId, Date.now() + EVIDENCE_TIMEOUT_MILLISECONDS);
    if (message.chatId !== chatId || message.deleted) throw new FeishuEvidenceRejectedError("Schedule destination is no longer accessible in its original chat");
  }

  async read(event: LarkMessageEvent, threadKey: string): Promise<FeishuTopicEvidence> {
    const deadline = Date.now() + EVIDENCE_TIMEOUT_MILLISECONDS;
    const current = await this.#readMessage(event.message_id, deadline);
    assertCurrentMessage(current, event);
    // Event and REST relations are independent of the routing thread. A normal
    // quoted reply may later become a new thread without its quoted source.
    if (event.reply_to) current.parentId ??= event.reply_to;
    if (event.root_id) current.rootId ??= event.root_id;
    const limitations: string[] = [];
    const references = await this.#readReferences(current, deadline, limitations);
    const threadId = current.threadId ?? (threadKey.startsWith("omt_") ? threadKey : undefined);
    let threadMessages: FeishuEvidenceMessage[] = [];
    if (threadId) {
      try {
        const envelope = await this.#transport.listThread(threadId, remainingTime(deadline));
        threadMessages = messagesFromEnvelope(envelope, "threads-messages-list").reverse();
        if (!paginationComplete(envelope)) addLimitation(limitations, "topic_message_limit");
      } catch {
        addLimitation(limitations, "topic_evidence_unavailable");
      }
    }
    for (const message of threadMessages) {
      if (message.chatId !== event.chat_id || message.threadId !== threadId) {
        throw new FeishuEvidenceRejectedError("lark-cli returned a message outside the current Feishu topic");
      }
    }
    // Budget current + explicit references first. Unrelated topic history cannot
    // evict the very message/image the user is asking about.
    return topicEvidence(
      event.chat_id, threadKey,
      deduplicateMessages([current, ...references, ...threadMessages]),
      limitations, references.map((message) => message.messageId),
    );
  }

  /** Refresh only observed IDs from this chat; background never joins Issue evidence. */
  async readRecent(event: LarkMessageEvent, ids: readonly string[], deadline: number): Promise<{
    messages: FeishuEvidenceMessage[]; limitations: string[];
  }> {
    const messages: FeishuEvidenceMessage[] = [];
    const limitations: string[] = [];
    for (const id of [...new Set(ids)].slice(-12).reverse()) {
      let source: FeishuEvidenceMessage | undefined;
      try {
        source = messagesFromEnvelope(await this.#transport.getMessage(id, remainingTime(deadline)), "messages-mget")
          .find((message) => message.messageId === id);
      } catch {
        addLimitation(limitations, `${id}:recent_message_unavailable`);
        continue;
      }
      if (!source) { addLimitation(limitations, `${id}:recent_message_unavailable`); continue; }
      if (source.chatId !== event.chat_id || source.senderType !== "user") {
        throw new Error("Recent message identity escaped the observed chat");
      }
      if (source.text.length > MAX_MESSAGE_CHARACTERS) {
        source = { ...source, text: boundedText(source.text, MAX_MESSAGE_CHARACTERS) };
        addLimitation(limitations, `${id}:recent_content_limit`);
      }
      messages.unshift(source);
    }
    return { messages, limitations };
  }

  async #readMessage(messageId: string, deadline: number): Promise<FeishuEvidenceMessage> {
    const timeout = remainingTime(deadline);
    const [content, metadata] = await Promise.all([
      this.#transport.getMessage(messageId, timeout),
      this.#transport.getMessageMetadata(messageId, timeout),
    ]);
    const message = messagesFromEnvelope(content, "messages-mget")
      .find((item) => item.messageId === messageId);
    if (!message) throw new Error("lark-cli messages-mget omitted the requested message");
    return withReplyMetadata(message, metadata);
  }

  async #readReferences(
    current: FeishuEvidenceMessage, deadline: number, limitations: string[],
  ): Promise<FeishuEvidenceMessage[]> {
    const messages = new Map<string, FeishuEvidenceMessage>([[current.messageId, current]]);
    const pending = replyIds(current);
    const attempted = new Set<string>([current.messageId]);
    for (let index = 0; index < pending.length; index += 1) {
      const id = pending[index]!;
      if (attempted.has(id)) continue;
      if (attempted.size > MAX_REFERENCED_MESSAGES) {
        addLimitation(limitations, "reply_message_limit");
        break;
      }
      attempted.add(id);
      let message: FeishuEvidenceMessage;
      try {
        message = await this.#readMessage(id, deadline);
      } catch {
        // A deleted/inaccessible reference must not erase the current message or
        // silently turn the reply into a context-free question.
        addLimitation(limitations, "reply_message_unavailable");
        this.#log.warn("lark.reply_evidence.degraded", {
          messageId: current.messageId, sourceMessageId: id, reason: "reply_message_unavailable",
        });
        continue;
      }
      if (message.chatId !== current.chatId) {
        throw new FeishuEvidenceRejectedError("lark-cli returned a referenced message outside the current Feishu chat");
      }
      messages.set(id, message);
      pending.push(...replyIds(message));
    }
    if (hasReplyCycle(current.messageId, messages)) {
      addLimitation(limitations, "reply_cycle");
    }
    return [...messages.values()].filter((message) => message !== current);
  }
}

export function unavailableTopicEvidence(
  event: LarkMessageEvent,
  threadKey: string,
): FeishuTopicEvidence {
  return {
    version: 2,
    delivery: "degraded",
    chatId: event.chat_id,
    threadKey,
    limitations: ["topic_evidence_unavailable"],
    referencedMessageIds: [],
    messages: [{
      messageId: event.message_id,
      chatId: event.chat_id,
      ...(event.thread_id ? { threadId: event.thread_id } : {}),
      ...(event.reply_to ? { parentId: event.reply_to } : {}),
      ...(event.root_id ? { rootId: event.root_id } : {}),
      senderId: event.sender_id,
      senderType: event.sender_type,
      ...(event.create_time ? { createTime: event.create_time } : {}),
      messageType: event.message_type,
      ...decodeFeishuMessageContent(event.message_type, event.content),
      text: boundedText(event.content, MAX_MESSAGE_CHARACTERS),
    }],
  };
}

class CliMessageEvidenceTransport implements MessageEvidenceTransport {
  readonly #context: LarkContext;

  constructor(context: LarkContext) {
    this.#context = Object.freeze({ ...context });
  }

  getMessage(messageId: string, timeoutMilliseconds: number): Promise<unknown> {
    return runLarkJson(this.#context, [
      "im",
      "+messages-mget",
      "--message-ids",
      messageId,
      "--no-reactions",
      "--as",
      "bot",
      "--format",
      "json",
    ], { timeoutMilliseconds });
  }

  getMessageMetadata(messageId: string, timeoutMilliseconds: number): Promise<unknown> {
    if (!/^om_[a-zA-Z0-9]+$/.test(messageId)) throw new Error("Invalid Feishu message ID");
    // CLI 1.0.93's formatter drops parent_id when thread_id exists. Only read
    // relations via this fixed official endpoint; content still belongs to mget.
    return runLarkJson(this.#context, [
      "api", "GET", `/open-apis/im/v1/messages/${messageId}`,
      "--params", JSON.stringify({ user_id_type: "open_id" }),
      "--as", "bot", "--format", "json",
    ], { timeoutMilliseconds });
  }

  listThread(threadId: string, timeoutMilliseconds: number): Promise<unknown> {
    return runLarkJson(this.#context, [
      "im",
      "+threads-messages-list",
      "--thread",
      threadId,
      "--order",
      "desc",
      "--page-size",
      "50",
      "--page-all",
      "--page-limit",
      String(MAX_TOPIC_MESSAGES / 50),
      "--no-reactions",
      "--as",
      "bot",
      "--format",
      "json",
    ], { timeoutMilliseconds });
  }
}

function messagesFromEnvelope(value: unknown, command: string): FeishuEvidenceMessage[] {
  if (!isSuccessfulLarkEnvelope(value)) throw new Error(`lark-cli ${command} did not return ok=true`);
  const root = record(value, `${command} envelope`);
  const data = record(root.data, `${command} data`);
  if (!Array.isArray(data.messages)) throw new Error(`lark-cli ${command} omitted data.messages`);
  return data.messages.slice(0, MAX_TOPIC_MESSAGES).map((value, index) => {
    const item = record(value, `${command} message ${index + 1}`);
    const sender = record(item.sender, `${command} message ${index + 1}.sender`);
    const threadId = optionalString(item.thread_id);
    const parentId = optionalString(item.reply_to);
    const senderName = optionalString(sender.name);
    const messageAppLink = httpsLink(item.message_app_link);
    const createTime = optionalString(item.create_time);
    return {
      messageId: requiredString(item.message_id, "message_id"),
      chatId: requiredString(item.chat_id, "chat_id"),
      ...(threadId ? { threadId } : {}),
      ...(parentId ? { parentId } : {}),
      senderId: requiredString(sender.id, "sender.id"),
      senderType: requiredString(sender.sender_type, "sender.sender_type"),
      ...(senderName ? { senderName } : {}),
      ...(messageAppLink ? { messageAppLink } : {}),
      ...(createTime ? { createTime } : {}),
      messageType: requiredString(item.msg_type, "msg_type"),
      ...(item.deleted === true ? { deleted: true } : {}),
      ...(optionalString(item.update_time) ? { updateTime: optionalString(item.update_time)! } : {}),
      ...(item.deleted === true
        ? { text: "[消息已撤回]", materialReferences: [], contentLimitations: [] }
        : decodeFeishuMessageContent(requiredString(item.msg_type, "msg_type"), contentText(item.content))),
    };
  }).filter((message) => message.messageType !== "system");
}

function topicEvidence(
  chatId: string,
  threadKey: string,
  inputMessages: readonly FeishuEvidenceMessage[],
  initialLimitations: readonly string[],
  referencedMessageIds: readonly string[],
): FeishuTopicEvidence {
  const limitations = [...initialLimitations];
  const messages: FeishuEvidenceMessage[] = [];
  let characters = 0;
  for (const message of inputMessages.slice(0, MAX_TOPIC_MESSAGES)) {
    if (!message.messageAppLink) addLimitation(limitations, "topic_message_link_missing");
    if (message.senderType === "user" && !message.senderName) {
      addLimitation(limitations, "topic_sender_name_missing");
    }
    const remaining = MAX_TOPIC_CHARACTERS - characters;
    if (remaining <= 0) {
      addLimitation(limitations, "topic_content_limit");
      break;
    }
    const text = boundedText(message.text, Math.min(MAX_MESSAGE_CHARACTERS, remaining));
    if (text.length < message.text.length) addLimitation(limitations, "topic_content_limit");
    messages.push({ ...message, text });
    characters += text.length;
  }
  if (inputMessages.length > MAX_TOPIC_MESSAGES) addLimitation(limitations, "topic_message_limit");
  return {
    version: 2,
    delivery: limitations.length === 0 ? "handled" : "degraded",
    chatId,
    threadKey,
    limitations,
    referencedMessageIds: referencedMessageIds.filter((id) => messages.some((message) => message.messageId === id)),
    messages,
  };
}

function assertCurrentMessage(message: FeishuEvidenceMessage, event: LarkMessageEvent): void {
  if (
    message.chatId !== event.chat_id
    || message.senderId !== event.sender_id
    || message.senderType !== event.sender_type
  ) {
    throw new FeishuEvidenceRejectedError("lark-cli current message identity does not match the accepted event");
  }
}

function withReplyMetadata(message: FeishuEvidenceMessage, value: unknown): FeishuEvidenceMessage {
  if (!isSuccessfulLarkEnvelope(value)) throw new Error("lark-cli message metadata did not return ok=true");
  const data = record(record(value, "metadata envelope").data, "metadata data");
  if (!Array.isArray(data.items)) throw new Error("lark-cli metadata omitted data.items");
  const item = data.items.map((item) => record(item, "metadata item"))
    .find((item) => item.message_id === message.messageId);
  if (!item || item.deleted === true) throw new FeishuEvidenceRejectedError("Referenced message is missing or deleted");
  const sender = record(item.sender, "metadata sender");
  if (item.chat_id !== message.chatId || sender.id !== message.senderId
    || sender.sender_type !== message.senderType || item.msg_type !== message.messageType) {
    throw new FeishuEvidenceRejectedError("Feishu message content and relation identity do not match");
  }
  const parentId = relationId(item.parent_id);
  const rootId = relationId(item.root_id);
  return { ...message, ...(parentId ? { parentId } : {}), ...(rootId ? { rootId } : {}) };
}

function relationId(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^om_[a-zA-Z0-9]+$/.test(value)) {
    throw new Error("Invalid Feishu reply relation");
  }
  return value;
}

function replyIds(message: FeishuEvidenceMessage): string[] {
  return [...new Set([message.parentId, message.rootId].filter((id): id is string => Boolean(id)))];
}

function hasReplyCycle(id: string, messages: ReadonlyMap<string, FeishuEvidenceMessage>, path = new Set<string>()): boolean {
  if (path.has(id)) return true;
  const message = messages.get(id);
  if (!message) return false;
  const next = new Set(path).add(id);
  return replyIds(message).some((parent) => hasReplyCycle(parent, messages, next));
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Feishu evidence deadline exceeded");
  return remaining;
}

function deduplicateMessages(messages: readonly FeishuEvidenceMessage[]): FeishuEvidenceMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.messageId)) return false;
    seen.add(message.messageId);
    return true;
  });
}

function paginationComplete(value: unknown): boolean {
  const root = optionalRecord(value);
  const data = optionalRecord(root.meta);
  const pagination = optionalRecord(data.pagination);
  if (typeof pagination.complete === "boolean") return pagination.complete;
  const envelopeData = optionalRecord(root.data);
  return envelopeData.has_more !== true;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function boundedText(value: string, maximum: number): string {
  const text = value.replaceAll("\r\n", "\n").trim();
  if (text.length <= maximum) return text;
  const marker = "\n…[已截断]";
  return maximum < marker.length ? text.slice(0, maximum) : `${text.slice(0, maximum - marker.length)}${marker}`;
}

function addLimitation(limitations: string[], value: string): void {
  if (!limitations.includes(value)) limitations.push(value);
}

function httpsLink(value: unknown): string | undefined {
  const link = optionalString(value);
  if (!link) return undefined;
  try {
    return new URL(link).protocol === "https:" ? link : undefined;
  } catch {
    return undefined;
  }
}

function requiredString(value: unknown, name: string): string {
  const text = optionalString(value);
  if (!text) throw new Error(`lark-cli message omitted ${name}`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
