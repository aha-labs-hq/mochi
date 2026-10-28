/** Presentation only: a verified mailbox's domain selects a website icon. */
export function mailboxIconUrl(address: string): string | null {
  const parts = address.trim().split("@");
  if (address.length > 320 || parts.length !== 2 || !parts[0] || !parts[1])
    return null;
  const domain = parts[1];
  if (/[\s/\\:?#%]/.test(domain)) return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${domain}`).hostname;
  } catch {
    return null;
  }
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    ) ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)!) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(hostname)
  )
    return null;
  return `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
}
