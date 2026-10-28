import { createPublicKey, verify } from "node:crypto";
import { compareProductVersions } from "../control/updateLifecycle.ts";

export interface UpdateTrust {
  origin: string;
  feedPath: string;
  publicKey: string;
  teamId: string;
}
export interface UpdateRelease {
  schemaVersion: 1;
  product: "app.mochi.companion";
  version: string;
  architecture: "arm64";
  minimumMacOS: string;
  minimumUpdateVersion: string;
  candidateSha256: string;
  artifact: { path: string; sha256: string; size: number };
  notes: string;
}
export interface UpdateFeed {
  schemaVersion: 1;
  issuedAt: string;
  withdrawn: boolean;
  release: UpdateRelease;
}
export interface SignedUpdateFeed {
  payload: string;
  signature: string;
}
export const MAXIMUM_FEED_BYTES = 32_768;
export const MAXIMUM_UPDATE_BYTES = 4 * 1024 ** 3;

/** The same bounded transport is used by the desktop and publication readback. */
export async function readUpdateFeedResponse(
  response: Response,
): Promise<string> {
  if (!response.ok || !response.body) throw Error("update_network");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAXIMUM_FEED_BYTES) throw Error("update_verification");
      chunks.push(item.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Verify the exact signed bytes before parsing any server-controlled field. */
export function readUpdateFeed(
  text: string,
  trust: UpdateTrust,
  now = Date.now(),
): UpdateFeed {
  if (Buffer.byteLength(text) > MAXIMUM_FEED_BYTES)
    throw Error("update_feed_invalid");
  const envelope = exact(JSON.parse(text), ["payload", "signature"]);
  const bytes = base64(envelope.payload),
    signature = base64(envelope.signature);
  if (signature.length !== 64 || bytes.length > 24_576)
    throw Error("update_feed_invalid");
  const key = base64(trust.publicKey);
  if (key.length !== 32) throw Error("update_trust_invalid");
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, bytes, publicKey, signature))
    throw Error("update_signature_invalid");
  const feed = exact(JSON.parse(bytes.toString("utf8")), [
    "schemaVersion",
    "issuedAt",
    "withdrawn",
    "release",
  ]);
  const issued = date(feed.issuedAt);
  if (
    feed.schemaVersion !== 1 ||
    typeof feed.withdrawn !== "boolean" ||
    issued > now + 300_000
  )
    throw Error("update_feed_invalid");
  return {
    schemaVersion: 1,
    issuedAt: feed.issuedAt as string,
    withdrawn: feed.withdrawn as boolean,
    release: parseUpdateRelease(feed.release, trust),
  };
}

export function parseUpdateRelease(
  value: unknown,
  trust: UpdateTrust,
): UpdateRelease {
  const r = exact(value, [
    "schemaVersion",
    "product",
    "version",
    "architecture",
    "minimumMacOS",
    "minimumUpdateVersion",
    "candidateSha256",
    "artifact",
    "notes",
  ]);
  const artifact = exact(r.artifact, ["path", "sha256", "size"]);
  if (
    r.schemaVersion !== 1 ||
    r.product !== "app.mochi.companion" ||
    r.architecture !== "arm64" ||
    typeof r.minimumMacOS !== "string" ||
    r.minimumMacOS.length > 32 ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(r.minimumMacOS) ||
    typeof r.version !== "string" ||
    r.version.length > 64 ||
    typeof r.minimumUpdateVersion !== "string" ||
    r.minimumUpdateVersion.length > 64 ||
    compareProductVersions(r.version, r.minimumUpdateVersion) < 0 ||
    !hash(r.candidateSha256) ||
    !hash(artifact.sha256) ||
    typeof artifact.size !== "number" ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    artifact.size > MAXIMUM_UPDATE_BYTES ||
    typeof artifact.path !== "string" ||
    !/^Mochi-\d+\.\d+\.\d+-arm64-[a-f0-9]{16}\/Mochi\.dmg$/.test(
      artifact.path,
    ) ||
    artifact.path !==
      `Mochi-${r.version}-arm64-${(r.candidateSha256 as string).slice(0, 16)}/Mochi.dmg` ||
    typeof r.notes !== "string" ||
    r.notes.length > 4000 ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.notes)
  )
    throw Error("update_feed_invalid");
  const origin = new URL(trust.origin);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw Error("update_trust_invalid");
  return r as unknown as UpdateRelease;
}

export function updateIsSupported(
  release: UpdateRelease,
  current: string,
  macOS: string,
): boolean {
  const os = macOS.split(".").map(Number),
    minimum = release.minimumMacOS.split(".").map(Number);
  if (os.some((x) => !Number.isSafeInteger(x) || x < 0) || os.length < 2)
    return false;
  let osOrder = 0;
  for (let i = 0; i < 3; i++)
    if ((os[i] ?? 0) !== (minimum[i] ?? 0)) {
      osOrder = (os[i] ?? 0) > (minimum[i] ?? 0) ? 1 : -1;
      break;
    }
  return (
    compareProductVersions(release.version, current) > 0 &&
    compareProductVersions(current, release.minimumUpdateVersion) >= 0 &&
    osOrder >= 0
  );
}

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw Error("update_feed_invalid");
  return value as Record<string, unknown>;
}
function base64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FEED_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw Error("update_feed_invalid");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) throw Error("update_feed_invalid");
  return data;
}
function date(value: unknown): number {
  if (
    typeof value !== "string" ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw Error("update_feed_invalid");
  return Date.parse(value);
}
function hash(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
