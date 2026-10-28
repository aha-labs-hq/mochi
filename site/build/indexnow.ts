/**
 * IndexNow tells Bing and the other participating search engines which pages
 * changed, instead of waiting for their next crawl. The key only proves that a
 * submission comes from the site; it is public by design and served at
 * `/<key>.txt` by every indexable build.
 */
export const INDEXNOW_KEY = "69973bc52cd79c38b76d0fe145b28126";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** The page URLs of a built sitemap, in order. */
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
}

/** One submission for every indexable page of one site. */
export function indexNowSubmission(urls: readonly string[]) {
  if (!urls.length) throw new Error("IndexNow needs at least one page URL");
  const origin = new URL(urls[0]!).origin;
  if (urls.some((url) => new URL(url).origin !== origin))
    throw new Error("IndexNow URLs must share one host");
  return {
    host: new URL(origin).host,
    key: INDEXNOW_KEY,
    keyLocation: `${origin}/${INDEXNOW_KEY}.txt`,
    urlList: [...urls],
  };
}
