import { expect, test } from "bun:test";
import {
  LarkMessenger,
  parseScheduleDeliveryReceipt,
  scheduleDeliveryArguments,
} from "../src/lark/messenger.ts";
import type { ScheduleOccurrence } from "../src/schedules/dispatcher.ts";
import { scheduleDeliveryText } from "../src/schedules/prompt.ts";

const target = {
  chatId: "oc_group",
  replyMessageId: "om_origin",
  threadKey: "omt_origin",
  delivery: "group" as const,
};
test("one occurrence has one Bot destination and a different cycle cannot collapse identical reports", () => {
  const first = scheduleDeliveryArguments(
    target,
    "bot/arrangement/day1",
    "same report",
  );
  const second = scheduleDeliveryArguments(
    target,
    "bot/arrangement/day2",
    "same report",
  );
  expect(first).toContain("+messages-send");
  expect(first).toContain("--chat-id");
  expect(first).not.toContain("--reply-in-thread");
  expect(first.at(-1)).toBe("bot");
  expect(first[first.indexOf("--idempotency-key") + 1]).not.toBe(
    second[second.indexOf("--idempotency-key") + 1],
  );
  expect(
    scheduleDeliveryArguments(
      { ...target, delivery: "thread" },
      "same",
      "report",
    ),
  ).toContain("--reply-in-thread");
});
test("delivery accepts a verified Bot receipt for the original group and never treats an ambiguous reply as delivered", async () => {
  const receipt = {
    ok: true,
    identity: "bot",
    data: { message_id: "om_result", chat_id: "oc_group" },
  };
  expect(parseScheduleDeliveryReceipt(receipt, target)).toEqual({
    chatId: "oc_group",
    messageId: "om_result",
    threadKey: "om_result",
  });
  for (const value of [
    { ...receipt, identity: "user" },
    { ...receipt, ok: false },
    { ...receipt, data: { ...receipt.data, chat_id: "oc_other" } },
    { ok: true, identity: "bot", data: {} },
  ])
    expect(() => parseScheduleDeliveryReceipt(value, target)).toThrow();
  expect(() =>
    parseScheduleDeliveryReceipt(
      { ...receipt, data: { ...receipt.data, thread_id: "omt_other" } },
      { ...target, delivery: "thread" },
    ),
  ).toThrow();
  const commands: readonly string[][] = [];
  const messenger = new LarkMessenger(
    { cliPath: "/unused", configDirectory: "/unused", profile: "fixture" },
    async (_context, args) => {
      (commands as string[][]).push([...args]);
      return receipt;
    },
  );
  await messenger.deliverSchedule(
    target,
    "occurrence",
    '## Result\n<at user_id="all">全员</at> ![image](https://example.org/x.png)',
  );
  const markdown = commands[0]![commands[0]!.indexOf("--markdown") + 1]!;
  expect(markdown).not.toContain("<at");
  expect(markdown).not.toContain("![");
});
test("one result holds its own meaning, lateness and a verified original-discussion link", () => {
  const occurrence = {
    dueAt: 1000,
    startedAt: 10_000_000,
    coalesced: true,
    schedule: {
      title: "发布进展",
      sourceMessageLink:
        "https://applink.feishu.cn/client/message/open?messageId=om_origin",
    },
  } as ScheduleOccurrence;
  const result = scheduleDeliveryText(
    occurrence,
    "当前仍有一项阻塞。\n\n[依据](https://example.org/issue/20)",
  );
  expect(result).toContain("**发布进展**");
  expect(result).toContain("最近一期");
  expect(result).toContain("原讨论");
  expect(result).toContain("这条消息下继续讨论");
  expect(result).not.toContain("已读");
});
