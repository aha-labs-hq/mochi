import type { ConnectorProvenance } from "./connectors/protocol.ts";
import type { GitHubRepositoryScope } from "./github/repository.ts";

export interface Mention {
  id: string;
  key?: string;
  name?: string;
}

export interface LarkMessageEvent {
  type: "im.message.receive_v1";
  event_id?: string;
  message_id: string;
  message_type: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  sender_id: string;
  sender_type: string;
  content: string;
  mentions: Mention[];
  root_id?: string;
  thread_id?: string;
  reply_to?: string;
  create_time?: string;
}

export interface MessageContext {
  chatId: string;
  threadKey: string;
  requesterId: string;
  sourceMessageId: string;
}

/**
 * The origin of a recorded change.
 *
 * Aliased to the connector's neutral provenance rather than declared again, so a
 * capability, a channel and an audit record all speak about attribution in one
 * vocabulary.
 */
export type IssueProvenance = ConnectorProvenance;

export type IssueMutation =
  | { kind: "create"; title: string; body: string; assignees?: string[]; provenance?: IssueProvenance }
  | { kind: "edit"; issueNumber: number; title?: string; body?: string }
  | { kind: "comment"; issueNumber: number; body: string }
  | { kind: "assign" | "unassign"; issueNumber: number; assignees: string[] }
  | { kind: "add_labels" | "remove_labels"; issueNumber: number; labels: string[] }
  | { kind: "set_milestone"; issueNumber: number; milestone: string }
  | { kind: "clear_milestone"; issueNumber: number }
  | { kind: "close"; issueNumber: number; reason: "completed" | "not_planned" }
  | { kind: "reopen" | "unlock"; issueNumber: number }
  | { kind: "lock"; issueNumber: number; reason?: "off-topic" | "too heated" | "resolved" | "spam" };

export type IssueActionDecision =
  | { kind: "reuse"; actionId?: string; issueNumber: number }
  | { kind: "force_create"; actionId?: string };

export type IssueActionStatus =
  | "awaiting_choice"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export interface IssueAction {
  id: string;
  repositoryScope: GitHubRepositoryScope;
  repositoryFullName: string;
  chatId: string;
  threadKey: string;
  proposedBy: string;
  proposalMessageId: string;
  mutation: IssueMutation;
  fingerprint: string;
  status: IssueActionStatus;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export function threadKeyFor(event: LarkMessageEvent): string {
  return event.thread_id ?? event.root_id ?? event.message_id;
}

export function threadKeysFor(event: LarkMessageEvent): string[] {
  const keys = [event.thread_id, event.root_id, event.reply_to, event.message_id]
    .filter((value): value is string => Boolean(value));
  return [...new Set(keys)];
}
