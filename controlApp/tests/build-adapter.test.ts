import { expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { version } from "../../package.json";
import { signDesktop, verifyDesktop } from "../../script/build_desktop.ts";
import { requireBunEntitlements } from "../../script/bun_signing.ts";
import {
  assertElectrobunBundle,
  compileDesktopEntrypoint,
  prepareElectrobunBundle,
} from "../build/electrobun.ts";
import { desktopIdentity } from "../build/identity.ts";

test("the product adapter owns both native version keys from the product version", async () => {
  const build = await mkdtemp(join(tmpdir(), "mochi-sdk-version-"));
  try {
    const application = join(build, "inner/Mochi.app");
    for (const file of [
      "MacOS/bun",
      "MacOS/launcher",
      "MacOS/bspatch",
      "MacOS/zig-zstd",
      "Resources/uninstall",
      "Resources/AppIcon.icns",
      "Resources/main.js",
      "Info.plist",
    ]) {
      const path = join(application, "Contents", file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "fixture");
    }
    await mkdir(join(build, "resources"));
    const commands: string[][] = [];
    expect(
      await prepareElectrobunBundle(
        build,
        desktopIdentity(true),
        async (args) => {
          commands.push(args);
          return args[1] === "--version" ? "1.4.0" : "";
        },
      ),
    ).toEqual({ application, runtimeVersion: "1.4.0" });
    expect(
      await Bun.file(
        join(application, "Contents/Resources/AppIcon.icns"),
      ).exists(),
    ).toBe(false);
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
      expect(commands.filter((args) => args[2] === key)).toEqual([
        [
          "/usr/bin/plutil",
          "-replace",
          key,
          "-string",
          version,
          join(application, "Contents/Info.plist"),
        ],
      ]);
    }
  } finally {
    await rm(build, { recursive: true, force: true });
  }
});

test("SDK layout drift stops assembly before adapting its delivery lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "mochi-sdk-contract-"));
  try {
    expect(() => assertElectrobunBundle(root)).toThrow();
    for (const file of [
      "MacOS/bun",
      "MacOS/launcher",
      "MacOS/bspatch",
      "MacOS/zig-zstd",
      "Resources/uninstall",
      "Resources/AppIcon.icns",
      "Resources/main.js",
      "Info.plist",
    ]) {
      const path = join(root, "Contents", file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "fixture");
    }
    expect(() => assertElectrobunBundle(root)).not.toThrow();
    await rm(join(root, "Contents/MacOS/launcher"));
    expect(() => assertElectrobunBundle(root)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "the shipped App runs its embedded bootstrap as Mochi without another executable or ambient config",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mochi-entrypoint-"));
    const application = join(directory, "Mochi Test.app");
    const binary = join(application, "Contents/MacOS/Mochi");
    const runtime = join(application, "Contents/MacOS/bun");
    const bootstrap = join(application, "Contents/Resources/main.js");
    try {
      await mkdir(dirname(runtime), { recursive: true });
      await mkdir(dirname(bootstrap), { recursive: true });
      await cp(process.execPath, runtime);
      await writeFile(
        bootstrap,
        "console.log(JSON.stringify({ executable: process.execPath, argv0: process.argv0, cwd: process.cwd(), runtime: Bun.version, ambient: process.env.MOCHI_AMBIENT_TEST ?? null }));",
      );
      const version = await compileDesktopEntrypoint(
        application,
        async (args) => {
          const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
          const [code, out, err] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code, err).toBe(0);
          return out;
        },
        process.execPath,
      );
      expect(version).toBe(Bun.version);
      for (const file of [
        runtime,
        bootstrap,
        join(dirname(bootstrap), "mochi-entry.ts"),
      ])
        expect(await Bun.file(file).exists()).toBe(false);
      await writeFile(
        join(application, "Contents/Info.plist"),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Mochi</string><key>CFBundleIdentifier</key><string>app.mochi.entrypoint-test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
      );
      await signDesktop(application);
      await requireBunEntitlements(application);
      await writeFile(
        join(directory, ".env"),
        "MOCHI_AMBIENT_TEST=unexpected\n",
      );
      await writeFile(
        join(directory, "bunfig.toml"),
        'preload = ["./unexpected.ts"]',
      );
      await writeFile(
        join(directory, "unexpected.ts"),
        'throw new Error("ambient preload");',
      );
      const child = Bun.spawn([binary], {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, err).toBe(0);
      expect(JSON.parse(out)).toEqual({
        executable: await realpath(binary),
        argv0: binary,
        cwd: await realpath(dirname(binary)),
        runtime: Bun.version,
        ambient: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test("a failed bootstrap compilation keeps its source runtime and never publishes a partial App", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mochi-entrypoint-failure-"));
  try {
    const resources = join(directory, "Contents/Resources");
    await mkdir(resources, { recursive: true });
    await mkdir(join(directory, "Contents/MacOS"));
    await writeFile(join(directory, "Contents/MacOS/bun"), "original runtime");
    await writeFile(join(resources, "main.js"), "original bootstrap");
    await expect(
      compileDesktopEntrypoint(
        directory,
        async (args) => {
          if (args[1] === "--version") return "1.4.0";
          throw new Error("compile failed");
        },
        "/pinned/bun",
      ),
    ).rejects.toThrow("compile failed");
    expect(await readFile(join(resources, "main.js"), "utf8")).toBe(
      "original bootstrap",
    );
    expect(await readFile(join(directory, "Contents/MacOS/bun"), "utf8")).toBe(
      "original runtime",
    );
    expect(await Bun.file(join(resources, "mochi-entry.ts")).exists()).toBe(
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native verification reports launcher exit immediately instead of waiting for stale readiness", async () => {
  for (const exitCode of [0, 1])
    await expect(
      verifyDesktop("/not-a-running-app.app", Date.now(), {
        exitCode,
        signalCode: null,
      }),
    ).rejects.toThrow(`Desktop launcher exited before readiness (${exitCode})`);
});
