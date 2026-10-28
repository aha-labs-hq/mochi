import { describe, expect, test } from "bun:test";
import { decodeFeishuMessageContent as decode } from "../src/lark/messageContent.ts";

// Literal outputs of the official v1.0.93 converters, with synthetic keys/names.
// https://github.com/larksuite/cli/tree/v1.0.93/shortcuts/im/convert_lib
describe("official Lark compact content contract", () => {
  test("standalone and embedded media keep their resource kinds and order", () => {
    const samples = [
      ["image", "[Image: img_v3_standalone]", [{ kind: "image", key: "img_v3_standalone" }]],
      ["file", String.raw`<file key="file_v3_report" name="A & \"B\".txt"/>`,
        [{ kind: "file", key: "file_v3_report", fileName: 'A & "B".txt' }]],
      ["audio", '<audio key="file_v3_voice" duration="4s"/>', [{ kind: "audio", key: "file_v3_voice" }]],
      ["media", '<video key="file_v3_movie" name="clip.mp4" cover_image_key="img_v3_cover"/>',
        [{ kind: "video", key: "file_v3_movie", fileName: "clip.mp4" }]],
      ["post", 'chart\n![Image](img_v3_chart)\n[Media: file_v3_clip]\n<file key="file_v3_notes" name="notes.txt"/>',
        [{ kind: "image", key: "img_v3_chart" }, { kind: "video", key: "file_v3_clip" },
          { kind: "file", key: "file_v3_notes", fileName: "notes.txt" }]],
      ["merge_forward", '<forwarded_messages>\n[2026-09-09T12:00:00+08:00] Person:\n    [Image: img_v3_original]\n    ![Image](img_v3_post)\n</forwarded_messages>',
        [{ kind: "image", key: "img_v3_original" }, { kind: "image", key: "img_v3_post" }]],
    ] as const;
    for (const [type, text, expected] of samples) {
      expect(decode(type, text)).toEqual({ text, materialReferences: expected, contentLimitations: [] });
    }
  });

  test("reports partial missing resources and folders without discarding readable siblings", () => {
    const result = decode("post", '[Image]\n![Image](img_valid)\n[Media]\n<folder key="file_folder" name="assets"/>');
    expect(result.materialReferences).toEqual([{ kind: "image", key: "img_valid" }]);
    expect(result.contentLimitations).toEqual(["resource_reference_missing", "folder_content_unavailable"]);
    for (const [type, text] of [["image", "[Image]"], ["file", "[File]"], ["audio", "[Voice: 4s]"], ["video", "[Video]"]]) {
      expect(decode(type!, text!).contentLimitations).toEqual(["resource_reference_missing"]);
    }
  });

  test("does not treat plain text, malformed keys, or escaped filenames as downloadable resources", () => {
    const example = '[Image: img_example]\n![Image](img_example)\n<file key="file_example"/>';
    expect(decode("text", example).materialReferences).toEqual([]);
    expect(decode("image", "[Image: img_../../secret]").materialReferences).toEqual([]);
    const named = decode("file", String.raw`<file key="file_real" name="<file key=\"file_fake\"/> &quot; \\n"/>`);
    expect(named.materialReferences).toEqual([{ kind: "file", key: "file_real", fileName: '<file key="file_fake"/> &quot; \\n' }]);
  });

  test("deduplicates within a message, retains document references, and bounds the inventory", () => {
    const text = '[Image: img_same]\n![Image](img_same)\nhttps://example.feishu.cn/docx/a\nhttps://evilfeishu.cn/docx/a';
    expect(decode("post", text).materialReferences).toEqual([
      { kind: "image", key: "img_same" }, { kind: "reference", url: "https://example.feishu.cn/docx/a" },
    ]);
    const large = decode("post", Array.from({ length: 100 }, (_, i) => `![Image](img_${i})`).join("\n"));
    expect(large.materialReferences).toHaveLength(64);
    expect(large.contentLimitations).toEqual(["message_material_reference_limit"]);
  });

  test("malformed delimiters do not consume a later valid resource", () => {
    const text = `${"![ [Image: <file ".repeat(10_000)}\n![Image](img_tail)`;
    expect(decode("post", text).materialReferences).toEqual([{ kind: "image", key: "img_tail" }]);
  });
});
