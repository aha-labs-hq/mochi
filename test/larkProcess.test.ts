import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarkMessenger } from "../src/lark/messenger.ts";
import {
  DEFAULT_LARK_COMMAND_TIMEOUT_MILLISECONDS,
  runLarkCommand,
  runLarkJson,
} from "../src/lark/process.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("finite lark-cli commands", () => {
  test("have one default deadline and terminate a stuck child", async () => {
    expect(DEFAULT_LARK_COMMAND_TIMEOUT_MILLISECONDS).toBe(30_000);
    const executable = fakeExecutable("await new Promise(() => undefined);");
    await expect(runLarkJson({ cliPath: executable, profile: "profile", configDirectory: "/private/test-config" }, [], { timeoutMilliseconds: 20 }))
      .rejects.toThrow("lark-cli timed out after 20ms");
  });

  test("rejects an invalid deadline before launching the command", async () => {
    await expect(runLarkCommand("/path/that/must/not/run", [], { timeoutMilliseconds: 0 }))
      .rejects.toThrow("lark-cli timeout must be a positive integer");
  });

  test("routes replies through the same bounded JSON command runner", async () => {
    const executable = fakeExecutable(`
if (!process.argv.includes("+messages-reply") || !process.argv.includes("--idempotency-key")) {
  process.stderr.write("missing reply contract");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ ok: true, data: {} }));
`);
    await expect(new LarkMessenger({ cliPath: executable, profile: "profile", configDirectory: "/private/test-config" }).replyInThread("om_message", "hello"))
      .resolves.toBeUndefined();
  });
});

function fakeExecutable(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "mochi-lark-command-"));
  directories.push(directory);
  const path = join(directory, "fake-lark.ts");
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
