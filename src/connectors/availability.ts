import type {
  ConnectorCapabilitySummary,
  ConnectorCatalogConnection,
} from "./protocol.ts";

/** Closed catalog-level states shared by the model and the renderer. */
export const CONNECTOR_CAPABILITY_AVAILABILITIES = [
  "ready",
  "selection_required",
  "resource_checking",
  "resource_unavailable",
  "authorization_required",
  "read_only",
  "access_unconfirmed",
  "connection_unavailable",
] as const;

export type ConnectorCapabilityAvailability =
  (typeof CONNECTOR_CAPABILITY_AVAILABILITIES)[number];

export function isConnectorCapabilityAvailability(
  value: unknown,
): value is ConnectorCapabilityAvailability {
  return CONNECTOR_CAPABILITY_AVAILABILITIES.some((state) => state === value);
}

/**
 * Derives the only catalog-level answer to "can this capability be used now?".
 *
 * This is a description of the current catalog, not a replacement for the
 * Broker's live grant and admission checks. A capability with no selected
 * resource of its own is waiting for a choice. For an `optional` capability,
 * this only blocks the durable connector path; the provider may also expose a
 * separate current-context path, such as Feishu message material. Once a connection has selected
 * any durable resources, `resourceScope` is the atomic proof for that whole
 * saved range; while that proof is checking or unavailable, no selected
 * resource is callable through the catalog.
 */
export function connectorCapabilityAvailability(
  connection: ConnectorCatalogConnection,
  capability: ConnectorCapabilitySummary,
): ConnectorCapabilityAvailability {
  if (connection.status !== "ready") return "connection_unavailable";
  if (
    !capability.requiredScopes.every((scope) =>
      connection.grantedScopes.includes(scope),
    )
  ) {
    return "authorization_required";
  }
  const selected = connection.resources.filter(
    (resource) =>
      resource.selected && capability.resourceTypes.includes(resource.type),
  );
  if (selected.length === 0) return "selection_required";
  const resourceScope = connection.resourceScope;
  if (resourceScope.status !== "ready" && resourceScope.selectedCount > 0) {
    return resourceScope.status === "checking"
      ? "resource_checking"
      : "resource_unavailable";
  }
  if (
    capability.operation === "read" ||
    selected.some((resource) => resource.writable === true)
  )
    return "ready";
  return selected.some((resource) => resource.writable === undefined)
    ? "access_unconfirmed"
    : "read_only";
}
