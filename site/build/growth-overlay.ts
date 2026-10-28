/** Extend the approved production artifact without publishing pending app/site work. */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { betaApplicationUrl } from "../src/facts.ts";

const [baseArg, builtArg, outArg] = Bun.argv.slice(2);
if (!baseArg || !builtArg || !outArg)
  throw new Error(
    "Usage: bun site/build/growth-overlay.ts <approved-artifact> <built-site> <new-output>",
  );
const base = resolve(baseArg),
  built = resolve(builtArg),
  output = resolve(outArg);
if (
  [base, built].some(
    (path) =>
      output === path ||
      output.startsWith(path + sep) ||
      path.startsWith(output + sep),
  )
)
  throw new Error("Output must be separate from both inputs");
await mkdir(output); // Never overwrite an existing artifact.
await cp(base, output, { recursive: true });

const existing = [
  "index.html",
  "download/index.html",
  "start/index.html",
  "privacy/index.html",
  "admin/index.html",
];
const added = [
  "workflows/index.html",
  "workflows/discussion-to-issue/index.html",
  "workflows/project-answers/index.html",
];
const footerLink =
  '<li><a href="/start/" class="transition-colors hover:text-primary">上手指南</a></li>';
const newLink =
  '<li><a href="/workflows/" class="transition-colors hover:text-primary">实际用法</a></li>';
function once(text: string, before: string, after: string) {
  if (text.split(before).length !== 2)
    throw new Error(`Approved artifact changed at ${before.slice(0, 70)}`);
  return text.replace(before, after);
}
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
for (const file of existing) {
  let html = await readFile(join(base, file), "utf8");
  html = once(html, "/analytics.js?v=3", "/analytics.js?v=4");
  html = once(html, footerLink, footerLink + newLink);
  if (file === "start/index.html") {
    html = once(
      html,
      ">开始使用 Mochi</h1>",
      '>开始使用 Mochi</h1><p class="my-4"><strong>当前尚无公开下载。</strong>请先<a href="/download/" class="text-primary underline">申请内测</a>。以下步骤从收到内测安装包开始；安装、更新和卸载以该版本随附的说明为准。</p>',
    );
    html = once(
      html,
      "官方下载页</a> 下载适合你设备的",
      "安装与内测说明</a>，取得适合你设备的",
    );
  }
  if (file === "download/index.html") {
    // The page also has a footer support link to the same form in the old
    // artifact. Mark only the visible application CTA as a conversion intent.
    const betaCta = new RegExp(
      `<a\\s+href="${escapeRegExp(betaApplicationUrl)}"[^>]*>填写内测申请`,
    );
    const matches = html.match(betaCta);
    if (matches?.length !== 1) throw new Error("Approved download CTA changed");
    html = html.replace(betaCta, (anchor) =>
      anchor.replace(
        `href="${betaApplicationUrl}"`,
        'href="__MOCHI_BETA_CTA__" data-analytics-event="beta_form_open"',
      ),
    );
  }
  // The approved artifact's old support links pointed at the application
  // table. Keep the application CTA above, but make every support surface
  // reach the authoritative support mailbox.
  html = html.replaceAll(
    `href="${betaApplicationUrl}"`,
    'href="mailto:hello@mochi.host"',
  );
  if (file === "admin/index.html")
    html = html.replaceAll(`>${betaApplicationUrl}<`, ">hello@mochi.host<");
  if (file === "download/index.html")
    html = html.replace(
      'href="__MOCHI_BETA_CTA__"',
      `href="${betaApplicationUrl}"`,
    );
  await writeFile(join(output, file), html);
}
// The approved 404 page has no current analytics entry, but its footer still
// contained the retired application-table support URL.
const notFound = join(output, "404.html");
if (await Bun.file(notFound).exists()) {
  const html = (await readFile(notFound, "utf8")).replaceAll(
    `href="${betaApplicationUrl}"`,
    'href="mailto:hello@mochi.host"',
  );
  await writeFile(notFound, html);
}

const assetQueue = new Set<string>();
const discover = (text: string) => {
  for (const match of text.matchAll(/\/assets\/[A-Za-z0-9_.%+-]+/g))
    assetQueue.add(match[0].slice(1));
};
for (const file of added) {
  // These reading pages use native links/details; no current app-derived client bundle is needed.
  const html = (await readFile(join(built, file), "utf8"))
    .replace(/<script\b[^>]*type="module"[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, "");
  discover(html);
  await mkdir(dirname(join(output, file)), { recursive: true });
  await writeFile(join(output, file), html);
}
for (const file of assetQueue) {
  const bytes = await readFile(join(built, file));
  const target = Bun.file(join(output, file));
  if (await target.exists()) {
    if (!Buffer.from(await target.arrayBuffer()).equals(bytes))
      throw new Error(`Immutable asset changed: ${file}`);
  } else {
    await mkdir(dirname(join(output, file)), { recursive: true });
    await writeFile(join(output, file), bytes);
  }
  if (file.endsWith(".css")) discover(bytes.toString());
}
await cp(join(built, "analytics.js"), join(output, "analytics.js"));
const sitemap = once(
  await readFile(join(base, "sitemap.xml"), "utf8"),
  "</urlset>",
  `${added
    .map(
      (file) =>
        `<url><loc>https://mochi.host/${file.replace("index.html", "")}</loc></url>`,
    )
    .join("\n")}\n</urlset>`,
);
await writeFile(join(output, "sitemap.xml"), sitemap);
await writeFile(
  join(output, "_headers"),
  (await readFile(join(base, "_headers"), "utf8")) +
    "\n/workflows/*\n  Cache-Control: public, max-age=0, must-revalidate\n",
);

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function filePaths(directory: string, prefix = ""): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await filePaths(join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      paths.push(relative);
    }
  }
  return paths;
}

const files: {
  path: string;
  sha256: string;
  bytes: number;
  changed: boolean;
}[] = [];
for (const file of (await filePaths(output)).sort()) {
  const target = Bun.file(join(output, file));
  if (!(await target.exists())) continue;
  const bytes = Buffer.from(await target.arrayBuffer());
  const original = Bun.file(join(base, file));
  files.push({
    path: file,
    sha256: digest(bytes),
    bytes: bytes.length,
    changed:
      !(await original.exists()) ||
      !Buffer.from(await original.arrayBuffer()).equals(bytes),
  });
}
await writeFile(
  `${output}.manifest.json`,
  `${JSON.stringify({ base, built, output, files }, null, 2)}\n`,
);
console.log(
  `Overlay: ${files.length} files, ${files.filter((file) => file.changed).length} new or changed; existing assets retained.`,
);
