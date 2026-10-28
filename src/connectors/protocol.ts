export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ConnectorOperation = "read" | "write";
/** Whether an invocation must carry an exact authorization quote from the current message. */
export type ConnectorRequestAuthorization = "none" | "current_message";
/**
 * The fewest letters or digits a `current_message` quote must carry.
 *
 * Four is the shortest explicit request that still names an action and its
 * object, such as "关掉 #12"; a fragment like "看看" lifted from a question
 * carries no request at all. A message shorter than this is quoted whole, so a
 * terse "好" or "关了吧" still authorizes what it answers.
 */
export const CONNECTOR_AUTHORIZATION_QUOTE_MIN_CHARACTERS = 4;
/** Optional choices extend a separate current-context path across messages. */
export type ConnectorResourceSelectionMode = "required" | "optional";
export type ConnectorReadback = "none" | "required";

export const CONNECTOR_MAX_INPUT_BYTES = 128_000;
export const CONNECTOR_MAX_OUTPUT_BYTES = 200_000;
export const CONNECTOR_MAX_JSON_DEPTH = 32;
export const CONNECTOR_MAX_SCHEMA_DEPTH = 16;
export const CONNECTOR_MAX_SCHEMA_PROPERTIES = 128;
export const CONNECTOR_MAX_SCHEMA_NODES = 2_048;
export const CONNECTOR_MAX_CONNECTIONS = 256;
export const CONNECTOR_MAX_RESOURCES = 1_000;
export const CONNECTOR_MAX_CAPABILITIES = 256;
export const CONNECTOR_MAX_TEXT_LENGTH = 100_000;
/** Stable provider problem codes are bounded protocol data, not free-form prose. */
export const CONNECTOR_MAX_PROBLEM_LENGTH = 120;

export interface ConnectorJsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, ConnectorJsonSchemaProperty>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface ConnectorJsonSchemaProperty {
  readonly type:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "array"
    | "object";
  readonly description?: string;
  readonly enum?: readonly JsonPrimitive[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly items?: ConnectorJsonSchemaProperty;
  readonly properties?: Readonly<Record<string, ConnectorJsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
}

export interface ConnectorResourceType {
  readonly id: string;
  readonly displayName: string;
}

export interface ConnectorCapabilityManifest {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly operation: ConnectorOperation;
  readonly resourceTypes: readonly string[];
  readonly resourceSelection: ConnectorResourceSelectionMode;
  readonly inputSchema: ConnectorJsonSchema;
  readonly requestAuthorization: ConnectorRequestAuthorization;
  readonly requiredScopes: readonly string[];
  readonly idempotency: "none" | "required";
  readonly readback: ConnectorReadback;
}

/** Catalog metadata is intentionally smaller than the describe payload. */
export interface ConnectorCapabilitySummary {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly operation: ConnectorOperation;
  readonly resourceTypes: readonly string[];
  readonly resourceSelection: ConnectorResourceSelectionMode;
  readonly requestAuthorization: ConnectorRequestAuthorization;
  readonly requiredScopes: readonly string[];
  readonly idempotency: "none" | "required";
  readonly readback: ConnectorReadback;
  /** Changes whenever the complete capability manifest changes. */
  readonly manifestRevision: string;
}

export interface ConnectorProviderManifest {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly resourceTypes: readonly ConnectorResourceType[];
  readonly capabilities: readonly ConnectorCapabilityManifest[];
}

export interface ConnectorResourceSnapshot {
  readonly id: string;
  readonly type: string;
  readonly displayName: string;
  /** Whether this Bot saved the resource in its durable connector range. */
  readonly selected: boolean;
  /**
   * The account or owner the resource belongs to, when the provider has one.
   *
   * It is an opaque provider identifier used for display grouping, never for
   * authority: what a call may reach is decided by the connection and the
   * selection, not by this value.
   */
  readonly ownerId?: string;
  /** Whether the resource is private to its owner, when that is meaningful. */
  readonly visibility?: "public" | "private";
  /** Whether this Bot may write to the resource, when the provider can say. */
  readonly writable?: boolean;
}

/**
 * The current proof state of a connection's durable resource scope.
 *
 * This is separate from the connection lifecycle: a provider account can be
 * connected and usable for current-message material while the entire durable
 * resource range is being rechecked or is temporarily unreachable.
 */
export interface ConnectorResourceScopeSnapshot {
  readonly status: "ready" | "checking" | "unavailable";
  /** Number of durable resource choices held locally, including unverified ones. */
  readonly selectedCount: number;
  readonly problem?: string;
}

export interface ConnectorConnectionSnapshot {
  readonly botId: string;
  readonly connectionId: string;
  readonly providerId: string;
  readonly status:
    | "ready"
    | "authorizing"
    | "reauthorization_required"
    | "unavailable";
  readonly account: { readonly displayName: string } | null;
  /** Provider-reported authorization facts; resource-level grants may be empty. */
  readonly grantedScopes: readonly string[];
  readonly resources: readonly ConnectorResourceSnapshot[];
  /** Required proof state for the Bot's durable resource range. */
  readonly resourceScope: ConnectorResourceScopeSnapshot;
  /**
   * The provider's own stable reason the connection is not ready, when it has
   * one.
   *
   * It is a closed identifier rather than prose: the caller needs to tell an
   * unrecoverable setup defect from a re-authorization the user can perform, and
   * a settings window renders that difference as a specific next action.
   */
  readonly problem?: string;
}

export interface ConnectorCatalogConnection {
  readonly connectionId: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly providerDisplayName: string;
  readonly account: { readonly displayName: string } | null;
  readonly status: ConnectorConnectionSnapshot["status"];
  /** Carried through from the connection so a caller can act on the reason. */
  readonly problem: string | null;
  /** Provider-reported authorization facts; resource-level grants may be empty. */
  readonly grantedScopes: readonly string[];
  readonly resources: readonly ConnectorResourceSnapshot[];
  /** Proof state for the Bot's durable resource range. */
  readonly resourceScope: ConnectorResourceScopeSnapshot;
  readonly capabilities: readonly ConnectorCapabilitySummary[];
}

export interface ConnectorCatalog {
  readonly botId: string;
  readonly revision: string;
  readonly connections: readonly ConnectorCatalogConnection[];
}

export interface ConnectorRequestContext {
  readonly botId: string;
  readonly sourceMessageId: string;
  readonly sourceText: string;
  readonly topicKey: string;
  readonly requesterId: string;
  /** Trusted channel scope supplied by the host, never capability input. */
  readonly conversationId?: string;
  /**
   * The origin of this turn, already resolved to a provider-neutral shape by the
   * channel that received it.
   *
   * A capability that records who asked for a change needs this, and it must not
   * have to know which chat product the request came from. A channel that cannot
   * prove provenance supplies none, and a capability that requires it fails
   * closed rather than writing an unattributable record.
   */
  readonly provenance?: ConnectorProvenance;
}

export interface ConnectorProvenance {
  readonly sourceMessageLink: string;
  readonly requesterName: string;
  readonly participantNames: readonly string[];
}

/** The normalized authority passed to an adapter for one provider action. */
export interface ConnectorTaskGrant {
  readonly botId: string;
  readonly connectionId: string;
  readonly resourceId: string;
  readonly capabilityId: string;
  readonly sourceMessageId: string;
  readonly topicKey: string;
  readonly requesterId: string;
  readonly authorizationQuote: string | null;
  readonly catalogRevision: string;
}

export interface ConnectorRequest {
  readonly connectionId: string;
  readonly resourceId: string;
  readonly capabilityId: string;
  readonly catalogRevision: string;
  readonly input: JsonValue;
}

export interface ConnectorWriteRequest extends ConnectorRequest {
  readonly authorizationQuote?: string;
  readonly idempotencyKey?: string;
}

export interface ConnectorWriteResult {
  readonly status: "applied" | "already_applied";
  /** null means the capability did not promise an authoritative readback. */
  readonly readback: JsonValue | null;
  readonly summary?: string;
}

export interface ConnectorAdapter {
  readonly manifest: ConnectorProviderManifest;
  snapshot(
    botId: string,
    signal?: AbortSignal,
  ): Promise<readonly ConnectorConnectionSnapshot[]>;
  read(input: {
    readonly context: ConnectorRequestContext;
    readonly grant: ConnectorTaskGrant;
    readonly connection: ConnectorConnectionSnapshot;
    readonly resource: ConnectorResourceSnapshot;
    readonly capability: ConnectorCapabilityManifest;
    readonly input: JsonValue;
    readonly signal?: AbortSignal;
  }): Promise<JsonValue>;
  write(input: {
    readonly context: ConnectorRequestContext;
    readonly grant: ConnectorTaskGrant;
    readonly connection: ConnectorConnectionSnapshot;
    readonly resource: ConnectorResourceSnapshot;
    readonly capability: ConnectorCapabilityManifest;
    readonly input: JsonValue;
    readonly idempotencyKey: string | null;
    readonly signal?: AbortSignal;
  }): Promise<ConnectorWriteResult>;
}
