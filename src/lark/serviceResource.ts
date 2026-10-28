/**
 * The Feishu service resource types this Bot can read.
 *
 * Feishu's listing endpoints do not expose a complete directory for this Bot:
 * an authorized Bot can see an empty wiki space list and an empty drive root
 * even when a shared object is readable. A resource therefore enters Mochi from
 * a reference the owner supplies and the Bot then proves it can read. Wiki nodes
 * and cloud documents share one read path because the CLI resolves a wiki URL to
 * its underlying document, so they differ in how they are addressed, not in what
 * reading them costs.
 */
export type FeishuServiceResourceType = "document" | "wiki";

export function isFeishuServiceResourceType(value: unknown): value is FeishuServiceResourceType {
  return value === "document" || value === "wiki";
}

/**
 * The provider's own object type, as `drive +inspect` reports it.
 *
 * `doc` and `docx` are both cloud documents; `wiki` is a knowledge-base node.
 * Anything else the CLI can resolve is not something this Bot's grant can read,
 * so it is refused at selection instead of stored and failing later.
 */
export function feishuServiceResourceTypeFor(
  providerType: string,
): FeishuServiceResourceType | null {
  if (providerType === "doc" || providerType === "docx") return "document";
  if (providerType === "wiki") return "wiki";
  return null;
}

/** Provider object tokens are opaque identifiers; the shape only bounds size. */
export function isFeishuServiceResourceToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** The default host used when a provider response has no regional origin. */
export const FEISHU_CANONICAL_HOST = "https://www.feishu.cn";

const FEISHU_HOST_SUFFIXES = ["feishu.cn", "larksuite.com", "larkoffice.com"] as const;

/**
 * Keeps a proven Feishu/Lark region when rebuilding a token URL.
 *
 * The resource token is the identity; the origin is only the transport route.
 * Both are still constrained here so a persisted address cannot redirect a
 * later read to an arbitrary host.
 */
export function feishuOriginForUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !FEISHU_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    return null;
  }
  return url.origin;
}

/**
 * The address for a stored resource, rebuilt from the proven token.
 *
 * A read never trusts a remembered URL: the owner's link may have been a
 * redirect or a share alias, and the provider may have renamed the object since.
 */
export function feishuServiceAddress(
  type: FeishuServiceResourceType,
  token: string,
  sourceUrl?: string,
): string {
  const origin = sourceUrl
    ? feishuOriginForUrl(sourceUrl)
    : FEISHU_CANONICAL_HOST;
  if (!origin) throw new Error("Feishu resource address has an untrusted origin");
  return type === "wiki"
    ? `${origin}/wiki/${token}`
    : `${origin}/docx/${token}`;
}
