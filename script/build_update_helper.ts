import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { developerIdApplicationRequirement } from "../controlApp/build/packageTrust.ts";
import {
  INSTALLER_WORK_ROOT,
  INSTALLER_UPDATE_ROOT,
  INSTALLER_TRANSACTION_ROOT,
  INSTALLED_APPLICATION_PATH,
  UPDATE_SERVICE_LABEL,
  UPDATE_SERVICE_SOCKET,
} from "../src/product/installation.ts";
import { INSTALLED_PRODUCT_ROOT } from "../src/product/layout.ts";
import { BRIDGE_USER_PATTERN } from "../src/runtime/sudoers.ts";
import distribution from "../release/distribution.json";
import updates from "../release/updates.json";
import product from "../package.json";

const repository = resolve(import.meta.dir, "..");
export const UPDATE_CACHE_SUFFIX =
  "/Library/Caches/app.mochi.companion/Updates";
export async function buildUpdateHelper(output: string): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("Mochi updates currently support Apple silicon macOS only");
  const work = await mkdtemp(join(tmpdir(), "mochi-update-build-"));
  const team = distribution.developerIdTeamId;
  if (!team)
    throw Error("Update helper requires the configured Developer ID Team");
  const fields = {
    root: INSTALLER_UPDATE_ROOT,
    workRoot: INSTALLER_WORK_ROOT,
    transactionRoot: INSTALLER_TRANSACTION_ROOT,
    application: INSTALLED_APPLICATION_PATH,
    hold: `${INSTALLED_PRODUCT_ROOT}/Installation/update-pending`,
    requirement: `${developerIdApplicationRequirement(team)} and identifier "app.mochi.companion"`,
    bridgeRequirement: developerIdApplicationRequirement(team),
    publicKey: updates.publicKey,
    feedURL: new URL(
      updates.feedPath,
      distribution.downloads.baseUrl,
    ).toString(),
    team,
    sudoers: "/etc/sudoers.d/mochi-pi-runtime",
    bridgeUserPattern: BRIDGE_USER_PATTERN.source,
    bridge: `${INSTALLED_PRODUCT_ROOT}/bin/mochi-bridge`,
    lark: `${INSTALLED_PRODUCT_ROOT}/bin/lark-cli`,
    cacheSuffix: UPDATE_CACHE_SUFFIX,
    productVersion: product.version,
    runtimeHome: "/Users/_mochi",
  };
  try {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      join(work, "Configuration.swift"),
      `enum UpdateConfiguration {\n${Object.entries(fields)
        .map(([key, value]) => `  static let ${key} = ${JSON.stringify(value)}`)
        .join("\n")}\n}\n`,
    );
    // Top-level Swift statements have exactly one entrypoint named main.swift.
    await writeFile(
      join(work, "main.swift"),
      await Bun.file(join(repository, "installer/update_main.swift")).text(),
    );
    // The helper can request system-administration consent during uninstall.
    // Give TCC a signed product identity and purpose, including when the App
    // has already closed for removal.
    await writeFile(join(work, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.mochi.update</string>
<key>CFBundleName</key><string>Mochi</string>
<key>CFBundleDisplayName</key><string>Mochi</string>
<key>CFBundleVersion</key><string>${product.version}</string>
<key>NSSystemAdministrationUsageDescription</key><string>卸载并删除全部数据时，Mochi 需要移除专用的后台运行账号。</string>
</dict></plist>\n`);
    await command([
      "xcrun",
      "clang",
      "-target",
      "arm64-apple-macos14.0",
      "-Wall",
      "-Werror",
      "-c",
      join(repository, "installer/update_peer.c"),
      "-o",
      join(work, "peer.o"),
    ]);
    await command(["xcrun", "clang", "-target", "arm64-apple-macos14.0", "-Wall", "-Werror",
      "-c", join(repository, "installer/durability.c"), "-o", join(work, "durability.o")]);
    await command([
      "xcrun",
      "swiftc",
      "-swift-version",
      "5",
      "-target",
      "arm64-apple-macos14.0",
      // Concurrent worktrees must not rebuild the same imported Clang module.
      "-module-cache-path",
      join(work, "modules"),
      "-O",
      "-import-objc-header",
      join(repository, "installer/update_peer.h"),
      "-framework",
      "Security",
      "-lsqlite3",
      "-lbsm",
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
      "-Xlinker", join(work, "Info.plist"),
      join(work, "Configuration.swift"),
      join(repository, "installer/update.swift"),
      join(work, "main.swift"),
      join(work, "peer.o"),
      join(work, "durability.o"),
      "-o",
      output,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function buildDurabilityTool(output: string): Promise<void> {
  await command(["xcrun", "clang", "-target", "arm64-apple-macos14.0", "-Wall", "-Werror",
    "-DMOCHI_DURABILITY_MAIN", join(repository, "installer/durability.c"), "-o", output]);
}

export function updateDaemonPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${UPDATE_SERVICE_LABEL}</string>
<key>AssociatedBundleIdentifiers</key><string>app.mochi.companion</string>
<key>ProgramArguments</key><array><string>${INSTALLED_PRODUCT_ROOT}/bin/mochi-update</string></array>
<key>WorkingDirectory</key><string>/var/empty</string>
<key>ProcessType</key><string>Background</string>
<key>Sockets</key><dict><key>Listener</key><dict>
<key>SockPathName</key><string>${UPDATE_SERVICE_SOCKET}</string>
<key>SockPathMode</key><integer>438</integer>
</dict></dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}
async function command(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0)
    throw Error("Native update helper build failed");
}
if (import.meta.main)
  await buildUpdateHelper(resolve(repository, "dist/mochi-update"));
