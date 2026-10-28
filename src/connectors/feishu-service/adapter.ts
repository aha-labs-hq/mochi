import {
  FeishuServiceResourceError,
  parseFeishuResourceId,
} from "../../lark/serviceResourceResolver.ts";
import { canonicalJson } from "../canonical.ts";
import { ConnectorError } from "../errors.ts";
import type {
  ConnectorAdapter,
  ConnectorCapabilityManifest,
  ConnectorConnectionSnapshot,
  ConnectorRequestContext,
  ConnectorResourceSnapshot,
  ConnectorTaskGrant,
  ConnectorWriteResult,
  JsonValue,
} from "../protocol.ts";
import type {
  ConnectorResourceSelection,
  ConnectorSelectionStore,
} from "../selectionStore.ts";
import {
  FEISHU_SERVICE_MANIFEST,
  FEISHU_SERVICE_PROVIDER_ID,
} from "./manifest.ts";

/**
 * The provider facts one Bot's Feishu binding supplies.
 *
 * Declared here rather than imported from the Lark layer so the connector module
 * keeps no dependency on how a connection is hosted; the app hands in a getter.
 */
export interface FeishuServiceBinding {
  readonly cliPath: string;
  readonly configDirectory: string;
  readonly targetAppId: string;
  readonly grantedScopes: readonly string[];
  readonly displayName: string;
  readonly status: "ready" | "unavailable";
  readonly problem: string | null;
}

/** Resolves a stored resource and reads it, reusing the verified lark-cli path. */
export interface FeishuServiceResourceReader {
  resolve(
    url: string,
    timeoutMilliseconds?: number,
  ): Promise<{
    resourceId: string;
    resourceType: string;
    displayName: string;
    address: string;
  }>;
  read(
    resourceType: string,
    token: string,
    scope: "full" | "outline",
    address?: string,
  ): Promise<{ content: unknown | null; limitation?: string }>;
}

/** Fails the way the resolver does, so one error vocabulary crosses the seam. */
export type FeishuServiceReaderFactory = (
  binding: FeishuServiceBinding,
) => FeishuServiceResourceReader;

/**
 * The Feishu service connector.
 *
 * Resources are URL-addressed because Feishu's listing endpoints do not expose
 * a complete directory for this Bot: an authorized Bot can see an empty wiki
 * space list and an empty drive root even when a shared object is readable.
 * A resource enters this catalog only after an owner supplies a reference and
 * the Bot proves it can read that object.
 */
export class FeishuServiceConnector implements ConnectorAdapter {
  readonly manifest = FEISHU_SERVICE_MANIFEST;
  readonly #binding: () => FeishuServiceBinding | undefined;
  readonly #selections: ConnectorSelectionStore;
  readonly #reader: FeishuServiceReaderFactory;
  #resourceProofConnectionId: string | undefined;
  #resourceProofFingerprint: string | undefined;
  #resourceProofState: "unknown" | "ready" | "unavailable" = "unknown";
  #resourceProofProblem: FeishuServiceResourceError["code"] | undefined;

  constructor(
    binding: () => FeishuServiceBinding | undefined,
    selections: ConnectorSelectionStore,
    reader: FeishuServiceReaderFactory,
  ) {
    this.#binding = binding;
    this.#selections = selections;
    this.#reader = reader;
  }

  /**
   * Invalidates the last resource proof before a connection is rechecked. The
   * connection itself may still be valid, but old fixed resources are not a
   * callable scope until this connector proves them again.
   */
  invalidateResourceProof(): void {
    this.#resourceProofConnectionId = undefined;
    this.#resourceProofFingerprint = undefined;
    this.#resourceProofState = "unknown";
    this.#resourceProofProblem = undefined;
  }

  /**
   * Whether a saved range on a ready connection is still unproven, for example
   * after Feishu did not answer. A proven range is left alone: reconciling it
   * would close it to running tools while the proof is redone.
   */
  needsRecheck(): boolean {
    const binding = this.#binding();
    if (binding?.status !== "ready") return false;
    const connectionId = connectionIdFor(binding);
    return (
      this.#resourceProofStateFor(
        connectionId,
        this.#selections.connectorSelections(connectionId),
      ) !== "ready"
    );
  }

  /**
   * Reports the connection and its fixed resources from stored facts only.
   *
   * The catalog is rebuilt on every read and write, so a snapshot that called the
   * provider would put a network round trip on every tool call. Re-proving is an
   * explicit reconcile instead, exactly as the GitHub selection does. An empty
   * list is valid: current-message material uses the channel material path.
   */
  async snapshot(
    botId: string,
  ): Promise<readonly ConnectorConnectionSnapshot[]> {
    const binding = this.#binding();
    if (!binding) return [];
    const connectionId = connectionIdFor(binding);
    const selections = this.#selections.connectorSelections(connectionId);
    const proofState = this.#resourceProofStateFor(connectionId, selections);
    const status =
      binding.status === "ready"
        ? "ready"
        : isFeishuReauthorizationProblem(binding.problem)
          ? "reauthorization_required"
          : "unavailable";
    const problem =
      status === "ready" ? null : (binding.problem ?? "provider_unavailable");
    const resourceScope =
      selections.length === 0
        ? { status: "ready" as const, selectedCount: 0 }
        : {
            status:
              binding.status !== "ready"
                ? ("unavailable" as const)
                : proofState === "unknown"
                  ? ("checking" as const)
                  : proofState,
            selectedCount: selections.length,
            ...(binding.status !== "ready"
              ? { problem: binding.problem ?? "provider_unavailable" }
              : proofState === "unknown"
                ? { problem: "resource_reconciliation_required" }
                : proofState === "unavailable"
                  ? {
                      problem:
                        this.#resourceProofProblem ?? "provider_unavailable",
                    }
                  : {}),
          };
    return [
      {
        botId,
        connectionId,
        providerId: FEISHU_SERVICE_PROVIDER_ID,
        status,
        ...(problem === null ? {} : { problem }),
        // The Bot's own display name is not a credential and is already public.
        account: { displayName: binding.displayName },
        grantedScopes: binding.grantedScopes,
        resourceScope,
        // `selected` is the durable Mochi range, not a promise that the
        // provider is reachable now. Keep the rows visible while
        // `resourceScope` reports checking/unavailable so the user can inspect
        // or remove a local choice without mistaking it for current authority.
        resources: selections.map(
          (selection): ConnectorResourceSnapshot => ({
            id: selection.resourceId,
            type: selection.resourceType,
            displayName: selection.displayName,
            selected: true,
          }),
        ),
      },
    ];
  }

  async read(input: {
    context: ConnectorRequestContext;
    grant: ConnectorTaskGrant;
    connection: ConnectorConnectionSnapshot;
    resource: ConnectorResourceSnapshot;
    capability: ConnectorCapabilityManifest;
    input: JsonValue;
    signal?: AbortSignal;
  }): Promise<JsonValue> {
    const reader = this.#readerFor(input.connection.connectionId);
    const parsed = parseFeishuResourceId(input.resource.id);
    if (!parsed) {
      throw new ConnectorError(
        "resource_not_selected",
        `无法解析的飞书资源标识：${input.resource.id}`,
      );
    }
    const selection = this.#selections
      .connectorSelections(input.connection.connectionId)
      .find((candidate) => candidate.resourceId === input.resource.id);
    if (!selection) {
      throw new ConnectorError(
        "resource_not_selected",
        `飞书资源选择不存在：${input.resource.id}`,
      );
    }
    const scope = readScope(input.input);
    try {
      const snapshot = await reader.read(
        parsed.resourceType,
        parsed.token,
        scope,
        selection.address,
      );
      if (snapshot.content === null) {
        throw new FeishuServiceResourceError(
          snapshot.limitation === "document_type_not_reported"
            ? "metadata_incomplete"
            : "not_readable",
        );
      }
      // A successful body with a limitation is still useful, but the limitation
      // must travel with it so the model cannot mistake partial content for a
      // complete document.
      return {
        content: snapshot.content as JsonValue,
        ...(snapshot.limitation ? { limitation: snapshot.limitation } : {}),
      };
    } catch (error) {
      if (error instanceof FeishuServiceResourceError) {
        throw new ConnectorError(
          connectorErrorCodeFor(error.code),
          `飞书资源读取失败：${error.code}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async write(): Promise<ConnectorWriteResult> {
    // No write capability is declared, so the Broker refuses before reaching here.
    throw new ConnectorError(
      "capability_unavailable",
      "飞书服务连接器只提供读取能力",
    );
  }

  /**
   * Fixes these URLs into this connection's optional cross-message scope.
   *
   * Additive rather than whole-set: the renderer holds resource ids and display
   * names but never the stored addresses, and a document's URL is not a fact the
   * settings window needs. Existing resources are therefore carried forward by
   * the Bot, which already owns them.
   *
   * A URL that does not resolve, resolves to a type this Bot cannot read, or
   * fails a real read is refused rather than stored — a fixed resource must never
   * outlive the authority that would make it usable.
   */
  async add(urls: readonly string[]): Promise<void> {
    const binding = this.#binding();
    if (binding?.status !== "ready")
      throw new ConnectorError("connection_unavailable", "飞书尚未连接");
    const connectionId = connectionIdFor(binding);
    const reader = this.#reader(binding);
    const existing = this.#selections.connectorSelections(connectionId);
    if (
      existing.length > 0 &&
      this.#resourceProofStateFor(connectionId, existing) !== "ready"
    ) {
      throw new ConnectorError(
        "resource_unavailable",
        "飞书固定资料尚未完成复核",
      );
    }
    const byId = new Map(existing.map((row) => [row.resourceId, row]));
    const additions: ConnectorResourceSelection[] = [];
    for (const url of urls) {
      let resource: Awaited<ReturnType<FeishuServiceResourceReader["resolve"]>>;
      try {
        resource = await reader.resolve(url);
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        if (error instanceof FeishuServiceResourceError) {
          throw new ConnectorError(
            connectorErrorCodeFor(error.code),
            `飞书资料引用失败：${error.code}`,
            { cause: error },
          );
        }
        throw new ConnectorError(
          "provider_unavailable",
          "飞书资料引用暂时无法确认",
          { cause: error },
        );
      }
      const previous = byId.get(resource.resourceId);
      if (previous) {
        // Already fixed: adding it again keeps its identity rather than
        // invalidating work in flight against it.
        continue;
      }
      const next: ConnectorResourceSelection = {
        connectionId,
        resourceId: resource.resourceId,
        resourceType: resource.resourceType,
        displayName: resource.displayName,
        address: resource.address,
        selectionId: crypto.randomUUID().replaceAll("-", ""),
      };
      const parsed = parseFeishuResourceId(next.resourceId);
      if (!parsed || parsed.resourceType !== next.resourceType) {
        throw new ConnectorError(
          "adapter_result_invalid",
          "飞书服务返回了无法验证的资源标识",
        );
      }
      byId.set(next.resourceId, next);
      additions.push(next);
    }
    const added = new Set(additions.map((row) => row.resourceId));
    this.#selections.replaceConnectorSelections(connectionId, [
      ...existing.filter((row) => !added.has(row.resourceId)),
      ...additions,
    ]);
    this.#setResourceProofState(
      connectionId,
      "ready",
      this.#selections.connectorSelections(connectionId),
    );
  }

  /**
   * Revokes a replaced or disconnected App's fixed resources, so connecting the
   * same App again later starts from an empty scope instead of resurrecting it.
   */
  forget(connectionId: string): void {
    if (!connectionId.startsWith("feishu:")) {
      throw new Error("Not a Feishu service connection");
    }
    this.#selections.replaceConnectorSelections(connectionId, []);
    if (this.#resourceProofConnectionId === connectionId) {
      this.invalidateResourceProof();
    }
  }

  /** A stale window cannot remove a resource that was since fixed again. */
  remove(resourceId: string, selectionId: string): void {
    const binding = this.#binding();
    if (!binding)
      throw new ConnectorError("connection_unavailable", "飞书尚未连接");
    const connectionId = connectionIdFor(binding);
    const existing = this.#selections.connectorSelections(connectionId);
    const resource = existing.find((row) => row.resourceId === resourceId);
    if (!resource || resource.selectionId !== selectionId) {
      throw new ConnectorError("resource_not_selected", "连接器资源选择已变化");
    }
    this.#selections.replaceConnectorSelections(
      connectionId,
      existing.filter((row) => row.resourceId !== resourceId),
    );
  }

  /**
   * Drops fixed resources this Bot can no longer prove it can read.
   *
   * A provider that rejects a resource removes the choice durably, so a revoked
   * document cannot survive as a stale authority. A failed provider call is not
   * an answer, so an unreachable Feishu leaves the fixed scope untouched.
   */
  async reconcile(): Promise<boolean> {
    const binding = this.#binding();
    if (!binding) return false;
    const connectionId = connectionIdFor(binding);
    const reader = this.#reader(binding);
    const stored = this.#selections.connectorSelections(connectionId);
    this.#setResourceProofState(connectionId, "unknown", stored);
    if (binding.status !== "ready" || stored.length === 0) {
      this.#setResourceProofState(
        connectionId,
        binding.status === "ready" ? "ready" : "unavailable",
        stored,
      );
      return false;
    }
    const proven: ConnectorResourceSelection[] = [];
    const deadline = Date.now() + FEISHU_RESOURCE_RECONCILE_BUDGET_MILLISECONDS;
    try {
      for (const selection of stored) {
        try {
          if (Date.now() >= deadline) {
            throw new FeishuServiceResourceError("provider_unavailable");
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new FeishuServiceResourceError("provider_unavailable");
          }
          const resource = await reader.resolve(
            selection.address,
            Math.min(remaining, FEISHU_RESOURCE_RESOLVE_TIMEOUT_MILLISECONDS),
          );
          const parsed = parseFeishuResourceId(resource.resourceId);
          if (
            !parsed ||
            parsed.resourceType !== resource.resourceType ||
            resource.resourceId !== selection.resourceId ||
            resource.resourceType !== selection.resourceType ||
            !resource.displayName ||
            !resource.address
          ) {
            // Reconciliation may refresh a title or canonical address, but a
            // saved selection must never silently become another resource.
            throw new FeishuServiceResourceError("provider_response_invalid");
          }
          proven.push({
            ...selection,
            ...resource,
            selectionId: selection.selectionId,
          });
        } catch (error) {
          if (isDefinitiveResourceFailure(error)) continue;
          throw error;
        }
      }
    } catch (error) {
      this.#setResourceProofState(
        connectionId,
        "unavailable",
        stored,
        error instanceof FeishuServiceResourceError
          ? error.code
          : "provider_unavailable",
      );
      throw error;
    }
    const changed =
      proven.length !== stored.length ||
      proven.some((resource, index) => {
        const previous = stored[index];
        return previous === undefined || !sameSelection(resource, previous);
      });
    if (changed) {
      this.#selections.replaceConnectorSelections(connectionId, proven);
    }
    this.#setResourceProofState(connectionId, "ready", proven);
    return changed;
  }

  #readerFor(connectionId: string): FeishuServiceResourceReader {
    const binding = this.#binding();
    if (binding?.status !== "ready")
      throw new ConnectorError("connection_unavailable", "飞书尚未连接");
    if (connectionIdFor(binding) !== connectionId) {
      throw new ConnectorError(
        "connection_unavailable",
        "飞书连接与请求不一致",
      );
    }
    const selections = this.#selections.connectorSelections(connectionId);
    if (this.#resourceProofStateFor(connectionId, selections) !== "ready") {
      throw new ConnectorError(
        "resource_unavailable",
        "飞书固定资料尚未完成复核",
      );
    }
    return this.#reader(binding);
  }

  #resourceProofStateFor(
    connectionId: string,
    selections: readonly ConnectorResourceSelection[],
  ): "unknown" | "ready" | "unavailable" {
    if (selections.length === 0) return "ready";
    return this.#resourceProofConnectionId === connectionId &&
      this.#resourceProofFingerprint === resourceProofFingerprint(selections)
      ? this.#resourceProofState
      : "unknown";
  }

  #setResourceProofState(
    connectionId: string,
    state: "unknown" | "ready" | "unavailable",
    selections: readonly ConnectorResourceSelection[],
    problem?: FeishuServiceResourceError["code"],
  ): void {
    this.#resourceProofConnectionId = connectionId;
    this.#resourceProofFingerprint = resourceProofFingerprint(selections);
    this.#resourceProofState = state;
    this.#resourceProofProblem = state === "unavailable" ? problem : undefined;
  }
}

/** Binds a proof to the exact saved range, rather than only its cardinality. */
function resourceProofFingerprint(
  selections: readonly ConnectorResourceSelection[],
): string {
  return canonicalJson(
    selections
      .map((selection) => ({
        connectionId: selection.connectionId,
        resourceId: selection.resourceId,
        resourceType: selection.resourceType,
        displayName: selection.displayName,
        address: selection.address,
        selectionId: selection.selectionId,
      }))
      .sort((left, right) => {
        const leftKey = `${left.resourceId}\u0000${left.selectionId}`;
        const rightKey = `${right.resourceId}\u0000${right.selectionId}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  );
}

function isDefinitiveResourceFailure(
  error: unknown,
): error is FeishuServiceResourceError {
  return (
    error instanceof FeishuServiceResourceError &&
    (error.code === "not_readable" || error.code === "type_not_supported")
  );
}

function connectorErrorCodeFor(
  code: FeishuServiceResourceError["code"],
):
  | "provider_unavailable"
  | "provider_response_invalid"
  | "metadata_incomplete"
  | "not_readable"
  | "request_invalid" {
  switch (code) {
    case "provider_unavailable":
      return "provider_unavailable";
    case "provider_response_invalid":
      return "provider_response_invalid";
    case "metadata_incomplete":
      return "metadata_incomplete";
    case "not_readable":
    case "type_not_supported":
      return "not_readable";
    case "url_not_feishu":
      return "request_invalid";
  }
}

function sameSelection(
  left: ConnectorResourceSelection,
  right: ConnectorResourceSelection,
): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.resourceId === right.resourceId &&
    left.resourceType === right.resourceType &&
    left.displayName === right.displayName &&
    left.address === right.address &&
    left.selectionId === right.selectionId
  );
}

/**
 * The connection id is derived from the bound app, so a Bot that replaces its
 * Bot app cannot inherit the previous app's resource selection.
 */
export function connectionIdFor(binding: FeishuServiceBinding): string {
  return `feishu:${binding.targetAppId}`;
}

function readScope(input: JsonValue): "full" | "outline" {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return "full";
  return (input as Record<string, JsonValue>).scope === "outline"
    ? "outline"
    : "full";
}

const FEISHU_RESOURCE_RECONCILE_BUDGET_MILLISECONDS = 30_000;
const FEISHU_RESOURCE_RESOLVE_TIMEOUT_MILLISECONDS = 20_000;

/**
 * These failures describe a customer-visible Feishu setup step, rather than a
 * transient provider outage. Keeping the distinction in the adapter lets every
 * catalog consumer show the same recovery state without knowing Feishu's error
 * vocabulary.
 */
const FEISHU_REAUTHORIZATION_PROBLEMS = [
  "permissions_required",
  "permissions_approval_required",
  "group_messages_required",
  "publication_required",
] as const;

function isFeishuReauthorizationProblem(problem: string | null): boolean {
  return (
    problem !== null &&
    FEISHU_REAUTHORIZATION_PROBLEMS.includes(
      problem as (typeof FEISHU_REAUTHORIZATION_PROBLEMS)[number],
    )
  );
}
