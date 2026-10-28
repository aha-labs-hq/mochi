import { GITHUB_CONNECTION_FAILURES, GitHubConnectionError, type GitHubConnectionFailure } from "./integration.ts";

/**
 * This Bot's GitHub credential, without any project catalog.
 *
 * Which repositories are available on the grant is a property of the account, and
 * which of them a Bot may use is a property of that Bot, so the two are never
 * merged into one shared list. The Bot's own status carries its own projects.
 */
export interface GitHubConnectionSnapshot {
  status: "disconnected" | "authorizing" | "connected" | "unavailable";
  account: { id: number; login: string } | null;
  problem: GitHubConnectionFailure | null;
}

export function emptyGitHubSnapshot(): GitHubConnectionSnapshot {
  return { status: "unavailable", account: null, problem: "provider_unavailable" };
}

export function isGitHubConnectionSnapshot(value: unknown): value is GitHubConnectionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "account,problem,status") return false;
  const data = value as Record<string, unknown>;
  if (!["disconnected", "authorizing", "connected", "unavailable"].includes(String(data.status))
    || (data.problem !== null && !GITHUB_CONNECTION_FAILURES.includes(data.problem as GitHubConnectionFailure))) return false;
  if (data.account !== null) {
    if (typeof data.account !== "object" || Array.isArray(data.account)) return false;
    const account = data.account as Record<string, unknown>;
    if (Object.keys(account).sort().join(",") !== "id,login" || !isGitHubId(account.id)
      || typeof account.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account.login)) return false;
  }
  if (data.status === "connected" && (data.account === null || data.problem !== null)) return false;
  if (data.status === "disconnected" && (data.account !== null || data.problem !== null)) return false;
  if (data.status === "unavailable" && data.problem === null) return false;
  if (data.status === "authorizing" && data.problem !== null) return false;
  return true;
}

/**
 * One verified repository as the provider and the grant describe it, before any
 * Bot has decided whether it uses it.
 */
export interface GitHubCatalogRepository {
  id: number;
  ownerId: number;
  fullName: string;
  installationId: number;
  private: boolean;
  canWriteIssues: boolean;
}

/** Renderer-safe catalog, derived only from the customer/App grant intersection. */
export interface GitHubProject extends GitHubCatalogRepository {
  selected: boolean;
}

export function isGitHubProject(value: unknown): value is GitHubProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const project = value as Record<string, unknown>;
  if (Object.keys(project).sort().join(",") !== "canWriteIssues,fullName,id,installationId,ownerId,private,selected") return false;
  return isGitHubId(project.id) && isGitHubId(project.ownerId) && isGitHubId(project.installationId)
    && isGitHubFullName(project.fullName) && typeof project.private === "boolean"
    && typeof project.canWriteIssues === "boolean" && typeof project.selected === "boolean";
}

/** Durable authority for an Issue proposal, not a mutable owner/repo address. */
export interface GitHubRepositoryScope {
  accountId: number;
  grantId: string;
  repositoryId: number;
  ownerId: number;
  installationId: number;
  selectionId: string;
}

/**
 * One Bot's durable choice of one repository.
 *
 * The logical selection carries only the repository and selection identities. The
 * persisted connector row may retain display facts and the grant/install binding
 * needed to recognize stale rows, but owner and installation used for a call are
 * still proven from the live catalog when the scope is assembled.
 */
export interface GitHubSelection {
  repositoryId: number;
  selectionId: string;
}

export function isGitHubId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isGitHubFullName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 140
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value)
    && !value.endsWith("/.") && !value.endsWith("/..");
}

export function isGitHubNonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function parseGitHubScope(value: unknown): GitHubRepositoryScope {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "accountId,grantId,installationId,ownerId,repositoryId,selectionId") {
    throw new GitHubConnectionError("repository_changed");
  }
  const scope = value as Record<string, unknown>;
  if (!isGitHubId(scope.accountId) || !isGitHubId(scope.repositoryId) || !isGitHubId(scope.ownerId) || !isGitHubId(scope.installationId)
    || !isGitHubNonce(scope.grantId) || !isGitHubNonce(scope.selectionId)) {
    throw new GitHubConnectionError("repository_changed");
  }
  return {
    accountId: scope.accountId, grantId: scope.grantId, repositoryId: scope.repositoryId,
    ownerId: scope.ownerId, installationId: scope.installationId, selectionId: scope.selectionId,
  };
}

export function parseGitHubProjects(value: unknown): GitHubProject[] {
  if (!Array.isArray(value) || value.length > 1000) throw new GitHubConnectionError("provider_response_invalid");
  const projects = value.map((item: unknown): GitHubProject => {
    if (!isGitHubProject(item)) throw new GitHubConnectionError("provider_response_invalid");
    return {
      id: item.id, ownerId: item.ownerId, installationId: item.installationId,
      fullName: item.fullName, private: item.private, canWriteIssues: item.canWriteIssues, selected: item.selected,
    };
  });
  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new GitHubConnectionError("provider_response_invalid");
  }
  return projects;
}
