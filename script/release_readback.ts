import { createHash } from "node:crypto";
import { releaseDistribution } from "./release_distribution.ts";
import {
  type PublicationFile,
  publicationArguments,
  publicationObjectHeaders,
  verifyStagedPublication,
} from "./stage_release_publication.ts";

export interface ReadbackReport {
  accepted: boolean;
  baseUrl: string;
  directoryName: string;
  files: Array<{ filename: string; url: string; status: number; sizeBytes: number; sha256: string }>;
  failures: string[];
}

/**
 * Fetches every published file as an anonymous visitor would: no credentials,
 * no cookies, no redirects followed. Bytes, digests and the HTTP representation
 * must equal the accepted staging directory.
 */
export async function readBackPublication(input: {
  baseUrl: string;
  directoryName: string;
  files: readonly PublicationFile[];
  fetch?: typeof fetch;
}): Promise<ReadbackReport> {
  const get = input.fetch ?? fetch;
  const failures: string[] = [];
  const files: ReadbackReport["files"] = [];
  for (const file of input.files) {
    const url = new URL(`${input.directoryName}/${file.filename}`, input.baseUrl).toString();
    const response = await get(url, { redirect: "manual", signal: AbortSignal.timeout(60 * 60_000) });
    const hash = createHash("sha256");
    let sizeBytes = 0;
    if (response.status === 200 && response.body) {
      for await (const chunk of response.body) {
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
      }
    } else {
      await response.body?.cancel();
    }
    const sha256 = hash.digest("hex");
    files.push({ filename: file.filename, url, status: response.status, sizeBytes, sha256 });
    if (response.status !== 200) {
      failures.push(`${file.filename} returned HTTP ${response.status}`);
      continue;
    }
    if (sizeBytes !== file.sizeBytes || sha256 !== file.sha256) failures.push(`${file.filename} bytes differ from the accepted file`);
    const expected = publicationObjectHeaders(file.filename);
    for (const [header, value] of [
      ["content-type", expected.contentType],
      ["content-disposition", expected.contentDisposition],
      ["cache-control", expected.cacheControl],
    ] as const) {
      if (response.headers.get(header) !== value) failures.push(`${file.filename} ${header} is ${JSON.stringify(response.headers.get(header))}, expected ${JSON.stringify(value)}`);
    }
  }
  return { accepted: failures.length === 0, baseUrl: input.baseUrl, directoryName: input.directoryName, files, failures };
}

/** Re-proves the staged directory, then reads its published copy back anonymously. */
export async function readBackStagedPublication(
  input: Parameters<typeof verifyStagedPublication>[0],
  fetchImplementation?: typeof fetch,
): Promise<ReadbackReport> {
  const staged = await verifyStagedPublication(input);
  const distribution = await releaseDistribution();
  return readBackPublication({
    baseUrl: distribution.downloads.baseUrl,
    directoryName: staged.directoryName,
    files: staged.files,
    ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
  });
}

if (import.meta.main) {
  const { directory, ...input } = publicationArguments(process.argv.slice(2), "release:readback");
  const report = await readBackStagedPublication({ ...input, publicationDirectory: directory });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.accepted) process.exitCode = 1;
}
