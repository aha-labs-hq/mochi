import { boundedJson } from "./github.ts";
import {
  AUTHORITY_ERROR_HEADER,
  AUTHORITY_PROTOCOL,
  AuthorityError,
  type AuthorityErrorCode,
} from "./protocol.ts";

export const AUTHORITY_VERSION = 1;
const MAX_REQUEST_BYTES = 150_000;
/** The period of every authority rate-limit binding, also sent as Retry-After. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export async function requestJson(request: Request): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const contentLength = Number(request.headers.get("content-length"));
  if (
    contentType !== "application/json" ||
    (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES)
  ) {
    throw new AuthorityError("invalid_request");
  }
  try {
    return await boundedJson(
      new Response(request.body),
      MAX_REQUEST_BYTES,
      5_000,
    );
  } catch {
    throw new AuthorityError("invalid_request");
  }
}

export function parseId(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new AuthorityError("issuer_unavailable");
  return result;
}

/** A refusal the authority makes itself, named in the header the client branches on. */
export function refusal(error: AuthorityError, requestId: string): Response {
  return response(
    error.status,
    {
      version: AUTHORITY_VERSION,
      error: error.code,
      requestId,
      ...(error.code === "protocol_unsupported"
        ? { supported: AUTHORITY_PROTOCOL }
        : {}),
    },
    { requestId, error: error.code },
  );
}

export function response(
  status: number,
  body: unknown,
  identifiers: {
    requestId?: string;
    githubRequestId?: string;
    error?: AuthorityErrorCode;
  } = {},
): Response {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...(identifiers.requestId
      ? { "X-Mochi-Request-Id": identifiers.requestId }
      : {}),
    ...(identifiers.githubRequestId
      ? { "X-GitHub-Request-Id": identifiers.githubRequestId }
      : {}),
    ...(identifiers.error
      ? { [AUTHORITY_ERROR_HEADER]: identifiers.error }
      : {}),
    ...(identifiers.error === "rate_limited"
      ? { "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) }
      : {}),
  };
  if (status === 204) return new Response(null, { status, headers });
  return Response.json(body, {
    status,
    headers,
  });
}

export function log(
  event: string,
  requestId: string,
  accountId: number | null,
  repositoryId: number | null,
  outcome: string,
  error = false,
): void {
  const entry = JSON.stringify({
    event,
    requestId,
    accountId,
    repositoryId,
    outcome,
  });
  if (error) console.error(entry);
  else console.log(entry);
}
