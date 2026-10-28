import { createHash, createHmac } from "node:crypto";
import { releaseDistribution } from "./release_distribution.ts";
import {
  type PublicationFile,
  publicationArguments,
  publicationObjectHeaders,
  verifyStagedPublication,
} from "./stage_release_publication.ts";

/**
 * Uploads one staged, accepted publication directory to the release bucket.
 * Objects are created once and never replaced: a key that already holds the
 * same bytes is reported, any other existing object fails the upload.
 */

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The bucket-scoped R2 token, only from the environment; never logged or written. */
export function r2CredentialsFromEnvironment(environment: NodeJS.ProcessEnv): R2Credentials {
  const accessKeyId = environment.MOCHI_R2_ACCESS_KEY_ID;
  const secretAccessKey = environment.MOCHI_R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey)
    throw new Error("Set MOCHI_R2_ACCESS_KEY_ID and MOCHI_R2_SECRET_ACCESS_KEY to the bucket-scoped R2 API token's S3 credentials");
  return { accessKeyId, secretAccessKey };
}

/** AWS Signature Version 4 for one S3-compatible request; returns the headers to send besides Host. */
export function signS3Request(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadSha256: string;
  credentials: R2Credentials;
  now: Date;
  region: string;
}): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value])),
    host: input.url.host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)])
    .sort(([left], [right]) => (left! < right! ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`).join("&");
  const canonicalRequest = [input.method, input.url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadSha256].join("\n");
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonicalRequest)].join("\n");
  let key: Buffer = createHmac("sha256", `AWS4${input.credentials.secretAccessKey}`).update(date).digest();
  for (const part of [input.region, "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const { host: _signedHost, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface UploadedObject {
  key: string;
  sizeBytes: number;
  sha256: string;
  result: "uploaded" | "already-present";
}

/** Creates every file of one verified publication directory under `<directory>/` in the bucket. */
export async function uploadPublication(input: {
  accountId: string;
  bucket: string;
  directoryName: string;
  files: ReadonlyArray<PublicationFile & { path: string }>;
  credentials: R2Credentials;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<UploadedObject[]> {
  const send = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date());
  const endpoint = `https://${input.accountId}.r2.cloudflarestorage.com`;
  const uploaded: UploadedObject[] = [];
  for (const file of input.files) {
    const key = `${input.directoryName}/${file.filename}`;
    const url = new URL(`/${input.bucket}/${key.split("/").map(encodeRfc3986).join("/")}`, endpoint);
    const request = (method: "HEAD" | "PUT", headers: Record<string, string>, payloadSha256: string, timeout: number): RequestInit => ({
      method,
      headers: signS3Request({ method, url, headers, payloadSha256, credentials: input.credentials, now: now(), region: "auto" }),
      signal: AbortSignal.timeout(timeout),
    });
    const existing = await send(url, request("HEAD", {}, EMPTY_SHA256, 60_000));
    if (existing.status === 200) {
      if (existing.headers.get("content-length") !== String(file.sizeBytes) || existing.headers.get("x-amz-meta-sha256") !== file.sha256)
        throw new Error(`${key} already exists with different bytes; published release objects are never replaced`);
      uploaded.push({ key, sizeBytes: file.sizeBytes, sha256: file.sha256, result: "already-present" });
      continue;
    }
    if (existing.status !== 404) throw new Error(`R2 HEAD ${key} returned HTTP ${existing.status}${await r2ErrorCode(existing)}`);
    const representation = publicationObjectHeaders(file.filename);
    const created = await send(url, {
      ...request("PUT", {
        "cache-control": representation.cacheControl,
        "content-disposition": representation.contentDisposition,
        "content-type": representation.contentType,
        "if-none-match": "*",
        "x-amz-meta-sha256": file.sha256,
      }, file.sha256, 60 * 60_000),
      body: Bun.file(file.path),
    });
    if (!created.ok) throw new Error(`R2 PUT ${key} returned HTTP ${created.status}${await r2ErrorCode(created)}`);
    uploaded.push({ key, sizeBytes: file.sizeBytes, sha256: file.sha256, result: "uploaded" });
  }
  return uploaded;
}

/** Only the S3 error code: R2 error bodies are diagnostics, never echoed whole. */
async function r2ErrorCode(response: Response): Promise<string> {
  if (response.status === 404 || !response.body) return "";
  const code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(await response.text())?.[1];
  return code ? ` (${code})` : "";
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.main) {
  const { directory, ...input } = publicationArguments(process.argv.slice(2), "release:upload");
  const credentials = r2CredentialsFromEnvironment(process.env);
  const staged = await verifyStagedPublication({ ...input, publicationDirectory: directory });
  const distribution = await releaseDistribution();
  const objects = await uploadPublication({
    accountId: distribution.cloudflareAccountId,
    bucket: distribution.downloads.bucket,
    directoryName: staged.directoryName,
    files: staged.files,
    credentials,
  });
  process.stdout.write(`${JSON.stringify({ bucket: distribution.downloads.bucket, directory: staged.directoryName, objects }, null, 2)}\n`);
}
