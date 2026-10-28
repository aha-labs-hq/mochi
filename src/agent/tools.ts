import { createHash } from "node:crypto";
import { canonicalJson } from "../connectors/canonical.ts";
import { connectorCapabilityAvailability } from "../connectors/availability.ts";
import type { ConnectorBroker } from "../connectors/broker.ts";
import { ConnectorError } from "../connectors/errors.ts";
import type { ConnectorProvenance, JsonValue } from "../connectors/protocol.ts";
import { isConnectorIdentifier } from "../connectors/selectionStore.ts";
import type { MessageContext } from "../domain.ts";
import { log } from "../log.ts";
import type { RuntimeToolOutputItem } from "../runtime/toolOutput.ts";
import { textToolOutput } from "../runtime/toolOutput.ts";
import { runtimeCapabilityAbi } from "../runtime/capability.ts";
import { mergeIssueOutcomes, type WorkflowOutcome } from "../issueWorkflow.ts";
import type { ScheduleResource } from "../schedules/store.ts";
import type { ConnectorSelectionStore } from "../connectors/selectionStore.ts";
import { scheduleResourcesStillSelected } from "../schedules/authority.ts";
import {
  CONNECTOR_CATALOG_TOOL,
  CONNECTOR_DESCRIBE_TOOL,
  CONNECTOR_READ_TOOL,
  CONNECTOR_TOOLS,
  CONNECTOR_TOOL_NAMES,
} from "./connectorTools.ts";


export interface ToolTurnState {
  /** `connector_write` calls this message has sent to the Broker. */
  mutationCount: number;
  sourceText: string;
  issueOutcome: WorkflowOutcome | null;
  /**
   * Where this turn came from, already resolved to a neutral shape by the
   * channel that received it. A capability that records who asked for a change
   * reads this and never the chat product's own evidence.
   */
  provenance?: ConnectorProvenance;
  /** Trusted occurrence scope. An empty array means public research only. */
  scheduledResources?: readonly ScheduleResource[];
}

/**
 * The model's whole tool set.
 *
 * Every external service is reached through the same four provider-neutral
 * tools. A provider's operations live in its connector manifest, so adding a
 * provider changes the catalog the model reads and never the ABI: there is no
 * per-provider tool to add, and no second path to the same provider.
 *
 * This is a session-binding contract — the tools a permanent Session was bound
 * to are fixed at binding time — so changing this list requires an explicit
 * `runtime:session:migrate`, never a silent rebind.
 */
export const AGENT_TOOLS = Object.freeze([...CONNECTOR_TOOLS]);

export const AGENT_TOOL_CAPABILITY_ABI = runtimeCapabilityAbi(AGENT_TOOLS);

/**
 * Writes one user message may send, across every connector.
 *
 * A message authorizes its own writes, so the budget belongs to the source
 * message and a steered follow-up brings its own. Ten covers a batch a person
 * can still check in one reply — labelling five Issues with one correction
 * each, or five creates that each need a duplicate decision — while a runaway
 * or injected loop stops long before it can sweep a repository. Past it the
 * model reports what it did, and the next message continues with its own
 * authorization.
 */
export const CONNECTOR_WRITES_PER_MESSAGE = 10;

export class AgentToolExecutor {
  readonly #connectors: ConnectorBroker;
  readonly #botId: string;

  constructor(connectors: ConnectorBroker, botId: string, private readonly selections?: ConnectorSelectionStore) {
    this.#connectors = connectors;
    this.#botId = botId;
  }

  async execute(
    name: string,
    rawArguments: unknown,
    context: MessageContext,
    turn: ToolTurnState,
  ): Promise<RuntimeToolOutputItem[]> {
    if (!CONNECTOR_TOOL_NAMES.has(name)) throw new Error(`Unknown agent tool: ${name}`);
    const args = parseArguments(rawArguments);
    try {
      return connectorToolOutput(await this.#dispatch(name, args, context, turn));
    } catch (error) {
      if (error instanceof ConnectorError) throw connectorFailure(error);
      throw error;
    }
  }

  /**
   * Dispatches one provider-neutral connector tool.
   *
   * The Broker—not this layer—resolves the capability, validates the input
   * against the declared schema, checks the resource is selected, enforces the
   * authorization quote and decides idempotency. This layer supplies the turn's
   * provenance, refuses malformed identifiers before they reach it, and owns
   * the per-message write budget, because only it sees the turn.
   */
  async #dispatch(
    name: string,
    args: Record<string, unknown>,
    context: MessageContext,
    turn: ToolTurnState,
  ): Promise<JsonValue> {
    const broker = this.#connectors;
    if (turn.scheduledResources && name === "connector_write") throw new Error("安排执行期间不能写入外部服务或创建、修改安排。请交付建议，等待人的当前指令。");
    const scheduledCatalog = turn.scheduledResources ? await broker.catalog(this.#botId) : undefined;
    if (scheduledCatalog && (!this.selections || !scheduleResourcesStillSelected(this.#botId, turn.scheduledResources!, scheduledCatalog, this.selections))) {
      throw new Error("安排绑定的资源授权已变化，请重新指定。");
    }
    const requestContext = {
      botId: this.#botId,
      sourceMessageId: context.sourceMessageId,
      sourceText: turn.sourceText,
      topicKey: context.threadKey,
      requesterId: context.requesterId,
      conversationId: context.chatId,
      ...(turn.provenance ? { provenance: turn.provenance } : {}),
    };
    if (name === CONNECTOR_CATALOG_TOOL.name) {
      const catalog = scheduledCatalog ?? await broker.catalog(this.#botId);
      // Summaries only: a capability's full schema is fetched on demand, so a
      // routine turn never carries every provider's schema.
      return {
        revision: catalog.revision,
        connections: catalog.connections.filter((connection) => !turn.scheduledResources
          || turn.scheduledResources.some((resource) => resource.connectionId === connection.connectionId)).map((connection) => ({
          connection_id: connection.connectionId,
          provider: connection.providerDisplayName,
          status: connection.status,
          problem: connection.problem,
          // Explicitly name provider authorization facts so they are not
          // mistaken for the durable resource range below.
          granted_scopes: [...connection.grantedScopes],
          account: connection.account?.displayName ?? null,
          resources: connection.resources.filter((resource) => !turn.scheduledResources
            || turn.scheduledResources.some((pinned) => pinned.connectionId === connection.connectionId && pinned.resourceId === resource.id)).map((resource) => ({
            resource_id: resource.id,
            type: resource.type,
            name: resource.displayName,
            // Keep the choice boundary explicit for the model. The catalog
            // intentionally includes authorized but unselected options so a
            // settings surface can offer them; a read/write call still has to
            // pass the Broker's selected-resource and current-scope gates.
            selected: resource.selected,
            writable: resource.writable ?? null,
          })),
          resource_scope: {
            status: connection.resourceScope.status,
            selected_count: connection.resourceScope.selectedCount,
            ...(connection.resourceScope.problem
              ? { problem: connection.resourceScope.problem }
              : {}),
          },
          capabilities: connection.capabilities.filter((capability) => !turn.scheduledResources || capability.operation === "read").map((capability) => ({
            capability_id: capability.id,
            name: capability.displayName,
            operation: capability.operation,
            resource_selection: capability.resourceSelection,
            required_scopes: [...capability.requiredScopes],
            manifest_revision: capability.manifestRevision,
            availability: connectorCapabilityAvailability(connection, capability),
          })),
        })),
      } as JsonValue;
    }
    const connectionId = requestIdentifier(args.connection_id, "connection_id");
    const capabilityId = requestIdentifier(args.capability_id, "capability_id");
    const catalogRevision = requestIdentifier(args.catalog_revision, "catalog_revision");
    if (scheduledCatalog && (!turn.scheduledResources!.some((resource) => resource.connectionId === connectionId)
      || !scheduledCatalog.connections.find((connection) => connection.connectionId === connectionId)?.capabilities
        .some((capability) => capability.id === capabilityId && capability.operation === "read"))) throw new Error("这个能力不在安排的只读范围内。");
    if (name === CONNECTOR_DESCRIBE_TOOL.name) {
      return (await broker.describe(requestContext, {
        connectionId, capabilityId, catalogRevision,
      })) as unknown as JsonValue;
    }
    const resourceId = requestIdentifier(args.resource_id, "resource_id");
    if (turn.scheduledResources && !turn.scheduledResources.some((resource) => resource.connectionId === connectionId && resource.resourceId === resourceId)) {
      throw new Error("这个资源没有被指定给本次安排。");
    }
    const input = parseCapabilityInput(args.input);
    if (name === CONNECTOR_READ_TOOL.name) {
      return await broker.read(requestContext, {
        connectionId, resourceId, capabilityId, catalogRevision, input,
      });
    }
    // A write additionally needs the caller's exact authorization. The
    // idempotency key is derived here rather than accepted from the model: the
    // turn's source message and the exact request identify the operation, so a
    // repeated call for the same message and input is the same operation, while
    // a new message is genuinely new. Letting the model choose the key would let
    // it defeat the check by inventing one.
    const authorizationQuote = requiredString(args.authorization_quote, "authorization_quote");
    if (turn.mutationCount >= CONNECTOR_WRITES_PER_MESSAGE) {
      log.warn("connector.write.budget_exhausted", {
        botId: this.#botId,
        sourceMessageId: context.sourceMessageId,
        connectionId,
        resourceId,
        capabilityId,
        limit: CONNECTOR_WRITES_PER_MESSAGE,
      });
      turn.issueOutcome = mergeIssueOutcomes(turn.issueOutcome, "blocked");
      throw new ConnectorError(
        "write_budget_exhausted",
        `This message already sent ${CONNECTOR_WRITES_PER_MESSAGE} connector writes. Report what was done; the user's next message can continue.`,
      );
    }
    turn.mutationCount += 1;
    const result = await broker.write(requestContext, {
      connectionId, resourceId, capabilityId, catalogRevision, input,
      authorizationQuote,
      idempotencyKey: connectorIdempotencyKey({
        sourceMessageId: context.sourceMessageId,
        connectionId, resourceId, capabilityId, input,
      }),
    });
    turn.issueOutcome = mergeIssueOutcomes(turn.issueOutcome, issueOutcomeOf(result.readback));
    return result as unknown as JsonValue;
  }
}

/**
 * The Issue workflow's outcome carried by a write readback, which drives the
 * reply's waiting/blocked feedback; any other readback reports none.
 */
function issueOutcomeOf(readback: JsonValue | null): WorkflowOutcome | null {
  if (!readback || typeof readback !== "object" || Array.isArray(readback)) return null;
  const outcome = readback.outcome;
  return outcome === "completed" || outcome === "waiting" || outcome === "blocked" ? outcome : null;
}

/**
 * A connector refusal as the model receives it: the stable code to branch on,
 * the exact field to correct and, when a provider refused, its sanitized reason.
 */
function connectorFailure(error: ConnectorError): Error {
  return new Error(JSON.stringify({
    error: {
      code: error.code,
      message: error.message.slice(0, 500),
      ...(error.field ? { field: error.field } : {}),
      ...(error.provider ? { provider: error.provider } : {}),
    },
  }));
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * Wraps a connector result, refusing anything the runtime would have to truncate.
 *
 * The bound is a hard error rather than a truncation: a model that receives half
 * a result cannot tell which half it lost, and a silently shortened answer is
 * worse than a clear request to narrow the question.
 */
function connectorToolOutput(value: JsonValue): RuntimeToolOutputItem[] {
  const serialized = JSON.stringify(value);
  if (serialized.length > 100_000) {
    throw new Error(`connector_result_too_large: ${serialized.length} serialized characters exceeds 100000. No result was delivered. Ask for a narrower scope instead of repeating the request.`);
  }
  return textToolOutput(serialized);
}

/**
 * Derives a write's idempotency key from the operation itself.
 *
 * The source message plus the exact request is what identifies an operation, so
 * the same message asking for the same thing twice is one operation and a later
 * message is a new one. The key is derived rather than accepted so the model
 * cannot make a repeated side effect look like a fresh one.
 */
function connectorIdempotencyKey(operation: {
  sourceMessageId: string;
  connectionId: string;
  resourceId: string;
  capabilityId: string;
  input: JsonValue;
}): string {
  const digest = createHash("sha256")
    .update(canonicalJson({
      sourceMessageId: operation.sourceMessageId,
      connectionId: operation.connectionId,
      resourceId: operation.resourceId,
      capabilityId: operation.capabilityId,
      input: operation.input,
    }))
    .digest("hex");
  // The Broker bounds keys to 128 characters, and the source message is already
  // provenance, so a digest of the whole operation is the compact honest form.
  return `connector:${digest}`;
}

/** One opaque connector identifier from the catalog, never a provider address. */
function requestIdentifier(value: unknown, label: string): string {
  if (!isConnectorIdentifier(value)) {
    throw new Error(`${label} must be an identifier from the connector catalog`);
  }
  return value;
}

/**
 * Decodes a capability's input from its JSON object string.
 *
 * The tool ABI cannot carry a per-capability schema — that would put every
 * provider's schema in every turn — so the model sends JSON and the Broker
 * validates it against the schema it fetched with `connector_describe`.
 */
function parseCapabilityInput(value: unknown): JsonValue {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") throw new Error("input must be a JSON object string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("input must be a JSON object string");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("input must be a JSON object string");
  }
  return parsed as JsonValue;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
