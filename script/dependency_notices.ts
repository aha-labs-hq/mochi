import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

/** Preserve every shipped license and attribution, including SPDX LICENSES trees. */
export async function dependencyNotices(directory: string, fallbackLicense?: string): Promise<string> {
  const files: { path: string; label: string }[] = [];
  let hasLicense = false;
  async function collect(path: string, label: string): Promise<void> {
    const entry = await lstat(path);
    if (entry.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await collect(join(path, name), `${label}/${name}`);
    } else if (entry.isFile()) {
      files.push({ path, label });
    } else {
      throw new Error(`Unsupported dependency notice: ${path}`);
    }
  }
  for (const name of (await readdir(directory)).sort()) {
    if (!/^(licen[cs]es?|copying|copyright|notices?)([._-].*)?$/i.test(name)) continue;
    const before = files.length;
    await collect(join(directory, name), name);
    if (/^(licen[cs]es?|copying)([._-].*)?$/i.test(name) && files.length > before) hasLicense = true;
  }
  if (!hasLicense) {
    if (!fallbackLicense) throw new Error(`Missing distributable dependency license: ${directory}`);
    files.push({ path: fallbackLicense, label: basename(fallbackLicense) });
  }
  const sections = await Promise.all(files.map(async ({ path, label }) => {
    const text = (await readFile(path, "utf8")).trim();
    if (!text) throw new Error(`Empty dependency notice: ${path}`);
    return `${label}\n${text}`;
  }));
  return sections.join("\n\n");
}
