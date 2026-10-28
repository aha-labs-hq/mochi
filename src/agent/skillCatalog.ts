import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

/** Published protocol identity, in prompt order. The Markdown owns its structure. */
export const BUILTIN_SKILLS = [
  { id: "feishu-collaboration", name: "群聊协作" },
  { id: "message-contract", name: "阅读材料" },
  { id: "issue-authoring", name: "Issue 协作" },
  { id: "github-investigation", name: "GitHub 调查" },
] as const;
export type SkillId = (typeof BUILTIN_SKILLS)[number]["id"];
export const MAXIMUM_SKILL_CATALOG_BYTES = 131_072;

const documentSchema = Type.Object({
  id: Type.Enum(BUILTIN_SKILLS.map(({ id }) => id)),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  content: Type.String({ minLength: 1, maxLength: MAXIMUM_SKILL_CATALOG_BYTES, pattern: "\\S" }),
}, { additionalProperties: false });
export type SkillDocument = Static<typeof documentSchema>;
const validator = Compile(Type.Array(documentSchema, {
  minItems: BUILTIN_SKILLS.length,
  maxItems: BUILTIN_SKILLS.length,
}));

/** Fail visibly on an incomplete or foreign catalog; never substitute App copy. */
export function parseSkillCatalog(value: unknown): readonly SkillDocument[] {
  if (!validator.Check(value)
    || new Set(value.map(({ id }) => id)).size !== BUILTIN_SKILLS.length
    || value.some((item) => BUILTIN_SKILLS.find(({ id }) => id === item.id)?.name !== item.name)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAXIMUM_SKILL_CATALOG_BYTES) {
    throw new Error("Invalid built-in skill catalog");
  }
  return value;
}
