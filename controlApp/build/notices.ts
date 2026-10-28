import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Shipped JS/CSS packages plus the embedded native Bun runtime. No network at build time. */
export async function writeDesktopNotices(
  root: string,
  application: string,
  runtimeVersion: string,
): Promise<void> {
  const sections = ["Mochi Desktop — Third-Party Notices"];
  const rendererPackages: unknown = JSON.parse(
    await readFile(
      join(root, "controlApp/.build/renderer-packages.json"),
      "utf8",
    ),
  );
  if (
    !Array.isArray(rendererPackages) ||
    !rendererPackages.every(
      (name) =>
        typeof name === "string" &&
        /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name),
    )
  )
    throw new Error("Missing renderer package inventory");
  // Host SDK and action validation are Bun imports, not renderer chunks.
  for (const name of [
    ...new Set(["electrobun", "typebox", ...(rendererPackages as string[])]),
  ].sort()) {
    const directory = join(root, "node_modules", name);
    const metadata = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { version: string };
    const licenseFile = (await readdir(directory)).find((entry) =>
      /^licen[sc]e(?:\.(?:txt|md))?$/i.test(entry),
    );
    if (!licenseFile) throw new Error(`Missing desktop license: ${name}`);
    const license = await readFile(join(directory, licenseFile), "utf8");
    if (!metadata.version || !license.trim())
      throw new Error(`Missing desktop attribution: ${name}`);
    sections.push(`${name}@${metadata.version}\n${license}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(runtimeVersion))
    throw new Error("Cannot identify embedded desktop Bun");
  sections.push(
    `Bun ${runtimeVersion}\n${await readFile(join(root, "third_party/bun/LICENSE.md"), "utf8")}`,
  );
  await writeFile(
    join(application, "Contents/Resources/THIRD_PARTY_NOTICES.txt"),
    sections.join(
      "\n\n------------------------------------------------------------------------\n\n",
    ),
  );
}
