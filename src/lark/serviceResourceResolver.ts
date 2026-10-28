import { connectorResourceId, isConnectorDisplayName } from "../connectors/selectionStore.ts";
import type { LarkContext } from "./process.ts";
import {
  FeishuReferenceReader,
  FeishuReferenceError,
  isFeishuReferenceUrl,
  type FeishuReferenceInspection,
  type LarkJsonRunner,
} from "./referenceReader.ts";
import {
  feishuServiceAddress,
  feishuServiceResourceTypeFor,
  isFeishuServiceResourceType,
  isFeishuServiceResourceToken,
  type FeishuServiceResourceType,
} from "./serviceResource.ts";

export class FeishuServiceResourceError extends Error {
  readonly code: FeishuServiceResourceFailure;
  constructor(code: FeishuServiceResourceFailure) {
    super(`Feishu service resource: ${code}`);
    this.name = "FeishuServiceResourceError";
    this.code = code;
  }
}

export type FeishuServiceResourceFailure =
  | "url_not_feishu"
  | "type_not_supported"
  | "not_readable"
  | "metadata_incomplete"
  | "provider_response_invalid"
  | "provider_unavailable";

/** What a proven, readable Feishu resource looks like to the connector layer. */
export interface FeishuResolvedResource {
  resourceId: string;
  resourceType: FeishuServiceResourceType;
  displayName: string;
  address: string;
}

/**
 * Resolves a URL the owner supplied into a Feishu resource this Bot proved it can
 * read.
 *
 * The provider answers a well-formed URL for an object the Bot cannot open with a
 * successful envelope and an empty title, so resolution alone proves nothing. A
 * resource is only produced after a real read succeeds — that read is the whole
 * reason the model accepts an explicit reference: the provider's directory
 * endpoints can be empty even when a shared object is readable, so an absent
 * listing entry is not evidence that the grant is missing.
 */
export class FeishuServiceResourceResolver {
  readonly #reader: FeishuReferenceReader;

  constructor(context: LarkContext, run?: LarkJsonRunner) {
    this.#reader = new FeishuReferenceReader(context, run);
  }

  async resolve(
    url: string,
    timeoutMilliseconds = 20_000,
  ): Promise<FeishuResolvedResource> {
    if (!isFeishuReferenceUrl(url)) {
      throw new FeishuServiceResourceError("url_not_feishu");
    }
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      throw new RangeError("Feishu resource resolution timeout must be a finite positive number");
    }
    const deadline = Date.now() + Math.max(1, Math.min(Math.floor(timeoutMilliseconds), 20_000));
    const remaining = (): number => {
      const value = deadline - Date.now();
      if (value <= 0) throw new FeishuServiceResourceError("provider_unavailable");
      return value;
    };
    let inspection: FeishuReferenceInspection;
    try {
      inspection = await this.#reader.inspect(url, remaining());
    } catch (error) {
      throw resourceErrorFrom(error);
    }
    if (!isFeishuServiceResourceToken(inspection.token)) {
      throw new FeishuServiceResourceError("metadata_incomplete");
    }
    const resourceType = feishuServiceResourceTypeFor(inspection.type);
    if (!resourceType) throw new FeishuServiceResourceError("type_not_supported");
    if (!isFeishuReferenceUrl(inspection.canonicalUrl)) {
      throw new FeishuServiceResourceError("provider_response_invalid");
    }
    // Only a failed read proves access is missing; resolution never does.
    let snapshot: Awaited<ReturnType<FeishuReferenceReader["read"]>>;
    try {
      snapshot = await this.#reader.read(
        inspection.canonicalUrl,
        remaining(),
        "outline",
      );
    } catch (error) {
      throw resourceErrorFrom(error);
    }
    assertResourceIdentity(snapshot.inspect, resourceType, inspection.token);
    // A bounded limitation can accompany a real body (for example omitted
    // embedded objects). It affects completeness, not the fact that the object
    // is readable enough to fix; only a missing body fails resolution.
    if (snapshot.content === null) {
      throw new FeishuServiceResourceError(
        snapshot.limitation === "document_type_not_reported"
          ? "metadata_incomplete"
          : "not_readable",
      );
    }
    if (!isConnectorDisplayName(inspection.title)) {
      throw new FeishuServiceResourceError("metadata_incomplete");
    }
    return {
      resourceId: connectorResourceId(resourceType, inspection.token),
      resourceType,
      displayName: inspection.title,
      // Preserve the provider's regional origin (Feishu or Lark) while still
      // rebuilding the path from the verified token.
      address: feishuServiceAddress(
        resourceType,
        inspection.token,
        inspection.canonicalUrl,
      ),
    };
  }

  /** Reads a stored resource by its proven token, never by a remembered URL. */
  async read(
    resourceType: FeishuServiceResourceType,
    token: string,
    scope: "full" | "outline" = "full",
    address?: string,
  ) {
    try {
      const snapshot = await this.#reader.read(
        feishuServiceAddress(resourceType, token, address),
        undefined,
        scope,
      );
      assertResourceIdentity(snapshot.inspect, resourceType, token);
      // Preserve readable-but-incomplete bodies for the connector envelope. A
      // null body is the only result that cannot serve as a read.
      if (snapshot.content === null) {
        throw new FeishuServiceResourceError(
          snapshot.limitation === "document_type_not_reported"
            ? "metadata_incomplete"
            : "not_readable",
        );
      }
      return snapshot;
    } catch (error) {
      throw resourceErrorFrom(error);
    }
  }
}

function resourceErrorFrom(error: unknown): FeishuServiceResourceError {
  if (error instanceof FeishuServiceResourceError) return error;
  if (error instanceof FeishuReferenceError) {
    return new FeishuServiceResourceError(error.code);
  }
  return new FeishuServiceResourceError("provider_unavailable");
}

/**
 * A second provider lookup is still part of the same resource proof. A URL can
 * be redirected, reused, or return a different object after the original choice
 * was saved; accepting that response would silently retarget the durable scope.
 */
function assertResourceIdentity(
  inspect: Record<string, unknown>,
  expectedType: FeishuServiceResourceType,
  expectedToken: string,
): void {
  const token = firstString(inspect, ["token", "obj_token", "object_token"]);
  const type = firstString(inspect, ["type", "obj_type", "object_type"]);
  if (!token || !type) {
    throw new FeishuServiceResourceError("metadata_incomplete");
  }
  if (token !== expectedToken || feishuServiceResourceTypeFor(type) !== expectedType) {
    throw new FeishuServiceResourceError("provider_response_invalid");
  }
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
}

/** Splits a stored `type:token` resource id back into provider facts. */
export function parseFeishuResourceId(
  resourceId: string,
): { resourceType: FeishuServiceResourceType; token: string } | null {
  const separator = resourceId.indexOf(":");
  if (separator <= 0) return null;
  const resourceType = resourceId.slice(0, separator);
  const token = resourceId.slice(separator + 1);
  if (!isFeishuServiceResourceType(resourceType) || !isFeishuServiceResourceToken(token)) {
    return null;
  }
  return { resourceType, token };
}
