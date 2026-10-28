import { expect, test } from "bun:test";
import { materialContent } from "../src/attachments/content.ts";

test("material text paging reaches the end without corrupting surrogate pairs", () => {
  const text = "a".repeat(119_999) + "🐈" + "last page";
  const bytes = new TextEncoder().encode(text);
  const first = materialContent(bytes);
  expect(first.details.nextOffset).toBe(119_999);
  const second = materialContent(bytes, first.details.nextOffset);
  expect(second.content).toEqual([{ type: "text", text: "🐈last page" }]);
  expect(second.details.nextOffset).toBeUndefined();
});
test("PDF and invalid UTF-8 are never decoded as text", () => {
  for (const bytes of [
    new TextEncoder().encode("%PDF-1.7"),
    new Uint8Array([0xff, 0xff]),
    new Uint8Array([65, 0, 66]),
  ]) {
    expect(() => materialContent(bytes)).toThrow("no content reader");
  }
});
test("images use content signatures and reject text offsets", () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(materialContent(bytes).content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  expect(() => materialContent(bytes, 1)).toThrow("offset");
});
