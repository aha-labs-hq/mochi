import { describe, expect, test } from "bun:test";
import {
  INDEXNOW_KEY,
  indexNowSubmission,
  sitemapUrls,
} from "../build/indexnow.ts";

describe("IndexNow", () => {
  test("submits every sitemap page of one host with the public key file", () => {
    expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/);
    const urls = sitemapUrls(
      "<urlset><url><loc>https://mochi.host/</loc></url><url><loc>https://mochi.host/faq/</loc></url></urlset>",
    );
    expect(urls).toEqual(["https://mochi.host/", "https://mochi.host/faq/"]);
    expect(indexNowSubmission(urls)).toEqual({
      host: "mochi.host",
      key: INDEXNOW_KEY,
      keyLocation: `https://mochi.host/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    });
  });

  test("refuses an empty or mixed-host submission", () => {
    expect(() => indexNowSubmission([])).toThrow("at least one");
    expect(() =>
      indexNowSubmission(["https://mochi.host/", "https://elsewhere.tld/"]),
    ).toThrow("one host");
  });
});
