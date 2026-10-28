import { boundedGitHubValue } from "./oauth.ts";

/**
 * GitHub's own explanation of a refused request, reduced to bounded,
 * credential-free fields: the top-level message and, for validation failures,
 * which resource field was rejected and with what code.
 */
export interface GitHubRequestReason {
  readonly message?: string;
  readonly errors?: readonly GitHubFieldError[];
}

export interface GitHubFieldError {
  readonly resource?: string;
  readonly field?: string;
  readonly code?: string;
  readonly message?: string;
}

const REASON_BODY_BYTES = 16_384;
const REASON_MESSAGE_LENGTH = 300;
const FIELD_ERROR_LIMIT = 5;
const FIELD_ERROR_MESSAGE_LENGTH = 200;

/** Repository HTTP failures are local to one request, not proof that OAuth was lost. */
export class GitHubRequestError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  /**
   * Present only for a client error. A 4xx body says which argument to change;
   * a server failure's body says nothing a caller can act on, so it is never read.
   */
  readonly reason: GitHubRequestReason | undefined;

  constructor(readonly status: number, headers: Headers, reason?: GitHubRequestReason) {
    const code = status === 404 ? "resource_unavailable"
      : status === 403 ? "request_forbidden"
      : status === 429 ? "rate_limited"
      : status === 400 || status === 422 ? "request_invalid"
      : status === 409 ? "request_conflict" : "request_failed";
    const explanation = status === 404
      ? "The resource does not exist or is not accessible. Verify its path, ref, or number using available evidence; this response alone does not prove a sign-in failure."
      : status === 400 || status === 422
        ? "The request was rejected. Correct its arguments before trying again."
        : "The request did not succeed. Do not repeat it unchanged or infer that the operation completed.";
    super(`${code}: GitHub HTTP ${status}. ${explanation}`);
    this.name = "GitHubRequestError";
    this.code = code;
    const requestId = headers.get("x-github-request-id");
    this.requestId = requestId && /^[A-Za-z0-9:-]{1,128}$/.test(requestId) ? requestId : undefined;
    this.reason = reason;
  }

  /** Consumes a failed response, keeping only the sanitized reason a client error carries. */
  static async fromResponse(response: Response): Promise<GitHubRequestError> {
    const clientError = response.status >= 400 && response.status < 500 && response.status !== 401;
    if (!clientError) {
      void response.body?.cancel();
      return new GitHubRequestError(response.status, response.headers);
    }
    let body: unknown;
    try { body = await boundedGitHubValue(response, REASON_BODY_BYTES); }
    // An unreadable explanation leaves the status as the whole, still explicit, failure.
    catch { body = undefined; }
    return new GitHubRequestError(response.status, response.headers, requestReason(body));
  }
}

function requestReason(body: unknown): GitHubRequestReason | undefined {
  if (!isRecord(body)) return undefined;
  const message = typeof body.message === "string"
    ? providerText(body.message, REASON_MESSAGE_LENGTH)
    : undefined;
  const errors = Array.isArray(body.errors)
    ? body.errors.slice(0, FIELD_ERROR_LIMIT).flatMap((item): GitHubFieldError[] => {
      if (typeof item === "string") {
        const text = providerText(item, FIELD_ERROR_MESSAGE_LENGTH);
        return text ? [{ message: text }] : [];
      }
      if (!isRecord(item)) return [];
      const text = typeof item.message === "string"
        ? providerText(item.message, FIELD_ERROR_MESSAGE_LENGTH)
        : undefined;
      const entry: GitHubFieldError = {
        ...identifier("resource", item.resource),
        ...identifier("field", item.field),
        ...identifier("code", item.code),
        ...(text ? { message: text } : {}),
      };
      return Object.keys(entry).length > 0 ? [entry] : [];
    })
    : [];
  if (!message && errors.length === 0) return undefined;
  return { ...(message ? { message } : {}), ...(errors.length > 0 ? { errors } : {}) };
}

/** GitHub's resource, field and code names are short identifiers; anything else is dropped. */
function identifier<const K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === "string" && /^[A-Za-z0-9_.[\]-]{1,64}$/.test(value)
    ? { [key]: value } as Partial<Record<K, string>>
    : {};
}

/**
 * Provider prose made safe to hand to a model and a log: no credentials, no
 * URL user info or query, no control characters, and a hard length bound.
 */
function providerText(value: string, maximumLength: number): string | undefined {
  const printable = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }).join("");
  const text = printable
    .replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        return `${url.origin}${url.pathname}`;
      } catch { return "[url]"; }
    })
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[redacted]")
    .replace(/\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length <= maximumLength ? text : `${text.slice(0, maximumLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
