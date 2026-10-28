import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

interface BuildMetadata {
  inputs: Record<string, unknown>;
}

interface BundledPackage {
  name: string;
  version: string;
  license: string;
  directory: string;
}

const repositoryRoot = resolve(import.meta.dir, "..");
const outputDirectory = join(repositoryRoot, "dist");
const workerPath = join(outputDirectory, "mochi-pi-runtime");
const bridgePath = join(outputDirectory, "mochi-bridge");
const noticesPath = join(outputDirectory, "THIRD_PARTY_NOTICES.txt");
const piLicensePath = join(repositoryRoot, "third_party", "pi", "LICENSE");
const mitLicensePath = join(repositoryRoot, "third_party", "MIT-LICENSE.txt");
const bunLicensePath = join(repositoryRoot, "third_party", "bun", "LICENSE.md");

const repositoryManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
) as { packageManager?: unknown };
if (repositoryManifest.packageManager !== `bun@${Bun.version}`) {
  throw new Error(
    `Runtime build requires ${String(repositoryManifest.packageManager)}, current bun@${Bun.version}`,
  );
}

await mkdir(outputDirectory, { recursive: true });
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mochi-pi-build-"));
const workerMetadataPath = join(temporaryDirectory, "worker-bundle.json");
const bridgeMetadataPath = join(temporaryDirectory, "bridge-bundle.json");

try {
  await compile("Pi runtime", join(repositoryRoot, "src", "runtime", "worker.ts"), workerPath, workerMetadataPath);
  await compile("Bridge", join(repositoryRoot, "src", "index.ts"), bridgePath, bridgeMetadataPath);
  const workerMetadata = JSON.parse(await readFile(workerMetadataPath, "utf8")) as BuildMetadata;
  const bridgeMetadata = JSON.parse(await readFile(bridgeMetadataPath, "utf8")) as BuildMetadata;
  assertWorkerRuntimeModules(workerMetadata);
  const packages = await bundledPackages([
    ...Object.keys(workerMetadata.inputs),
    ...Object.keys(bridgeMetadata.inputs),
  ]);
  await writeFile(noticesPath, await renderNotices(packages), { mode: 0o644 });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function assertWorkerRuntimeModules(metadata: BuildMetadata): void {
  const inputs = Object.keys(metadata.inputs);
  for (const suffix of [
    "@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
    "@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js",
    "@earendil-works/pi-ai/dist/auth/oauth/callback-server.js",
    "src/oauthPage.ts",
    "controlApp/Resources/MochiCompanion.png",
    "src/oauthFelt.webp",
  ]) {
    if (!inputs.some((input) => input.endsWith(suffix))) {
      throw new Error(`Pi runtime bundle omitted required module: ${suffix}`);
    }
  }
}

async function compile(name: string, entry: string, output: string, metadata: string): Promise<void> {
  const build = Bun.spawn({
    cmd: [process.execPath, "build", "--compile", entry, `--outfile=${output}`, `--metafile=${metadata}`],
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) throw new Error(`${name} build exited ${exitCode}`);
}

async function bundledPackages(inputs: readonly string[]): Promise<BundledPackage[]> {
  const directories = new Set<string>();
  for (const input of inputs) {
    const parts = input.split("/");
    const nodeModulesIndex = parts.lastIndexOf("node_modules");
    if (nodeModulesIndex < 0 || nodeModulesIndex + 1 >= parts.length) continue;
    const packageLength = parts[nodeModulesIndex + 1]?.startsWith("@") ? 2 : 1;
    const packageParts = parts.slice(0, nodeModulesIndex + 1 + packageLength);
    directories.add(await realpath(resolve(repositoryRoot, ...packageParts)));
  }

  const packages = await Promise.all([...directories].map(async (directory) => {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      license?: unknown;
    };
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || typeof manifest.license !== "string") {
      throw new Error(`Bundled package has an incomplete identity or license: ${directory}`);
    }
    return { name: manifest.name, version: manifest.version, license: manifest.license, directory };
  }));
  return packages.sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

async function renderNotices(packages: readonly BundledPackage[]): Promise<string> {
  const bunLicense = (await readFile(bunLicensePath, "utf8")).trim();
  const sections = await Promise.all(packages.map(async (entry) => {
    const files = (await readdir(entry.directory, { withFileTypes: true }))
      .filter((item) => item.isFile() && /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(item.name))
      .map((item) => join(entry.directory, item.name))
      .sort();
    // Pi's scoped runtime packages, including the composition runtime added in
    // newer releases, publish the same upstream MIT license but omit a file.
    if (files.length === 0 && entry.name.startsWith("@earendil-works/")) files.push(piLicensePath);
    if (files.length === 0 && entry.license === "MIT") files.push(mitLicensePath);
    if (files.length === 0) throw new Error(`Bundled package has no distributable license text: ${entry.name}@${entry.version}`);
    const texts = await Promise.all(files.map(async (path) =>
      `${basename(path)}\n${(await readFile(path, "utf8")).trim()}`));
    return `${entry.name}@${entry.version} (${entry.license})\n${"-".repeat(72)}\n${texts.join("\n\n")}`;
  }));
  return [
    "Mochi Runtime — Third-Party Notices",
    "",
    "Generated from the exact dependency graph bundled into mochi-bridge and mochi-pi-runtime.",
    "This file must accompany every distributed copy of those executables.",
    "",
    `Bun ${Bun.version} standalone runtime`,
    "------------------------------------------------------------------------",
    bunLicense,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}
