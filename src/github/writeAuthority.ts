import {
  AUTHORITY_ERROR_HEADER,
  AUTHORITY_ERRORS,
  AuthorityError,
  authorityErrorCode,
  type IssueWriteMethod,
  issueOperationPolicy,
  issueWriteRequest,
  type RepositoryRole,
  roleSatisfies,
} from "../../identity/src/protocol.ts";
import { log } from "../log.ts";
import {
  GITHUB_INTEGRATION,
  GITHUB_REQUEST_TIMEOUT_MS,
  GitHubConnectionError,
} from "./integration.ts";
import type { GitHubRepositoryScope } from "./repository.ts";
import { GitHubRequestError } from "./requestError.ts";

type RefusalCode =
  | "permission_denied"
  | "rate_limited"
  | "protocol_unsupported";

/**
 * The authority refused one write before it reached GitHub. Like every
 * GitHubRequestError it belongs to the request alone and leaves the grant
 * connected; its message says what would let the write succeed.
 */
export class GitHubAuthorityRefusal extends GitHubRequestError {
  override readonly code: RefusalCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: RefusalCode, status: number, headers: Headers) {
    super(status, headers);
    this.name = "GitHubAuthorityRefusal";
    this.code = code;
    const retryAfter = headers.get("retry-after");
    this.retryAfterSeconds =
      code === "rate_limited" && retryAfter && /^[1-9]\d{0,3}$/.test(retryAfter)
        ? Number(retryAfter)
        : undefined;
    this.message = `${code}: ${explanation(code, this.retryAfterSeconds)}`;
  }
}

/**
 * The native product keeps the customer grant but never performs a GitHub write
 * with that user's token. This client can ask only for the closed Issue operation;
 * the remote authority re-proves the user/App/repository intersection and writes
 * with a repository-scoped installation token that never leaves the authority.
 */
export class GitHubWriteAuthority {
  constructor(readonly fetchImplementation: typeof fetch = fetch) {}

  /**
   * `role` is the account's role as the catalog just proved it. The authority
   * proves it again before writing; an operation that role cannot perform is
   * refused here the way the authority would refuse it, and nothing is sent.
   */
  async issue(
    userToken: string,
    scope: GitHubRepositoryScope,
    fullName: string,
    role: RepositoryRole,
    path: string,
    method: IssueWriteMethod,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    let request: ReturnType<typeof issueWriteRequest>;
    try {
      request = issueWriteRequest({
        accountId: scope.accountId,
        repository: {
          id: scope.repositoryId,
          ownerId: scope.ownerId,
          installationId: scope.installationId,
          fullName,
        },
        operation: { method, path, ...(body === undefined ? {} : { body }) },
      });
    } catch (error) {
      if (!(error instanceof AuthorityError)) throw error;
      // The authority would refuse it the same way; nothing is sent.
      throw new GitHubRequestError(400, new Headers());
    }
    const policy = issueOperationPolicy(request.operation);
    if (!policy || !roleSatisfies(role, policy.role)) {
      throw new GitHubAuthorityRefusal(
        "permission_denied",
        AUTHORITY_ERRORS.permission_denied,
        new Headers(),
      );
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${GITHUB_INTEGRATION.authorityUrl}/v1/issues`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${userToken}`,
            "Content-Type": "application/json",
            "User-Agent": "mochi",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
          ]),
        },
      );
    } catch {
      throw new GitHubConnectionError(
        signal.aborted ? "authorization_cancelled" : "provider_unavailable",
      );
    }
    const code = authorityErrorCode(
      response.headers.get(AUTHORITY_ERROR_HEADER),
    );
    // Without the header this is GitHub's own answer, relayed unchanged; the
    // remaining authority failures stay ordinary request failures too.
    if (
      code === undefined ||
      code === "invalid_request" ||
      code === "issuer_unavailable" ||
      code === "provider_unavailable" ||
      code === "provider_response_invalid"
    ) {
      return response;
    }
    await response.body?.cancel();
    const authorityRequestId = response.headers.get("x-mochi-request-id");
    log.warn("github.authority.refused", {
      repositoryId: scope.repositoryId,
      method,
      httpStatus: response.status,
      errorCode: code,
      ...(authorityRequestId && /^[0-9a-f-]{36}$/.test(authorityRequestId)
        ? { authorityRequestId }
        : {}),
    });
    if (code === "unauthorized")
      throw new GitHubConnectionError("sign_in_required");
    if (code === "repository_changed")
      throw new GitHubConnectionError("repository_changed");
    if (code === "grant_unavailable")
      throw new GitHubConnectionError("issue_write_not_granted");
    throw new GitHubAuthorityRefusal(code, response.status, response.headers);
  }
}

function explanation(
  code: RefusalCode,
  retryAfterSeconds: number | undefined,
): string {
  if (code === "rate_limited") {
    return `Mochi's GitHub write authority is limiting writes for this GitHub account or installation, so this write was not performed. Wait ${retryAfterSeconds === undefined ? "a minute" : `${retryAfterSeconds} seconds`} before the next write.`;
  }
  if (code === "permission_denied") {
    return "The connected GitHub account's role on this repository does not allow this Issue operation, so it was not performed. On GitHub, opening Issues and commenting need read access; labels, assignees, milestones, closing and reopening need triage; editing a title or body, locking, and commenting on a locked conversation need write. Someone with that role must make the change or grant it.";
  }
  return "Mochi's GitHub write authority no longer accepts this version of Mochi, so the write was not performed. Mochi must be updated before it can write to GitHub.";
}
