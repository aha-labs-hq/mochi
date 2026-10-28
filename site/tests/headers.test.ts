import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { headersFor, pagesHeaders, parseHeaders } from "../build/headers.ts";

const inline = 'document.documentElement.classList.add("js");';
const page = `<!doctype html><html><head><script>${inline}</script>
<script type="application/ld+json">{"@type":"WebPage"}</script></head>
<body><script type="module" crossorigin src="/assets/index.js"></script></body></html>`;
const text = pagesHeaders([page, page]);
const rules = parseHeaders(text);
const at = (url: string) => headersFor(rules, new URL(url));

describe("website response headers", () => {
  test("the policy admits this origin and exactly the pages' inline scripts", () => {
    const policy = at("https://mochi.host/").get("content-security-policy")!;
    const hash = createHash("sha256").update(inline).digest("base64");
    expect(policy).toContain(
      `script-src 'self' https://static.cloudflareinsights.com https://analytics.ahrefs.com 'sha256-${hash}';`,
    );
    expect(policy).toContain(
      "connect-src 'self' https://cloudflareinsights.com",
    );
    expect(policy.match(/'sha256-/g)).toHaveLength(1);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
  });

  test("every address is HTTPS-only; only pages.dev addresses stay unindexed", () => {
    for (const url of [
      "https://mochi.host/",
      "https://mochi-ahalabs.pages.dev/admin/",
      "https://0123abcd.mochi-ahalabs.pages.dev/",
    ])
      expect(at(url).get("strict-transport-security")).toContain(
        "max-age=31536000",
      );
    expect(at("https://mochi.host/admin/").get("x-robots-tag")).toBeNull();
    expect(
      at("https://mochi-ahalabs.pages.dev/admin/").get("x-robots-tag"),
    ).toBe("noindex");
    expect(
      at("https://0123abcd.mochi-ahalabs.pages.dev/").get("x-robots-tag"),
    ).toBe("noindex");
  });

  test("hashed assets are immutable and the file fits Pages' limits", () => {
    expect(
      at("https://mochi.host/assets/index.js").get("cache-control"),
    ).toContain("immutable");
    expect(at("https://mochi.host/").get("cache-control")).toContain(
      "no-transform",
    );
    expect(at("https://mochi.host/").get("cache-control")).toContain(
      "max-age=0",
    );
    expect(
      at("https://mochi.host/analytics.js?v=3").get("cache-control"),
    ).toContain("no-cache");
    expect(at("https://mochi.host/robots.txt").get("cache-control")).toContain(
      "no-cache",
    );
    expect(at("https://mochi.host/sitemap.xml").get("cache-control")).toContain(
      "no-cache",
    );
    expect(rules.length).toBeLessThanOrEqual(100);
    for (const line of text.split("\n")) expect(line.length).toBeLessThan(2000);
  });
});
