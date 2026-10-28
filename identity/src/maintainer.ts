import { admitRequest } from "./admission.ts";
import {
  enforceLimit,
  GitHubAppAuthority,
  InstallationTokenCache,
} from "./github.ts";
import {
  AUTHORITY_VERSION,
  log,
  parseId,
  refusal,
  requestJson,
  response,
} from "./http.ts";
import {
  AUTHORITY_PROTOCOL,
  AuthorityError,
  type RepositoryIdentity,
} from "./protocol.ts";

const ISOLATE_TOKENS = new InstallationTokenCache();

export async function handleMaintainerRequest(
  request: Request,
  env: MaintainerEnv,
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
  if (
    request.method !== "POST" ||
    url.search !== "" ||
    !["/v1/maintainer/token", "/v1/maintainer/status"].includes(url.pathname)
  ) {
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
        installation: env.ACCOUNT_LIMIT,
      },
    },
  );
  // The IDs a request names, recorded with its outcome; claimed until GitHub proves them.
  const accountId: number | null = null;
  const repositoryId: number | null = null;
  try {
    if (url.pathname === "/v1/maintainer/token") {
      await admitRequest(request, env.REQUEST_LIMIT);
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
      await admitRequest(request, env.REQUEST_LIMIT);
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
    return handleMaintainerRequest(request, env, { tokens: ISOLATE_TOKENS });
  },
} satisfies ExportedHandler<MaintainerEnv>;

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

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
