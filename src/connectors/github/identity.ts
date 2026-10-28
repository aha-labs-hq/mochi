import { isGitHubId, isGitHubNonce } from "../../github/repository.ts";
import { connectorResourceId } from "../selectionStore.ts";
import { GITHUB_PROVIDER_ID, GITHUB_RESOURCE_TYPE } from "./manifest.ts";

/**
 * GitHub's connector identities.
 *
 * A connection belongs to one authorized account, so re-authorizing produces a
 * different connection rather than reusing one whose grant has changed. A
 * resource is one repository, addressed by its own numeric id.
 */

export function githubConnectionId(
  accountId: number | undefined,
): string | null {
  return accountId === undefined
    ? null
    : connectorResourceId(GITHUB_PROVIDER_ID, String(accountId));
}

export function githubResourceId(repositoryId: number): string {
  return connectorResourceId(GITHUB_RESOURCE_TYPE, String(repositoryId));
}

/**
 * What a stored choice carries about one repository.
 *
 * A selection carries the installation and OAuth grant it was made under, which
 * decide whether the choice is still valid, plus the display facts a screen shows
 * without a provider call. A repository id alone cannot express those bindings,
 * and the catalog is rebuilt on every tool call so the display facts cannot be
 * fetched there. The value is therefore a small provider-owned record, not a bare
 * string.
 */
export interface GitHubResourceFacts {
  /** The installation the choice was created under. */
  binding: string;
  /** The OAuth grant the choice was created under; null means a pre-grant row. */
  grantId: string | null;
  ownerId: string;
  visibility: "public" | "private";
  writable: boolean;
}

/** Encodes a stored choice's provider facts into the selection's payload column. */
export function encodeGitHubResourceFacts(facts: GitHubResourceFacts): string {
  return JSON.stringify(facts);
}

/**
 * Decodes a stored choice's provider facts.
 *
 * A row that cannot be decoded is treated as carrying no display facts rather
 * than as a valid empty record, so a damaged row cannot silently present a
 * repository as public and read-only.
 */
export function decodeGitHubResourceFacts(
  value: string,
): GitHubResourceFacts | null {
  if (!value.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as Partial<GitHubResourceFacts>;
    if (
      typeof parsed.binding !== "string" ||
      typeof parsed.ownerId !== "string"
    )
      return null;
    if (parsed.visibility !== "public" && parsed.visibility !== "private")
      return null;
    if (typeof parsed.writable !== "boolean") return null;
    if (
      parsed.grantId !== undefined &&
      parsed.grantId !== null &&
      !isGitHubNonce(parsed.grantId)
    )
      return null;
    return {
      binding: parsed.binding,
      grantId: parsed.grantId ?? null,
      ownerId: parsed.ownerId,
      visibility: parsed.visibility,
      writable: parsed.writable,
    };
  } catch {
    return null;
  }
}

/** The repository a catalog resource id names, or null when it names another. */
export function githubRepositoryIdOf(resourceId: string): number | null {
  const separator = resourceId.indexOf(":");
  if (separator <= 0 || resourceId.slice(0, separator) !== GITHUB_RESOURCE_TYPE)
    return null;
  const repositoryId = Number(resourceId.slice(separator + 1));
  return isGitHubId(repositoryId) ? repositoryId : null;
}
