import type { Publication, SiteContext } from "./context.ts";
import { macName, maker, releaseName, tagline } from "./facts.ts";

/** Facts shared by visible pages and their search metadata. */
export interface PageMetadata {
  path: string;
  name: string;
  title: string;
  description: string;
  indexed: boolean;
  /** Workflow and editorial pages are articles; a hub exposes its visible list. */
  articleSection?: string;
  /** Only supplied when the publication date is also visible on the page. */
  datePublished?: string;
  /** Named personal author shown in the article byline; publisher stays separate. */
  author?: { name: string; url: string };
  collectionItems?: readonly { name: string; url: string }[];
}

export interface HeadAssets {
  favicon48: string;
  favicon96: string;
  touchIcon: string;
  shareImage: string;
}

/** The download page's title, sharing text and breadcrumb describe its phase. */
export function publicationPageMetadata(
  page: PageMetadata,
  site: SiteContext,
): PageMetadata {
  if (page.path !== "/download/" || !site.release) return page;
  const { minimumMacOS, architecture } = site.release;
  const name = releaseName(site.release);
  const device = macName(architecture);
  return {
    ...page,
    name: "下载 Mochi",
    title: `下载 ${name} · Mochi 麻薯`,
    description: `下载 ${name}，适用于 ${device}、macOS ${minimumMacOS} 或更新版本。查看安装方法、使用边界、卸载方式与文件校验值。`,
  };
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[char]};`,
  );

/**
 * What search engines read about a page. A release build knows the site's
 * origin from the publication record and is indexable; a preview is not.
 * Favicons are multiples of 48 px, the sizes Google Search shows.
 */
export function pageHead(
  page: PageMetadata,
  site: SiteContext,
  assets: HeadAssets,
) {
  page = publicationPageMetadata(page, site);
  const { favicon48, favicon96, touchIcon, shareImage } = assets;
  const origin = site.publication
    ? new URL(site.publication.downloadPageUrl).origin
    : "";
  const indexable = site.indexable && Boolean(site.publication) && page.indexed;
  const url = `${origin}${page.path}`;
  const image = `${origin}${shareImage}`;
  const meta = (key: "name" | "property", name: string, content: string) =>
    `<meta ${key}="${name}" content="${escapeHtml(content)}" />`;
  const tags = [
    `<title>${escapeHtml(page.title)}</title>`,
    meta("name", "description", page.description),
    meta(
      "name",
      "robots",
      indexable
        ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
        : "noindex",
    ),
    `<link rel="icon" type="image/png" sizes="48x48" href="${favicon48}" />`,
    `<link rel="icon" type="image/png" sizes="96x96" href="${favicon96}" />`,
    `<link rel="apple-touch-icon" href="${touchIcon}" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
    '<script defer src="/analytics.js?v=4"></script>',
    meta("property", "og:type", page.articleSection ? "article" : "website"),
    meta("property", "og:site_name", "Mochi 麻薯"),
    meta("property", "og:locale", "zh_CN"),
    meta("property", "og:title", page.title),
    meta("property", "og:description", page.description),
    meta("property", "og:image", image),
    meta("property", "og:image:width", "1200"),
    meta("property", "og:image:height", "630"),
    meta(
      "property",
      "og:image:alt",
      `麻薯趴在卡片边沿，卡片上写着 Mochi 麻薯：${tagline}`,
    ),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", page.title),
    meta("name", "twitter:description", page.description),
    meta("name", "twitter:image", image),
    meta("name", "twitter:image:alt", `Mochi 麻薯：${tagline}`),
  ];
  if (page.articleSection && page.datePublished)
    tags.push(meta("property", "article:published_time", page.datePublished));
  if (indexable)
    tags.push(
      `<link rel="canonical" href="${url}" />`,
      meta("property", "og:url", url),
      `<script type="application/ld+json">${JSON.stringify(
        structuredData(page, origin, site.publication!, shareImage),
      ).replace(/</g, "\\u003c")}</script>`,
    );
  return tags.join("\n    ");
}

/**
 * schema.org facts that match what the page itself shows. Mochi has no
 * public price or rating yet, so the application claims neither.
 */
function structuredData(
  page: PageMetadata,
  origin: string,
  publication: Publication,
  shareImage: string,
) {
  const organization = {
    "@type": "Organization",
    "@id": "https://ahalabs.site/#org",
    name: publication.publisherName,
    url: maker.url,
    sameAs: maker.sameAs,
  };
  const website = {
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: "Mochi 麻薯",
    alternateName: ["Mochi", "麻薯"],
    url: `${origin}/`,
    inLanguage: "zh-CN",
    publisher: { "@id": organization["@id"] },
  };
  const application = {
    "@type": "SoftwareApplication",
    "@id": `${origin}/#app`,
    name: "Mochi",
    alternateName: "麻薯",
    applicationCategory: "BusinessApplication",
    operatingSystem: "macOS",
    description:
      "Mochi 是飞书里的 AI GitHub 项目伙伴：从选定的项目查找答案并附上出处，把聊定的事接成有负责人的 Issue，再回到原事项跟进。",
    url: `${origin}/`,
    image: `${origin}${shareImage}`,
    publisher: { "@id": organization["@id"] },
    sameAs: [
      "https://ahalabs.site/en/#mochi",
      "https://kohozheng.com/work/mochi/",
      "https://github.com/aha-labs-hq/mochi",
    ],
  };
  const webpage = {
    "@type": "WebPage",
    "@id": `${origin}${page.path}#webpage`,
    name: page.title,
    description: page.description,
    url: `${origin}${page.path}`,
    inLanguage: "zh-CN",
    isPartOf: { "@id": website["@id"] },
    about: { "@id": application["@id"] },
    mainEntity: {
      "@id": page.articleSection
        ? `${origin}${page.path}#article`
        : application["@id"],
    },
    primaryImageOfPage: `${origin}${shareImage}`,
    ...(page.path === "/"
      ? {}
      : { breadcrumb: { "@id": `${origin}${page.path}#breadcrumb` } }),
  };
  const graph: Record<string, unknown>[] = [
    organization,
    website,
    application,
    webpage,
  ];
  if (page.articleSection) {
    graph.push({
      "@type": "Article",
      "@id": `${origin}${page.path}#article`,
      headline: page.name,
      description: page.description,
      inLanguage: "zh-CN",
      articleSection: page.articleSection,
      ...(page.datePublished ? { datePublished: page.datePublished } : {}),
      image: `${origin}${shareImage}`,
      url: `${origin}${page.path}`,
      author: page.author
        ? { "@type": "Person", name: page.author.name, url: page.author.url }
        : { "@id": organization["@id"] },
      publisher: { "@id": organization["@id"] },
      mainEntityOfPage: { "@id": webpage["@id"] },
    });
  }
  if (page.collectionItems?.length) {
    const itemListId = `${origin}${page.path}#items`;
    graph.push(
      {
        "@type": "CollectionPage",
        "@id": `${origin}${page.path}#collection`,
        url: `${origin}${page.path}`,
        name: page.name,
        description: page.description,
        inLanguage: "zh-CN",
        isPartOf: { "@id": website["@id"] },
        about: { "@id": application["@id"] },
        mainEntity: { "@id": itemListId },
      },
      {
        "@type": "ItemList",
        "@id": itemListId,
        name: page.name,
        itemListOrder: "https://schema.org/ItemListOrderAscending",
        numberOfItems: page.collectionItems.length,
        itemListElement: page.collectionItems.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.name,
          item: `${origin}${item.url}`,
        })),
      },
    );
  }
  if (page.path !== "/")
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${origin}${page.path}#breadcrumb`,
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "首页",
          item: `${origin}/`,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: page.name,
          item: `${origin}${page.path}`,
        },
      ],
    });
  return { "@context": "https://schema.org", "@graph": graph };
}
