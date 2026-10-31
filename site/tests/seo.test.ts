import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePublicationDetails } from "../../script/stage_release_publication.ts";
import { type SiteContext, supportText } from "../src/context.ts";
import { maker } from "../src/facts.ts";
import { type PageMetadata, pageHead } from "../src/seo.ts";
import { superagentArticle } from "../src/superagent.ts";

const page: PageMetadata = {
  path: "/",
  name: "首页",
  title: "Mochi 麻薯",
  description: "飞书群里的项目伙伴",
  indexed: true,
};
const assets = {
  favicon48: "/assets/icon-48.png",
  favicon96: "/assets/icon-96.png",
  touchIcon: "/assets/touch.png",
  shareImage: "/og.png",
};
const site: SiteContext = {
  indexable: true,
  release: null,
  publication: {
    publisherName: "Aha Labs",
    downloadPageUrl: "https://mochi-ahalabs.pages.dev/download/",
    supportUrl: "mailto:hello@ahalabs.site",
    privacyContactEmail: "hello@ahalabs.site",
  },
  documents: { guide: "", privacy: "" },
};
const graph = (head: string) => {
  const script = head.match(
    /<script type="application\/ld\+json">(.*?)<\/script>/s,
  );
  if (!script) throw new Error("Missing structured data");
  return JSON.parse(script[1]!)["@graph"];
};

describe("website search publication", () => {
  test("personal editorial authorship is distinct from its publisher", () => {
    const head = pageHead(
      { ...superagentArticle, indexed: true },
      site,
      assets,
    );
    const article = graph(head).find(
      (node: Record<string, unknown>) => node["@type"] === "Article",
    );
    expect(article.author).toEqual({
      "@type": "Person",
      ...superagentArticle.author,
    });
    expect(article.publisher).toEqual({ "@id": "https://ahalabs.site/#org" });
    expect(article.headline).toBe(superagentArticle.name);
  });

  test("dated articles agree across sharing and structured metadata without inventing dates", () => {
    const article: PageMetadata = {
      ...page,
      path: "/insights/example/",
      name: "A sourced editorial",
      articleSection: "Mochi 观点",
      datePublished: "2026-11-01",
    };
    const head = pageHead(article, site, assets);
    expect(head).toContain('property="og:type" content="article"');
    expect(head).toContain(
      'property="article:published_time" content="2026-11-01"',
    );
    const entity = graph(head).find(
      (node: Record<string, unknown>) => node["@type"] === "Article",
    );
    expect(entity.datePublished).toBe(article.datePublished);
    expect(entity.headline).toBe(article.name);
    expect(entity.url).toBe(
      "https://mochi-ahalabs.pages.dev/insights/example/",
    );
    expect(entity.author["@id"]).toBe("https://ahalabs.site/#org");
    expect(entity).not.toHaveProperty("dateModified");

    const { datePublished: _, ...undated } = article;
    const undatedHead = pageHead(undated, site, assets);
    expect(undatedHead).not.toContain("article:published_time");
    expect(
      graph(undatedHead).find(
        (node: Record<string, unknown>) => node["@type"] === "Article",
      ),
    ).not.toHaveProperty("datePublished");
    expect(pageHead(page, site, assets)).toContain(
      'property="og:type" content="website"',
    );
  });

  test("previews cannot claim a public canonical URL or invite indexing", () => {
    const head = pageHead(page, { ...site, publication: null }, assets);
    expect(head).toContain('name="robots" content="noindex"');
    expect(head).not.toContain('rel="canonical"');
    expect(head).not.toContain("application/ld+json");
  });

  test("published metadata uses the reviewed origin and real publisher", () => {
    const head = pageHead(page, site, assets);
    expect(head).toContain(
      'rel="canonical" href="https://mochi-ahalabs.pages.dev/"',
    );
    expect(head).toContain('name="robots" content="index, follow');
    expect(head).toContain(
      'property="og:image" content="https://mochi-ahalabs.pages.dev/og.png"',
    );
    const nodes = graph(head);
    const organization = nodes.find(
      (node: Record<string, unknown>) => node["@type"] === "Organization",
    );
    expect(organization.name).toBe("Aha Labs");
    // The maker's own site and profiles, not the product's.
    expect(organization.url).toBe(maker.url);
    expect(organization.sameAs).toEqual(maker.sameAs);
    const app = nodes.find(
      (node: Record<string, unknown>) =>
        node["@type"] === "SoftwareApplication",
    );
    expect(app.operatingSystem).toBe("macOS");
    expect(app.sameAs).toEqual([
      "https://ahalabs.site/en/#mochi",
      "https://kohozheng.com/work/mochi/",
      "https://github.com/aha-labs-hq/mochi",
    ]);
    expect(app).not.toHaveProperty("offers");
    expect(app).not.toHaveProperty("aggregateRating");
    expect(
      nodes.some(
        (node: Record<string, unknown>) => node["@type"] === "FAQPage",
      ),
    ).toBe(false);
    expect(
      nodes.some(
        (node: Record<string, unknown>) =>
          node["@id"] === "https://mochi-ahalabs.pages.dev/#app",
      ),
    ).toBe(true);
  });

  test("a temporary site can name its real publisher without being indexed", () => {
    const head = pageHead(page, { ...site, indexable: false }, assets);
    expect(head).toContain('name="robots" content="noindex"');
    expect(head).toContain(
      'property="og:image" content="https://mochi-ahalabs.pages.dev/og.png"',
    );
    expect(head).not.toContain('rel="canonical"');
    expect(head).not.toContain("application/ld+json");
  });

  test("subpages describe the same URL as their canonical and breadcrumb", () => {
    const head = pageHead(
      { ...page, path: "/admin/", name: "给管理员的说明" },
      site,
      assets,
    );
    expect(head).toContain(
      'rel="canonical" href="https://mochi-ahalabs.pages.dev/admin/"',
    );
    const breadcrumb = graph(head).find(
      (node: Record<string, unknown>) => node["@type"] === "BreadcrumbList",
    );
    expect(breadcrumb.itemListElement[1]).toMatchObject({
      name: "给管理员的说明",
      item: "https://mochi-ahalabs.pages.dev/admin/",
    });
    const nodes = graph(head);
    expect(
      nodes.some(
        (node: Record<string, unknown>) => node["@type"] === "Organization",
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (node: Record<string, unknown>) =>
          node["@type"] === "SoftwareApplication",
      ),
    ).toBe(true);
    expect(
      nodes.find(
        (node: Record<string, unknown>) => node["@type"] === "WebPage",
      ),
    ).toMatchObject({
      about: { "@id": "https://mochi-ahalabs.pages.dev/#app" },
      mainEntity: { "@id": "https://mochi-ahalabs.pages.dev/#app" },
    });
  });

  test("workflow pages expose an article and the hub exposes its visible list", () => {
    const articleHead = pageHead(
      {
        ...page,
        path: "/workflows/project-answers/",
        name: "在飞书里查 GitHub 项目",
        articleSection: "Mochi 工作流",
      },
      site,
      assets,
    );
    const article = graph(articleHead).find(
      (node: Record<string, unknown>) => node["@type"] === "Article",
    );
    expect(article).toMatchObject({
      articleSection: "Mochi 工作流",
      mainEntityOfPage: {
        "@id":
          "https://mochi-ahalabs.pages.dev/workflows/project-answers/#webpage",
      },
    });
    const hubHead = pageHead(
      {
        ...page,
        path: "/workflows/",
        name: "实际用法",
        collectionItems: [
          { name: "查项目", url: "/workflows/project-answers/" },
          { name: "接 Issue", url: "/workflows/discussion-to-issue/" },
        ],
      },
      site,
      assets,
    );
    const itemList = graph(hubHead).find(
      (node: Record<string, unknown>) => node["@type"] === "ItemList",
    );
    expect(itemList).toMatchObject({ numberOfItems: 2 });
    expect(itemList.itemListElement[0].item).toBe(
      "https://mochi-ahalabs.pages.dev/workflows/project-answers/",
    );
  });

  test("missing pages remain noindex even in a published build", () => {
    const head = pageHead(
      { ...page, path: "/404", indexed: false },
      site,
      assets,
    );
    expect(head).toContain('name="robots" content="noindex"');
    expect(head).not.toContain('rel="canonical"');
    expect(head).not.toContain("application/ld+json");
  });

  test("reviewed text cannot break metadata or a JSON-LD script", () => {
    const hostile = '</script><script>alert("x")</script>';
    const head = pageHead({ ...page, title: hostile }, site, assets);
    expect(head).not.toContain(hostile);
    expect(
      graph(head).find(
        (node: Record<string, unknown>) => node["@type"] === "WebPage",
      ).name,
    ).toBe(hostile);
  });
});

describe("website publication record", () => {
  test("passes the release publication gate that deploys use", async () => {
    const record = JSON.parse(
      await readFile(join(import.meta.dir, "../publication.json"), "utf8"),
    );
    expect(parsePublicationDetails(record)).toEqual(record);
  });

  test("a support mailbox reads as its address, a support page by name", () => {
    expect(supportText("mailto:support@mochi-product.tld")).toBe(
      "support@mochi-product.tld",
    );
    expect(supportText("https://mochi-product.tld/support/")).toBe("支持入口");
  });
});
