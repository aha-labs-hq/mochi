import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LarkMessageEvent } from "../src/domain.ts";
import { FeishuMessageEvidenceReader, FeishuEvidenceRejectedError, type MessageEvidenceTransport } from "../src/lark/messageEvidence.ts";
import { FeishuMessageHydrator, type LarkResourceReader } from "../src/lark/messageHydrator.ts";
import { runtimeUserMessage } from "../src/runtime/instructions.ts";

const stagingRoots: string[] = [];
afterEach(() => {
  for (const root of stagingRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One turn's Bot-owned material staging root. */
function stagingRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mochi-reply-context-"));
  stagingRoots.push(root);
  return join(root, "materialStaging");
}

/** The hydrator reads message resources through an explicit reader, never a path. */
function hydrator(read: LarkResourceReader["read"]): FeishuMessageHydrator {
  return new FeishuMessageHydrator(context, stagingRoot(), { read });
}

const context = { cliPath: "/lark-cli", profile: "fixture", configDirectory: "/private/fixture" };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const event: LarkMessageEvent = {
  type: "im.message.receive_v1", message_id: "om_current", chat_id: "oc_group", chat_type: "group",
  message_type: "text", content: "这些进展如何？", sender_id: "ou_requester", sender_type: "user", mentions: [],
};

function item(id: string, parent?: string, threadId?: string, root = parent) {
  return { message_id: id, parent_id: parent, root_id: root, thread_id: threadId,
    chat_id: "oc_group", msg_type: "text", content: id === "om_current" ? event.content : `source ${id}`,
    sender: { id: "ou_requester", sender_type: "user", name: "A person" },
    message_app_link: `https://applink.feishu.cn/client/chat/open?message=${id}` };
}
type Item = ReturnType<typeof item>;
function fixture(items: Item[], topic: Item[] = []) {
  const calls: string[] = [];
  const byId = new Map(items.map((value) => [value.message_id, value]));
  const normalized = (value: Item) => {
    const { parent_id, root_id: _, ...content } = value;
    return { ...content, ...(value.thread_id ? {} : { reply_to: parent_id }) };
  };
  const transport: MessageEvidenceTransport = {
    async getMessage(id, timeout) {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(30_000);
      calls.push(id);
      const value = byId.get(id);
      return { ok: true, data: { messages: value ? [normalized(value)] : [] } };
    },
    async getMessageMetadata(id) {
      const value = byId.get(id);
      return { ok: true, data: { items: value ? [value] : [] } };
    },
    async listThread() {
      return { ok: true, data: { messages: topic.map(normalized) }, meta: { pagination: { complete: true } } };
    },
  };
  return { calls, transport, reader: new FeishuMessageEvidenceReader(context, transport) };
}

describe("Feishu quoted-message context", () => {
  test("an ordinary reply carries the quoted post and image through the actual input builder", async () => {
    const original = { ...item("om_original"), msg_type: "post", content: "完成以下五项\n![Image](img_checklist)" };
    const f = fixture([item("om_current", "om_original"), original]);
    const evidence = await f.reader.read({ ...event, root_id: "om_original", reply_to: "om_original" }, "om_original");
    expect(evidence.delivery).toBe("handled");
    expect(evidence.referencedMessageIds).toEqual(["om_original"]);
    expect(f.calls).toEqual(["om_current", "om_original"]);
    const downloads: string[] = [];
    const message = await hydrator(async (messageId) => {
      downloads.push(messageId); return { bytes: png, sizeBytes: png.length };
    }).hydrate(event, event.content, "研发群", evidence);
    try {
      expect(downloads).toEqual(["om_original"]);
      expect(message.materials[0]?.dataUrl).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
      const materials = new Map(message.artifacts!.attachments.map((attachment) => [attachment.id, {
        ...attachment, localPath: `/current-turn/${attachment.id}`,
      }]));
      const prompt = runtimeUserMessage(message, materials,
        { chatName: "研发群", now: new Date("2026-10-15T06:03:00Z"), timeZone: "Asia/Shanghai" },
        { sources: "/current-turn/sources.json", topicEvidence: "/current-turn/topic.json" });
      // The quoted original is inline with its image; the current question appears once, last.
      expect(prompt).toContain(`## 引用的原文（最近的在前）\nA person：完成以下五项\n  ![Image](img_checklist) 〔材料 1〕`);
      const path = materials.values().next().value!.localPath;
      expect(prompt).toContain(` · 来自引用（A person） · handled · 第 1 张图片输入 · ${path}`);
      expect(prompt.endsWith(`原文）\n${event.content}\n</feishu_turn>`)).toBeTrue();
      expect(prompt.split(event.content)).toHaveLength(2);
      expect(prompt).not.toContain("om_original");
    } finally { message.artifacts?.dispose(); }
  });

  test("a fresh reader recovers the original outside a new thread even when mget hides parent_id", async () => {
    const first = item("om_first", "om_original", "omt_new");
    const current = item("om_current", "om_first", "omt_new");
    const original = { ...item("om_original"), content: "the actual checklist" };
    const f = fixture([current, first, original], [first, current]);
    const evidence = await f.reader.read({ ...event, thread_id: "omt_new", root_id: "om_first" }, "omt_new");
    expect(evidence.delivery).toBe("handled");
    expect(evidence.referencedMessageIds).toEqual(["om_first", "om_original"]);
    expect(evidence.messages.filter((message) => message.messageId === "om_first")).toHaveLength(1);
    expect(evidence.messages.find((message) => message.messageId === "om_original")?.text).toBe(original.content);
  });

  test("missing references and thread failures retain the known source with explicit degradation", async () => {
    const f = fixture([item("om_current", "om_deleted", "omt_new")]);
    f.transport.listThread = async () => { throw new Error("unavailable"); };
    const evidence = await f.reader.read(event, "omt_new");
    expect(evidence.delivery).toBe("degraded");
    expect(evidence.limitations).toEqual(["reply_message_unavailable", "topic_evidence_unavailable"]);
    expect(evidence.messages[0]?.parentId).toBe("om_deleted");
    const message = await hydrator(async () => ({ bytes: png, sizeBytes: png.length }))
      .hydrate(event, event.content, "研发群", evidence);
    expect(message.delivery).toBe("degraded");
    expect(message.limitations).toContain("reply_message_unavailable");
  });

  test("never imports a cross-chat reference or a system message", async () => {
    const f = fixture([item("om_current", "om_other"), { ...item("om_other"), chat_id: "oc_other" }]);
    await expect(f.reader.read(event, "om_current")).rejects.toThrow("outside the current Feishu chat");
    const system = fixture([item("om_current", "om_system"), { ...item("om_system"), msg_type: "system" }]);
    const evidence = await system.reader.read(event, "om_current");
    expect(evidence.referencedMessageIds).toEqual([]);
    expect(evidence.limitations).toContain("reply_message_unavailable");
  });

  test("bounds ancestry and detects cycles without repeated requests", async () => {
    const f = fixture([item("om_current", "om_a"), item("om_a", "om_current")]);
    const evidence = await f.reader.read(event, "om_current");
    expect(evidence.limitations).toContain("reply_cycle");
    expect(f.calls).toEqual(["om_current", "om_a"]);
    const deep = fixture([item("om_current", "om_0"), ...Array.from({ length: 12 }, (_, i) => item(`om_${i}`, `om_${i + 1}`))]);
    const bounded = await deep.reader.read(event, "om_current");
    expect(bounded.referencedMessageIds).toHaveLength(8);
    expect(deep.calls).toHaveLength(9);
    expect(bounded.limitations).toContain("reply_message_limit");
  });

  test("explicitly quoted images survive a busy topic's recent-image budget", async () => {
    const first = item("om_current", "om_original", "omt_new");
    const original = { ...item("om_original"), msg_type: "post", content: "![Image](img_original)" };
    const history = Array.from({ length: 6 }, (_, i) => ({ ...item(`om_${i}`, undefined, "omt_new"), msg_type: "image", content: `![Image](img_${i})` }));
    const evidence = await fixture([first, original], history).reader.read(event, "omt_new");
    const message = await hydrator(async () => ({ bytes: png, sizeBytes: png.length }))
      .hydrate(event, event.content, "研发群", evidence);
    try {
      expect(message.materials).toHaveLength(7);
      expect(message.materials[0]?.sourceMessageId).toBe("om_original");
      expect(message.materials.filter((m) => m.dataUrl)).toHaveLength(7);
      expect(message.limitations).toEqual([]);
    } finally { message.artifacts?.dispose(); }
  });

  test("current and referenced messages survive topic truncation", async () => {
    const current = item("om_current", "om_original", "omt_new");
    const original = { ...item("om_original"), content: "source ".repeat(2_000) };
    const history = Array.from({ length: 200 }, (_, i) => ({ ...item(`om_${i}`, undefined, "omt_new"), content: "history ".repeat(1_000) }));
    const evidence = await fixture([current, original], history).reader.read(event, "omt_new");
    expect(evidence.messages[0]?.messageId).toBe("om_current");
    expect(evidence.referencedMessageIds).toEqual(["om_original"]);
    expect(evidence.messages[1]?.text.length).toBeLessThanOrEqual(8_000);
    expect(evidence.messages.reduce((sum, value) => sum + value.text.length, 0)).toBeLessThanOrEqual(256_000);
    expect(evidence.limitations).toContain("topic_content_limit");
    expect(evidence.limitations).toContain("topic_message_limit");
  });

  test("deleted or mismatched metadata is never presented as a verified quote", async () => {
    for (const broken of [{ deleted: true }, { sender: { id: "ou_wrong", sender_type: "user" } }]) {
      const current = item("om_current", "om_original");
      const original = item("om_original");
      const f = fixture([current, original]);
      f.transport.getMessageMetadata = async (id) => ({ ok: true, data: { items: [
        id === "om_current" ? current : { ...original, ...broken },
      ] } });
      const evidence = await f.reader.read(event, "om_current");
      expect(evidence.referencedMessageIds).toEqual([]);
      expect(evidence.limitations).toContain("reply_message_unavailable");
    }
  });

  test("unreadable quoted images retain their source and a visible limitation", async () => {
    const original = { ...item("om_original"), msg_type: "post", content: "![Image](img_original)" };
    const evidence = await fixture([item("om_current", "om_original"), original]).reader.read(event, "om_current");
    const message = await hydrator(async () => { throw new Error("fixture unavailable"); })
      .hydrate(event, event.content, "研发群", evidence);
    expect(message.delivery).toBe("degraded");
    expect(message.materials[0]).toMatchObject({ sourceMessageId: "om_original", delivery: "degraded", reason: "resource_read_failed" });
    expect(message.materials[0]?.dataUrl).toBeUndefined();
    expect(message.limitations).toContain("om_original:resource_read_failed");
  });
});


test("a deleted current message is a terminal rejection, not stale event evidence", async () => {
  const current = item("om_current");
  const f = fixture([current]);
  f.transport.getMessageMetadata = async () => ({ ok: true, data: { items: [{ ...current, deleted: true }] } });
  await expect(f.reader.read(event, "om_current")).rejects.toBeInstanceOf(FeishuEvidenceRejectedError);
});
