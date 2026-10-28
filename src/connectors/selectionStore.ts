/**
 * A connector resource one Bot has selected for durable connector use, across
 * every provider. Selection is a local scope choice, not a provider grant and
 * not proof that the resource is reachable right now.
 *
 * The identity is the provider's own stable token, never the URL an owner
 * pasted: providers redirect and rename, so the resolved token is the only fact
 * a later call may use as a resource identity. `address` is an opaque provider
 * payload: it may retain the original URL or a display/proof snapshot, but it is
 * never the resource identity or a current authorization proof.
 *
 * A row exists only after the adapter proved it can read the resource once. A
 * later provider recheck may temporarily make the row unavailable without
 * turning the stored choice into a new grant.
 */
export interface ConnectorResourceSelection {
  connectionId: string;
  /** `<provider type>:<token>`, matching the registry's resource-id contract. */
  resourceId: string;
  resourceType: string;
  displayName: string;
  address: string;
  selectionId: string;
}

/**
 * The registry accepts resource ids as `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`, so
 * an id is a provider type and a token joined by a colon. Two providers cannot
 * collide because each owns its own connection.
 */
export function connectorResourceId(
  resourceType: string,
  token: string,
): string {
  return `${resourceType}:${token}`;
}

export const MAXIMUM_CONNECTOR_RESOURCES = 1_000;

const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
/** The same 32-hex identity GitHub selections use, so both read alike. */
const SELECTION_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isConnectorResourceId(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
}

/**
 * Any opaque connector identifier: a connection, capability, resource or catalog
 * revision. Validated here so the model-facing tool layer only references
 * identifiers this module's contract accepts.
 */
export function isConnectorIdentifier(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
}

export function isConnectorSelectionId(value: unknown): value is string {
  return typeof value === "string" && SELECTION_ID_PATTERN.test(value);
}

export function isConnectorDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/\p{Cc}/u.test(value)
  );
}

/** A stored provider payload is bounded here; its provider owns the content. */
export function isConnectorAddress(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= 2_048
  );
}

export function isConnectorResourceSelection(
  value: unknown,
): value is ConnectorResourceSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const selection = value as Record<string, unknown>;
  return (
    Object.keys(selection).sort().join(",") ===
      "address,connectionId,displayName,resourceId,resourceType,selectionId" &&
    isConnectorResourceId(selection.connectionId) &&
    isConnectorResourceId(selection.resourceId) &&
    isConnectorResourceId(selection.resourceType) &&
    isConnectorDisplayName(selection.displayName) &&
    isConnectorAddress(selection.address) &&
    isConnectorSelectionId(selection.selectionId)
  );
}

/** The durable storage one Bot owns for its connector resource selections. */
export interface ConnectorSelectionStore {
  connectorSelections(connectionId: string): ConnectorResourceSelection[];
  /** Lists connection identities with durable rows so a provider can retire stale accounts. */
  connectorSelectionConnectionIds(): readonly string[];
  replaceConnectorSelections(
    connectionId: string,
    selections: readonly ConnectorResourceSelection[],
  ): void;
}
