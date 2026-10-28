import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyNotices } from "../script/dependency_notices.ts";
import { writeDesktopNotices } from "../controlApp/build/notices.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mochi-notices-"));
  roots.push(root);
  return root;
}
test("SPDX license trees, dual licenses, copyright and NOTICE all survive packaging", async () => {
  const root = await fixture();
  await mkdir(join(root, "LICENSES/vendor"), { recursive: true });
  for (const [name, text] of Object.entries({
    "LICENSES/MIT.txt": "MIT copyright owner", "LICENSES/vendor/BSD.txt": "BSD conditions",
    "LICENSE-APACHE": "Apache conditions", NOTICE: "Required attribution", COPYRIGHT: "Copyright holder",
    "README.md": "Unrelated readme",
  })) await writeFile(join(root, name), text);
  const notices = await dependencyNotices(root);
  for (const text of ["MIT copyright owner", "BSD conditions", "Apache conditions", "Required attribution", "Copyright holder"])
    expect(notices).toContain(text);
  expect(notices).toContain("LICENSES/vendor/BSD.txt");
  expect(notices).not.toContain("Unrelated readme");
});
test("NOTICE alone is not a license; an explicit license supplement preserves NOTICE", async () => {
  const root = await fixture();
  await writeFile(join(root, "NOTICE"), "Required attribution");
  await expect(dependencyNotices(root)).rejects.toThrow("Missing distributable");
  const license = join(await fixture(), "LICENSE");
  await writeFile(license, "Upstream license");
  expect(await dependencyNotices(root, license)).toContain("NOTICE\nRequired attribution\n\nLICENSE\nUpstream license");
});
test("empty notices and links fail before unrelated local content can be distributed", async () => {
  const root = await fixture();
  await writeFile(join(root, "LICENSE"), "License text");
  await writeFile(join(root, "NOTICE"), " ");
  await expect(dependencyNotices(root)).rejects.toThrow("Empty dependency notice");
  await rm(join(root, "NOTICE"));
  await symlink(join(root, "LICENSE"), join(root, "NOTICE"));
  await expect(dependencyNotices(root)).rejects.toThrow("Unsupported dependency notice");
});
test("the desktop output contains NOTICE and every license from its actual package inventory", async () => {
  const root = await fixture();
  for (const path of ["controlApp/.build", "App/Contents/Resources", "third_party/bun"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "controlApp/.build/renderer-packages.json"), '["renderer"]');
  await writeFile(join(root, "third_party/bun/LICENSE.md"), "Bun license");
  for (const name of ["electrobun", "typebox", "renderer"]) {
    const directory = join(root, "node_modules", name);
    await mkdir(join(directory, "LICENSES"), { recursive: true });
    await writeFile(join(directory, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(directory, "LICENSES/MIT.txt"), `${name} license`);
    await writeFile(join(directory, "NOTICE"), `${name} attribution`);
  }
  await writeDesktopNotices(root, join(root, "App"), "1.4.2");
  const output = await readFile(join(root, "App/Contents/Resources/THIRD_PARTY_NOTICES.txt"), "utf8");
  for (const name of ["electrobun", "typebox", "renderer"])
    for (const kind of ["license", "attribution"]) expect(output).toContain(`${name} ${kind}`);
});
