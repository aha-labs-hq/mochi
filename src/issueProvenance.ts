import type { MessageContext } from "./domain.ts";
import type { FeishuTopicEvidence } from "./lark/messageEvidence.ts";
import type { ConnectorProvenance } from "./connectors/protocol.ts";

/**
 * Resolves the origin of one turn from Feishu topic evidence, when it can.
 *
 * This is the only place Feishu evidence becomes a provider-neutral provenance,
 * so a capability that records who asked for a change never has to know which
 * chat product the request came from.
 *
 * Resolution is best-effort on purpose: most turns never record anything, so
 * incomplete evidence is a normal condition rather than a fault. A capability
 * that genuinely needs attribution — creating a record that names a person —
 * requires this value and fails closed when it is absent.
 */
export function issueProvenance(
  context: MessageContext,
  evidence: FeishuTopicEvidence,
): ConnectorProvenance | undefined {
  if (
    evidence.delivery !== "handled"
    || evidence.chatId !== context.chatId
    || evidence.threadKey !== context.threadKey
  ) return undefined;
  const source = evidence.messages.find((message) => message.messageId === context.sourceMessageId);
  if (!source || source.senderId !== context.requesterId) return undefined;
  if (!source.senderName || !source.messageAppLink) return undefined;

  const participantNames: string[] = [];
  const seenNames = new Set<string>();
  for (const message of evidence.messages) {
    if (message.senderType !== "user" || !message.senderName || seenNames.has(message.senderName)) continue;
    seenNames.add(message.senderName);
    participantNames.push(message.senderName);
  }
  return {
    sourceMessageLink: source.messageAppLink,
    requesterName: source.senderName,
    participantNames,
  };
}

/**
 * Renders the origin footer a recorded change carries.
 *
 * The label names the channel that supplied the provenance rather than a fixed
 * product, so the footer stays truthful when another channel starts supplying it.
 */
export function appendProvenance(
  body: string,
  provenance: ConnectorProvenance | undefined,
  originLabel = "原消息",
): string {
  if (!provenance) return body;
  const participants = provenance.participantNames.length > 0
    ? provenance.participantNames.map(escapeMarkdown).join("、")
    : "未能取得姓名";
  return `${body.trimEnd()}\n\n## 讨论来源\n\n`
    + `- 来源话题：[查看${originLabel}](${provenance.sourceMessageLink})\n`
    + `- 发起创建：${escapeMarkdown(provenance.requesterName)}\n`
    + `- 参与讨论：${participants}`;
}

export function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`");
}
