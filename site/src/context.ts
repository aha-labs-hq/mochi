import { createContext, useContext } from "react";

/** The issuer's public identity, as reviewed for release publication. */
export interface Publication {
  publisherName: string;
  downloadPageUrl: string;
  /** An HTTPS page or a `mailto:` address. */
  supportUrl: string;
  privacyContactEmail: string;
}

/** How the support entry reads on a page: its email address, or its name. */
export function supportText(supportUrl: string) {
  const url = new URL(supportUrl);
  return url.protocol === "mailto:" ? url.pathname : "支持入口";
}

/** Public facts projected from the accepted candidate, never entered by hand. */
export interface SiteRelease {
  /** A public beta passes the install, sandbox and removal scenarios; a release passes all. */
  channel: "release" | "public-beta";
  productVersion: string;
  architecture: "arm64" | "x86_64";
  minimumMacOS: string;
  limitations: string[];
  artifacts: {
    role: "applicationDiskImage";
    filename: string;
    sizeBytes: number;
    sha256: string;
    url: string;
  }[];
  notesUrl: string;
  checksumsUrl: string;
}

/**
 * Public issuer facts and search indexing are separate. A temporary address
 * can show real issuer facts while remaining noindex.
 */
export interface SiteContext {
  publication: Publication | null;
  /** Null until the same gate used by public staging accepts the exact files. */
  release: SiteRelease | null;
  /** Enabled explicitly only after choosing the canonical public domain. */
  indexable: boolean;
  /** `release/public/` documents with their issuer fields filled in. */
  documents: { guide: string; privacy: string };
}

const Site = createContext<SiteContext | null>(null);
export const SiteProvider = Site.Provider;

export function useSite() {
  const site = useContext(Site);
  if (!site) throw new Error("Site context is only available while rendering");
  return site;
}

/** Text for an issuer fact that a preview build cannot know yet. */
export const PENDING = "待发行方确认";
/** A document link whose destination the issuer has not confirmed. */
export const PENDING_LINK = "#pending";
