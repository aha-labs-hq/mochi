import { describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { createResolvedAddressGuard } from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";
import { NON_PUBLIC_ADDRESS_RANGES, PublicNetworkUnavailableError, publicDestinationFilter } from "../src/runtime/executionNetwork.ts";

// The guard the turn proxy dials through, configured as executionSandboxConfig configures it.
function guard(answers: Record<string, readonly string[]>) {
  return createResolvedAddressGuard({
    deniedResolvedAddresses: NON_PUBLIC_ADDRESS_RANGES,
    localAddresses: () => [],
    resolve: (hostname, _options, callback) => {
      const addresses = answers[hostname];
      if (!addresses) callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), []);
      else callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
    },
  });
}

function dial(answers: Record<string, readonly string[]>, hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    guard(answers).lookupFor(443)(hostname, {}, (error: Error | null, address: string | LookupAddress[]) => {
      if (error) reject(error);
      else resolve(address as string);
    });
  });
}

describe("addresses the turn proxy dials", () => {
  const nonPublic = {
    "DNS pointing at private space": ["10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1"],
    "loopback, unspecified and link-local": ["127.0.0.1", "127.1.2.3", "0.0.0.0", "169.254.169.254"],
    "fake-IP answers in the benchmarking block": ["198.18.0.7", "198.19.255.1"],
    "other special-purpose IPv4": ["192.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255"],
    "IPv6 loopback, link-local, ULA and multicast": ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1"],
    "IPv6 forms carrying private IPv4": ["::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:198.18.0.1", "64:ff9b::10.0.0.1", "2002:a00:1::1", "::10.0.0.1"],
    "IPv6 outside global unicast or reserved inside it": ["64:ff9b:1::1", "100::1", "2001::1", "2001:db8::1", "3fff::1", "5f00::1"],
  };
  for (const [label, addresses] of Object.entries(nonPublic)) {
    test(`refuses ${label}`, () => {
      const policy = guard({});
      expect(addresses.filter((address) => policy.permits("intranet.example", address, 443))).toEqual([]);
    });
  }

  test("permits globally routable addresses, including NAT64 and mapped forms of public IPv4", () => {
    const policy = guard({});
    const publicAddresses = ["93.184.216.34", "1.1.1.1", "198.20.0.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "2001:4860:4860::8888", "::ffff:93.184.216.34", "64:ff9b::808:808"];
    expect(publicAddresses.filter((address) => !policy.permits("public.example", address, 443))).toEqual([]);
  });

  test("a name that resolves to private space is refused at dial time, and a mixed answer dials only the public address", async () => {
    await expect(dial({ "rebind.example": ["10.0.0.5"] }, "rebind.example")).rejects.toThrow("blocked");
    await expect(dial({ "fake.example": ["198.18.3.4"] }, "fake.example")).rejects.toThrow("blocked");
    await expect(dial({ "v6.example": ["fd00::5"] }, "v6.example")).rejects.toThrow("blocked");
    expect(await dial({ "mixed.example": ["192.168.1.1", "93.184.216.34"] }, "mixed.example")).toBe("93.184.216.34");
  });
});

describe("turn proxy admission", () => {
  const admit = (host: string, port: number | undefined, answers: readonly string[] = ["93.184.216.34"]) => {
    const refused: PublicNetworkUnavailableError[] = [];
    const filter = publicDestinationFilter((error) => refused.push(error), async () => answers);
    return filter({ host, port }).then((allowed) => ({ allowed, refused }));
  };

  test("admits public names on web ports only", async () => {
    expect((await admit("example.com", 443)).allowed).toBeTrue();
    expect((await admit("example.com", 80)).allowed).toBeTrue();
    for (const port of [8080, 22, undefined]) expect((await admit("example.com", port)).allowed).toBeFalse();
  });

  test("refuses IP literals and every spelling of a loopback name", async () => {
    for (const host of ["10.0.0.1", "127.1", "0x7f.1", "::1", "[::1]", "localhost", "localhost.", "LOCALHOST.", "mochi.localhost", "mochi.localhost.", "."]) {
      expect({ host, allowed: (await admit(host, 80)).allowed }).toEqual({ host, allowed: false });
    }
  });

  test("refuses fake-IP answers with a reason the user can act on", async () => {
    const { allowed, refused } = await admit("Example.COM.", 443, ["198.18.0.42"]);
    expect(allowed).toBeFalse();
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(PublicNetworkUnavailableError);
    expect(refused[0]!.hostname).toBe("example.com");
    expect(refused[0]!.message).toContain("198.18.0.0/15");
  });

  test("leaves other answers and lookup failures to the pinned dial", async () => {
    expect(await admit("intranet.example", 443, ["10.0.0.5"])).toEqual({ allowed: true, refused: [] });
    const failing = publicDestinationFilter(() => { throw new Error("not a fake-IP refusal"); }, async () => { throw new Error("ENOTFOUND"); });
    expect(await failing({ host: "missing.example", port: 443 })).toBeTrue();
  });
});
