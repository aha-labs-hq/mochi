import { readFileSync } from "node:fs";
import { join } from "node:path";
import { productLayout } from "../product/layout.ts";
import { BUILTIN_SKILLS, parseSkillCatalog, type SkillDocument } from "./skillCatalog.ts";

/** Bridge-only source shared by prompt composition and the read-only reader. */
export function readBuiltinSkills(protocolDirectory = productLayout().protocolDirectory): readonly SkillDocument[] {
  return parseSkillCatalog(BUILTIN_SKILLS.map((skill) => ({
    ...skill,
    content: readFileSync(join(protocolDirectory, `${skill.id}.md`), "utf8"),
  })));
}
