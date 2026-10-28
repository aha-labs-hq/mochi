import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { publicHttpsAddress } from "./stage_release_publication.ts";

/**
 * `release/distribution.json` is the one owner of where and as whom Mochi is
 * distributed: the Developer ID Team that signs it, the Cloudflare account,
 * the R2 bucket and the public download base. The Team stays `null` until the
 * issuer's Apple Developer membership is active; release packaging refuses it.
 */
export interface ReleaseDistribution {
  schemaVersion: 1;
  developerIdTeamId: string | null;
  cloudflareAccountId: string;
  downloads: { bucket: string; baseUrl: string };
}

export const RELEASE_DISTRIBUTION_PATH = join(resolve(import.meta.dir, ".."), "release", "distribution.json");

export async function releaseDistribution(path = RELEASE_DISTRIBUTION_PATH): Promise<ReleaseDistribution> {
  return parseReleaseDistribution(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export function parseReleaseDistribution(value: unknown): ReleaseDistribution {
  const root = exact(value, "release distribution", ["schemaVersion", "developerIdTeamId", "cloudflareAccountId", "downloads"]);
  if (root.schemaVersion !== 1) throw new Error("Release distribution must use schema 1");
  if (root.developerIdTeamId !== null && (typeof root.developerIdTeamId !== "string" || !/^[A-Z0-9]{10}$/.test(root.developerIdTeamId)))
    throw new Error("Release distribution developerIdTeamId must be null or a 10-character Apple Team ID");
  if (typeof root.cloudflareAccountId !== "string" || !/^[0-9a-f]{32}$/.test(root.cloudflareAccountId))
    throw new Error("Release distribution cloudflareAccountId must be a Cloudflare account ID");
  const downloads = exact(root.downloads, "release distribution downloads", ["bucket", "baseUrl"]);
  if (typeof downloads.bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(downloads.bucket))
    throw new Error("Release distribution bucket must be an R2 bucket name");
  if (typeof downloads.baseUrl !== "string") throw new Error("Release distribution baseUrl must be a URL");
  const base = publicHttpsAddress(downloads.baseUrl, "Release download base URL");
  if (base.toString() !== downloads.baseUrl || base.pathname !== "/" || base.search || base.hash)
    throw new Error("Release download base URL must be a bare origin ending with /");
  return {
    schemaVersion: 1,
    developerIdTeamId: root.developerIdTeamId,
    cloudflareAccountId: root.cloudflareAccountId,
    downloads: { bucket: downloads.bucket, baseUrl: downloads.baseUrl },
  };
}

/** The configured Team; release packaging cannot start without it. */
export function requireDeveloperIdTeam(distribution: ReleaseDistribution): string {
  if (!distribution.developerIdTeamId)
    throw new Error("Release packaging requires developerIdTeamId in release/distribution.json; set it once the Developer ID certificates exist");
  return distribution.developerIdTeamId;
}

function exact(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    throw new Error(`${label} has an invalid shape`);
  return value as Record<string, unknown>;
}
