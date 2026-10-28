import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DESKTOP_TOOLCHAIN,
  pinnedBunRuntime,
  pinnedElectrobunEnvironment,
  verifyDesktopToolchain,
} from "../build/toolchain.ts";

const repository = resolve(import.meta.dir, "../..");
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "mochi-toolchain-")));
  directories.push(path);
  return path;
}
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const cacheRoot = (home: string) =>
  join(home, "npm/electrobun", DESKTOP_TOOLCHAIN.electrobun, "macos-arm64");

/** A Hutch cache the Electrobun shim itself accepts, sealed for `archiveSha256`. */
function sealedHutchCache(home: string, archiveSha256: string): string {
  const root = cacheRoot(home);
  mkdirSync(join(root, "bin"), { recursive: true });
  const files: Record<string, { size: number; sha256: string; mode?: number }> =
    {};
  for (const name of ["bin/hutch", "bin/hutch-engine"]) {
    const contents = `#!/bin/sh\necho ${DESKTOP_TOOLCHAIN.hutch.version}\n`;
    writeFileSync(join(root, name), contents);
    chmodSync(join(root, name), 0o755);
    files[name] = {
      size: contents.length,
      sha256: sha256(contents),
      mode: 0o755,
    };
  }
  const release = JSON.stringify({
    schema: 1,
    kind: "archive",
    product: "hutch",
    version: DESKTOP_TOOLCHAIN.hutch.version,
    platform: "macos-arm64",
    launcher: "bin/hutch",
    executable: "bin/hutch-engine",
  });
  writeFileSync(join(root, "hutch-release.json"), release);
  files["hutch-release.json"] = {
    size: release.length,
    sha256: sha256(release),
  };
  writeFileSync(
    join(root, ".electrobun-cache.json"),
    JSON.stringify({
      schemaVersion: 1,
      electrobunVersion: DESKTOP_TOOLCHAIN.electrobun,
      hutchVersion: DESKTOP_TOOLCHAIN.hutch.version,
      platform: "macos-arm64",
      archiveSha256,
      files,
    }),
    { mode: 0o444 },
  );
  return root;
}

const pinnedPlatform =
  process.platform === "darwin" && process.arch === "arm64";

test.skipIf(!pinnedPlatform)(
  "Electrobun runs only the pinned Hutch, named explicitly so its shim cannot fall back",
  async () => {
    const home = temporary();
    const root = sealedHutchCache(home, DESKTOP_TOOLCHAIN.hutch.sha256);
    const environment = await pinnedElectrobunEnvironment(
      repository,
      { HUTCH_HOME: home, PATH: "/usr/bin:/bin" },
      (() => {
        throw new Error("a pinned cache must not be downloaded again");
      }) as unknown as typeof fetch,
    );
    expect(environment).toEqual({
      HUTCH_HOME: home,
      PATH: "/usr/bin:/bin",
      ELECTROBUN_HUTCH_BINARY: join(root, "bin/hutch"),
    });
  },
);

test.skipIf(!pinnedPlatform)(
  "a cached Hutch from any other archive is refused instead of trusted or replaced",
  async () => {
    const home = temporary();
    sealedHutchCache(home, "0".repeat(64));
    await expect(
      pinnedElectrobunEnvironment(repository, { HUTCH_HOME: home }),
    ).rejects.toThrow(
      `not the pinned ${DESKTOP_TOOLCHAIN.hutch.version} archive`,
    );
  },
);

test.skipIf(!pinnedPlatform)(
  "a downloaded archive must match its pin before anything is unpacked",
  async () => {
    const home = temporary();
    const requested: string[] = [];
    const download = (async (url: string) => {
      requested.push(url);
      return new Response("substituted archive");
    }) as unknown as typeof fetch;
    await expect(
      pinnedElectrobunEnvironment(repository, { HUTCH_HOME: home }, download),
    ).rejects.toThrow("does not match its pinned digest");
    expect(requested).toEqual([DESKTOP_TOOLCHAIN.hutch.url]);
    expect(existsSync(cacheRoot(home))).toBe(false);
  },
);

test("Hutch's resolved dependencies and its Bun toolchain must be the pinned ones", async () => {
  const project = temporary();
  const home = temporary();
  symlinkSync(join(repository, "node_modules"), join(project, "node_modules"));
  mkdirSync(join(project, ".hutch"));
  const bun = join(home, "toolchains/bun/1.4.0/macos-arm64/bun");
  mkdirSync(join(bun, ".."), { recursive: true });
  writeFileSync(bun, "not the official Bun");
  const environment = { HUTCH_HOME: home };
  const lock = structuredClone(DESKTOP_TOOLCHAIN.dependencies) as unknown as {
    objects: Array<Record<string, string>>;
  };
  lock.objects[1]!.coreSha256 = "0".repeat(64);
  writeFileSync(
    join(project, ".hutch/dependencies.lock"),
    JSON.stringify(lock),
  );
  await expect(verifyDesktopToolchain(project, environment)).rejects.toThrow(
    "differ from the pinned toolchain",
  );
  writeFileSync(
    join(project, ".hutch/dependencies.lock"),
    JSON.stringify(DESKTOP_TOOLCHAIN.dependencies),
  );
  await expect(verifyDesktopToolchain(project, environment)).rejects.toThrow(
    "not the pinned official build",
  );
});

test("the App's Bun runtime is the repository's pinned Bun", () => {
  expect(pinnedBunRuntime(repository)).toBe(process.execPath);
  const project = temporary();
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ packageManager: "bun@0.0.1" }),
  );
  expect(() => pinnedBunRuntime(project)).toThrow("must be bun@0.0.1");
  expect(
    JSON.parse(readFileSync(join(repository, "package.json"), "utf8"))
      .packageManager,
  ).toBe(`bun@${Bun.version}`);
});
