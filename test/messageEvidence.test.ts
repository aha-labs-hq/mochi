import { describe, expect, test } from "bun:test";
import type { LarkMessageEvent } from "../src/domain.ts";
import {
  FeishuMessageEvidenceReader,
  type MessageEvidenceTransport,
} from "../src/lark/messageEvidence.ts";

describe("Feishu topic evidence", () => {
  test("reads one authoritative topic with names and message links", async () => {
    const calls: string[] = [];
    const transport: MessageEvidenceTransport = {
      getMessageMetadata: async () => metadata(message("om_current", "ou_requester", "Derek", "current")),
      async getMessage(messageId) {
        calls.push(`get:${messageId}`);
        return envelope([message("om_current", "ou_requester", "Derek", "current")]);
      },
      async listThread(threadId) {
        calls.push(`thread:${threadId}`);
        return envelope([
          message("om_root", "ou_originator", "Sherry", "original idea"),
          message("om_bot", "ou_bot", "Team Bot", "prior answer", "bot"),
          message("om_current", "ou_requester", "Derek", "current"),
        ], true);
      },
    };

    const evidence = await new FeishuMessageEvidenceReader({ cliPath: "/lark-cli", profile: "profile", configDirectory: "/private/test-config" }, transport)
      .read(event(), "omt_topic");

    expect(calls).toEqual(["get:om_current", "thread:omt_topic"]);
    expect(evidence).toMatchObject({
      delivery: "handled",
      chatId: "oc_group",
      threadKey: "omt_topic",
      limitations: [],
    });
    expect(evidence.messages.map(({ messageId, senderName, messageAppLink }) => ({
      messageId,
      senderName,
      messageAppLink,
    }))).toEqual(expect.arrayContaining([
      {
        messageId: "om_root",
        senderName: "Sherry",
        messageAppLink: "https://applink.feishu.cn/client/thread/open?message=om_root",
      },
      {
        messageId: "om_bot",
        senderName: "Team Bot",
        messageAppLink: "https://applink.feishu.cn/client/thread/open?message=om_bot",
      },
      {
        messageId: "om_current",
        senderName: "Derek",
        messageAppLink: "https://applink.feishu.cn/client/thread/open?message=om_current",
      },
    ]));
  });

  test("marks bounded pagination incomplete and rejects mismatched event identity", async () => {
    const incomplete: MessageEvidenceTransport = {
      getMessageMetadata: async () => metadata(message("om_current", "ou_requester", "Derek", "current")),
      getMessage: async () => envelope([message("om_current", "ou_requester", "Derek", "current")]),
      listThread: async () => envelope([message("om_current", "ou_requester", "Derek", "current")], false),
    };
    const evidence = await new FeishuMessageEvidenceReader({ cliPath: "/lark-cli", profile: "profile", configDirectory: "/private/test-config" }, incomplete)
      .read(event(), "omt_topic");
    expect(evidence.delivery).toBe("degraded");
    expect(evidence.limitations).toEqual(["topic_message_limit"]);

    const mismatched: MessageEvidenceTransport = {
      getMessageMetadata: async () => metadata(message("om_current", "ou_someone_else", "Other", "current")),
      getMessage: async () => envelope([message("om_current", "ou_someone_else", "Other", "current")]),
      listThread: async () => envelope([]),
    };
    await expect(new FeishuMessageEvidenceReader({ cliPath: "/lark-cli", profile: "profile", configDirectory: "/private/test-config" }, mismatched)
      .read(event(), "omt_topic"))
      .rejects.toThrow("identity does not match");
  });

  test("degrades evidence when a human name or message link is unavailable", async () => {
    const transport: MessageEvidenceTransport = {
      getMessageMetadata: async () => metadata(message("om_current", "ou_requester", "Derek", "current")),
      getMessage: async () => envelope([{
        ...message("om_current", "ou_requester", "Derek", "current"),
        message_app_link: undefined,
        sender: { id: "ou_requester", sender_type: "user" },
      }]),
      listThread: async () => envelope([{
        ...message("om_current", "ou_requester", "Derek", "current"),
        message_app_link: undefined,
        sender: { id: "ou_requester", sender_type: "user" },
      }]),
    };

    const evidence = await new FeishuMessageEvidenceReader({ cliPath: "/lark-cli", profile: "profile", configDirectory: "/private/test-config" }, transport)
      .read(event(), "omt_topic");

    expect(evidence.delivery).toBe("degraded");
    expect(evidence.limitations).toEqual([
      "topic_message_link_missing",
      "topic_sender_name_missing",
    ]);
  });
});

function metadata(item: Record<string, unknown>, parentId?: string, rootId = parentId): unknown {
  return { ok: true, data: { items: [{ ...item, parent_id: parentId, root_id: rootId }] } };
}

function envelope(messages: unknown[], complete = true): unknown {
  return {
    ok: true,
    data: { messages, has_more: !complete },
    meta: { pagination: { complete } },
  };
}

function message(
  messageId: string,
  senderId: string,
  senderName: string,
  content: string,
  senderType = "user",
): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: "oc_group",
    thread_id: "omt_topic",
    msg_type: "text",
    create_time: "2026-08-28 12:00",
    content,
    message_app_link: `https://applink.feishu.cn/client/thread/open?message=${messageId}`,
    sender: { id: senderId, sender_type: senderType, name: senderName },
  };
}

function event(): LarkMessageEvent {
  return {
    type: "im.message.receive_v1",
    message_id: "om_current",
    message_type: "text",
    chat_id: "oc_group",
    chat_type: "group",
    sender_id: "ou_requester",
    sender_type: "user",
    content: "current",
    mentions: [],
    thread_id: "omt_topic",
  };
}


test("recent evidence refreshes edits and tombstones without expanding Issue participants", async () => {
  const transport: MessageEvidenceTransport = {
    getMessage: async (id) => envelope([{ ...message(id, "ou_other", "David", "updated chart", "user"),
      deleted: id === "om_deleted", update_time: "2026-09-08 21:00" }]),
    getMessageMetadata: async () => { throw new Error("background must not traverse reply ancestry"); },
    listThread: async () => { throw new Error("background must not expand another topic"); },
  };
  const reader = new FeishuMessageEvidenceReader({ cliPath: "/lark-cli", profile: "fixture", configDirectory: "/private/fixture" }, transport);
  const result = await reader.readRecent(event(), ["om_edited", "om_deleted"], Date.now() + 1_000);
  expect(result.messages.map((m) => m.text)).toEqual(["updated chart", "[消息已撤回]"]);
  expect(result.messages[0]?.updateTime).toBe("2026-09-08 21:00");
  expect(result.messages[1]?.deleted).toBe(true);
  transport.getMessage = async () => envelope([{ ...message("om_other", "ou_other", "Other", "foreign"), chat_id: "oc_foreign" }]);
  await expect(reader.readRecent(event(), ["om_other"], Date.now() + 1_000)).rejects.toThrow("escaped");
});
