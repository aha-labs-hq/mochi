import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_LARK_CLI, verifyOfficialLarkBinary } from "../src/product/larkBinary.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function executable(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mochi-lark-pin-"));
  directories.push(directory);
  const path = join(directory, "lark-cli");
  await writeFile(path, contents);
  await chmod(path, 0o755);
  return path;
}

test("only the pinned official lark-cli bytes are accepted, before anything runs them", async () => {
  // A wrapper that would claim the right version and identity if it were executed.
  const impostor = await executable(`#!/bin/sh\necho "lark-cli version ${OFFICIAL_LARK_CLI.version}"\n`);
  await expect(verifyOfficialLarkBinary(impostor, "arm64")).rejects.toThrow(
    `lark-cli is not the pinned official ${OFFICIAL_LARK_CLI.version} executable`,
  );
});

test("an architecture without a pinned official executable is refused", async () => {
  const path = await executable("fixture");
  await expect(verifyOfficialLarkBinary(path, "x86_64")).rejects.toThrow("No official lark-cli is pinned for x86_64");
  expect(Object.keys(OFFICIAL_LARK_CLI.executableSha256)).toEqual(["arm64"]);
});

test("a symlink to lark-cli is refused", async () => {
  const path = await executable("fixture");
  const link = join(directories[0]!, "linked-lark-cli");
  await symlink(path, link);
  await expect(verifyOfficialLarkBinary(link, "arm64")).rejects.toThrow("not a wrapper or symlink");
});
