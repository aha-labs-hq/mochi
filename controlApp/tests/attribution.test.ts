import { expect, test } from "bun:test";
import { build } from "vite";
import { rendererAttribution, sourcePackage } from "../build/attribution.ts";
import { rendererConfig } from "../build/vite.ts";

test("source ownership handles scoped and nested JS/CSS compiler paths", () => {
  expect(sourcePackage("/project/src/main.ts")).toBeNull();
  expect(sourcePackage("/project/node_modules/react/index.js?commonjs")).toBe(
    "react",
  );
  expect(
    sourcePackage("Users/dev/project/node_modules/tailwindcss/index.css"),
  ).toBe("tailwindcss");
  expect(
    sourcePackage("/project/node_modules/a/node_modules/@scope/b/style.css"),
  ).toBe("@scope/b");
  expect(() => sourcePackage("/project/node_modules/@broken")).toThrow();
});

test("the actual renderer compiler attributes emitted JS and CSS without shipping source maps", async () => {
  let packages: string[] = [];
  const config = await rendererConfig({ fixture: true });
  config.build = { ...config.build, write: false };
  config.plugins!.push(
    rendererAttribution((value) => {
      packages = value;
    }),
  );
  const result = await build(config);
  expect(packages).toEqual(
    expect.arrayContaining(["react", "react-dom", "zustand", "tailwindcss"]),
  );
  expect(packages).not.toContain("@tailwindcss/vite");
  expect(packages).not.toContain("vite");
  if (Array.isArray(result) || !("output" in result))
    throw new Error("Expected a single renderer build");
  expect(result.output.some((entry) => entry.fileName.endsWith(".map"))).toBe(
    false,
  );
  const css = result.output.find(
    (entry) => entry.type === "asset" && entry.fileName.endsWith(".css"),
  );
  expect(css?.type === "asset" && String(css.source)).toContain("tailwindcss");
});
