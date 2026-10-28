import { expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunJitAvailable, signBunExecutable, verifyBunExecutable } from "../script/bun_signing.ts";

// Development builds are ad-hoc signed, so they would never show what the
// hardened runtime of a Developer ID release does to Bun. Apply the same
// runtime ad hoc to the pinned Bun and prove the product recipe keeps the JIT.
test.skipIf(process.platform !== "darwin")(
  "the product signing recipe keeps Bun's JIT under the hardened runtime, and the probe sees its absence",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mochi-bun-signing-"));
    try {
      const signed = join(directory, "signed-bun");
      const unentitled = join(directory, "unentitled-bun");
      for (const path of [signed, unentitled]) {
        await copyFile(process.execPath, path);
        await chmod(path, 0o755);
      }
      await signBunExecutable(signed);
      expect(await bunJitAvailable(signed)).toBe(true);

      const hardened = Bun.spawnSync(["/usr/bin/codesign", "--force", "--options", "runtime", "--sign", "-", unentitled]);
      expect(hardened.exitCode, hardened.stderr.toString()).toBe(0);
      expect(await bunJitAvailable(unentitled)).toBe(false);
      await expect(verifyBunExecutable(unentitled)).rejects.toThrow("exactly the Bun JIT entitlement");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
