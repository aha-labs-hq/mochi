import type { GitHubProject, GitHubRepositoryScope } from "./repository.ts";

/**
 * One repository capability a Bot derived from its own selection.
 *
 * `scope` is the Bot's own durable authority, not a shared address: it carries
 * the selection identity this Bot created, so a request made through it can only
 * ever reach a repository the customer chose for this Bot.
 */
export interface GitHubRepositoryAccess {
  readonly scope: GitHubRepositoryScope;
  readonly fullName: string;
  request(path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown): Promise<unknown>;
}

/** A Bot’s selected repositories and scope-bound access through its own connection. */
export interface BotGitHub {
  /** The selected, currently verified repositories, as the read tool reports them. */
  selectedProjects(): Promise<readonly GitHubProject[]>;
  /**
   * The Bot's locally saved project range, with display facts only.
   *
   * These rows are safe to show while the provider is unavailable, but they are
   * never an authority for a read or write. A live catalog proof is still
   * required before `selectedProjects()` or `repositoryAccess()` can succeed.
   */
  savedProjectsSnapshot(): readonly GitHubProject[];
  /** Throws when the repository is not this Bot's selection, or the grant no longer proves it. */
  repositoryAccess(repositoryId: number): Promise<GitHubRepositoryAccess>;
  /** The Bot's whole catalog with its own selection applied, re-proven against the grant. */
  discover(): Promise<readonly GitHubProject[]>;
  /** Replaces this Bot's selection with exactly these repositories. */
  select(repositoryIds: readonly number[]): Promise<void>;
}
