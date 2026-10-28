/**
 * Builds the static website into `site/dist`.
 *
 *   bun run site:build                          preview: issuer facts pending, noindex
 *   bun run site:build -- --publication <json>  temporary: real issuer, noindex
 *   bun run site:build -- --publication <json> --indexable  canonical domain: indexable
 *
 * The publication record is the same schema-1 file release staging consumes, so
 * the website and the published documents name one issuer, one download page
 * and one support entry. Its download page must be this website's /download/.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { build } from "vite";
import {
  type PublicationDetails,
  type PublicDocumentField,
  parsePublicationDetails,
  publicDocumentFields,
  renderPublicDocument,
} from "../../script/stage_release_publication.ts";
import {
  PENDING,
  PENDING_LINK,
  type Publication,
  type SiteContext,
} from "../src/context.ts";
import { tagline } from "../src/facts.ts";
import { entranceStage } from "../src/motion.ts";
import { pagesHeaders } from "./headers.ts";
import { INDEXNOW_KEY } from "./indexnow.ts";
import { websiteRelease, websiteReleaseInput } from "./release.ts";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const server = join(dist, ".server");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    publication: { type: "string" },
    indexable: { type: "boolean", default: false },
    "public-beta": { type: "boolean", default: false },
    "release-manifest": { type: "string" },
    "verification-result": { type: "string" },
    "acceptance-record": { type: "string", multiple: true },
    "artifact-base-url": { type: "string" },
  },
});
if (values.indexable && !values.publication)
  throw new Error(
    "Indexing requires reviewed publication details and the canonical domain",
  );

async function publication(
  path: string | undefined,
  acceptedDetails?: PublicationDetails,
) {
  if (!path) return null;
  const details =
    acceptedDetails ??
    parsePublicationDetails(JSON.parse(await readFile(resolve(path), "utf8")));
  const download = new URL(details.downloadPageUrl);
  if (download.pathname !== "/download/" || download.search || download.hash)
    throw new Error(
      "The publication's download page must be this site's /download/",
    );
  const { schemaVersion: _, ...facts } = details;
  return {
    facts: facts satisfies Publication,
    fields: publicDocumentFields(details),
  };
}

const paletteText = await readFile(
  join(root, "../controlApp/src/ui/palette.css"),
  "utf8",
);
const releaseInput = websiteReleaseInput(resolve(root, ".."), {
  publicBeta: values["public-beta"],
  ...(values["release-manifest"] !== undefined
    ? {
        candidateManifestPath: values["release-manifest"],
      }
    : {}),
  ...(values["verification-result"] !== undefined
    ? {
        verificationResultPath: values["verification-result"],
      }
    : {}),
  ...(values.publication && {
    publicationDetailsPath: resolve(values.publication),
  }),
  acceptanceRecordPaths: values["acceptance-record"] ?? [],
  ...(values["artifact-base-url"] !== undefined
    ? {
        artifactBaseUrl: values["artifact-base-url"],
      }
    : {}),
});
const accepted = releaseInput ? await websiteRelease(releaseInput) : null;
const reviewed = await publication(values.publication, accepted?.details);
const fields: Record<PublicDocumentField, string> = reviewed?.fields ?? {
  PUBLISHER_NAME: `（${PENDING}）`,
  DOWNLOAD_PAGE_URL: "/download/",
  SUPPORT_URL: PENDING_LINK,
  PRIVACY_CONTACT_EMAIL: `（${PENDING}）`,
};
const document = async (name: string) =>
  renderPublicDocument(
    await readFile(join(root, "../release/public", name), "utf8"),
    fields,
  );
const site: SiteContext = {
  publication: reviewed?.facts ?? null,
  release: accepted?.release ?? null,
  indexable: values.indexable,
  documents: {
    guide: await document("quick-start.md"),
    privacy: await document("privacy.md"),
  },
};
const shared = {
  root,
  configFile: join(root, "vite.config.ts"),
  logLevel: "warn" as const,
};
await build({ ...shared, build: { outDir: dist, emptyOutDir: true } });
await build({
  ...shared,
  build: {
    ssr: "src/entry-server.tsx",
    ssrEmitAssets: true,
    outDir: server,
    emptyOutDir: true,
  },
});

// Server-only sections own most pictures; keep their files, not their code.
const media = new Set([".avif", ".webp", ".png", ".jpg", ".svg", ".woff2"]);
for (const file of await readdir(join(server, "assets")).catch(() => []))
  if (media.has(extname(file)))
    await cp(join(server, "assets", file), join(dist, "assets", file), {
      force: false,
    });

const template = await readFile(join(dist, "index.html"), "utf8");
for (const marker of ["<!--site-head-->", "<!--site-body-->"])
  if (!template.includes(marker)) throw new Error(`Template lacks ${marker}`);
const { pages, render, SHARE_IMAGE, manifestIcons } = (await import(
  join(server, "entry-server.js")
)) as typeof import("../src/entry-server.tsx");
const documents: string[] = [];
for (const page of pages) {
  const { head, body } = render(page.path, site);
  const file = join(dist, page.file);
  const html = template
    .replace("<!--site-head-->", () => head)
    .replace("<!--site-body-->", () => body);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
  documents.push(html);
}
await rm(server, { recursive: true });
await writeFile(join(dist, SHARE_IMAGE), await shareImage());

// Crawlers must be able to read the noindex meta tags. The sitemap is generated
// only when indexing was explicitly enabled for the canonical public domain.
const origin = site.publication
  ? new URL(site.publication.downloadPageUrl).origin
  : null;
await writeFile(
  join(dist, "robots.txt"),
  site.indexable && origin
    ? `User-agent: OAI-SearchBot\nContent-signal: ai-train=no, search=yes, ai-input=yes\nAllow: /\n\nUser-agent: *\nContent-signal: ai-train=no, search=yes, ai-input=yes\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
    : "User-agent: OAI-SearchBot\nContent-signal: ai-train=no, search=yes, ai-input=yes\nAllow: /\n\nUser-agent: *\nContent-signal: ai-train=no, search=yes, ai-input=yes\nAllow: /\n",
);
if (site.indexable && origin) {
  const urls = pages
    .filter((page) => page.indexed)
    .map((page) => `  <url>\n    <loc>${origin}${page.path}</loc>\n  </url>`);
  await writeFile(
    join(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
  );
  await writeFile(join(dist, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);
}
const paper = palette("surface");
await writeFile(
  join(dist, "site.webmanifest"),
  `${JSON.stringify(
    {
      name: "Mochi 麻薯",
      short_name: "Mochi",
      lang: "zh-CN",
      start_url: "/",
      display: "browser",
      background_color: paper,
      theme_color: paper,
      icons: manifestIcons,
    },
    null,
    2,
  )}\n`,
);
await writeFile(join(dist, "_headers"), pagesHeaders(documents));

/** A colour from the shared palette, which owns every colour the site uses. */
function palette(name: string) {
  const value = paletteText.match(
    new RegExp(`--color-${name}: (#[0-9a-f]{6});`),
  )?.[1];
  if (!value) throw new Error(`Palette lacks --color-${name}`);
  return value;
}

/**
 * The link preview: Mochi resting its paws on a card that names it. The text
 * is set in PingFang SC, which macOS provides to the build.
 */
async function shareImage() {
  const color = palette;
  const [width, height, edge, catWidth] = [1200, 630, 392, 340];
  const text = (
    y: number,
    size: number,
    weight: number,
    fill: string,
    words: string,
  ) =>
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="PingFang SC" font-size="${size}" font-weight="${weight}" fill="${fill}">${words}</text>`;
  const scene =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><filter id="s" x="-10%" y="-20%" width="120%" height="160%"><feGaussianBlur stdDeviation="22"/></filter></defs>
    <rect width="${width}" height="${height}" fill="${color("surface")}"/>
    <rect x="186" y="${edge + 26}" width="828" height="320" rx="28" fill="#000" opacity="0.10" filter="url(#s)"/>
    <rect x="170" y="${edge}" width="860" height="320" rx="28" fill="${color("card")}"/>
    ${text(edge + 112, 60, 600, color("ink"), "Mochi 麻薯")}
    ${text(edge + 176, 34, 400, color("muted"), tagline)}
  </svg>`);
  const { rootSize, rootY, bodyBottom } = entranceStage;
  const ratio = catWidth / rootSize;
  const cat = await sharp(
    join(root, "../controlApp/Resources/MochiCompanion.png"),
  )
    .resize({ width: catWidth })
    .toBuffer();
  return sharp(scene)
    .composite([
      {
        input: cat,
        left: Math.round(width / 2 - catWidth / 2),
        top: Math.round(edge - (bodyBottom - rootY) * ratio),
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
console.log(
  `Website ${site.indexable ? "indexable" : "noindex"} build: ${pages.length} pages in ${relative(process.cwd(), dist)}`,
);
