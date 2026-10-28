import { expect, test } from "bun:test";
import { RecentFeishuContext } from "../src/lark/recentContext.ts";
import type { LarkMessageEvent } from "../src/domain.ts";
const event = (message_id: string, chat_id = "oc_group"): LarkMessageEvent => ({
  type: "im.message.receive_v1",
  message_id,
  chat_id,
  chat_type: "group",
  message_type: "post",
  sender_id: "ou_user",
  sender_type: "user",
  content: "unretained content",
  mentions: [],
});
test("recent discovery retains bounded IDs, never stale content or foreign groups", () => {
  const recent = new RecentFeishuContext(3, 2);
  for (const id of ["om_old", "om_a", "om_b", "om_current", "om_current"]) recent.observe(event(id));
  recent.observe(event("om_other", "oc_other"));
  expect(recent.recent("oc_group", "om_current")).toEqual(["om_a", "om_b"]);
  recent.observe({ ...event("om_system"), message_type: "system" });
  recent.observe({ ...event("om_bot"), sender_type: "app" });
  expect(recent.recent("oc_group", "om_current")).toEqual(["om_a", "om_b"]);
});
