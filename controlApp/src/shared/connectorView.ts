import type { ConnectorCatalogProjection } from "../../../src/control/connectorSnapshot.ts";
import type { GitHubConnectionSnapshot } from "../../../src/github/repository.ts";

/** Renderer state retains the provider's actionable re-authorization distinction. */
export type GitHubStatus =
  | GitHubConnectionSnapshot["status"]
  | "reauthorization_required";

/**
 * A provider-shaped reading of one Bot's connector catalog.
 *
 * The catalog is the only published fact about a connector; the desktop still
 * needs to ask provider-shaped questions of it, because its screens explain a
 * specific provider's state rather than a generic list. Deriving those answers
 * here keeps one source of truth: nothing publishes GitHub's facts separately,
 * and no screen is entitled to invent them.
 */

/** The GitHub connection a Bot's catalog describes, if it has one. */
function githubConnectionOf(
  catalog: ConnectorCatalogProjection | null,
): ConnectorCatalogProjection["connections"][number] | null {
  return (
    catalog?.connections.find(
      (connection) => connection.providerId === "github",
    ) ?? null
  );
}

/**
 * GitHub's connection state, as the settings screens already model it.
 *
 * The translation preserves the catalog's actionable states. In particular,
 * reauthorization is not the same as a signed-out connection: the owner still
 * has a known account and needs a specific provider consent action.
 */
export function githubStatusOf(
  catalog: ConnectorCatalogProjection | null,
): GitHubStatus {
  const connection = githubConnectionOf(catalog);
  if (!connection) return catalog === null ? "unavailable" : "disconnected";
  switch (connection.status) {
    case "ready":
      return "connected";
    case "authorizing":
      return "authorizing";
    case "reauthorization_required":
      return "reauthorization_required";
    case "unavailable":
      return "unavailable";
  }
}

/**
 * The account a Bot's GitHub connection is bound to, if it is bound.
 *
 * `id` is the catalog's own connection identity, not a second provider field:
 * a connection already belongs to exactly one account, so its identifier is the
 * stable account identity the renderer needs for keys and avatars.
 */
export function githubAccountOf(
  catalog: ConnectorCatalogProjection | null,
): { id: number; login: string } | null {
  const connection = githubConnectionOf(catalog);
  const login = connection?.accountDisplayName;
  if (!connection || login === null || login === undefined || login === "")
    return null;
  const accountId = Number(
    connection.connectionId.slice(connection.connectionId.indexOf(":") + 1),
  );
  return Number.isSafeInteger(accountId) && accountId > 0
    ? { id: accountId, login }
    : null;
}

/** The provider's own reason the connection is not usable, when it has one. */
export function githubProblemOf(
  catalog: ConnectorCatalogProjection | null,
): string | null {
  return githubConnectionOf(catalog)?.problem ?? null;
}

/**
 * The repositories this Bot has chosen, as catalog resource ids.
 *
 * The catalog lists every repository the connection can reach, so anything that
 * means "what is in use" — a count, a readback — must filter on `selected` rather
 * than trust the list length.
 */
export function githubSelectedResourceIds(
  catalog: ConnectorCatalogProjection | null,
): string[] {
  return (githubConnectionOf(catalog)?.resources ?? [])
    .filter((resource) => resource.selected)
    .map((resource) => resource.resourceId);
}

/**
 * Resolves the opaque resource ids selected by the desktop into the legacy
 * GitHub control-wire ids. The renderer never parses provider ids; this is the
 * one provider-owned conversion at the host-to-Bridge boundary.
 */
export function githubRepositoryIdsForResourceIds(
  catalog: ConnectorCatalogProjection | null,
  resourceIds: readonly string[],
): number[] | null {
  const connection = githubConnectionOf(catalog);
  if (!connection || new Set(resourceIds).size !== resourceIds.length)
    return null;
  const selected = new Set(resourceIds);
  const resources = connection.resources.filter((resource) =>
    selected.has(resource.resourceId),
  );
  if (resources.length !== resourceIds.length) return null;
  const ids: number[] = [];
  for (const resource of resources) {
    const match = /^repository:([1-9][0-9]*)$/.exec(resource.resourceId);
    if (!match) return null;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    ids.push(id);
  }
  return ids;
}

export interface GitHubProjectView {
  resourceId: string;
  fullName: string;
  selected: boolean;
  /** The owner's identity, used to group and illustrate the repository. */
  ownerId: number | null;
  visibility: "public" | "private" | null;
  writable: boolean | null;
}

/**
 * The repositories a Bot's GitHub connection can access, chosen or not.
 *
 * A project screen offers the rest, so this reports the connection's whole
 * authorized catalog with `selected` saying which are in use. The metadata a
 * screen shows alongside a repository comes from the resource facts the provider
 * published, never from a provider call made while rendering.
 */
export function githubProjectsOf(
  catalog: ConnectorCatalogProjection | null,
): GitHubProjectView[] {
  const connection = githubConnectionOf(catalog);
  if (!connection) return [];
  return connection.resources.flatMap((resource) => {
    const ownerId = Number(resource.ownerId);
    return [
      {
        resourceId: resource.resourceId,
        fullName: resource.displayName,
        selected: resource.selected,
        ownerId: Number.isSafeInteger(ownerId) && ownerId > 0 ? ownerId : null,
        visibility: resource.visibility,
        // Preserve unconfirmed authority as unknown in the presentation.
        writable: resource.writable,
      },
    ];
  });
}
