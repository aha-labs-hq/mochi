import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Every input the desktop build downloads, pinned by digest. Electrobun's npm
 * shim would otherwise trust an index served by the same release and, when the
 * download fails, fall back to or install a machine-wide Hutch. Update these
 * pins together with package.json#devDependencies.electrobun, from the release's
 * published archive and `hutch-artifacts.json`.
 */
export const DESKTOP_TOOLCHAIN = {
  electrobun: "2.0.1",
  hutch: {
    version: "0.24.3",
    platform: "macos-arm64",
    url: "https://github.com/blackboardsh/electrobun/releases/download/v2.0.1/electrobun-hutch-macos-arm64.tar.gz",
    size: 1_238_046,
    sha256: "6e23aada3ec7630421efb1a3e523007c9611ac0f390eb3bf1a0004796a8a65f5",
  },
  /** Hutch's own record of the Electrobun core, Cottontail and Bun toolchain it installed. */
  dependencies: {
    schemaVersion: 1,
    kind: "hutch-project-dependencies",
    objects: [
      {
        type: "release",
        relativeRoot:
          "releases/cottontail/0.5.0/e5660061b8e64b5ea044799da8518780a9987391/macos-arm64",
        version: "0.5.0",
        platform: "macos-arm64",
        product: "cottontail",
        revision: "e5660061b8e64b5ea044799da8518780a9987391",
        archiveSha256:
          "65983ede8068663adacfe738ea6ae27615642a4af680e0d5d9831af345848ea6",
      },
      {
        type: "electrobun",
        relativeRoot: "releases/electrobun/2.0.1/macos-arm64",
        version: "2.0.1",
        platform: "macos-arm64",
        product: "electrobun",
        coreSha256:
          "2d10d46a7716e3fafee9a9fecb13eb8d78531e312fd0d792db85a1d7899a12b2",
        sourceManifestSha256:
          "e7978b03a3f06b0068160dd39532c59dc8e39b403c1626a7d1ce7831a7e07a95",
      },
      {
        type: "toolchain",
        relativeRoot: "toolchains/bun/1.4.0/macos-arm64",
        version: "1.4.0",
        platform: "macos-arm64",
        toolchain: "bun",
      },
    ],
  },
  /** The official bun-v1.4.0 darwin-aarch64 executable Hutch runs during the build. */
  hutchBunSha256:
    "539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf",
} as const;

interface HutchShim {
  ELECTROBUN_VERSION: string;
  PAIRED_HUTCH_VERSION: string;
  downloadedHutchRoot(
    environment: NodeJS.ProcessEnv,
    platform: string,
    userHome: string,
    platformKey: string,
  ): string;
  validateCachedHutch(
    root: string,
    platformKey: string,
    platform: string,
  ): string | null;
  installDownloadedArchive(options: {
    archive: Buffer;
    environment: NodeJS.ProcessEnv;
    platform: string;
    platformKey: string;
    root: string;
  }): string;
}

/**
 * Electrobun's environment with the pinned Hutch selected explicitly. The shim
 * then never resolves, downloads, falls back to or installs another Hutch.
 */
export async function pinnedElectrobunEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
  download: typeof fetch = fetch,
): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(
      "Mochi's desktop toolchain is pinned for Apple silicon Macs only",
    );
  const shim = hutchShim(root);
  const pin = DESKTOP_TOOLCHAIN.hutch;
  const cache = hutchCache(shim, environment);
  if (!existsSync(cache)) {
    const response = await download(pin.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(`Pinned Hutch download returned HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length !== pin.size || sha256(archive) !== pin.sha256)
      throw new Error(
        "Downloaded Hutch archive does not match its pinned digest",
      );
    shim.installDownloadedArchive({
      archive,
      environment,
      platform: "darwin",
      platformKey: pin.platform,
      root: cache,
    });
  }
  // A valid cache always carries the shim's manifest of the archive it unpacked.
  const binary = shim.validateCachedHutch(cache, pin.platform, "darwin");
  if (!binary || cachedArchiveSha256(cache) !== pin.sha256)
    throw new Error(
      `Hutch at ${cache} is not the pinned ${pin.version} archive; remove that directory and build again`,
    );
  return { ...environment, ELECTROBUN_HUTCH_BINARY: binary };
}

/** After Hutch resolves the project, its downloads must be exactly the pinned ones. */
export async function verifyDesktopToolchain(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const lock: unknown = JSON.parse(
    await readFile(join(root, ".hutch/dependencies.lock"), "utf8"),
  );
  if (!isDeepStrictEqual(lock, DESKTOP_TOOLCHAIN.dependencies))
    throw new Error(
      "Hutch resolved desktop dependencies that differ from the pinned toolchain",
    );
  const home = resolve(hutchCache(hutchShim(root), environment), "../../../..");
  const bun = DESKTOP_TOOLCHAIN.dependencies.objects.find(
    (entry) => entry.type === "toolchain",
  )!;
  if (
    sha256(await readFile(join(home, bun.relativeRoot, "bun"))) !==
    DESKTOP_TOOLCHAIN.hutchBunSha256
  )
    throw new Error("Hutch's Bun toolchain is not the pinned official build");
}

/** The App runs on the repository's pinned Bun, the same runtime as the Bridge and worker. */
export function pinnedBunRuntime(root: string): string {
  const { packageManager } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { packageManager: string };
  if (packageManager !== `bun@${Bun.version}`)
    throw new Error(
      `The desktop runtime must be ${packageManager}; this build runs bun@${Bun.version}`,
    );
  return process.execPath;
}

function hutchShim(root: string): HutchShim {
  const shim = createRequire(import.meta.url)(
    join(root, "node_modules/electrobun/bin/resolve-hutch.cjs"),
  ) as HutchShim;
  if (
    shim.ELECTROBUN_VERSION !== DESKTOP_TOOLCHAIN.electrobun ||
    shim.PAIRED_HUTCH_VERSION !== DESKTOP_TOOLCHAIN.hutch.version
  )
    throw new Error(
      "Electrobun changed; update DESKTOP_TOOLCHAIN pins together with it",
    );
  return shim;
}

function hutchCache(shim: HutchShim, environment: NodeJS.ProcessEnv): string {
  return shim.downloadedHutchRoot(
    environment,
    "darwin",
    homedir(),
    DESKTOP_TOOLCHAIN.hutch.platform,
  );
}

function cachedArchiveSha256(cache: string): unknown {
  return (
    JSON.parse(readFileSync(join(cache, ".electrobun-cache.json"), "utf8")) as {
      archiveSha256?: unknown;
    }
  ).archiveSha256;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
