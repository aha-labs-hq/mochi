import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  readUpdateFeed,
  readUpdateFeedResponse,
  updateIsSupported,
  type UpdateFeed,
} from "../src/product/updateFeed.ts";
import {
  requireForwardFeed,
  publishUpdateFeed,
} from "../script/release_update.ts";

const keys = generateKeyPairSync("ed25519");
const trust = {
  origin: "https://downloads.mochi.host/",
  feedPath: "updates/stable.json",
  teamId: "9P89G9N875",
  publicKey: keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64"),
};
const feed: UpdateFeed = {
  schemaVersion: 1,
  issuedAt: new Date().toISOString(),
  withdrawn: false,
  release: {
    schemaVersion: 1,
    product: "app.mochi.companion",
    version: "0.4.0",
    minimumUpdateVersion: "0.3.0",
    minimumMacOS: "14.0",
    architecture: "arm64",
    candidateSha256: "a".repeat(64),
    artifact: {
      path: `Mochi-0.4.0-arm64-${"a".repeat(16)}/Mochi.dmg`,
      sha256: "b".repeat(64),
      size: 123,
    },
    notes: "更新体验更顺畅。",
  },
};
const signed = (value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: bytes.toString("base64"),
    signature: sign(null, bytes, keys.privateKey).toString("base64"),
  });
};
test("only exact signed bytes from the fixed product and immutable candidate can advertise an update", () => {
  expect(readUpdateFeed(signed(feed), trust)).toEqual(feed);
  for (const value of [
    { ...feed, extra: true },
    { ...feed, release: { ...feed.release, product: "another.app" } },
    {
      ...feed,
      release: {
        ...feed.release,
        artifact: { ...feed.release.artifact, path: "https://host/Mochi.dmg" },
      },
    },
    { ...feed, release: { ...feed.release, version: "0.04.0" } },
    { ...feed, issuedAt: new Date(Date.now() + 600_000).toISOString() },
  ])
    expect(() => readUpdateFeed(signed(value), trust)).toThrow();
  const bad = JSON.parse(signed(feed));
  bad.payload = Buffer.from("{}").toString("base64");
  expect(() => readUpdateFeed(JSON.stringify(bad), trust)).toThrow();
  expect(() =>
    readUpdateFeed(signed(feed), {
      ...trust,
      publicKey: Buffer.alloc(32).toString("base64"),
    }),
  ).toThrow();
});
test("OS/version compatibility and withdrawal retain a monotonic version identity", () => {
  expect(updateIsSupported(feed.release, "0.3.0", "14.0")).toBe(true);
  for (const [version, os] of [
    ["0.2.0", "14.0"],
    ["0.4.0", "15.0"],
    ["0.3.0", "13.9"],
  ])
    expect(updateIsSupported(feed.release, version!, os!)).toBe(false);
  const withdrawn = {
    ...feed,
    withdrawn: true,
    issuedAt: new Date(Date.parse(feed.issuedAt) + 1000).toISOString(),
  };
  expect(() => requireForwardFeed(feed, withdrawn)).not.toThrow();
  const replacement = {
    ...feed,
    issuedAt: new Date(Date.parse(feed.issuedAt) + 2000).toISOString(),
    release: { ...feed.release, candidateSha256: "c".repeat(64) },
  };
  expect(() => requireForwardFeed(withdrawn, replacement)).toThrow();
  expect(() => requireForwardFeed(feed, feed)).toThrow();
});

const publication = (body: string, send: typeof fetch) =>
  publishUpdateFeed({
    body,
    trust,
    accountId: "fixture",
    bucket: "mochi",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    fetch: send,
  });
test("first publication uses create-only and existing pointers use their exact ETag", async () => {
  const next = signed({
    ...feed,
    issuedAt: new Date(Date.parse(feed.issuedAt) + 1000).toISOString(),
  });
  for (const existing of [false, true]) {
    let step = 0;
    await publication(next, (async (url, request) => {
      step++;
      if (step === 1)
        return existing
          ? new Response(signed(feed), { headers: { etag: '\"one\"' } })
          : new Response(null, { status: 404 });
      if (step === 2) {
        expect(request?.method).toBe("PUT");
        const headers = new Headers(request?.headers);
        expect(headers.get(existing ? "if-match" : "if-none-match")).toBe(
          existing ? '\"one\"' : "*",
        );
        expect(headers.get("cache-control")).toBe("no-store");
        expect(request?.body).toBe(next);
        return new Response(null, { status: 200 });
      }
      expect(String(url)).toBe(
        "https://downloads.mochi.host/updates/stable.json",
      );
      return new Response(next);
    }) as typeof fetch);
    expect(step).toBe(3);
  }
});
test("a competing publisher is never overwritten and unknown readback is never called success", async () => {
  const next = signed({
    ...feed,
    issuedAt: new Date(Date.parse(feed.issuedAt) + 1000).toISOString(),
  });
  for (const conflict of [false, true]) {
    let step = 0;
    await expect(
      publication(next, (async () => {
        step++;
        if (step === 1)
          return new Response(signed(feed), { headers: { etag: '\"one\"' } });
        if (step === 2)
          return new Response(null, { status: conflict ? 412 : 200 });
        return new Response(signed(feed));
      }) as unknown as typeof fetch),
    ).rejects.toThrow(conflict ? "not confirmed" : "readback did not match");
    expect(step).toBe(conflict ? 2 : 3);
  }
});
test("oversized feed bodies are cancelled before parsing or publication", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32_769));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(readUpdateFeedResponse(response)).rejects.toThrow(
    "verification",
  );
  expect(cancelled).toBe(true);
});
