import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { desktopIdentity } from "../controlApp/build/identity.ts";

const buildScript = readFileSync(
  resolve(import.meta.dir, "..", "script", "build_and_run.sh"),
  "utf8",
);
const desktopBuilder = readFileSync(
  resolve(import.meta.dir, "..", "script", "build_desktop.ts"),
  "utf8",
);

describe("development App identity", () => {
  test("keeps the product bundle name for packaging and labels local runs", () => {
    expect(desktopIdentity(true)).toEqual({ name: "Mochi", identifier: "app.mochi.companion" });
    expect(desktopIdentity(false)).toEqual({ name: "Mochi Development", identifier: "app.mochi.companion.development" });
    expect(buildScript).toContain("script/build_desktop.ts");
    expect(buildScript).not.toContain("pkill");
  });
  test("detaches bundled runs but binds the HMR host to its launching process", () => {
    const launcher = desktopBuilder.slice(
      desktopBuilder.indexOf("export async function launchDesktop("),
      desktopBuilder.indexOf("async function desktopProcesses("),
    );
    expect(launcher).toContain("detached: true");
    expect(launcher).toContain('stdin: renderer ? "pipe" : "ignore"');
    expect(launcher).toContain("child.unref()");
  });
});
