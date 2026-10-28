import publication from "../../../site/publication.json" with { type: "json" };

/**
 * The public support mailbox. `site/publication.json` owns it for the website
 * and this App alike, so the two cannot name different addresses. A support
 * entry that is not a mailbox fails on load instead of shipping an App that
 * sends people nowhere.
 */
export const SUPPORT_EMAIL = mailbox(publication.supportUrl);

function mailbox(url: string): string {
  const address = url.startsWith("mailto:") ? url.slice("mailto:".length) : "";
  if (!/^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(address))
    throw new Error("site/publication.json must name a support mailbox");
  return address;
}
