import { canonicalJson, connectorRegistryDigest } from "./canonical.ts";
import type {
  ConnectorAdapter,
  ConnectorCapabilityManifest,
  ConnectorCapabilitySummary,
  ConnectorCatalog,
  ConnectorCatalogConnection,
  ConnectorConnectionSnapshot,
  ConnectorJsonSchema,
  ConnectorJsonSchemaProperty,
  ConnectorProviderManifest,
  ConnectorResourceSnapshot,
  JsonValue,
} from "./protocol.ts";
import {
  CONNECTOR_MAX_CAPABILITIES,
  CONNECTOR_MAX_CONNECTIONS,
  CONNECTOR_MAX_JSON_DEPTH,
  CONNECTOR_MAX_OUTPUT_BYTES,
  CONNECTOR_MAX_PROBLEM_LENGTH,
  CONNECTOR_MAX_RESOURCES,
  CONNECTOR_MAX_SCHEMA_DEPTH,
  CONNECTOR_MAX_SCHEMA_NODES,
  CONNECTOR_MAX_SCHEMA_PROPERTIES,
} from "./protocol.ts";

export class ConnectorRegistry {
  readonly #adapters = new Map<string, ConnectorAdapter>();

  register(adapter: ConnectorAdapter): void {
    validateManifest(adapter.manifest);
    deepFreeze(adapter.manifest);
    if (this.#adapters.has(adapter.manifest.id)) {
      throw new Error(
        `Connector provider is already registered: ${adapter.manifest.id}`,
      );
    }
    this.#adapters.set(adapter.manifest.id, adapter);
  }

  async catalog(
    botId: string,
    signal?: AbortSignal,
  ): Promise<ConnectorCatalog> {
    assertNonEmpty(botId, "Bot id", 128);
    if (hasControlCharacter(botId)) throw new Error("Invalid Bot id");
    const connections: ConnectorCatalogConnection[] = [];
    const connectionIds = new Set<string>();
    const snapshotsByAdapter = await Promise.all(
      [...this.#adapters.values()].map(async (adapter) => ({
        adapter,
        snapshots: await adapter.snapshot(botId, signal),
      })),
    );
    for (const { adapter, snapshots } of snapshotsByAdapter) {
      if (!Array.isArray(snapshots))
        throw new Error(
          `Connector adapter returned invalid snapshots: ${adapter.manifest.id}`,
        );
      if (snapshots.length > CONNECTOR_MAX_CONNECTIONS)
        throw new Error(
          `Connector adapter returned too many connections: ${adapter.manifest.id}`,
        );
      const typedSnapshots =
        snapshots as readonly ConnectorConnectionSnapshot[];
      for (const connection of typedSnapshots) {
        if (!isRecord(connection))
          throw new Error(
            "Connector adapter returned an invalid connection snapshot",
          );
        if (
          typeof connection.botId !== "string" ||
          typeof connection.providerId !== "string" ||
          typeof connection.connectionId !== "string"
        )
          throw new Error(
            "Connector adapter returned an invalid connection identity",
          );
        if (connection.botId !== botId)
          throw new Error(
            "Connector adapter returned a snapshot for another Bot",
          );
        if (connection.providerId !== adapter.manifest.id) {
          throw new Error(
            "Connector adapter returned a snapshot for another provider",
          );
        }
        if (
          connection.status !== "ready" &&
          connection.status !== "authorizing" &&
          connection.status !== "reauthorization_required" &&
          connection.status !== "unavailable"
        ) {
          throw new Error(
            "Connector adapter returned an invalid connection status",
          );
        }
        if (connection.problem !== undefined) {
          if (
            typeof connection.problem !== "string" ||
            connection.problem.length === 0 ||
            connection.problem.length > CONNECTOR_MAX_PROBLEM_LENGTH ||
            hasControlCharacter(connection.problem)
          ) {
            throw new Error(
              `Connector connection has an invalid problem: ${connection.connectionId}`,
            );
          }
          if (
            connection.status === "ready" ||
            connection.status === "authorizing"
          ) {
            throw new Error(
              `Connector connection is ${connection.status} but has a problem: ${connection.connectionId}`,
            );
          }
        } else if (
          connection.status === "reauthorization_required" ||
          connection.status === "unavailable"
        ) {
          throw new Error(
            `Connector connection is ${connection.status} without a problem: ${connection.connectionId}`,
          );
        }
        if (connection.account !== null) {
          if (
            !isRecord(connection.account) ||
            typeof connection.account.displayName !== "string"
          )
            throw new Error(
              `Connector adapter returned an invalid account display name: ${connection.connectionId}`,
            );
          assertNonEmpty(
            connection.account.displayName,
            "account display name",
            120,
          );
          if (hasControlCharacter(connection.account.displayName)) {
            throw new Error(
              `Connector adapter returned an unsafe account display name: ${connection.connectionId}`,
            );
          }
        }
        if (!Array.isArray(connection.grantedScopes))
          throw new Error(
            `Connector adapter returned invalid granted scopes: ${connection.connectionId}`,
          );
        if (
          new Set(connection.grantedScopes).size !==
          connection.grantedScopes.length
        ) {
          throw new Error(
            `Connector adapter returned duplicate granted scopes: ${connection.connectionId}`,
          );
        }
        for (const scope of connection.grantedScopes) {
          if (typeof scope !== "string")
            throw new Error(
              `Connector adapter returned an invalid granted scope: ${connection.connectionId}`,
            );
          assertNonEmpty(scope, "granted scope", 160);
          if (hasControlCharacter(scope))
            throw new Error(
              `Connector adapter returned an unsafe granted scope: ${connection.connectionId}`,
            );
        }
        if (
          !/^[a-z][a-z0-9._:-]{0,127}$/.test(connection.connectionId) ||
          !connectionIds.add(connection.connectionId)
        ) {
          throw new Error(
            `Connector adapter returned a duplicate or invalid connection: ${connection.connectionId}`,
          );
        }
        if (!Array.isArray(connection.resources))
          throw new Error(
            `Connector adapter returned invalid resources: ${connection.connectionId}`,
          );
        const resourceIds = new Set<string>();
        if (connection.resources.length > CONNECTOR_MAX_RESOURCES)
          throw new Error(
            `Connector adapter returned too many resources: ${connection.connectionId}`,
          );
        for (const resource of connection.resources) {
          if (!isRecord(resource))
            throw new Error(
              `Connector adapter returned an invalid resource: ${connection.connectionId}`,
            );
          if (
            typeof resource.id !== "string" ||
            typeof resource.type !== "string" ||
            typeof resource.displayName !== "string" ||
            typeof resource.selected !== "boolean"
          )
            throw new Error(
              `Connector adapter returned an invalid resource: ${resource.id}`,
            );
          if (
            !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(resource.id) ||
            !resourceIds.add(resource.id)
          ) {
            throw new Error(
              `Connector adapter returned a duplicate or invalid resource: ${resource.id}`,
            );
          }
          if (
            !adapter.manifest.resourceTypes.some(
              (type) => type.id === resource.type,
            )
          ) {
            throw new Error(
              `Connector adapter returned an unknown resource type: ${resource.type}`,
            );
          }
          assertNonEmpty(resource.displayName, "resource display name", 256);
          if (hasControlCharacter(resource.displayName)) {
            throw new Error(
              `Connector adapter returned an unsafe resource display name: ${resource.id}`,
            );
          }
          if (resource.ownerId !== undefined) {
            if (typeof resource.ownerId !== "string")
              throw new Error(
                `Connector adapter returned an invalid resource owner: ${resource.id}`,
              );
            assertNonEmpty(resource.ownerId, "resource owner", 128);
            if (hasControlCharacter(resource.ownerId))
              throw new Error(
                `Connector adapter returned an unsafe resource owner: ${resource.id}`,
              );
          }
          if (
            resource.visibility !== undefined &&
            resource.visibility !== "public" &&
            resource.visibility !== "private"
          ) {
            throw new Error(
              `Connector adapter returned an invalid resource visibility: ${resource.id}`,
            );
          }
          if (
            resource.writable !== undefined &&
            typeof resource.writable !== "boolean"
          )
            throw new Error(
              `Connector adapter returned an invalid resource write flag: ${resource.id}`,
            );
        }
        const resourceScope = normalizeResourceScope(
          connection.resourceScope,
          connection.resources,
          connection.connectionId,
        );
        // Keep every declared operation visible. The catalog availability layer
        // distinguishes a missing provider grant from an unselected resource,
        // an outage, and a capability that the provider has not implemented.
        const capabilities: ConnectorCapabilitySummary[] =
          adapter.manifest.capabilities
            .map(capabilitySummary)
            .sort((left, right) => stableCompare(left.id, right.id));
        // Every provider-known resource is published, including a durable choice
        // whose scope is currently being rechecked. `selected` describes the
        // saved range; resourceScope and the Broker decide whether it is callable
        // now. An unselected resource remains an option, never an authority.
        const resources: ConnectorCatalogConnection["resources"] =
          connection.resources
            .map((resource: ConnectorResourceSnapshot) => ({ ...resource }))
            .sort((left, right) => stableCompare(left.id, right.id));
        if (connections.length >= CONNECTOR_MAX_CONNECTIONS)
          throw new Error("Connector catalog has too many connections");
        connections.push({
          connectionId: connection.connectionId,
          problem: connection.problem ?? null,
          providerId: adapter.manifest.id,
          providerVersion: adapter.manifest.version,
          providerDisplayName: adapter.manifest.displayName,
          account:
            connection.account === null
              ? null
              : { displayName: connection.account.displayName },
          status: connection.status,
          grantedScopes: [...connection.grantedScopes].sort(),
          resources,
          resourceScope,
          capabilities,
        });
      }
    }
    connections.sort((left, right) =>
      stableCompare(left.connectionId, right.connectionId),
    );
    const catalog: ConnectorCatalog = {
      botId,
      revision: connectorRegistryDigest({ botId, connections }),
      connections,
    };
    assertBoundedJsonValue(catalog, "connector catalog");
    return deepFreeze(catalog);
  }

  adapter(providerId: string): ConnectorAdapter {
    const adapter = this.#adapters.get(providerId);
    if (!adapter) throw new Error(`Unknown connector provider: ${providerId}`);
    return adapter;
  }
}

function normalizeResourceScope(
  value: ConnectorConnectionSnapshot["resourceScope"],
  resources: readonly ConnectorResourceSnapshot[],
  connectionId: string,
): ConnectorConnectionSnapshot["resourceScope"] {
  const scope = value;
  if (!scope) {
    throw new Error(
      `Connector adapter omitted resource scope: ${connectionId}`,
    );
  }
  if (
    scope.status !== "ready" &&
    scope.status !== "checking" &&
    scope.status !== "unavailable"
  ) {
    throw new Error(
      `Connector resource scope has an invalid status: ${connectionId}`,
    );
  }
  if (
    !Number.isInteger(scope.selectedCount) ||
    scope.selectedCount < 0 ||
    scope.selectedCount > CONNECTOR_MAX_RESOURCES
  ) {
    throw new Error(
      `Connector resource scope has an invalid count: ${connectionId}`,
    );
  }
  const actualSelected = resources.filter(
    (resource) => resource.selected,
  ).length;
  if (scope.selectedCount !== actualSelected) {
    throw new Error(
      `Connector resource scope disagrees with resources: ${connectionId}`,
    );
  }
  if (scope.problem !== undefined) {
    if (
      typeof scope.problem !== "string" ||
      scope.problem.length === 0 ||
      scope.problem.length > CONNECTOR_MAX_PROBLEM_LENGTH ||
      hasControlCharacter(scope.problem)
    ) {
      throw new Error(
        `Connector resource scope has an invalid problem: ${connectionId}`,
      );
    }
    if (scope.status === "ready") {
      throw new Error(
        `Connector resource scope is ready but has a problem: ${connectionId}`,
      );
    }
  } else if (scope.status !== "ready") {
    throw new Error(
      `Connector resource scope is ${scope.status} without a problem: ${connectionId}`,
    );
  }
  if (scope.selectedCount === 0 && scope.status !== "ready") {
    throw new Error(
      `Connector resource scope is ${scope.status} with no selected resources: ${connectionId}`,
    );
  }
  return {
    status: scope.status,
    selectedCount: scope.selectedCount,
    ...(scope.problem === undefined ? {} : { problem: scope.problem }),
  };
}

function capabilitySummary(
  capability: ConnectorCapabilityManifest,
): ConnectorCapabilitySummary {
  return {
    id: capability.id,
    displayName: capability.displayName,
    description: capability.description,
    operation: capability.operation,
    resourceTypes: [...capability.resourceTypes],
    resourceSelection: capability.resourceSelection,
    requestAuthorization: capability.requestAuthorization,
    requiredScopes: [...capability.requiredScopes],
    idempotency: capability.idempotency,
    readback: capability.readback,
    manifestRevision: connectorRegistryDigest(capability),
  };
}

export function validateManifest(manifest: ConnectorProviderManifest): void {
  if (!isPlainObjectValue(manifest))
    throw new Error("Connector provider manifest must be an object");
  assertIdentifier(manifest.id, "provider id");
  assertVersion(manifest.version);
  assertNonEmpty(manifest.displayName, "provider display name", 120);
  assertSafeText(manifest.displayName, "provider display name", 120);
  if (!Array.isArray(manifest.resourceTypes))
    throw new Error("Connector provider resource types must be an array");
  if (manifest.resourceTypes.length === 0)
    throw new Error("Connector provider must declare a resource type");
  if (manifest.resourceTypes.length > CONNECTOR_MAX_RESOURCES)
    throw new Error("Connector provider declares too many resource types");
  const resourceIds = new Set<string>();
  for (const resource of manifest.resourceTypes) {
    if (!isPlainObjectValue(resource))
      throw new Error("Connector provider resource type must be an object");
    assertIdentifier(resource.id, "resource type id");
    assertNonEmpty(resource.displayName, "resource type display name", 120);
    assertSafeText(resource.displayName, "resource type display name", 120);
    if (!resourceIds.add(resource.id))
      throw new Error(`Duplicate resource type: ${resource.id}`);
  }
  if (!Array.isArray(manifest.capabilities))
    throw new Error("Connector provider capabilities must be an array");
  if (manifest.capabilities.length === 0)
    throw new Error("Connector provider must declare a capability");
  if (manifest.capabilities.length > CONNECTOR_MAX_CAPABILITIES)
    throw new Error("Connector provider declares too many capabilities");
  const capabilityIds = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (!isPlainObjectValue(capability))
      throw new Error("Connector provider capability must be an object");
    if (!capabilityIds.add(capability.id))
      throw new Error(`Duplicate connector capability: ${capability.id}`);
    assertCapability(manifest, capability);
  }
}

function assertCapability(
  manifest: ConnectorProviderManifest,
  capability: ConnectorCapabilityManifest,
): void {
  // Dot-separated segments, each a lowercase identifier. The first segment was
  // previously restricted to letters and digits, which forced a provider to
  // spell a multi-word noun as one run-on word; nothing about an identifier
  // justifies that, and every other segment already allowed separators.
  if (!/^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/.test(capability.id)) {
    throw new Error(`Invalid connector capability id: ${capability.id}`);
  }
  assertNonEmpty(capability.displayName, "capability display name", 120);
  assertNonEmpty(capability.description, "capability description", 1_000);
  assertSafeText(capability.displayName, "capability display name", 120);
  assertSafeText(capability.description, "capability description", 1_000);
  if (capability.operation !== "read" && capability.operation !== "write")
    throw new Error(`Invalid connector operation: ${capability.id}`);
  if (
    capability.resourceSelection !== "required" &&
    capability.resourceSelection !== "optional"
  )
    throw new Error(`Invalid connector resource selection: ${capability.id}`);
  if (
    capability.requestAuthorization !== "none" &&
    capability.requestAuthorization !== "current_message"
  )
    throw new Error(
      `Invalid connector request authorization: ${capability.id}`,
    );
  if (
    capability.idempotency !== "none" &&
    capability.idempotency !== "required"
  )
    throw new Error(`Invalid connector idempotency: ${capability.id}`);
  if (capability.readback !== "none" && capability.readback !== "required")
    throw new Error(`Invalid connector readback: ${capability.id}`);
  if (
    !Array.isArray(capability.resourceTypes) ||
    !Array.isArray(capability.requiredScopes)
  )
    throw new Error(`Invalid connector capability arrays: ${capability.id}`);
  if (capability.resourceTypes.length === 0)
    throw new Error(`Capability has no resource type: ${capability.id}`);
  for (const resourceType of capability.resourceTypes) {
    assertIdentifier(resourceType, "resource type id");
    if (
      !manifest.resourceTypes.some((resource) => resource.id === resourceType)
    ) {
      throw new Error(
        `Capability ${capability.id} references unknown resource type: ${resourceType}`,
      );
    }
  }
  for (const scope of capability.requiredScopes)
    assertNonEmpty(scope, "required scope", 160);
  for (const scope of capability.requiredScopes) {
    if (hasControlCharacter(scope))
      throw new Error(`Invalid required scope: ${scope}`);
  }
  if (
    new Set(capability.requiredScopes).size !== capability.requiredScopes.length
  )
    throw new Error(`Capability has duplicate scopes: ${capability.id}`);
  validateSchema(capability.inputSchema);
}

function validateSchema(schema: ConnectorJsonSchema): void {
  if (
    !isRecord(schema) ||
    schema.type !== "object" ||
    schema.additionalProperties !== false
  )
    throw new Error("Connector input schema must be a closed object");
  if (!isRecord(schema.properties) || !Array.isArray(schema.required))
    throw new Error("Connector input schema has invalid fields");
  const properties = Object.keys(schema.properties);
  if (properties.length > CONNECTOR_MAX_SCHEMA_PROPERTIES)
    throw new Error("Connector input schema has too many properties");
  if (new Set(properties).size !== properties.length)
    throw new Error("Connector input schema has duplicate properties");
  if (new Set(schema.required).size !== schema.required.length)
    throw new Error("Connector input schema has duplicate required properties");
  for (const required of schema.required) {
    assertSafeText(required, "schema required property", 256);
    if (!properties.includes(required))
      throw new Error(
        `Connector schema requires unknown property: ${required}`,
      );
  }
  const state = { nodes: 0 };
  for (const propertyName of properties) {
    assertSafeText(propertyName, "schema property name", 256);
    validateSchemaProperty(schema.properties[propertyName]!, 1, state);
  }
}

function validateSchemaProperty(
  schema: ConnectorJsonSchemaProperty,
  depth: number,
  state: { nodes: number },
): void {
  if (depth > CONNECTOR_MAX_SCHEMA_DEPTH)
    throw new Error("Connector schema exceeds the nesting limit");
  state.nodes += 1;
  if (state.nodes > CONNECTOR_MAX_SCHEMA_NODES)
    throw new Error("Connector schema has too many nodes");
  if (!isRecord(schema))
    throw new Error("Connector schema property must be an object");
  if (
    schema.type !== "string" &&
    schema.type !== "integer" &&
    schema.type !== "number" &&
    schema.type !== "boolean" &&
    schema.type !== "array" &&
    schema.type !== "object"
  )
    throw new Error("Connector schema property has an invalid type");
  if (schema.description !== undefined) {
    assertSafeText(schema.description, "schema property description", 1_000);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length > 128)
      throw new Error("Connector schema enum is too large");
    const enumKeys = new Set<string>();
    for (const item of schema.enum) {
      if (!isSchemaValueType(item, schema.type))
        throw new Error("Connector schema enum value does not match its type");
      const enumKey = canonicalJson(item);
      if (!enumKeys.add(enumKey))
        throw new Error("Connector schema enum has duplicate values");
    }
  }
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    if (schema.type !== "string")
      throw new Error("Connector string bounds require a string schema");
    assertNonNegativeInteger(
      schema.minLength,
      "Connector minimum string length",
    );
    assertNonNegativeInteger(
      schema.maxLength,
      "Connector maximum string length",
    );
    if (
      schema.minLength !== undefined &&
      schema.maxLength !== undefined &&
      schema.minLength > schema.maxLength
    )
      throw new Error("Connector schema minimum string length exceeds maximum");
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    if (schema.type !== "integer" && schema.type !== "number")
      throw new Error("Connector numeric bounds require a numeric schema");
    if (schema.minimum !== undefined && !Number.isFinite(schema.minimum))
      throw new Error("Connector schema minimum must be finite");
    if (schema.maximum !== undefined && !Number.isFinite(schema.maximum))
      throw new Error("Connector schema maximum must be finite");
  }
  if (schema.minItems !== undefined || schema.maxItems !== undefined) {
    if (schema.type !== "array")
      throw new Error("Connector item bounds require an array schema");
    assertNonNegativeInteger(schema.minItems, "Connector minimum item count");
    assertNonNegativeInteger(schema.maxItems, "Connector maximum item count");
    if (
      schema.minItems !== undefined &&
      schema.maxItems !== undefined &&
      schema.minItems > schema.maxItems
    )
      throw new Error("Connector schema minimum item count exceeds maximum");
  }
  if (schema.type === "array" && !schema.items)
    throw new Error("Connector array schema must declare items");
  if (schema.type === "object") {
    if (!isRecord(schema.properties) || schema.additionalProperties !== false)
      throw new Error("Nested connector objects must be closed");
    const nestedProperties = Object.keys(schema.properties);
    if (nestedProperties.length > CONNECTOR_MAX_SCHEMA_PROPERTIES)
      throw new Error("Nested connector schema has too many properties");
    const requiredProperties = schema.required ?? [];
    if (!Array.isArray(requiredProperties))
      throw new Error(
        "Nested connector schema has invalid required properties",
      );
    if (new Set(requiredProperties).size !== requiredProperties.length)
      throw new Error(
        "Nested connector schema has duplicate required properties",
      );
    for (const required of requiredProperties) {
      assertSafeText(required, "nested schema required property", 256);
      if (!Object.hasOwn(schema.properties, required))
        throw new Error(
          `Nested connector schema requires unknown property: ${required}`,
        );
    }
    if (schema.items !== undefined)
      throw new Error("Nested connector objects cannot declare array items");
    for (const propertyName of nestedProperties) {
      assertSafeText(propertyName, "nested schema property name", 256);
      validateSchemaProperty(
        schema.properties[propertyName]!,
        depth + 1,
        state,
      );
    }
  }
  if (
    schema.type === "array" &&
    (schema.properties !== undefined ||
      schema.required !== undefined ||
      schema.additionalProperties !== undefined)
  )
    throw new Error("Connector array schemas cannot declare object fields");
  if (
    schema.type !== "object" &&
    schema.type !== "array" &&
    (schema.items !== undefined ||
      schema.properties !== undefined ||
      schema.required !== undefined ||
      schema.additionalProperties !== undefined)
  )
    throw new Error("Primitive connector schemas cannot declare nested fields");
  if (schema.items) validateSchemaProperty(schema.items, depth + 1, state);
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  ) {
    throw new Error("Connector schema minimum exceeds maximum");
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    throw new Error(`Invalid ${label}: ${value}`);
}

function assertVersion(value: string): void {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value))
    throw new Error(`Invalid connector version: ${value}`);
}

function assertNonEmpty(value: string, label: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  )
    throw new Error(`Invalid ${label}`);
}

function assertSafeText(value: string, label: string, maximum: number): void {
  assertNonEmpty(value, label, maximum);
  if (hasControlCharacter(value)) throw new Error(`Invalid ${label}`);
}

function assertNonNegativeInteger(
  value: number | undefined,
  label: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new Error(`${label} must be a non-negative integer`);
}

function isSchemaValueType(
  value: JsonValue,
  type: ConnectorJsonSchemaProperty["type"],
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
  }
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainObjectValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertJsonValue(
  value: unknown,
  label = "value",
  depth = 0,
): asserts value is JsonValue {
  if (depth > CONNECTOR_MAX_JSON_DEPTH)
    throw new Error(`${label} exceeds the JSON nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
  } else if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, depth + 1);
    return;
  } else if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error(`${label} must be JSON data`);
    for (const [key, item] of Object.entries(value)) {
      assertNonEmpty(key, `${label} key`, 256);
      assertJsonValue(item, `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`${label} must be JSON data`);
}

export function assertBoundedJsonValue(
  value: unknown,
  label: string,
  maximumBytes = CONNECTOR_MAX_OUTPUT_BYTES,
): asserts value is JsonValue {
  assertJsonValue(value, label);
  const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
  if (bytes > maximumBytes)
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
}
