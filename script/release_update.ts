import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import configuration from "../release/updates.json";
import {
  parseUpdateRelease,
  readUpdateFeed,
  readUpdateFeedResponse,
  type UpdateFeed,
  type UpdateTrust,
} from "../src/product/updateFeed.ts";
import { compareProductVersions } from "../src/control/updateLifecycle.ts";
import {
  releaseDistribution,
  requireDeveloperIdTeam,
} from "./release_distribution.ts";
import {
  type ReleasePublicationInput,
  validateReleasePublication,
  verifyStagedPublication,
} from "./stage_release_publication.ts";
import { readBackPublication } from "./release_readback.ts";
import {
  r2CredentialsFromEnvironment,
  signS3Request,
  type R2Credentials,
} from "./release_upload.ts";

/** Only a release moves the update feed; a public beta is never offered as an update. */
type Input = Omit<ReleasePublicationInput, "channel"> & {
  publicationDirectory: string;
  notesPath: string;
};
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export async function acceptedUpdate(
  input: Input,
  now = new Date(),
): Promise<{ feed: UpdateFeed; trust: UpdateTrust }> {
  const accepted = await validateReleasePublication({ ...input, channel: "release" });
  const distribution = await releaseDistribution();
  const trust = {
    origin: distribution.downloads.baseUrl,
    feedPath: configuration.feedPath,
    publicKey: configuration.publicKey,
    teamId: requireDeveloperIdTeam(distribution),
  };
  const artifact = accepted.manifest.artifacts.find(
    (x) => x.role === "applicationDiskImage",
  )!;
  const notes = (await readFile(input.notesPath, "utf8")).trim();
  const release = parseUpdateRelease(
    {
      schemaVersion: 1,
      product: "app.mochi.companion",
      version: accepted.manifest.productVersion,
      architecture: accepted.manifest.architecture,
      minimumMacOS: accepted.manifest.minimumMacOS,
      minimumUpdateVersion: configuration.minimumUpdateVersion,
      candidateSha256: accepted.manifestSha256,
      artifact: {
        path: `${accepted.directoryName}/${artifact.filename}`,
        sha256: artifact.sha256,
        size: artifact.sizeBytes,
      },
      notes,
    },
    trust,
  );
  return {
    feed: {
      schemaVersion: 1,
      issuedAt: now.toISOString(),
      withdrawn: false,
      release,
    },
    trust,
  };
}

/** Immutable artifacts must be visible anonymously before the mutable pointer moves. */
async function proveDownloads(input: Input): Promise<void> {
  const staged = await verifyStagedPublication({ ...input, channel: "release" }),
    distribution = await releaseDistribution();
  const result = await readBackPublication({
    baseUrl: distribution.downloads.baseUrl,
    directoryName: staged.directoryName,
    files: staged.files,
  });
  if (!result.accepted)
    throw Error(`Update publication blocked: ${result.failures.join("; ")}`);
}

export function requireForwardFeed(
  previous: UpdateFeed | null,
  next: UpdateFeed,
): void {
  if (!previous) return;
  if (next.issuedAt <= previous.issuedAt)
    throw Error("Update feed time must advance");
  if (!previous.release || !next.release) return;
  const order = compareProductVersions(
    next.release.version,
    previous.release.version,
  );
  if (
    order < 0 ||
    (order === 0 &&
      next.release.candidateSha256 !== previous.release.candidateSha256)
  )
    throw Error(
      "A public version cannot be downgraded or replaced with different bytes",
    );
}

export async function publishUpdateFeed(input: {
  body: string;
  trust: UpdateTrust;
  accountId: string;
  bucket: string;
  credentials: R2Credentials;
  fetch?: typeof fetch;
}): Promise<void> {
  const send = input.fetch ?? fetch,
    feed = readUpdateFeed(input.body, input.trust);
  const url = new URL(
    `/${input.bucket}/${input.trust.feedPath}`,
    `https://${input.accountId}.r2.cloudflarestorage.com`,
  );
  const request = (
    method: string,
    body: string,
    headers: Record<string, string> = {},
  ) => ({
    method,
    redirect: "error" as const,
    signal: AbortSignal.timeout(30_000),
    headers: signS3Request({
      method,
      url,
      headers,
      payloadSha256: sha(body),
      credentials: input.credentials,
      now: new Date(),
      region: "auto",
    }),
  });
  const old = await send(url, request("GET", ""));
  let etag: string | null = null;
  if (old.status === 200) {
    etag = old.headers.get("etag");
    if (!etag) throw Error("Update feed has no concurrency token");
    const body = await readUpdateFeedResponse(old);
    requireForwardFeed(readUpdateFeed(body, input.trust), feed);
  } else if (old.status !== 404)
    throw Error("Cannot read the previous update pointer");
  const response = await send(url, {
    ...request("PUT", input.body, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(etag ? { "if-match": etag } : { "if-none-match": "*" }),
    }),
    body: input.body,
  });
  if (!response.ok)
    throw Error(
      `Update pointer publication was not confirmed: HTTP ${response.status}; read back before retrying`,
    );
  const actual = await send(new URL(input.trust.feedPath, input.trust.origin), {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (
    !actual.ok ||
    sha(await readUpdateFeedResponse(actual)) !== sha(input.body)
  )
    throw Error(
      "Update pointer upload succeeded but anonymous readback did not match",
    );
}

if (import.meta.main) {
  const [mode, inputPath, feedPath, signer] = process.argv.slice(2);
  if (
    (mode !== "stage" && mode !== "publish" && mode !== "withdraw") ||
    !inputPath ||
    !feedPath ||
    (mode === "stage" && !signer)
  )
    throw Error(
      "Usage: release_update.ts stage|publish|withdraw <publication-input.json> <signed-feed.json> [Sparkle sign_update path]",
    );
  const input = JSON.parse(await readFile(resolve(inputPath), "utf8")) as Input;
  const { feed, trust } = await acceptedUpdate(input);
  if (mode === "stage" || mode === "withdraw") {
    if (!signer)
      throw Error("Staging requires Sparkle's official sign_update executable");
    if (mode === "withdraw") feed.withdrawn = true;
    const work = await mkdtemp(join(tmpdir(), "mochi-update-feed-"));
    try {
      const path = join(work, "payload.bin"),
        payload = JSON.stringify(feed);
      await writeFile(path, payload, { mode: 0o600 });
      const child = Bun.spawn(
        [
          resolve(signer),
          "--account",
          configuration.keychainAccount,
          "-p",
          path,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, signature] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0)
        throw Error(
          "Update feed signing failed; complete the macOS Keychain authorization and retry",
        );
      const body = JSON.stringify({
        payload: Buffer.from(payload).toString("base64"),
        signature: signature.trim(),
      });
      readUpdateFeed(body, trust);
      await writeFile(resolve(feedPath), body + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  } else {
    const body = await readFile(resolve(feedPath), "utf8"),
      signed = readUpdateFeed(body, trust);
    if (
      signed.release &&
      JSON.stringify(signed.release) !== JSON.stringify(feed.release)
    )
      throw Error("Signed feed does not name the accepted publication");
    if (!signed.withdrawn) await proveDownloads(input);
    const distribution = await releaseDistribution();
    await publishUpdateFeed({
      body,
      trust,
      accountId: distribution.cloudflareAccountId,
      bucket: distribution.downloads.bucket,
      credentials: r2CredentialsFromEnvironment(process.env),
    });
  }
}
