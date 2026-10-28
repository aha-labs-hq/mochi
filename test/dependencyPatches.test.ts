import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("dependency patches", () => {
  test("every patch file is registered and has its reason in patches/README.md", () => {
    const { patchedDependencies } = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { patchedDependencies: Record<string, string> };
    const files = readdirSync(join(root, "patches"))
      .filter((name) => name !== "README.md")
      .map((name) => `patches/${name}`);
    expect(Object.values(patchedDependencies).sort()).toEqual(files.sort());
    const entries = [
      ...readFileSync(join(root, "patches/README.md"), "utf8").matchAll(
        /^## `([^`]+)`$/gm,
      ),
    ].map((match) => match[1]);
    expect(entries.sort()).toEqual(Object.keys(patchedDependencies).sort());
  });
});
