import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { NetworkHostPattern } from "@anthropic-ai/sandbox-runtime";

/**
 * Resolved addresses the turn proxy refuses to dial. Public means globally
 * routable unicast, so this lists every special-purpose block that is not:
 * private and shared space, loopback, link-local, benchmarking (where fake-IP
 * DNS answers), documentation, multicast and reserved space; for IPv6,
 * everything outside global unicast 2000::/3 and the non-global blocks inside
 * it. The proxy dials only an address that passed, and judges an IPv6 address
 * that carries IPv4 (mapped, NAT64 64:ff9b::/96, 6to4) by that IPv4 address.
 */
export const NON_PUBLIC_ADDRESS_RANGES: readonly string[] = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "::/128", "::1/128", "64:ff9b:1::/48", "100::/8", "200::/7", "400::/6", "800::/5", "1000::/4",
  "2001::/23", "2001:db8::/32", "3fff::/20", "4000::/2", "8000::/1",
];

/** Proxy apps in fake-IP mode (Clash/mihomo, Surge, sing-box) answer every name from this benchmarking block. */
const FAKE_IP_RANGE = "198.18.0.0/15";
const fakeIp = new BlockList();
fakeIp.addSubnet("198.18.0.0", 15, "ipv4");

/** This Mac's DNS hides real destinations, so no public request can be judged. */
export class PublicNetworkUnavailableError extends Error {
  readonly hostname: string;

  constructor(hostname: string) {
    super(`Public network access is unavailable in this turn: this Mac's DNS returns fake-IP addresses (${FAKE_IP_RANGE}, first seen for ${hostname}). `
      + "A proxy app such as Clash Verge/mihomo, Surge or sing-box is running in fake-IP mode, so Mochi cannot tell whether a destination "
      + "is public or on the local network, and refuses web requests. To restore web access, the Mac's owner can switch the proxy's DNS "
      + "to real-IP mode (mihomo: dns.enhanced-mode: redir-host) or turn off its TUN/enhanced mode. Mochi does not change proxy settings.");
    this.name = "PublicNetworkUnavailableError";
    this.hostname = hostname;
  }
}

export type Resolve = (hostname: string) => Promise<readonly string[]>;

export const systemResolve: Resolve = async (hostname) => (await lookup(hostname, { all: true })).map(({ address }) => address);

/**
 * Admits public names on ports 80 and 443. The proxy then resolves the name
 * again and dials only an address outside NON_PUBLIC_ADDRESS_RANGES; that pinned
 * dial is the enforcement point, so a failed lookup here is left to it. This
 * first resolution recognises fake-IP answers, whose real destination nothing
 * on this Mac can see, so the refusal can say why.
 */
export function publicDestinationFilter(refuseFakeIp: (error: PublicNetworkUnavailableError) => void, resolve: Resolve = systemResolve) {
  return async ({ host, port }: NetworkHostPattern): Promise<boolean> => {
    if ((port !== 80 && port !== 443) || isIP(host) !== 0) return false;
    let hostname: string;
    // URL parsing canonicalises case and IPv4 shorthand (127.1); DNS ignores trailing dots (localhost.).
    try { hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, ""); }
    catch { return false; }
    if (!hostname || isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost")) return false;
    const addresses = await resolve(hostname).catch(() => []);
    if (!addresses.some((address) => isIP(address) === 4 && fakeIp.check(address, "ipv4"))) return true;
    refuseFakeIp(new PublicNetworkUnavailableError(hostname));
    return false;
  };
}
