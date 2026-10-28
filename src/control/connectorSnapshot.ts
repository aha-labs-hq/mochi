import type { ConnectorCatalog } from "../connectors/protocol.ts";
import {
  connectorCapabilityAvailability,
  type ConnectorCapabilityAvailability,
} from "../connectors/availability.ts";
export {
  CONNECTOR_CAPABILITY_AVAILABILITIES,
  isConnectorCapabilityAvailability,
  type ConnectorCapabilityAvailability,
} from "../connectors/availability.ts";

/**
 * The renderer-facing projection of one Bot's connector catalog.
 *
 * Deliberately narrower than `ConnectorCatalog`: a resource's `address` is a
 * provider URL that embeds a document token, so it never leaves the Bot. The
 * renderer receives an opaque resource id — which is what it must send back on
 * any selection change — plus a display name the provider already published.
 */
export interface ConnectorConnectionProjection {
  connectionId: string;
  providerId: string;
  providerDisplayName: string;
  status: "ready" | "authorizing" | "reauthorization_required" | "unavailable";
  accountDisplayName: string | null;
  /** The provider's closed reason the connection is not ready, if any. */
  problem: string | null;
  /** Provider-reported authorization facts; resource-level grants may be empty. */
  grantedScopes: readonly string[];
  /** Current proof state of the durable connector scope. */
  resourceScope: {
    status: "ready" | "checking" | "unavailable";
    selectedCount: number;
    problem?: string;
  };
  resources: readonly {
    resourceId: string;
    resourceType: string;
    displayName: string;
    selectionId: string | null;
    /** Whether this Bot chose it; an unchosen resource is an option, not a call. */
    selected: boolean;
    /** The owner's opaque identity, used to group and illustrate resources. */
    ownerId: string | null;
    /** Whether the resource is private to its owner, when the provider says. */
    visibility: "public" | "private" | null;
    /** Whether this Bot may write to it, when the provider says. */
    writable: boolean | null;
  }[];
  capabilities: readonly {
    id: string;
    displayName: string;
    description: string;
    operation: "read" | "write";
    /** Whether selecting a durable resource is required or optional. */
    resourceSelection: "required" | "optional";
    /** Availability at the catalog boundary, not a guarantee of execution. */
    availability: ConnectorCapabilityAvailability;
  }[];
}

export interface ConnectorCatalogProjection {
  revision: string;
  connections: readonly ConnectorConnectionProjection[];
}

/**
 * Projects the internal catalog to the safe shape the settings window reads.
 *
 * Capabilities are the provider's implemented operations. Availability tells a
 * missing provider grant from a missing resource choice or a connection outage;
 * the renderer does not infer access from scopes or duplicate these policies.
 */
export function projectConnectorCatalog(
  catalog: ConnectorCatalog,
  selectionIds: (connectionId: string, resourceId: string) => string | undefined,
): ConnectorCatalogProjection {
  return {
    revision: catalog.revision,
    connections: catalog.connections.map((connection) => {
      return {
        connectionId: connection.connectionId,
        providerId: connection.providerId,
        providerDisplayName: connection.providerDisplayName,
        status: connection.status,
        accountDisplayName: connection.account?.displayName ?? null,
        problem: connection.problem ?? null,
        grantedScopes: connection.grantedScopes,
        resourceScope: connection.resourceScope,
        resources: connection.resources.map((resource) => {
          // An unselected option has no authority; a selected resource
          // always carries the identity its selection was created with.
          // A missing one is a defect, not a state to render: an empty identity
          // would be sent back as a valid selection and match nothing.
          const selectionId = resource.selected
            ? selectionIds(connection.connectionId, resource.id)
            : null;
          if (resource.selected && !selectionId) {
            throw new Error(
              `Connector resource is missing its selection identity: ${resource.id}`,
            );
          }
          return {
            resourceId: resource.id,
            resourceType: resource.type,
            displayName: resource.displayName,
            selectionId: selectionId ?? null,
            selected: resource.selected,
            ownerId: resource.ownerId ?? null,
            visibility: resource.visibility ?? null,
            writable: resource.writable ?? null,
          };
        }),
        capabilities: connection.capabilities.map((capability) => ({
          id: capability.id,
          displayName: capability.displayName,
          description: capability.description,
          operation: capability.operation,
          resourceSelection: capability.resourceSelection,
          availability: connectorCapabilityAvailability(connection, capability),
        })),
      };
    }),
  };
}
