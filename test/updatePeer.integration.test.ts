import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state.ts";

test("native audit-token authentication proves the connected process and rejects another identity, path or Team", async () => {
  const root = await mkdtemp(join(tmpdir(), "mochi-peer-"));
  const binary = join(root, "peer"),
    socket = join(root, "s");
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, diagnostic: code ? output + error : "" }).toEqual({
      code: 0,
      diagnostic: "",
    });
  };
  try {
    await run([
      "xcrun",
      "clang",
      "-Wall",
      "-Werror",
      "-I",
      resolve("installer"),
      "test/fixtures/update-peer.c",
      "installer/update_peer.c",
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      "-lbsm",
      "-o",
      binary,
    ]);
    await run([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      "app.mochi.update-peer-fixture",
      binary,
    ]);
    const actualBinary = await realpath(binary);
    await run([
      binary,
      socket,
      'identifier "app.mochi.update-peer-fixture"',
      actualBinary,
      "1",
    ]);
    await run([binary, socket, 'identifier "app.mochi.other"', binary, "0"]);
    await run([
      binary,
      socket,
      'identifier "app.mochi.update-peer-fixture"',
      join(root, "another-path"),
      "0",
    ]);
    await run([
      binary,
      socket,
      'anchor apple generic and certificate leaf[subject.OU] = "9P89G9N875"',
      binary,
      "0",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("native recovery never turns an unfinished commit into success and preserves its evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "mochi-update-state-"));
  const binary = join(root, "state");
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, diagnostic: code ? out + err : "" }).toEqual({
      code: 0,
      diagnostic: "",
    });
  };
  try {
    await copyFile(
      "test/fixtures/update-helper-state.swift",
      join(root, "main.swift"),
    );
    await run([
      "xcrun",
      "clang",
      "-c",
      "installer/update_peer.c",
      "-o",
      join(root, "peer.o"),
    ]);
    await run(["xcrun", "clang", "-c", "installer/durability.c", "-o", join(root, "durability.o")]);
    await run([
      "xcrun",
      "swiftc",
      "-swift-version",
      "5",
      "-import-objc-header",
      "installer/update_peer.h",
      "-framework",
      "Security",
      "-lsqlite3",
      "-lbsm",
      "installer/update.swift",
      join(root, "main.swift"),
      join(root, "peer.o"),
      join(root, "durability.o"),
      "-o",
      binary,
    ]);
    const stateDirectory = join(
      root,
      "home/Library/Application Support/Mochi/Bots/11111111-1111-4111-8111-111111111111/State",
    );
    await mkdir(stateDirectory, { recursive: true });
    new StateStore(join(stateDirectory, "bot.sqlite")).close();
    await run([
      "/usr/bin/codesign", "--force", "--sign", "-", "--identifier",
      "app.mochi.update-state-fixture", binary,
    ]);
    await run([binary, root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
