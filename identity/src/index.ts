import { admitRequest } from "./admission.ts";
import { GitHubAppAuthority, InstallationTokenCache } from "./github.ts";
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
  parseIssueWriteRequest,
} from "./protocol.ts";

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
  if (
    request.method !== "POST" ||
    url.search !== "" ||
    url.pathname !== "/v1/issues"
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
        installation: env.INSTALLATION_LIMIT,
      },
    },
  );
  // The IDs a request names, recorded with its outcome; claimed until GitHub proves them.
  let accountId: number | null = null;
  let repositoryId: number | null = null;
  try {
    if (url.pathname === "/v1/issues") {
      await admitRequest(request, env.REQUEST_LIMIT);
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

function bearer(value: string | null): string {
  const match = value?.match(/^Bearer (ghu_[A-Za-z0-9_]{1,2048})$/);
  if (!match?.[1]) throw new AuthorityError("unauthorized");
  return match[1];
}
