/**
 * The wire contract between installed Mochi Apps and `mochi-github-authority`.
 *
 * Many installed Apps call one remote Worker, and none of them is upgraded when
 * the Worker is. Both sides import this module: the Worker parses requests with
 * it, and the native client builds them with it, so a request one side accepts
 * is exactly the request the other side sends. Changing what this module
 * accepts is a protocol change for every App already installed.
 */

/**
 * Client protocol versions the authority accepts; a client sends `maximum`.
 * Raise `maximum` when the request shape changes and keep parsing every older
 * version down to `minimum`; raise `minimum` only to retire the Apps that speak
 * it. A version outside the range is refused as `protocol_unsupported`.
 */
export const AUTHORITY_PROTOCOL = Object.freeze({ minimum: 1, maximum: 1 });

/** Every refusal the authority makes itself, with its HTTP status. */
export const AUTHORITY_ERRORS = Object.freeze({
  invalid_request: 400,
  unauthorized: 401,
  grant_unavailable: 403,
  permission_denied: 403,
  repository_changed: 409,
  protocol_unsupported: 426,
  rate_limited: 429,
  provider_response_invalid: 502,
  issuer_unavailable: 503,
  provider_unavailable: 503,
});
export type AuthorityErrorCode = keyof typeof AUTHORITY_ERRORS;

/**
 * Carries the code of every refusal the authority makes itself. A response
 * without it is GitHub's own answer to the write, relayed unchanged.
 */
export const AUTHORITY_ERROR_HEADER = "X-Mochi-Authority-Error";

export class AuthorityError extends Error {
  readonly status: number;

  constructor(
    readonly code: AuthorityErrorCode,
    status: number = AUTHORITY_ERRORS[code],
  ) {
    super(code);
    this.name = "AuthorityError";
    this.status = status;
  }
}

export function authorityErrorCode(
  value: string | null,
): AuthorityErrorCode | undefined {
  return value !== null && Object.hasOwn(AUTHORITY_ERRORS, value)
    ? (value as AuthorityErrorCode)
    : undefined;
}

export interface RepositoryIdentity {
  id: number;
  ownerId: number;
  installationId: number;
  fullName: string;
}

export type IssueWriteMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export interface IssueOperation {
  method: IssueWriteMethod;
  /** Relative to the repository, such as `/issues/42/comments`. */
  path: string;
  body?: Record<string, unknown>;
}

export interface IssueWriteRequest {
  version: number;
  accountId: number;
  repository: RepositoryIdentity;
  operation: IssueOperation;
}

/** GitHub repository roles, weakest first, as Issue operations tell them apart. */
const REPOSITORY_ROLES = ["read", "triage", "write"] as const;
export type RepositoryRole = (typeof REPOSITORY_ROLES)[number];

export function roleSatisfies(
  role: RepositoryRole,
  needed: RepositoryRole,
): boolean {
  return REPOSITORY_ROLES.indexOf(role) >= REPOSITORY_ROLES.indexOf(needed);
}

/**
 * The role GitHub reports for the account in a repository's `permissions`, or
 * undefined when the account cannot even read it. The authority gates each
 * write by this role and the native catalog derives it the same way, so the
 * App refuses exactly the operations the authority would.
 */
export function repositoryRole(
  permissions: unknown,
): RepositoryRole | undefined {
  if (!record(permissions)) return undefined;
  if (
    permissions.admin === true ||
    permissions.maintain === true ||
    permissions.push === true
  )
    return "write";
  if (permissions.triage === true) return "triage";
  return permissions.pull === true ? "read" : undefined;
}

export type IssueOperationKind =
  | "create"
  | "update"
  | "comment"
  | "assignees"
  | "labels"
  | "lock";

interface OperationRule {
  kind: IssueOperationKind;
  method: IssueWriteMethod;
  path: RegExp;
  role: RepositoryRole;
  /** The only body fields allowed, each with the role that setting it needs. */
  fields: Readonly<Record<string, RepositoryRole>>;
}

const ISSUE = String.raw`^\/issues\/[1-9]\d*`;
// Exactly what encodeURIComponent produces for a label name.
const LABEL = "[A-Za-z0-9%._~!'()*-]+";

/**
 * The closed Issue surface, and the repository role each operation needs on
 * GitHub itself (GitHub Docs, "Repository roles for an organization"). The
 * authority writes as the App, so nobody may do through Mochi what their own
 * role cannot: opening an Issue and commenting need read; applying labels,
 * assignees and milestones and closing or reopening need triage; editing a
 * title or body and locking need write, as does commenting on a locked
 * conversation, which the authority checks against the Issue itself. An
 * operation needs the strongest role among the fields it sets.
 */
const OPERATIONS: readonly OperationRule[] = [
  {
    kind: "create",
    method: "POST",
    path: /^\/issues$/,
    role: "read",
    fields: {
      title: "read",
      body: "read",
      labels: "triage",
      assignees: "triage",
      milestone: "triage",
    },
  },
  {
    kind: "update",
    method: "PATCH",
    path: new RegExp(`${ISSUE}$`),
    role: "triage",
    fields: {
      title: "write",
      body: "write",
      state: "triage",
      state_reason: "triage",
      labels: "triage",
      assignees: "triage",
      milestone: "triage",
    },
  },
  {
    kind: "comment",
    method: "POST",
    path: new RegExp(`${ISSUE}\\/comments$`),
    role: "read",
    fields: { body: "read" },
  },
  ...(["POST", "DELETE"] as const).map(
    (method): OperationRule => ({
      kind: "assignees",
      method,
      path: new RegExp(`${ISSUE}\\/assignees$`),
      role: "triage",
      fields: { assignees: "triage" },
    }),
  ),
  {
    kind: "labels",
    method: "POST",
    path: new RegExp(`${ISSUE}\\/labels$`),
    role: "triage",
    fields: { labels: "triage" },
  },
  {
    kind: "labels",
    method: "DELETE",
    path: new RegExp(`${ISSUE}\\/labels\\/${LABEL}$`),
    role: "triage",
    fields: {},
  },
  {
    kind: "lock",
    method: "PUT",
    path: new RegExp(`${ISSUE}\\/lock$`),
    role: "write",
    fields: { lock_reason: "write" },
  },
  {
    kind: "lock",
    method: "DELETE",
    path: new RegExp(`${ISSUE}\\/lock$`),
    role: "write",
    fields: {},
  },
];

/** What an operation is and the role it needs, or undefined outside the surface. */
export function issueOperationPolicy(operation: {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}): { kind: IssueOperationKind; role: RepositoryRole } | undefined {
  const rule = OPERATIONS.find(
    (candidate) =>
      candidate.method === operation.method &&
      candidate.path.test(operation.path),
  );
  // A dot segment would be resolved away, moving the request to another path.
  if (!rule || /\/\.{1,2}$/.test(operation.path)) return undefined;
  let role = rule.role;
  for (const field of Object.keys(operation.body ?? {})) {
    if (!Object.hasOwn(rule.fields, field)) return undefined;
    const needed = rule.fields[field] as RepositoryRole;
    if (!roleSatisfies(role, needed)) role = needed;
  }
  return { kind: rule.kind, role };
}

/** Whether a route is on the closed surface, before its body is known. */
export function allowedIssueWrite(path: string, method: string): boolean {
  return issueOperationPolicy({ method, path }) !== undefined;
}

export function parseIssueWriteRequest(value: unknown): IssueWriteRequest {
  if (!record(value) || !Number.isSafeInteger(value.version)) {
    throw new AuthorityError("invalid_request");
  }
  const version = value.version as number;
  if (
    version < AUTHORITY_PROTOCOL.minimum ||
    version > AUTHORITY_PROTOCOL.maximum
  ) {
    throw new AuthorityError("protocol_unsupported");
  }
  if (
    keys(value) !== "accountId,operation,repository,version" ||
    !isId(value.accountId) ||
    !record(value.repository) ||
    !record(value.operation)
  ) {
    throw new AuthorityError("invalid_request");
  }
  const repository = value.repository;
  const operation = value.operation;
  if (
    keys(repository) !== "fullName,id,installationId,ownerId" ||
    !isId(repository.id) ||
    !isId(repository.ownerId) ||
    !isId(repository.installationId) ||
    !isFullName(repository.fullName) ||
    !["method,path", "body,method,path"].includes(keys(operation)) ||
    typeof operation.method !== "string" ||
    typeof operation.path !== "string" ||
    ("body" in operation && !record(operation.body)) ||
    !issueOperationPolicy({
      method: operation.method,
      path: operation.path,
      ...(record(operation.body) ? { body: operation.body } : {}),
    })
  ) {
    throw new AuthorityError("invalid_request");
  }
  return {
    version,
    accountId: value.accountId,
    repository: {
      id: repository.id,
      ownerId: repository.ownerId,
      installationId: repository.installationId,
      fullName: repository.fullName,
    },
    operation: {
      method: operation.method as IssueWriteMethod,
      path: operation.path,
      ...(record(operation.body) ? { body: operation.body } : {}),
    },
  };
}

/** The request this client sends; it refuses anything the authority would. */
export function issueWriteRequest(input: {
  accountId: number;
  repository: RepositoryIdentity;
  operation: { method: IssueWriteMethod; path: string; body?: unknown };
}): IssueWriteRequest {
  return parseIssueWriteRequest({
    version: AUTHORITY_PROTOCOL.maximum,
    ...input,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(",");
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFullName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 140 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
    !value.endsWith("/.") &&
    !value.endsWith("/..")
  );
}
