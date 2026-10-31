import { createHash } from "node:crypto";

/**
 * Cloudflare Pages response headers for the built site: the one place its
 * security policy is written. Hashed assets are immutable; every response
 * carries HSTS and a content security policy that admits only this origin
 * and the exact inline scripts the pages contain. Pages' own `*.pages.dev`
 * addresses stay out of search results.
 * https://developers.cloudflare.com/pages/configuration/headers/
 */
export function pagesHeaders(documents: string[]): string {
  const scripts = new Set<string>();
  // JSON-LD is data, never executed, so the policy does not govern it.
  for (const html of documents)
    for (const [, attributes, body] of html.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script>/g,
    ))
      if (!/\bsrc=|type="application\/ld\+json"/.test(attributes!))
        scripts.add(
          `'sha256-${createHash("sha256").update(body!).digest("base64")}'`,
        );
  const policy = [
    "default-src 'self'",
    [
      "script-src 'self' https://static.cloudflareinsights.com https://analytics.ahrefs.com",
      ...[...scripts].sort(),
    ].join(" "),
    "connect-src 'self' https://cloudflareinsights.com https://analytics.ahrefs.com",
    "img-src 'self'",
    // React renders layout values as style attributes.
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return `${[
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/*",
    "  Cache-Control: no-transform",
    "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
    `  Content-Security-Policy: ${policy}`,
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin",
    "  X-Frame-Options: DENY",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    ...[
      "/",
      "/download/*",
      "/start/*",
      "/privacy/*",
      "/admin/*",
      "/workflows/*",
      "/insights/*",
    ].flatMap((path) => [
      path,
      "  Cache-Control: public, max-age=0, must-revalidate",
    ]),
    "/robots.txt",
    "  Cache-Control: no-cache",
    "/sitemap.xml",
    "  Cache-Control: no-cache",
    "/analytics.js",
    "  Cache-Control: no-cache, no-transform",
    "https://:project.pages.dev/*",
    "  X-Robots-Tag: noindex",
    "https://:version.:project.pages.dev/*",
    "  X-Robots-Tag: noindex",
  ].join("\n")}\n`;
}

interface HeaderRule {
  host: RegExp | null;
  path: RegExp;
  headers: [string, string][];
}

/** Reads a `_headers` file the way Pages matches it, for local previews. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      const rule = rules.at(-1);
      const colon = line.indexOf(":");
      if (!rule || colon < 0) throw new Error(`Malformed header line: ${line}`);
      rule.headers.push([
        line.slice(0, colon).trim(),
        line.slice(colon + 1).trim(),
      ]);
      continue;
    }
    const absolute = line.match(/^https:\/\/([^/]+)(\/.*)$/);
    rules.push({
      host: absolute ? pattern(absolute[1]!, "[^./]+") : null,
      path: pattern(absolute ? absolute[2]! : line.trim(), "[^/]+"),
      headers: [],
    });
  }
  return rules;
}

/** Every matching rule contributes; a repeated header joins with commas. */
export function headersFor(rules: HeaderRule[], url: URL): Headers {
  const headers = new Headers();
  for (const rule of rules)
    if (
      (!rule.host || rule.host.test(url.hostname)) &&
      rule.path.test(url.pathname)
    )
      for (const [name, value] of rule.headers) headers.append(name, value);
  return headers;
}

function pattern(text: string, placeholder: string): RegExp {
  const source = text
    .split(/(\*|:[A-Za-z]\w*)/)
    .map((part) =>
      part === "*"
        ? ".*"
        : part.startsWith(":")
          ? placeholder
          : part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}
