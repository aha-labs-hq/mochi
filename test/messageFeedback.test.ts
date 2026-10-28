import { describe, expect, spyOn, test } from "bun:test";
import { MessageFeedback, type ReplyFeedback } from "../src/lark/messageFeedback.ts";
import type { ReactionEmoji } from "../src/lark/messenger.ts";
import { log } from "../src/log.ts";

const source = { botId: "bot-fixture", messageId: "om_request" };

function fixture(options: { accepted?: Promise<void>; failCreate?: ReactionEmoji; failDelete?: boolean } = {}) {
  const calls: string[] = [];
  const visible = new Set<string>();
  const feedback = new MessageFeedback({
    createReaction: async (messageId, emoji) => {
      expect(messageId).toBe(source.messageId);
      calls.push(`create:${emoji}`);
      if (emoji === "OnIt") await options.accepted;
      if (emoji === options.failCreate) throw new Error("fixture create failure");
      visible.add(emoji);
      return emoji;
    },
    deleteReaction: async (messageId, id) => {
      expect(messageId).toBe(source.messageId);
      calls.push(`delete:${id}`);
      if (options.failDelete) throw new Error("fixture delete failure");
      visible.delete(id);
    },
  }, source);
  return { feedback, calls, visible };
}

describe("Feishu message feedback", () => {
  test("a reply clears processing even when acceptance completes after the model", async () => {
    const accepted = Promise.withResolvers<void>();
    const f = fixture({ accepted: accepted.promise });
    f.feedback.started();
    f.feedback.started();
    const finished = f.feedback.finish("replied");
    f.feedback.started();
    expect(f.calls).toEqual(["create:OnIt"]);
    accepted.resolve();
    await finished;
    expect(f.calls).toEqual(["create:OnIt", "create:Typing", "delete:OnIt", "delete:Typing"]);
    expect(f.visible.size).toBe(0);
    await f.feedback.finish("replied");
    expect(f.calls).toHaveLength(4);
  });

  test("a coalesced reply clears acceptance without inventing processing or completion", async () => {
    const f = fixture();
    await f.feedback.finish("replied");
    expect(f.calls).toEqual(["create:OnIt", "delete:OnIt"]);
    expect(f.visible.size).toBe(0);
  });

  for (const [feedback, emoji] of [
    ["waiting", "THINKING"], ["blocked", "FROWN"], ["failed", "ERROR"],
  ] as const satisfies readonly (readonly [ReplyFeedback, ReactionEmoji])[]) {
    test(`${feedback} remains visible after clearing transient progress`, async () => {
      const f = fixture();
      f.feedback.started();
      await f.feedback.finish(feedback);
      expect([...f.visible]).toEqual([emoji]);
      expect(f.calls).toEqual(["create:OnIt", "create:Typing", "delete:OnIt", `create:${emoji}`, "delete:Typing"]);
    });
  }

  for (const failedEmoji of ["OnIt", "Typing"] as const) {
    test(`failure to create ${failedEmoji} neither fails delivery nor leaves known progress behind`, async () => {
      const warnings = spyOn(log, "warn").mockImplementation(() => {});
      try {
        const f = fixture({ failCreate: failedEmoji });
        f.feedback.started();
        await f.feedback.finish("replied");
        expect(f.visible.size).toBe(0);
        expect(warnings).toHaveBeenCalledWith("bot.reaction.create_failed", expect.objectContaining({ ...source, emojiType: failedEmoji }));
      } finally { warnings.mockRestore(); }
    });
  }

  test("failed cleanup is observable and does not replay a reaction or fail the reply", async () => {
    const warnings = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const f = fixture({ failDelete: true });
      await f.feedback.finish("replied");
      expect(f.calls).toEqual(["create:OnIt", "delete:OnIt"]);
      expect(warnings).toHaveBeenCalledWith("bot.reaction.delete_failed", expect.objectContaining({ ...source, reactionId: "OnIt" }));
    } finally { warnings.mockRestore(); }
  });

  for (const [feedback, emoji] of [
    ["waiting", "THINKING"], ["blocked", "FROWN"], ["failed", "ERROR"],
  ] as const) {
    test(`failure to create final ${emoji} still clears stale processing`, async () => {
      const warnings = spyOn(log, "warn").mockImplementation(() => {});
      try {
        const f = fixture({ failCreate: emoji });
        f.feedback.started();
        await f.feedback.finish(feedback);
        expect(f.visible.size).toBe(0);
        expect(warnings).toHaveBeenCalledWith("bot.reaction.create_failed", expect.objectContaining({ ...source, emojiType: emoji }));
      } finally { warnings.mockRestore(); }
    });
  }
});
