import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../src/attachments/artifacts.ts";
import {
  FeishuMessageHydrator,
  type FeishuReferenceContentReader,
  type LarkResourceReader,
} from "../src/lark/messageHydrator.ts";
import type { FeishuEvidenceMessage, FeishuTopicEvidence } from "../src/lark/messageEvidence.ts";
import { FeishuMessageEvidenceReader, unavailableTopicEvidence, type MessageEvidenceTransport } from "../src/lark/messageEvidence.ts";
import { decodeFeishuMessageContent } from "../src/lark/messageContent.ts";
import type { LarkMessageEvent } from "../src/domain.ts";

const context = { cliPath: "/lark-cli", profile: "fixture", configDirectory: "/private/fixture" };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  resources: LarkResourceReader = {
    async read() {
      return { bytes: png, sizeBytes: png.length };
    },
  },
  references?: FeishuReferenceContentReader,
) {
  const root = mkdtempSync(join(tmpdir(), "mochi-material-test-"));
  roots.push(root);
  // The staging root is a Bot-owned material directory; the store owns its ceiling.
  return new FeishuMessageHydrator(
    context,
    join(root, "materialStaging"),
    resources,
    new AttachmentStore(join(root, "materialStaging")),
    references,
  );
}
function event(type = "text", content = "请分析材料"): LarkMessageEvent {
  return {
    type: "im.message.receive_v1",
    message_id: "om_current",
    message_type: type,
    chat_id: "oc_group",
    chat_type: "group",
    sender_id: "ou_user",
    sender_type: "user",
    content,
    mentions: [],
  };
}
function source(id: string, text: string, messageType = "post"): FeishuEvidenceMessage {
  return { messageId: id, chatId: "oc_group", senderId: "ou_user", senderType: "user", messageType, ...decodeFeishuMessageContent(messageType, text) };
}
function evidence(
  messages: FeishuEvidenceMessage[],
  referencedMessageIds: string[] = [],
): FeishuTopicEvidence {
  return {
    version: 2,
    delivery: "handled",
    chatId: "oc_group",
    threadKey: "omt_topic",
    limitations: [],
    referencedMessageIds,
    messages,
  };
}

describe("unified Feishu material delivery", () => {
  test("official standalone image messages survive REST ingestion from every source", async () => {
    for (const origin of ["current", "reply", "topic", "recent"] as const) {
      const id = origin === "current" ? "om_current" : "om_image";
      const e = { ...(origin === "current" ? event("image", "[Image: img_v3_original]") : event()),
        thread_id: "omt_topic", ...(origin === "reply" ? { reply_to: id } : {}) };
      const image = { ...providerMessage(id, "image", "[Image: img_v3_original]"),
        sender: { id: origin === "current" ? "ou_user" : "ou_other", sender_type: "user", name: "Author" } };
      const current = origin === "current" ? image : providerMessage(e.message_id, "text", "@Mochi 解释这张图");
      const transport: MessageEvidenceTransport = {
        getMessage: async (id) => ({ ok: true, data: { messages: [id === e.message_id ? current : image] } }),
        getMessageMetadata: async (id) => ({ ok: true, data: { items: [
          { ...(id === e.message_id ? current : image), ...(id === e.message_id ? { parent_id: e.reply_to } : {}) },
        ] } }),
        // The replied-to image can be outside the new thread entirely.
        listThread: async () => ({ ok: true, data: { messages: origin === "topic" ? [current, image] : [current] } }),
      };
      const reader = new FeishuMessageEvidenceReader(context, transport);
      const topic = await reader.read(e, "omt_topic");
      const recent = await reader.readRecent(e, origin === "recent" ? [id] : [], Date.now() + 1_000);
      const calls: string[] = [];
      const hydrated = await fixture({ async read(owner, ref) {
        calls.push(`${owner}:${ref.key}`);
        return { bytes: png, sizeBytes: png.length };
      } }).hydrate(e, e.content, "研发群", topic, recent);
      expect(calls).toEqual([`${id}:img_v3_original`]);
      expect(hydrated.materials).toHaveLength(1);
      expect(hydrated.materials[0]).toMatchObject({ source: origin, sourceMessageId: id,
        kind: "image", readability: "image", delivery: "handled", dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
      expect(hydrated.text).toBe(e.content);
      // The group name travels with the input so the turn can say where it is.
      expect(hydrated.chatName).toBe("研发群");
      hydrated.artifacts?.dispose();
    }
  });

  test("text truncation cannot erase images, files, or document references", async () => {
    const text = `${"long message ".repeat(800)}\n![Image](img_tail)\n<file key="file_tail" name="tail.txt"/>\nhttps://example.feishu.cn/docx/tail`;
    const e = event("post", text);
    const item = providerMessage(e.message_id, "post", text);
    const reader = new FeishuMessageEvidenceReader(context, {
      getMessage: async () => ({ ok: true, data: { messages: [item] } }),
      getMessageMetadata: async () => ({ ok: true, data: { items: [item] } }),
      listThread: async () => ({ ok: true, data: { messages: [] } }),
    });
    const topic = await reader.read(e, "omt_topic");
    const recent = await reader.readRecent(e, [e.message_id], Date.now() + 1_000);
    const fallback = unavailableTopicEvidence(e, "omt_topic");
    for (const source of [topic.messages[0]!, recent.messages[0]!, fallback.messages[0]!]) {
      expect(source.text.length).toBeLessThan(text.length);
      expect(source.text).not.toContain("img_tail");
      expect(source.materialReferences.map((r) => r.key ?? r.url)).toEqual([
        "img_tail", "file_tail", "https://example.feishu.cn/docx/tail",
      ]);
    }
    const hydrated = await fixture(undefined, { async read(url) { return { url, inspect: {}, content: { text: "document" } }; } })
      .hydrate(e, e.content, "研发群", topic);
    expect(hydrated.materials.map((m) => m.kind)).toEqual(["image", "file", "reference"]);
    expect(hydrated.materials.every((m) => m.id)).toBeTrue();
    hydrated.artifacts?.dispose();
  });

  test("the same mixed post delivers its image and file from every source", async () => {
    const text = '![Image](img_chart)\n<file key="file_notes" name="notes.txt"/>';
    for (const origin of ["current", "reply", "topic", "recent"] as const) {
      const calls: string[] = [];
      const h = fixture({
        async read(id, ref) {
          calls.push(`${id}:${ref.key}`);
          const bytes = ref.kind === "image" ? png : new TextEncoder().encode("release evidence");
          return { bytes, sizeBytes: bytes.length };
        },
      });
      const id = origin === "current" ? "om_current" : "om_source";
      const item = source(id, text);
      const e = origin === "current" ? event("post", text) : event();
      const message = await h.hydrate(
        e,
        e.content,
        "研发群",
        evidence(origin === "recent" ? [] : [item], origin === "reply" ? [id] : []),
        { messages: origin === "recent" ? [item] : [], limitations: [] },
      );
      expect(calls).toEqual([`${id}:img_chart`, `${id}:file_notes`]);
      expect(message.materials.map((m) => [m.source, m.readability, m.delivery])).toEqual([
        [origin, "image", "handled"],
        [origin, "text", "handled"],
      ]);
      expect(message.materials[0]?.dataUrl).toStartWith("data:image/png;base64,");
      message.artifacts?.dispose();
    }
  });

  test("uses REST-expanded current forwards without changing authorization text", async () => {
    const e = event("merge_forward", "[Merged forward]");
    const message = await fixture().hydrate(
      e,
      e.content,
      "研发群",
      evidence([source(e.message_id, "forwarded chart\n![Image](img_chart)", "merge_forward")]),
    );
    expect(message.text).toBe("[Merged forward]");
    expect(message.materials[0]).toMatchObject({ sourceMessageId: e.message_id, readability: "image" });
    message.artifacts?.dispose();
  });

  test("refreshes document material on a later turn and keeps embedded-content gaps visible", async () => {
    let reads = 0;
    const h = fixture(undefined, {
      async read(url) {
        reads++;
        return {
          url,
          inspect: { type: "docx" },
          content: { text: `revision ${reads}` },
          limitation: "document_embedded_content_unavailable",
        };
      },
    });
    const e = event();
    const prior = evidence([source("om_doc", "https://example.feishu.cn/docx/document", "text")]);
    for (let i = 1; i <= 2; i++) {
      const message = await h.hydrate(e, e.content, "研发群", prior);
      const material = message.materials[0]!;
      expect(material).toMatchObject({
        source: "topic",
        kind: "reference",
        readability: "text",
        delivery: "degraded",
      });
      const file = message.artifacts!.attachment(material.id!)!;
      expect(await Bun.file(file.path).text()).toContain(`revision ${i}`);
      message.artifacts!.dispose();
    }
    expect(reads).toBe(2);
  });

  test("records every over-budget resource and prioritizes current then explicit references", async () => {
    const texts = Array.from({ length: 10 }, (_, i) => source(`om_${i}`, `![Image](img_${i})`));
    const e = event("image", "![Image](img_current)");
    const message = await fixture().hydrate(e, e.content, "研发群", evidence(texts, ["om_0"]));
    expect(message.materials).toHaveLength(11);
    expect(message.materials[0]?.source).toBe("current");
    expect(message.materials[1]?.sourceMessageId).toBe("om_0");
    expect(message.materials.filter((m) => m.dataUrl)).toHaveLength(8);
    expect(
      message.materials
        .slice(8)
        .every((m) => m.reason === "resource_count_limit" && m.delivery === "degraded"),
    ).toBe(true);
    message.artifacts?.dispose();
  });

  test("never advertises PDF bytes as understood text", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nno zero bytes in this fixture");
    const e = event("file", '<file key="file_pdf" name="report.pdf"/>');
    const message = await fixture({
      async read() {
        return { bytes, sizeBytes: bytes.length };
      },
    }).hydrate(e, e.content, "研发群");
    expect(message.materials[0]).toMatchObject({
      readability: "metadata",
      delivery: "degraded",
      reason: "content_reader_unavailable",
      mimeType: "application/pdf",
    });
    expect(message.materials[0]?.id).toBeDefined();
    message.artifacts?.dispose();
  });

  test("does not fetch resource-like prose and marks unsupported content", async () => {
    let reads = 0;
    const h = fixture({
      async read() {
        reads++;
        throw new Error("unexpected download");
      },
    });
    for (const type of ["text", "post"]) {
      const e = event(type, "Variables img_chart and file_notes are identifiers.");
      expect((await h.hydrate(e, e.content, "研发群")).materials).toEqual([]);
    }
    for (const type of ["interactive", "sticker", "future_type"]) {
      const e = event(type, "unavailable visual content");
      expect((await h.hydrate(e, e.content, "研发群")).delivery).toBe("degraded");
    }
    expect(reads).toBe(0);
  });

  test("never downloads deleted, system, bot, or foreign-chat context", async () => {
    let reads = 0;
    const h = fixture({
      async read() {
        reads++;
        throw new Error("unexpected download");
      },
    });
    const items = [
      { ...source("om_deleted", "![Image](img_deleted)"), deleted: true },
      source("om_system", "![Image](img_system)", "system"),
      { ...source("om_bot", "![Image](img_bot)"), senderType: "app" },
    ];
    const message = await h.hydrate(event(), "look", "研发群", evidence(items));
    expect(message.materials).toEqual([]);
    expect(message.contextMessages.some((m) => m.messageType === "system")).toBe(false);
    expect(reads).toBe(0);
    await expect(
      h.hydrate(event(), "look", "研发群", evidence([{ ...source("om_other", ""), chatId: "oc_other" }])),
    ).rejects.toThrow("escaped");
  });

  test("expired preparation and oversized files leave explicit material records", async () => {
    const e = event("image", "![Image](img_chart)");
    const h = fixture({
      async read() {
        return { bytes: new Uint8Array(), sizeBytes: 6 * 1024 * 1024 };
      },
    });
    const expired = await h.hydrate(e, e.content, "研发群", undefined, undefined, Date.now() - 1);
    expect(expired.materials[0]?.reason).toBe("material_deadline_exceeded");
    const oversized = await h.hydrate(e, e.content, "研发群");
    expect(oversized.materials[0]?.reason).toBe("resource_size_limit");
    expect(oversized.artifacts).toBeUndefined();
  });
});

function providerMessage(id: string, type: string, content: string) {
  return { message_id: id, chat_id: "oc_group", thread_id: "omt_topic", msg_type: type, content,
    sender: { id: "ou_user", sender_type: "user", name: "Person" },
    message_app_link: `https://applink.feishu.cn/client/thread/open?message=${id}` };
}
