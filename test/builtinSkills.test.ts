import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBuiltinSkills } from "../src/agent/builtinSkills.ts";
import { BUILTIN_SKILLS, MAXIMUM_SKILL_CATALOG_BYTES, parseSkillCatalog } from "../src/agent/skillCatalog.ts";
import { MOCHI_CONTROL_PROTOCOL_VERSION as version, parseControlRequest, parseControlResponse } from "../src/control/protocol.ts";
import { runtimeSystemPrompt } from "../src/runtime/instructions.ts";
import * as layout from "../src/product/layout.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("published Markdown is verbatim and matches the existing prompt order", () => {
  const protocolDirectory = resolve(import.meta.dir, "../config/protocol");
  const productLayout = spyOn(layout, "productLayout").mockReturnValue({
    ...layout.resolveProductLayout(), protocolDirectory,
  });
  try {
    const skills = readBuiltinSkills();
    expect(skills.map(({ id }) => id)).toEqual(["feishu-collaboration", "message-contract", "issue-authoring", "github-investigation"]);
    for (const skill of skills) expect(skill.content).toBe(readFileSync(join(protocolDirectory, `${skill.id}.md`), "utf8"));
    expect(runtimeSystemPrompt("user preferences").endsWith(skills.map(({ content }) => content.trim()).join("\n\n"))).toBe(true);
  } finally { productLayout.mockRestore(); }
});

test("the deployed protocol directory is the source, with no App copy or document schema", () => {
  const root = mkdtempSync(join(tmpdir(), "mochi-skills-")); directories.push(root);
  const content = "\nNo required headings.\r\n\r\n| A | B |\r\n| - | - |\r\n| x | y |\n\n```text\nraw <tag>\n```\n";
  for (const skill of BUILTIN_SKILLS) writeFileSync(join(root, `${skill.id}.md`), content);
  expect(readBuiltinSkills(root).every((skill) => skill.content === content)).toBe(true);
  writeFileSync(join(root, "message-contract.md"), " \n");
  expect(() => readBuiltinSkills(root)).toThrow();
  rmSync(join(root, "message-contract.md"));
  expect(() => readBuiltinSkills(root)).toThrow();
});

test("read_skills is a bounded no-argument catalog, never a file or write API", () => {
  const skills = readBuiltinSkills(resolve(import.meta.dir, "../config/protocol"));
  expect(parseControlRequest(JSON.stringify({ version, botId: BOT_ID, command: "read_skills" })))
    .toEqual({ version, botId: BOT_ID, command: "read_skills" });
  for (const extra of [{ path: "/etc/passwd" }, { id: "github-investigation" }, { content: "changed" }]) {
    expect(() => parseControlRequest(JSON.stringify({ version, botId: BOT_ID, command: "read_skills", ...extra }))).toThrow();
  }
  // A Bot-scoped command without its Bot has no defensible default.
  expect(() => parseControlRequest(JSON.stringify({ version, command: "read_skills" }))).toThrow();
  const response = (value: unknown) => parseControlResponse(JSON.stringify({ version, ok: true, skills: value }), "read_skills");
  expect(response(skills).skills).toEqual(skills);
  for (const invalid of [[], skills.slice(1), [...skills.slice(1), skills[1]],
    skills.map((s, i) => i ? s : { ...s, path: "/private" }),
    skills.map((s, i) => i ? s : { ...s, name: "foreign skill" }),
    skills.map((s, i) => i ? s : { ...s, content: "🫧".repeat(MAXIMUM_SKILL_CATALOG_BYTES / 4) }),
  ]) expect(() => response(invalid)).toThrow();
  expect(() => parseSkillCatalog({ skills })).toThrow();
});
