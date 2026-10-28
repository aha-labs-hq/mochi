import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const app = join(root, "controlApp/src");

/** Runtime (non-type) module specifiers of one source file. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const statement =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([\w$*\s{},]*?)\s*from\s+"([^"]+)"/g;
  for (const match of text.matchAll(statement)) {
    if (match[2]) continue;
    const clause = match[3]!;
    const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
    // `import { type A, type B }` is erased like `import type`.
    const named = braces?.[1]
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (named?.length && named.every((part) => part.startsWith("type ")))
      continue;
    specifiers.push(match[4]!);
  }
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+"([^"]+)"/g))
    specifiers.push(match[1]!);
  return specifiers;
}

function resolveRelative(from: string, specifier: string): string {
  const path = resolve(dirname(from), specifier);
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`])
    if (existsSync(candidate) && /\.(tsx?|json)$/.test(candidate))
      return candidate;
  return path;
}

test("the renderer reaches Bridge and host code only through the closed shared contract", () => {
  const entries = new Bun.Glob("{ui,motion}/**/*.{ts,tsx}");
  const pending = [...entries.scanSync(app)].map((file) => join(app, file));
  const seen = new Set<string>();
  const violations: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.add(file);
    const area = relative(app, file).split("/")[0];
    const inRenderer =
      file.startsWith(app) && (area === "ui" || area === "motion");
    for (const specifier of runtimeImports(file)) {
      if (/^(node|bun):|^electrobun\/main/.test(specifier)) {
        violations.push(`${relative(root, file)} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelative(file, specifier);
      const targetArea = target.startsWith(app)
        ? relative(app, target).split("/")[0]
        : "bridge";
      if (inRenderer && (targetArea === "host" || targetArea === "bridge")) {
        // Static assets and the motion manifest are data, not code.
        if (!/\.(json|png|webp|jpg|svg|css|html)$/.test(target))
          violations.push(`${relative(root, file)} -> ${specifier}`);
      }
      pending.push(target);
    }
  }
  expect(violations).toEqual([]);
  // The walk really did cross into the Bridge through shared.
  expect(
    [...seen].some((file) => file.startsWith(join(root, "src/runtime/"))),
  ).toBe(true);
});
