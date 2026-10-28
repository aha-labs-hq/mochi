import {
  boundedJson,
  enforceLimit,
  GitHubAppAuthority,
  InstallationTokenCache,
} from "./github.ts";
import {
  AUTHORITY_ERROR_HEADER,
  AUTHORITY_PROTOCOL,
  AuthorityError,
  type AuthorityErrorCode,
  parseIssueWriteRequest,
  type RepositoryIdentity,
} from "./protocol.ts";

/** Body format of the authority's own responses; the maintainer helper checks it. */
const AUTHORITY_VERSION = 1;
const MAX_REQUEST_BYTES = 150_000;
/** The `period` of every binding under `ratelimits` in wrangler.jsonc. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;
/** Lives as long as this isolate; see InstallationTokenCache. */
const ISOLATE_TOKENS = new InstallationTokenCache();

export async function handleAuthorityRequest(
  request: Request,
  env: Env,
  options: {
    tokens: InstallationTokenCache;
    fetchImplementation?: typeof fetch;
    now?: () => number;
  },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  if (
    url.origin !== "https://authority.mochi.invalid" &&
    url.protocol !== "https:"
  ) {
    return refusal(new AuthorityError("invalid_request"), requestId);
  }
  if (
    request.method === "GET" &&
    url.pathname === "/health" &&
    url.search === ""
  ) {
    return response(200, {
      version: AUTHORITY_VERSION,
      status: "ok",
      actor: {
        appId: Number(env.GITHUB_APP_ID),
        slug: env.GITHUB_APP_SLUG,
        login: env.GITHUB_APP_BOT_LOGIN,
      },
      protocol: AUTHORITY_PROTOCOL,
    });
  }
  if (request.method !== "POST" || url.search !== "") {
    return refusal(new AuthorityError("invalid_request", 404), requestId);
  }

  const authority = new GitHubAppAuthority(
    {
      appId: parseId(env.GITHUB_APP_ID),
      appSlug: env.GITHUB_APP_SLUG,
      apiVersion: env.GITHUB_API_VERSION,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    },
    {
      ...options,
      limits: {
        account: env.ACCOUNT_LIMIT,
        installation: env.INSTALLATION_LIMIT,
      },
    },
  );
  // The IDs a request names, recorded with its outcome; claimed until GitHub proves them.
  let accountId: number | null = null;
  let repositoryId: number | null = null;
  try {
    if (url.pathname === "/v1/issues") {
      const userToken = bearer(request.headers.get("authorization"));
      const input = parseIssueWriteRequest(await requestJson(request));
      accountId = input.accountId;
      repositoryId = input.repository.id;
      const result = await authority.executeIssue(userToken, input);
      log(
        "github_issue_write",
        requestId,
        accountId,
        repositoryId,
        result.status < 400 ? "completed" : "rejected",
      );
      return response(result.status, result.body, {
        requestId,
        ...(result.requestId ? { githubRequestId: result.requestId } : {}),
      });
    }
    if (url.pathname === "/v1/maintainer/token") {
      await maintainerAuthorization(
        request.headers.get("authorization"),
        env.MAINTAINER_AUTH_TOKEN,
      );
      await enforceLimit(env.ACCOUNT_LIMIT, "maintainer");
      const input = await requestJson(request);
      if (!isMaintainerRequest(input))
        throw new AuthorityError("invalid_request");
      const repository: Omit<RepositoryIdentity, "installationId"> = {
        id: parseId(env.MAINTAINER_REPOSITORY_ID),
        ownerId: parseId(env.MAINTAINER_REPOSITORY_OWNER_ID),
        fullName: env.MAINTAINER_REPOSITORY_FULL_NAME,
      };
      const issued = await authority.maintainerToken(repository);
      log(
        "maintainer_token",
        requestId,
        parseId(env.MAINTAINER_ACCOUNT_ID),
        repository.id,
        "completed",
      );
      return response(200, {
        version: AUTHORITY_VERSION,
        requestId,
        actor: {
          appId: Number(env.GITHUB_APP_ID),
          slug: env.GITHUB_APP_SLUG,
          login: env.GITHUB_APP_BOT_LOGIN,
        },
        repository: { ...repository, installationId: issued.installationId },
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
        token: issued.token,
        expiresAt: issued.expiresAt,
      });
    }
    if (url.pathname === "/v1/maintainer/status") {
      await maintainerAuthorization(
        request.headers.get("authorization"),
        env.MAINTAINER_AUTH_TOKEN,
      );
      await enforceLimit(env.ACCOUNT_LIMIT, "maintainer");
      const input = await requestJson(request);
      if (!isMaintainerStatusRequest(input))
        throw new AuthorityError("invalid_request");
      const issuer = await authority.verifyIssuer();
      log(
        "maintainer_status",
        requestId,
        parseId(env.MAINTAINER_ACCOUNT_ID),
        parseId(env.MAINTAINER_REPOSITORY_ID),
        "completed",
      );
      return response(200, { version: AUTHORITY_VERSION, requestId, issuer });
    }
    throw new AuthorityError("invalid_request", 404);
  } catch (error) {
    const authorityError =
      error instanceof AuthorityError
        ? error
        : new AuthorityError("provider_unavailable");
    log(
      "authority_request",
      requestId,
      accountId,
      repositoryId,
      authorityError.code,
      true,
    );
    return refusal(authorityError, requestId);
  }
}

export default {
  fetch(request, env) {
    return handleAuthorityRequest(request, env, { tokens: ISOLATE_TOKENS });
  },
} satisfies ExportedHandler<Env>;

async function requestJson(request: Request): Promise<unknown> {
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
    return await boundedJson(new Response(request.body), MAX_REQUEST_BYTES);
  } catch {
    throw new AuthorityError("invalid_request");
  }
}

function bearer(value: string | null): string {
  const match = value?.match(/^Bearer (ghu_[A-Za-z0-9_]{1,2048})$/);
  if (!match?.[1]) throw new AuthorityError("unauthorized");
  return match[1];
}

async function maintainerAuthorization(
  value: string | null,
  expected: string,
): Promise<void> {
  const match = value?.match(/^Mochi-Maintainer ([A-Za-z0-9_-]{32,256})$/);
  if (!match?.[1] || !/^[A-Za-z0-9_-]{32,256}$/.test(expected)) {
    throw new AuthorityError("unauthorized");
  }
  // Equal-length digests compared in constant time leak neither the
  // credential's length nor how much of it matched.
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1])),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  if (!constantTimeEqual(new Uint8Array(left), new Uint8Array(right))) {
    throw new AuthorityError("unauthorized");
  }
}

function isMaintainerRequest(
  value: unknown,
): value is { version: 1; purpose: "change_proposal" } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "purpose,version" &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).purpose === "change_proposal"
  );
}

function isMaintainerStatusRequest(
  value: unknown,
): value is { version: 1; purpose: "status" } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "purpose,version" &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).purpose === "status"
  );
}

function parseId(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new AuthorityError("issuer_unavailable");
  return result;
}

/** A refusal the authority makes itself, named in the header the client branches on. */
function refusal(error: AuthorityError, requestId: string): Response {
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

function response(
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

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function log(
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
