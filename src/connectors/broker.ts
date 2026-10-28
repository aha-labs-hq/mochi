import { createHash } from "node:crypto";
import { errorFields, log } from "../log.ts";
import { connectorCapabilityAvailability } from "./availability.ts";
import { canonicalJson, connectorRegistryDigest } from "./canonical.ts";
import { ConnectorError } from "./errors.ts";
import type { ConnectorWriteRecord, ConnectorWriteStore } from "./ledger.ts";
import type {
  ConnectorAdapter,
  ConnectorCapabilityManifest,
  ConnectorCatalog,
  ConnectorConnectionSnapshot,
  ConnectorRequest,
  ConnectorRequestContext,
  ConnectorResourceSnapshot,
  ConnectorTaskGrant,
  ConnectorWriteRequest,
  ConnectorWriteResult,
  JsonValue,
} from "./protocol.ts";
import {
  CONNECTOR_AUTHORIZATION_QUOTE_MIN_CHARACTERS,
  CONNECTOR_MAX_INPUT_BYTES,
  CONNECTOR_MAX_TEXT_LENGTH,
} from "./protocol.ts";
import { assertBoundedJsonValue, type ConnectorRegistry } from "./registry.ts";

export interface ConnectorDescribeRequest {
  readonly connectionId: string;
  readonly capabilityId: string;
  readonly catalogRevision: string;
}

export class ConnectorBroker {
  readonly #registry: ConnectorRegistry;
  readonly #writes: ConnectorWriteStore | undefined;

  /**
   * The ledger is optional so the Broker stays usable without a Bot database.
   * Omitting it does not weaken anything: a capability that declares
   * `idempotency: "required"` is refused rather than reaching its adapter.
   */
  constructor(registry: ConnectorRegistry, writes?: ConnectorWriteStore) {
    this.#registry = registry;
    this.#writes = writes;
  }

  catalog(botId: string, signal?: AbortSignal): Promise<ConnectorCatalog> {
    return this.#registry.catalog(botId, signal);
  }

  async describe(
    context: ConnectorRequestContext,
    request: ConnectorDescribeRequest,
    signal?: AbortSignal,
  ): Promise<ConnectorCapabilityManifest> {
    validateContext(context);
    validateRequestShape(request, "describe");
    assertRequestIdentifier(request.connectionId, "connection id");
    assertRequestIdentifier(request.capabilityId, "capability id");
    assertCatalogRevision(request.catalogRevision);
    const catalog = await this.#registry.catalog(context.botId, signal);
    assertCurrentCatalog(catalog.revision, request.catalogRevision);
    const connection = catalog.connections.find(
      (item) => item.connectionId === request.connectionId,
    );
    if (!connection)
      throw new ConnectorError(
        "connection_not_found",
        `Connector connection was not found: ${request.connectionId}`,
      );
    if (connection.status !== "ready")
      throw new ConnectorError(
        "connection_unavailable",
        `Connector connection is not ready: ${request.connectionId}`,
      );
    const capability = connection.capabilities.find(
      (item) => item.id === request.capabilityId,
    );
    if (!capability)
      throw new ConnectorError(
        "capability_unavailable",
        `Connector capability is unavailable: ${request.connectionId}/${request.capabilityId}`,
      );
    const manifest = this.#registry
      .adapter(connection.providerId)
      .manifest.capabilities.find((item) => item.id === capability.id);
    if (
      !manifest ||
      connectorRegistryDigest(manifest) !== capability.manifestRevision
    )
      throw new ConnectorError(
        "capability_unavailable",
        `Connector capability is unavailable: ${request.connectionId}/${request.capabilityId}`,
      );
    return manifest;
  }

  async read(
    context: ConnectorRequestContext,
    request: ConnectorRequest,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    validateContext(context);
    validateRequestShape(request, "read");
    const resolved = await this.#resolve(context, request, signal);
    if (resolved.capability.operation !== "read")
      throw new ConnectorError(
        "capability_wrong_operation",
        "Connector capability is not read-only",
      );
    validateInputOrThrow(request.input, resolved.capability);
    let result: JsonValue;
    try {
      result = await resolved.adapter.read({
        context,
        grant: makeGrant(context, request, null),
        connection: resolved.connection,
        resource: resolved.resource,
        capability: resolved.capability,
        input: request.input,
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw adapterFailure(cause, context, request, "read");
    }
    try {
      assertBoundedJsonValue(result, "connector read result");
    } catch (cause) {
      throw new ConnectorError(
        "adapter_result_invalid",
        "Connector adapter returned an invalid read result",
        { cause },
      );
    }
    return result;
  }

  async write(
    context: ConnectorRequestContext,
    request: ConnectorWriteRequest,
    signal?: AbortSignal,
  ): Promise<ConnectorWriteResult> {
    validateContext(context);
    validateRequestShape(request, "write");
    const resolved = await this.#resolve(context, request, signal);
    if (resolved.capability.operation !== "write")
      throw new ConnectorError(
        "capability_wrong_operation",
        "Connector capability is not writable",
      );
    if (resolved.resource.writable !== true)
      throw new ConnectorError(
        "capability_unavailable",
        resolved.resource.writable === false
          ? "Connector resource is read-only"
          : "Connector resource write access is unconfirmed",
      );
    validateInputOrThrow(request.input, resolved.capability);
    const authorizationQuote =
      resolved.capability.requestAuthorization === "current_message"
        ? currentMessageAuthorization(
            context.sourceText,
            request.authorizationQuote,
          )
        : null;
    if (resolved.capability.idempotency === "required") {
      if (
        !request.idempotencyKey ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.idempotencyKey)
      ) {
        throw new ConnectorError(
          "idempotency_invalid",
          "Connector write requires a bounded idempotency key",
        );
      }
    }
    const capabilityRevision = connectorRegistryDigest(resolved.capability);
    const ledgerKey = {
      connectionId: resolved.connection.connectionId,
      capabilityId: resolved.capability.id,
      idempotencyKey: request.idempotencyKey ?? "",
      resourceId: resolved.resource.id,
      catalogRevision: resolved.catalogRevision,
      capabilityRevision,
      inputDigest: createHash("sha256")
        .update(canonicalJson(request.input))
        .digest("hex"),
      sourceMessageId: context.sourceMessageId,
      topicKey: context.topicKey,
      requesterId: context.requesterId,
      authorizationDigest: authorizationQuote
        ? createHash("sha256").update(authorizationQuote).digest("hex")
        : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (resolved.capability.idempotency === "required") {
      const replay = this.#claimWrite(ledgerKey);
      if (replay) return replay;
    }
    let result: ConnectorWriteResult;
    try {
      result = await resolved.adapter.write({
        context,
        grant: makeGrant(context, request, authorizationQuote),
        connection: resolved.connection,
        resource: resolved.resource,
        capability: resolved.capability,
        input: request.input,
        idempotencyKey: request.idempotencyKey ?? null,
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      // A failed attempt must not poison its key: only a completed write blocks
      // a later retry, so the claim is released before the failure propagates.
      if (resolved.capability.idempotency === "required")
        this.#writes?.abandonConnectorWrite(
          ledgerKey.connectionId,
          ledgerKey.capabilityId,
          ledgerKey.idempotencyKey,
        );
      throw adapterFailure(cause, context, request, "write");
    }
    // Validate before recording, so an invalid adapter result never becomes the
    // replayable answer for this key.
    const parsed = parseWriteResult(result, resolved.capability.readback);
    if (resolved.capability.idempotency === "required") {
      this.#writes!.completeConnectorWrite(
        ledgerKey.connectionId,
        ledgerKey.capabilityId,
        ledgerKey.idempotencyKey,
        JSON.stringify(result),
      );
    }
    return parsed;
  }

  /**
   * Claims the write key, returning the recorded result when this exact write
   * already happened.
   *
   * The decision belongs here rather than in the adapter: an adapter cannot prove
   * it did not already act, so "already applied" must come from a record the
   * Broker owns. A key already in flight fails closed instead of issuing a second
   * side effect. A completed key is a replay only when the resource, capability
   * meaning, input, source message, topic, requester and exact authorization are
   * the same. The catalog revision is an observation point, not part of the
   * side-effect identity: refreshing a directory must not turn the same
   * operation into a second write.
   */
  #claimWrite(
    record: Omit<ConnectorWriteRecord, "status" | "resultJson">,
  ): ConnectorWriteResult | null {
    const writes = this.#writes;
    if (!writes)
      throw new ConnectorError(
        "idempotency_unavailable",
        "Connector write requires an idempotency ledger, but none is configured",
      );
    const existing = writes.connectorWriteRecord(
      record.connectionId,
      record.capabilityId,
      record.idempotencyKey,
    );
    if (existing) {
      if (existing.status === "pending")
        throw new ConnectorError(
          "idempotency_in_flight",
          "A connector write with this key is already executing",
        );
      if (
        existing.resourceId !== record.resourceId ||
        existing.capabilityRevision !== record.capabilityRevision ||
        existing.inputDigest !== record.inputDigest ||
        existing.sourceMessageId !== record.sourceMessageId ||
        existing.topicKey !== record.topicKey ||
        existing.requesterId !== record.requesterId ||
        existing.authorizationDigest !== record.authorizationDigest
      )
        throw new ConnectorError(
          "idempotency_conflict",
          "This connector write key is already recorded against a different request",
        );
      if (existing.resultJson === null)
        throw new ConnectorError(
          "idempotency_conflict",
          "This connector write key is recorded without a result",
        );
      // The stored result already passed this validation when it was recorded,
      // and a recorded write always carried a readback.
      return {
        ...parseWriteResult(JSON.parse(existing.resultJson), "required"),
        status: "already_applied",
      };
    }
    if (!writes.claimConnectorWrite(record))
      throw new ConnectorError(
        "idempotency_in_flight",
        "A connector write with this key is already executing",
      );
    return null;
  }

  async #resolve(
    context: ConnectorRequestContext,
    request: ConnectorRequest,
    signal?: AbortSignal,
  ): Promise<{
    adapter: ConnectorAdapter;
    connection: ConnectorConnectionSnapshot;
    resource: ConnectorResourceSnapshot;
    capability: ConnectorCapabilityManifest;
    catalogRevision: string;
  }> {
    assertRequestIdentifier(request.connectionId, "connection id");
    assertRequestIdentifier(request.resourceId, "resource id");
    assertRequestIdentifier(request.capabilityId, "capability id");
    assertCatalogRevision(request.catalogRevision);
    const catalog = await this.#registry.catalog(context.botId, signal);
    assertCurrentCatalog(catalog.revision, request.catalogRevision);
    const catalogConnection = catalog.connections.find(
      (item) => item.connectionId === request.connectionId,
    );
    if (!catalogConnection)
      throw new ConnectorError(
        "connection_not_found",
        `Connector connection was not found: ${request.connectionId}`,
      );
    if (catalogConnection.status !== "ready")
      throw new ConnectorError(
        "connection_unavailable",
        `Connector connection is not ready: ${request.connectionId}`,
      );
    // Resolve the choice boundary before checking the shared scope proof. This
    // keeps an unselected option distinct from a selected resource that is
    // temporarily unreachable, even when a provider has multiple resource types.
    const resource = catalogConnection.resources.find(
      (item) => item.id === request.resourceId,
    );
    if (!resource?.selected)
      throw new ConnectorError(
        "resource_not_selected",
        `Connector resource is not selected: ${request.connectionId}/${request.resourceId}`,
      );
    const resourceScope = catalogConnection.resourceScope;
    if (resourceScope.status !== "ready")
      throw new ConnectorError(
        "resource_unavailable",
        `Connector resource scope is ${resourceScope.status}: ${request.connectionId}`,
      );
    const capabilitySummary = catalogConnection.capabilities.find(
      (item) => item.id === request.capabilityId,
    );
    if (!capabilitySummary)
      throw new ConnectorError(
        "capability_unavailable",
        `Connector capability is unavailable: ${request.connectionId}/${request.capabilityId}`,
      );
    const adapter = this.#registry.adapter(catalogConnection.providerId);
    const capability = adapter.manifest.capabilities.find(
      (item) => item.id === capabilitySummary.id,
    );
    if (
      !capability ||
      connectorRegistryDigest(capability) !== capabilitySummary.manifestRevision
    )
      throw new ConnectorError(
        "capability_unavailable",
        `Connector capability is unavailable: ${request.connectionId}/${request.capabilityId}`,
      );
    if (
      connectorCapabilityAvailability(catalogConnection, capabilitySummary) ===
      "authorization_required"
    )
      throw new ConnectorError(
        "capability_unavailable",
        `Connector capability lacks the provider grant: ${request.connectionId}/${request.capabilityId}`,
      );
    if (!capability.resourceTypes.includes(resource.type))
      throw new ConnectorError(
        "capability_unavailable",
        "Connector capability does not apply to this resource",
      );
    return {
      adapter,
      connection: {
        botId: context.botId,
        connectionId: catalogConnection.connectionId,
        providerId: catalogConnection.providerId,
        status: catalogConnection.status,
        account: catalogConnection.account,
        grantedScopes: catalogConnection.grantedScopes,
        resources: catalogConnection.resources,
        resourceScope: catalogConnection.resourceScope,
      },
      resource,
      capability,
      catalogRevision: catalog.revision,
    };
  }
}

function makeGrant(
  context: ConnectorRequestContext,
  request: ConnectorRequest,
  authorizationQuote: string | null,
): ConnectorTaskGrant {
  return {
    botId: context.botId,
    connectionId: request.connectionId,
    resourceId: request.resourceId,
    capabilityId: request.capabilityId,
    sourceMessageId: context.sourceMessageId,
    topicKey: context.topicKey,
    requesterId: context.requesterId,
    authorizationQuote,
    catalogRevision: request.catalogRevision,
  };
}

/**
 * Proves a write against the current user message and returns the quote.
 *
 * The quote must be an exact excerpt with substance: at least
 * `CONNECTOR_AUTHORIZATION_QUOTE_MIN_CHARACTERS` letters or digits, or every letter and
 * digit of a shorter message. Whether the excerpt actually asks for this change
 * remains the model's judgment; this proves the cited evidence is real and is
 * not a fragment too small to mean anything.
 */
function currentMessageAuthorization(
  sourceText: string,
  quoteInput: string | undefined,
): string {
  const quote = quoteInput?.trim();
  if (!isValidAuthorizationQuote(quote) || !sourceText.includes(quote))
    throw new ConnectorError(
      "authorization_missing",
      "authorization_quote must be an exact excerpt of the current user message",
      { field: "authorization_quote" },
    );
  const required = Math.min(
    CONNECTOR_AUTHORIZATION_QUOTE_MIN_CHARACTERS,
    meaningfulCharacters(sourceText),
  );
  if (meaningfulCharacters(quote) < required)
    throw new ConnectorError(
      "authorization_too_short",
      `authorization_quote must contain at least ${CONNECTOR_AUTHORIZATION_QUOTE_MIN_CHARACTERS} letters or digits of the request, or the whole message when it is shorter`,
      { field: "authorization_quote" },
    );
  return quote;
}

function meaningfulCharacters(value: string): number {
  return value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/**
 * Classifies a failure the adapter did not classify itself.
 *
 * A provider refusal the adapter understands arrives as a ConnectorError with
 * its own code, field and reason. Anything else is unexpected: the caller gets a
 * stable code without internal detail, and the log keeps the cause.
 */
function adapterFailure(
  cause: unknown,
  context: ConnectorRequestContext,
  request: ConnectorRequest,
  operation: "read" | "write",
): ConnectorError {
  if (cause instanceof ConnectorError) return cause;
  log.warn("connector.adapter.failed", {
    botId: context.botId,
    sourceMessageId: context.sourceMessageId,
    connectionId: request.connectionId,
    capabilityId: request.capabilityId,
    operation,
    ...errorFields(cause),
  });
  return new ConnectorError(
    "adapter_failed",
    `Connector adapter failed during a ${operation}`,
    { cause },
  );
}

function validateContext(context: ConnectorRequestContext): void {
  assertRequestIdentifier(context.botId, "Bot id");
  assertContextText(context.sourceMessageId, "source message id", 256);
  assertContextText(context.topicKey, "topic key", 512);
  assertContextText(context.requesterId, "requester id", 256);
  if (context.conversationId !== undefined)
    assertContextText(context.conversationId, "conversation id", 128);
  assertContextText(
    context.sourceText,
    "source text",
    CONNECTOR_MAX_TEXT_LENGTH,
    true,
  );
}

function assertContextText(
  value: string,
  label: string,
  maximum: number,
  allowLineBreaks = false,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined || codePoint === 0x7f) return true;
      if (
        allowLineBreaks &&
        (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)
      )
        return false;
      return codePoint < 0x20;
    })
  )
    throw new ConnectorError(
      "request_invalid",
      `Connector request has an invalid ${label}`,
    );
}

function assertRequestIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim().length === 0 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
      );
    })
  ) {
    throw new ConnectorError(
      "request_invalid",
      `Connector request has an invalid ${label}`,
    );
  }
}

function validateRequestShape(
  request: unknown,
  kind: "describe" | "read" | "write",
): void {
  if (!isPlainRecord(request))
    throw new ConnectorError(
      "request_invalid",
      `Connector ${kind} request must be an object`,
    );
  const allowed =
    kind === "describe"
      ? new Set(["connectionId", "capabilityId", "catalogRevision"])
      : new Set([
          "connectionId",
          "resourceId",
          "capabilityId",
          "catalogRevision",
          "input",
          ...(kind === "write" ? ["authorizationQuote", "idempotencyKey"] : []),
        ]);
  if (Object.keys(request).some((key) => !allowed.has(key)))
    throw new ConnectorError(
      "request_invalid",
      `Connector ${kind} request has unknown fields`,
    );
}

function isValidAuthorizationQuote(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_000 &&
    value.trim().length > 0 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        codePoint !== 0x7f &&
        (codePoint >= 0x20 ||
          codePoint === 0x09 ||
          codePoint === 0x0a ||
          codePoint === 0x0d)
      );
    })
  );
}

function assertCatalogRevision(value: string): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value))
    throw new ConnectorError(
      "request_invalid",
      "Connector request has an invalid catalog revision",
    );
}

function assertCurrentCatalog(current: string, requested: string): void {
  if (current !== requested)
    throw new ConnectorError(
      "catalog_changed",
      "Connector catalog changed; read it again before acting",
    );
}

function validateInputOrThrow(
  input: JsonValue,
  capability: ConnectorCapabilityManifest,
): void {
  try {
    assertBoundedJsonValue(input, "connector input", CONNECTOR_MAX_INPUT_BYTES);
    validateObject(input, capability.inputSchema, "input");
  } catch (cause) {
    if (cause instanceof ConnectorError) throw cause;
    throw new ConnectorError(
      "input_invalid",
      cause instanceof Error
        ? cause.message
        : "Connector input exceeds its bounds",
      { cause, field: "input" },
    );
  }
}

/** A schema violation names the exact path the caller must correct. */
function violation(label: string, problem: string): ConnectorError {
  return new ConnectorError("input_invalid", `${label} ${problem}`, {
    field: label,
  });
}

function validateObject(
  value: JsonValue,
  schema: ConnectorCapabilityManifest["inputSchema"],
  label: string,
): void {
  if (!isPlainRecord(value)) throw violation(label, "must be an object");
  for (const required of schema.required) {
    if (!hasOwn(value, required))
      throw violation(`${label}.${required}`, "is required");
  }
  for (const key of Object.keys(value)) {
    const property = hasOwn(schema.properties, key)
      ? schema.properties[key]
      : undefined;
    if (!property)
      throw violation(
        `${label}.${key}`,
        "is not accepted by the capability schema",
      );
    validateProperty(value[key]!, property, `${label}.${key}`);
  }
}

function validateProperty(
  value: JsonValue,
  schema: ConnectorCapabilityManifest["inputSchema"]["properties"][string],
  label: string,
): void {
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value)))
    throw violation(
      label,
      `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") throw violation(label, "must be a string");
      if (schema.minLength !== undefined && value.length < schema.minLength)
        throw violation(
          label,
          `must have at least ${schema.minLength} characters`,
        );
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        throw violation(
          label,
          `must have at most ${schema.maxLength} characters`,
        );
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw violation(label, "must be an integer");
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw violation(label, "must be a number");
      break;
    case "boolean":
      if (typeof value !== "boolean")
        throw violation(label, "must be a boolean");
      break;
    case "array":
      if (!Array.isArray(value)) throw violation(label, "must be an array");
      for (const [index, item] of value.entries())
        validateProperty(item, schema.items!, `${label}[${index}]`);
      break;
    case "object":
      if (!isPlainRecord(value)) throw violation(label, "must be an object");
      if (!schema.properties || schema.additionalProperties !== false)
        throw violation(label, "uses an open object schema");
      for (const required of schema.required ?? []) {
        if (!hasOwn(value, required))
          throw violation(`${label}.${required}`, "is required");
      }
      for (const [key, nested] of Object.entries(value)) {
        const nestedSchema = hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
        if (!nestedSchema)
          throw violation(`${label}.${key}`, "is not accepted");
        validateProperty(nested, nestedSchema, `${label}.${key}`);
      }
      break;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw violation(label, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      throw violation(label, `must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      throw violation(label, `must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw violation(label, `must have at most ${schema.maxItems} items`);
  }
}

/**
 * Validates an adapter's write result against the capability's readback contract.
 *
 * The requirement, not the whole capability, is what this needs, so a recorded
 * result can be re-validated on replay without reconstructing the manifest.
 */
function parseWriteResult(
  value: unknown,
  readbackRequirement: ConnectorCapabilityManifest["readback"],
): ConnectorWriteResult {
  if (!isPlainRecord(value))
    throw new ConnectorError(
      "adapter_result_invalid",
      "Connector adapter returned an invalid write result",
    );
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => key !== "status" && key !== "readback" && key !== "summary",
    )
  )
    throw new ConnectorError(
      "adapter_result_invalid",
      "Connector adapter returned unknown write result fields",
    );
  const status = value.status;
  if (status !== "applied" && status !== "already_applied")
    throw new ConnectorError(
      "adapter_result_invalid",
      "Connector write returned an invalid status",
    );
  if (
    value.summary !== undefined &&
    (typeof value.summary !== "string" ||
      value.summary.length > 2_000 ||
      !isSafeUserText(value.summary))
  )
    throw new ConnectorError(
      "adapter_result_invalid",
      "Connector write returned an invalid summary",
    );
  const readback = value.readback;
  if (readback === undefined || readback === null) {
    if (readbackRequirement === "required")
      throw new ConnectorError(
        "readback_missing",
        "Connector write completed without an authoritative readback",
      );
    return {
      status,
      readback: null,
      ...(value.summary === undefined ? {} : { summary: value.summary }),
    };
  }
  try {
    assertBoundedJsonValue(readback, "connector write readback");
  } catch (cause) {
    throw new ConnectorError(
      "adapter_result_invalid",
      "Connector adapter returned an invalid write readback",
      { cause },
    );
  }
  return {
    status,
    readback,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
  };
}

function isPlainRecord(value: unknown): value is Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeUserText(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      codePoint !== 0x7f &&
      (codePoint >= 0x20 ||
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d)
    );
  });
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}
