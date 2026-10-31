import { expect, test } from "bun:test";
import { createRequire } from "node:module";

// Exercise the dependency resolved by Pi, rather than an unrelated test copy.
const requireFromPi = createRequire(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { Minimatch, minimatch } = requireFromPi("minimatch") as typeof import("minimatch");

test("Pi's glob dependency bounds preprocessing amplification", () => {
  // 10.2.6 produced 256 entries despite a limit of 64. Keep the reproduction
  // small so a regression fails an assertion instead of exhausting the host.
  const pattern = Array(8).fill("**/../a/b").join("/");
  const compiled = new Minimatch(pattern, {
    optimizationLevel: 2,
    braceExpandMax: 64,
  });
  expect(compiled.set.length).toBeGreaterThan(0);
  expect(compiled.set.length).toBeLessThanOrEqual(64);
});

test("Pi's model and resource globs keep matching through the dependency upgrade", () => {
  expect(minimatch("openai/gpt-example", "OPENAI/*", { nocase: true })).toBe(true);
  expect(minimatch("anthropic/model-example", "openai/*", { nocase: true })).toBe(false);
  expect(minimatch("skills/review/SKILL.md", "skills/**/SKILL.md")).toBe(true);
  expect(minimatch("src/worker.ts", "**/*.{ts,tsx}")).toBe(true);
  expect(minimatch("src/worker.js", "**/*.{ts,tsx}")).toBe(false);
  expect(minimatch(".private/SKILL.md", "**/SKILL.md")).toBe(false);
});
