import { describe, expect, test } from "bun:test";
import type { MessageContext } from "../src/domain.ts";
import { appendProvenance, issueProvenance } from "../src/issueProvenance.ts";
import type { FeishuTopicEvidence } from "../src/lark/messageEvidence.ts";

const context: MessageContext = {
  chatId: "oc_group",
  threadKey: "omt_topic",
  requesterId: "ou_requester",
  sourceMessageId: "om_current",
};

describe("Issue provenance", () => {
  test("derives only authoritative human names and links without leaking Feishu IDs", () => {
    const provenance = issueProvenance(context, evidence());
    expect(provenance).not.toBeUndefined();
    if (!provenance) throw new Error("Expected resolved provenance");
    expect(provenance).toEqual({
      sourceMessageLink: "https://applink.feishu.cn/client/thread/open?message=om_current",
      requesterName: "Derek",
      participantNames: ["Sherry", "Derek"],
    });

    const body = appendProvenance("## 要解决的问题\n\nSomething", provenance);
    expect(body).toContain("## 讨论来源");
    expect(body).toContain("发起创建：Derek");
    expect(body).toContain("参与讨论：Sherry、Derek");
    expect(body).toContain(provenance.sourceMessageLink);
    expect(body).not.toContain("ou_requester");
    expect(body).not.toContain("Team Bot");
  });

  test("yields no provenance rather than a guess when the evidence is incomplete", () => {
    // Most turns record nothing, so unprovable evidence is a normal condition.
    // The capability that needs attribution is what refuses to proceed without it.
    expect(issueProvenance(context, {
      ...evidence(),
      delivery: "degraded",
      limitations: ["topic_message_limit"],
    })).toBeUndefined();
    // A message the requester did not send, or one without a name, cannot be
    // attributed either.
    expect(issueProvenance(context, {
      ...evidence(),
      messages: evidence().messages.map(({ senderName: _senderName, ...message }) => message),
    })).toBeUndefined();
  });
});

function evidence(): FeishuTopicEvidence {
  return {
    version: 2,
    referencedMessageIds: [],
    delivery: "handled",
    chatId: "oc_group",
    threadKey: "omt_topic",
    limitations: [],
    messages: [
      {
        messageId: "om_root",
        chatId: "oc_group",
        threadId: "omt_topic",
        senderId: "ou_originator",
        senderType: "user",
        senderName: "Sherry",
        messageAppLink: "https://applink.feishu.cn/client/thread/open?message=om_root",
        messageType: "text", materialReferences: [], contentLimitations: [],
        text: "original",
      },
      {
        messageId: "om_bot",
        chatId: "oc_group",
        threadId: "omt_topic",
        senderId: "ou_bot",
        senderType: "bot",
        senderName: "Team Bot",
        messageAppLink: "https://applink.feishu.cn/client/thread/open?message=om_bot",
        messageType: "post", materialReferences: [], contentLimitations: [],
        text: "answer",
      },
      {
        messageId: "om_current",
        chatId: "oc_group",
        threadId: "omt_topic",
        senderId: "ou_requester",
        senderType: "user",
        senderName: "Derek",
        messageAppLink: "https://applink.feishu.cn/client/thread/open?message=om_current",
        messageType: "text", materialReferences: [], contentLimitations: [],
        text: "create issue",
      },
    ],
  };
}
