import { describe, expect, test } from "bun:test";
import { decideEvent, parseMessageEvent } from "../src/eventPolicy.ts";
import { threadKeysFor, type LarkMessageEvent } from "../src/domain.ts";

const baseEvent: LarkMessageEvent = {
  type: "im.message.receive_v1",
  message_id: "om_message",
  message_type: "text",
  chat_id: "oc_allowed",
  chat_type: "group",
  sender_id: "ou_sender",
  sender_type: "user",
  content: "@Mochi 看一下 PR #42",
  mentions: [{ id: "ou_bot", key: "@_user_1", name: "Mochi" }],
  root_id: "om_root",
};

const config = {
  chatEnabled: true,
  botOpenId: "ou_bot",
  topicIsActive: false,
};

describe("event policy", () => {
  test("activates an allowed topic from a human Bot mention", () => {
    const decision = decideEvent(baseEvent, config);
    expect(decision).toEqual({
      accepted: true,
      route: "activate_topic",
      text: "看一下 PR #42",
      context: {
        chatId: "oc_allowed",
        threadKey: "om_root",
        requesterId: "ou_sender",
        sourceMessageId: "om_message",
      },
    });
  });

  test("continues an active native topic without another mention", () => {
    const { root_id: _rootId, ...nativeTopicEvent } = baseEvent;
    const decision = decideEvent({
      ...nativeTopicEvent,
      message_id: "om_reply",
      thread_id: "omt_topic",
      content: "继续检查失败的 Checks",
      mentions: [],
    }, { ...config, topicIsActive: true });
    expect(decision).toEqual({
      accepted: true,
      route: "continue_topic",
      text: "继续检查失败的 Checks",
      context: {
        chatId: "oc_allowed",
        threadKey: "omt_topic",
        requesterId: "ou_sender",
        sourceMessageId: "om_reply",
      },
    });
  });

  test("uses the stable thread_id instead of a changing root_id", () => {
    const decision = decideEvent({
      ...baseEvent,
      message_id: "om_reply",
      thread_id: "omt_display_only",
      content: "继续",
      mentions: [],
    }, { ...config, topicIsActive: true });
    expect(decision).toMatchObject({
      accepted: true,
      context: { threadKey: "omt_display_only" },
    });
  });

  test("recognizes both identifiers carried by an existing reply thread", () => {
    expect(threadKeysFor({
      ...baseEvent,
      thread_id: "omt_existing",
    })).toEqual(["omt_existing", "om_root", "om_message"]);
  });

  test("keeps the persisted legacy identifier as the active thread key", () => {
    const decision = decideEvent({
      ...baseEvent,
      thread_id: "omt_existing",
      content: "继续",
      mentions: [],
    }, {
      ...config,
      topicIsActive: true,
      activeThreadKey: "omt_existing",
    });
    expect(decision).toMatchObject({
      accepted: true,
      context: { threadKey: "omt_existing" },
    });
  });

  test("strips an optional Bot mention from an active topic", () => {
    const decision = decideEvent(baseEvent, { ...config, topicIsActive: true });
    expect(decision.accepted && decision.text).toBe("看一下 PR #42");
    expect(decision.accepted && decision.route).toBe("continue_topic");
  });

  test("accepts non-text and future message types inside an active topic", () => {
    expect(decideEvent({
      ...baseEvent,
      message_type: "image",
      content: "![Image](img_example)",
      mentions: [],
    }, { ...config, topicIsActive: true })).toMatchObject({
      accepted: true,
      text: "![Image](img_example)",
    });
    expect(decideEvent({
      ...baseEvent,
      message_type: "future_type",
      content: "",
      mentions: [],
    }, { ...config, topicIsActive: true })).toMatchObject({
      accepted: true,
      text: "",
    });
  });

  test.each([
    ["direct message", { chat_type: "p2p" }, "not_group"],
    ["bot sender", { sender_type: "bot" }, "sender_not_user"],
    ["inactive topic", { mentions: [{ id: "ou_someone" }] }, "topic_not_active"],
    ["top-level without mention", { root_id: undefined, mentions: [] }, "bot_not_mentioned"],
    ["system message", { message_type: "system" }, "system_message"],
  ] as const)("rejects %s", (_label, patch, reason) => {
    const decision = decideEvent({ ...baseEvent, ...patch } as LarkMessageEvent, config);
    expect(decision).toEqual({ accepted: false, reason });
  });

  test("a disabled group cannot activate or continue a topic", () => {
    expect(decideEvent(baseEvent, { ...config, chatEnabled: false, topicIsActive: true })).toEqual({ accepted: false, reason: "chat_not_allowed" });
  });

  test("fails closed on malformed event payloads", () => {
    expect(parseMessageEvent({ type: "im.message.receive_v1" })).toBeUndefined();
    expect(parseMessageEvent(null)).toBeUndefined();
  });
});
