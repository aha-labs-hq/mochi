import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync, linkSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstructionStore } from "../src/agent/instructionStore.ts";
import { parseInstructionDocument, parseInstructionsRequest } from "../src/agent/instructionDocument.ts";
import { parseControlRequest, parseControlResponse, MOCHI_CONTROL_PROTOCOL_VERSION as version } from "../src/control/protocol.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-instructions-")));
  directories.push(directory);
  const path = join(directory, "AGENTS.md");
  writeFileSync(path, "# 嘱咐\n\n先说人话。\n", { mode: 0o600 });
  return { directory, path, store: new InstructionStore(path) };
}

test("saves the exact Markdown privately, rejects stale drafts, and accepts a lost-response replay", () => {
  const { store, path } = fixture();
  const original = store.read();
  const content = "# 我的嘱咐\n\n用所有同事都懂的话回答。\n";
  const saved = store.save({ ...original, content });
  expect(saved.revision).not.toBe(original.revision);
  expect(readFileSync(path, "utf8")).toBe(content);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(store.save({ ...original, content })).toEqual(saved);
  expect(() => store.save({ ...original, content: "old tab" })).toThrow("instructions_conflict");
  expect(store.read()).toEqual(saved);
  writeFileSync(path, "external edit");
  expect(() => store.save({ ...saved, content: "my draft" })).toThrow("instructions_conflict");
});

test("rejects shared files, symlinks, missing documents, and invalid content without clobbering", () => {
  const { store, path, directory } = fixture();
  const original = store.read();
  for (const content of ["", "  \n", "bad\u0000text", "x".repeat(32769)]) {
    expect(() => store.save({ ...original, content })).toThrow();
    expect(store.read()).toEqual(original);
  }
  symlinkSync(path, join(directory, "link.md"));
  expect(() => new InstructionStore(join(directory, "link.md")).read()).toThrow();
  expect(() => new InstructionStore(join(directory, "absent.md")).read()).toThrow();
  chmodSync(path, 0o644);
  expect(() => store.read()).toThrow();
  chmodSync(path, 0o600);
  linkSync(path, join(directory, "shared.md"));
  expect(() => store.save({ ...original, content: "no" })).toThrow();
});

test("closed on-demand contracts carry no paths and preserve the revision", () => {
  const document = fixture().store.read();
  expect(parseInstructionsRequest({ type: "read" })).toEqual({ type: "read" });
  expect(parseControlRequest(JSON.stringify({ version, botId: BOT_ID, command: "read_instructions" })))
    .toMatchObject({ botId: BOT_ID, command: "read_instructions" });
  expect(parseControlResponse(JSON.stringify({ version, ok: true, document }), "read_instructions").document).toEqual(document);
  expect(parseControlRequest(JSON.stringify({ version, botId: BOT_ID, command: "save_instructions", document }))).toMatchObject({ document });
  for (const value of [{ ...document, path: "/tmp/a" }, { ...document, revision: "old" }]) expect(() => parseInstructionDocument(value)).toThrow();
  expect(() => parseInstructionsRequest({ type: "read", path: "/etc/passwd" })).toThrow();
  expect(() => parseControlRequest(JSON.stringify({ version, botId: BOT_ID, command: "save_instructions", document, path: "/tmp" }))).toThrow();
  // Instructions belong to one Bot, so an anonymous request has no defensible target.
  expect(() => parseControlRequest(JSON.stringify({ version, command: "read_instructions" }))).toThrow();
  expect(() => parseControlResponse(JSON.stringify({ version, ok: true, document }), "model_catalog")).toThrow();
});
