import { isSuccessfulLarkEnvelope, runLarkJson, type LarkContext } from "./process.ts";
import { feishuOriginForUrl } from "./serviceResource.ts";

const REFERENCE_TIMEOUT_MILLISECONDS = 20_000;
// Wiki links are resolved by the provider to the same document fetch path. The
// URL shape differs, but the returned content is still a readable Doc/Docx body.
const READABLE_DOCUMENT_TYPES = new Set(["doc", "docx", "wiki"]);

export type LarkJsonRunner = typeof runLarkJson;

export type FeishuReferenceFailure =
  | "provider_unavailable"
  | "provider_response_invalid"
  | "metadata_incomplete"
  | "not_readable";

/** A structured boundary failure from the official reference reader. */
export class FeishuReferenceError extends Error {
  readonly code: FeishuReferenceFailure;

  constructor(code: FeishuReferenceFailure, options?: { cause?: unknown }) {
    super(`Feishu reference: ${code}`, options);
    this.name = "FeishuReferenceError";
    this.code = code;
  }
}

export interface FeishuReferenceSnapshot {
  url: string;
  inspect: Record<string, unknown>;
  content: unknown | null;
  limitation?: string;
}

/** What the provider resolved a URL to, before anything was read. */
export interface FeishuReferenceInspection {
  /** The provider's canonical token, stable across renames and redirects. */
  token: string;
  /** The provider's own object type, which decides whether content is readable. */
  type: string;
  /** Empty when the caller may not see the object's metadata. */
  title: string;
  /** The canonical URL the provider reports for this object. */
  canonicalUrl: string;
}

export function isFeishuReferenceUrl(value: string): boolean {
  return feishuOriginForUrl(value) !== null;
}

export class FeishuReferenceReader {
  readonly #context: LarkContext;
  readonly #run: LarkJsonRunner;

  constructor(context: LarkContext, run: LarkJsonRunner = runLarkJson) {
    this.#context = Object.freeze({ ...context });
    this.#run = run;
  }

  /**
   * Resolves a Feishu URL to its canonical token and type.
   *
   * This parses the URL; it does not prove access. The provider answers a
   * well-formed URL for an object the Bot cannot open with a successful envelope
   * and an empty title, so a caller that needs proof of access must read.
   */
  async inspect(url: string, timeoutMilliseconds = REFERENCE_TIMEOUT_MILLISECONDS): Promise<FeishuReferenceInspection> {
    assertFeishuUrl(url);
    const timeout = boundedTimeout(timeoutMilliseconds);
    const inspectData = await this.#inspect(url, timeout);
    const token = firstString(inspectData, ["token", "obj_token", "object_token"]);
    const type = firstString(inspectData, ["type", "obj_type", "object_type"]);
    if (!token || !type) {
      throw new FeishuReferenceError("metadata_incomplete");
    }
    const canonicalUrl = canonicalUrlFrom(inspectData, url);
    return Object.freeze({
      token,
      type,
      title: firstString(inspectData, ["title", "name"]) ?? "",
      canonicalUrl,
    });
  }

  async read(
    url: string,
    timeoutMilliseconds = REFERENCE_TIMEOUT_MILLISECONDS,
    scope: "full" | "outline" = "full",
  ): Promise<FeishuReferenceSnapshot> {
    assertFeishuUrl(url);
    const timeout = boundedTimeout(timeoutMilliseconds);
    const deadline = Date.now() + timeout;
    const remaining = () => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw new Error("Feishu reference deadline exceeded");
      return milliseconds;
    };
    // Inspection and content fetch share this deadline. Passing the original
    // timeout here would let inspection outlive the deadline and turn the
    // nominal bound into two sequential provider calls.
    const inspectData = await this.#inspect(url, remaining());
    // Validate provider output even when this object type has no content reader;
    // the inspection result is still part of the trusted reference envelope.
    const canonicalUrl = canonicalUrlFrom(inspectData, url);
    const documentType = firstString(inspectData, ["type", "obj_type", "object_type"]);

    if (!documentType || !READABLE_DOCUMENT_TYPES.has(documentType)) {
      return {
        url,
        inspect: inspectData,
        content: null,
        limitation: documentType
          ? `content_reader_not_available_for_${documentType}`
          : "document_type_not_reported",
      };
    }

    // Provider output is data, not authority. A returned canonical URL must stay
    // inside the same Feishu/Lark allowlist before it reaches the fetch command.
    let fetched: unknown;
    try {
      fetched = await this.#run(this.#context, [
        "docs",
        "+fetch",
        "--doc",
        canonicalUrl,
        "--scope",
        scope,
        "--detail",
        "simple",
        "--doc-format",
        "im-markdown",
        "--format",
        "json",
        "--as",
        "bot",
      ], { timeoutMilliseconds: remaining() });
    } catch (error) {
      throw classifyRunnerError(error);
    }
    if (!isSuccessfulLarkEnvelope(fetched)) {
      throw new FeishuReferenceError("provider_response_invalid");
    }
    let content: unknown;
    let body: Record<string, unknown>;
    try {
      content = record(fetched, "docs fetch envelope").data;
      body = record(content, "docs fetch data");
    } catch (error) {
      throw new FeishuReferenceError("provider_response_invalid", { cause: error });
    }
    const references = body.reference_map;
    const hasDependencies = references && typeof references === "object"
      && Object.keys(references).some((key) => key !== "comments");
    return { url, inspect: inspectData, content,
      ...(hasDependencies ? { limitation: "document_embedded_content_unavailable" }
        : body.tips ? { limitation: "document_content_partial" } : {}),
    };
  }

  async #inspect(url: string, timeoutMilliseconds: number): Promise<Record<string, unknown>> {
    let inspected: unknown;
    try {
      inspected = await this.#run(this.#context, [
        "drive",
        "+inspect",
        "--url",
        url,
        "--format",
        "json",
        "--as",
        "bot",
      ], { timeoutMilliseconds });
    } catch (error) {
      throw classifyRunnerError(error);
    }
    if (!isSuccessfulLarkEnvelope(inspected)) {
      throw new FeishuReferenceError("provider_response_invalid");
    }
    try {
      return record(record(inspected, "drive inspect envelope").data, "drive inspect data");
    } catch (error) {
      throw new FeishuReferenceError("provider_response_invalid", { cause: error });
    }
  }
}

function classifyRunnerError(error: unknown): FeishuReferenceError {
  if (error instanceof FeishuReferenceError) return error;
  // JSON.parse failures are malformed provider output; other runner failures
  // describe transport, process, or deadline failure.
  return new FeishuReferenceError(
    error instanceof SyntaxError ? "provider_response_invalid" : "provider_unavailable",
    { cause: error },
  );
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Feishu reference timeout must be a finite positive number");
  }
  return Math.max(1, Math.min(Math.floor(value), REFERENCE_TIMEOUT_MILLISECONDS));
}

function assertFeishuUrl(value: string): void {
  if (!isFeishuReferenceUrl(value)) {
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Feishu reference must be an absolute URL");
    }
    if (url.protocol !== "https:") {
      throw new Error("Feishu reference must use HTTPS");
    }
    throw new Error("Feishu reference host is not allowed");
  }
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
}

function canonicalUrlFrom(
  inspectData: Record<string, unknown>,
  fallback: string,
): string {
  const candidate = inspectData.url;
  if (candidate === undefined || candidate === null || candidate === "") return fallback;
  if (typeof candidate !== "string" || !isFeishuReferenceUrl(candidate)) {
    throw new FeishuReferenceError("provider_response_invalid");
  }
  return candidate;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}
