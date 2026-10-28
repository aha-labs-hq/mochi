import { lstatSync } from "node:fs";
import { cp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { version } from "../../package.json";
import { MINIMUM_MACOS_VERSION } from "../../src/product/version.ts";
import type { desktopIdentity } from "./identity.ts";
import { pinnedBunRuntime } from "./toolchain.ts";

const SDK_LIFECYCLE_FILES = [
  "MacOS/launcher",
  "MacOS/bspatch",
  "MacOS/zig-zstd",
  "Resources/uninstall",
];

export function assertElectrobunBundle(application: string): void {
  for (const path of [
    "MacOS/bun",
    ...SDK_LIFECYCLE_FILES,
    "Resources/main.js",
    "Info.plist",
  ]) {
    const entry = lstatSync(join(application, "Contents", path));
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("Electrobun bundle contract changed");
  }
}

/** The only adapter from Electrobun delivery to Mochi's existing product lifecycle. */
export async function prepareElectrobunBundle(
  build: string,
  identity: ReturnType<typeof desktopIdentity>,
  command: (args: string[]) => Promise<string>,
): Promise<{ application: string; runtimeVersion: string }> {
  const staged = join(build, "inner/Mochi.app");
  assertElectrobunBundle(staged);
  await cp(join(build, "resources"), join(staged, "Contents/Resources"), {
    recursive: true,
  });
  const runtimeVersion = await compileDesktopEntrypoint(
    staged,
    command,
    pinnedBunRuntime(resolve(import.meta.dir, "../..")),
  );
  // These belong to Electrobun's optional installation/update lifecycle, not ours.
  for (const relative of SDK_LIFECYCLE_FILES)
    await rm(join(staged, "Contents", relative));
  const plist = join(staged, "Contents/Info.plist");
  for (const [key, value] of Object.entries({
    CFBundleExecutable: "Mochi",
    CFBundleName: identity.name,
    CFBundleDisplayName: identity.name,
    CFBundleIdentifier: identity.identifier,
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    CFBundleIconFile: "Mochi.icns",
    LSMinimumSystemVersion: MINIMUM_MACOS_VERSION,
    NSHumanReadableCopyright: "Mochi",
  })) {
    await command([
      "/usr/bin/plutil",
      "-replace",
      key,
      "-string",
      value,
      plist,
    ]);
  }
  return { application: staged, runtimeVersion };
}

/** LaunchServices must register the executable that owns AppKit, without an exec
 * replacing its audit identity. Compile the untouched SDK bootstrap with the
 * repository's pinned Bun, so the App runs the same runtime as the Bridge and
 * worker; the SDK's own Bun, its installer and a second runtime process are dropped. */
export async function compileDesktopEntrypoint(
  application: string,
  command: (args: string[]) => Promise<string>,
  runtime: string,
): Promise<string> {
  const runtimeVersion = (await command([runtime, "--version"])).trim();
  if (!/^\d+\.\d+\.\d+$/.test(runtimeVersion))
    throw new Error("Cannot identify the desktop Bun runtime");
  const bootstrap = join(application, "Contents/Resources/main.js");
  const entry = join(application, "Contents/Resources/mochi-entry.ts");
  try {
    await writeFile(
      entry,
      'import { dirname } from "node:path";\n' +
        "process.chdir(dirname(process.execPath));\n" +
        'await import("./main.js");\n',
    );
    await command([
      runtime,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--outfile",
      join(application, "Contents/MacOS/Mochi"),
      entry,
    ]);
  } finally {
    await rm(entry, { force: true });
  }
  await rm(join(application, "Contents/MacOS/bun"));
  await rm(bootstrap);
  return runtimeVersion;
}
