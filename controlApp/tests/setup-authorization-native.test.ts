import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform !== "darwin")(
  "Native setup authorization preserves structured errors without blocking the main thread",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mochi-setup-native-"));
    const binary = join(directory, "setup-test");
    try {
      for (const command of [
        [
          "/usr/bin/clang",
          "-fobjc-arc",
          "-fblocks",
          "-framework",
          "AppKit",
          "-framework",
          "ServiceManagement",
          "-mmacosx-version-min=14.0",
          resolve(import.meta.dir, "../native/appkit.m"),
          join(import.meta.dir, "setup-authorization-native.m"),
          "-o",
          binary,
        ],
        [binary],
      ]) {
        const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, `${output}\n${error}`).toBe(0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
