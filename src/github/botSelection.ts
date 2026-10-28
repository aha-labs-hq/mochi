import type { GitHubConnection } from "./connection.ts";
import type { BotGitHub, GitHubRepositoryAccess } from "./botAccess.ts";
import { GitHubConnectionError } from "./integration.ts";
import {
  isGitHubFullName,
  isGitHubId,
  type GitHubProject,
  type GitHubSelection,
} from "./repository.ts";
import type { ConnectorSelectionStore } from "../connectors/selectionStore.ts";
import {
  decodeGitHubResourceFacts,
  encodeGitHubResourceFacts,
  githubConnectionId,
  githubRepositoryIdOf,
  githubResourceId,
} from "../connectors/github/identity.ts";
import { GITHUB_PROVIDER_ID } from "../connectors/github/manifest.ts";

/**
 * One Bot's project selection, reconciled against this Bot's GitHub grant.
 *
 * The credential proves which repositories exist; this decides which of them this
 * Bot uses, and it is the only place a selection identity is created. Every
 * capability it hands out is assembled from three separate facts that must all
 * still agree: the live credential (account and grant), the proof the provider
 * just returned (owner and installation) and this Bot's own durable record
 * (selection identity).
 */
export class GitHubProjectSelection implements BotGitHub {
  readonly #github: GitHubConnection;
  readonly #store: ConnectorSelectionStore;
  #catalog: { accountId: number; grantId: string; projects: readonly GitHubProject[] } | null = null;

  constructor(github: GitHubConnection, store: ConnectorSelectionStore) {
    this.#github = github;
    this.#store = store;
  }

  /** The last complete proof, available only for the same current grant. */
  catalogSnapshot(): readonly GitHubProject[] | null {
    if (this.#github.snapshot().status !== "connected") return null;
    const authority = this.#github.authority();
    return this.#catalog?.accountId === authority.accountId && this.#catalog.grantId === authority.grantId ? this.#catalog.projects : null;
  }

  /**
   * Returns only the locally saved display snapshot for the current account.
   *
   * The rows deliberately survive a temporary provider outage so Settings can
   * explain and remove the saved range. Every field is treated as untrusted
   * storage: malformed or incomplete rows are omitted, and no returned value
   * is accepted by `repositoryAccess()` without a fresh provider proof.
   */
  savedProjectsSnapshot(): readonly GitHubProject[] {
    const connectionId = this.#selectionConnectionId();
    if (!connectionId) return [];
    // A successful same-account OAuth exchange creates a new grant before the
    // provider directory has been reconciled. The old rows remain useful for a
    // provider outage, but while the current grant is provable they are only
    // display facts if they belong to that exact grant.
    let currentGrantId: string | null = null;
    if (this.#github.snapshot().status === "connected") {
      try {
        currentGrantId = this.#github.authority().grantId;
      } catch {
        // Keep the bounded local snapshot when authority cannot be confirmed.
      }
    }
    const seen = new Set<number>();
    return this.#store.connectorSelections(connectionId).flatMap((row) => {
      const repositoryId = githubRepositoryIdOf(row.resourceId);
      const facts = decodeGitHubResourceFacts(row.address);
      const ownerId = facts ? Number(facts.ownerId) : NaN;
      const installationId = facts ? Number(facts.binding) : NaN;
      if (
        repositoryId === null ||
        seen.has(repositoryId) ||
        facts === null ||
        (currentGrantId !== null && facts.grantId !== currentGrantId) ||
        !isGitHubId(ownerId) ||
        !isGitHubId(installationId) ||
        !isGitHubFullName(row.displayName)
      ) return [];
      seen.add(repositoryId);
      return [{
        id: repositoryId,
        ownerId,
        fullName: row.displayName,
        installationId,
        private: facts.visibility === "private",
        canWriteIssues: facts.writable,
        selected: true,
      }];
    });
  }

  async selectedProjects(): Promise<readonly GitHubProject[]> {
    return (await this.#reconcile()).filter((project) => project.selected);
  }

  /**
   * Scope-bound access to one repository.
   *
   * The scope is assembled from three facts that must all still agree: the live
   * credential (account and grant), the proof the provider just returned (owner
   * and installation) and this Bot's own durable record (selection identity).
   * The stored selection identity binds the Bot's choice; provider authority and
   * repository facts are proven again before the scope is handed out.
   */
  async repositoryAccess(repositoryId: number): Promise<GitHubRepositoryAccess> {
    const project = (await this.#reconcile()).find((candidate) => candidate.id === repositoryId);
    if (!project?.selected) throw new GitHubConnectionError("repository_not_selected");
    const selection = this.#selections().find((candidate) => candidate.repositoryId === repositoryId);
    if (!selection) throw new GitHubConnectionError("repository_not_selected");
    const authority = this.#github.authority();
    return this.#github.repositoryAccess({
      accountId: authority.accountId,
      grantId: authority.grantId,
      repositoryId: project.id,
      ownerId: project.ownerId,
      installationId: project.installationId,
      selectionId: selection.selectionId,
    });
  }

  /** The whole catalog with this Bot's selection applied, freshly proven. */
  discover(): Promise<readonly GitHubProject[]> {
    return this.#reconcile();
  }

  /**
   * Replaces the selection with exactly these repositories.
   *
   * A repository the grant does not currently prove is refused rather than
   * stored, so a selection can never be created ahead of the authority that
   * would make it usable. Existing selections keep their identity, because
   * re-selecting the same repository must not invalidate in-flight Issue actions.
   */
  async select(repositoryIds: readonly number[]): Promise<void> {
    if (repositoryIds.length > 1_000 || repositoryIds.some((id) => !isGitHubId(id))
      || new Set(repositoryIds).size !== repositoryIds.length) {
      throw new GitHubConnectionError("repository_not_selected");
    }
    const catalog = await this.#github.catalog();
    const connectionId = this.#connectionId();
    const existing = new Map(this.#selections().map((selection) => [selection.repositoryId, selection]));
    for (const id of repositoryIds) {
      if (!catalog.some((candidate) => candidate.id === id)) {
        throw new GitHubConnectionError("grant_unavailable");
      }
    }
    this.#store.replaceConnectorSelections(connectionId, repositoryIds.map((id) => {
      const previous = existing.get(id);
      const project = catalog.find((candidate) => candidate.id === id)!;
      return {
        connectionId,
        resourceId: githubResourceId(id),
        resourceType: "repository",
        displayName: project.fullName,
        // The provider facts a screen needs without a call, plus the installation
        // the choice was made under so a later reconcile can tell whether the
        // grant still covers this repository the same way.
        address: encodeGitHubResourceFacts({
          binding: String(project.installationId),
          grantId: this.#github.authority().grantId,
          ownerId: String(project.ownerId),
          visibility: project.private ? "private" : "public",
          writable: project.canWriteIssues,
        }),
        selectionId: previous?.selectionId ?? crypto.randomUUID().replaceAll("-", ""),
      };
    }));
  }

  /**
   * Reconciles the stored selection against a freshly proven catalog.
   *
   * Keep the last same-grant display proof while the next request is pending.
   * Actual repository access still awaits that new proof. A catalog read
   * failure is never answered with a stale list: the caller sees
   * the failure, and the Bot publishes no catalog rather than an unproven one.
   */
  async #reconcile(): Promise<readonly GitHubProject[]> {
    try {
      const catalog = await this.#github.catalog();
      const authority = this.#github.authority();
      const connectionId = githubConnectionId(authority.accountId);
      if (!connectionId) throw new GitHubConnectionError("sign_in_required");
      const stored = this.#storedSelections(connectionId);
      this.#clearGithubSelections(connectionId);
      // A selection is proven only when the live catalog still lists the repository
      // under the same installation it was chosen in. A repository moved to another
      // installation is a different grant, so the old choice must not survive it.
      const proven = stored.flatMap((selection) => {
        if (selection.grantId !== authority.grantId || !catalog.some((project) => project.id === selection.repositoryId
          && String(project.installationId) === selection.binding)) return [];
        return [{ ...selection, grantId: authority.grantId }];
      });
      if (proven.length !== stored.length) {
        // A grant proof that no longer covers a repository removes the choice
        // durably. Re-selecting it later creates a new authority.
        this.#store.replaceConnectorSelections(connectionId, proven.map((selection) => {
          const project = catalog.find((candidate) => candidate.id === selection.repositoryId)!;
          return {
            connectionId: this.#connectionId(),
            resourceId: githubResourceId(selection.repositoryId),
            resourceType: "repository",
            displayName: project.fullName,
            address: encodeGitHubResourceFacts({
              binding: String(project.installationId),
              grantId: authority.grantId,
              ownerId: String(project.ownerId),
              visibility: project.private ? "private" : "public",
              writable: project.canWriteIssues,
            }),
            selectionId: selection.selectionId,
          };
        }));
      }
      const selected = new Set(proven.map((selection) => selection.repositoryId));
      const projects = catalog.map((project) => ({ ...project, selected: selected.has(project.id) }));
      this.#catalog = { accountId: authority.accountId, grantId: authority.grantId, projects };
      return projects;
    } catch (error) {
      this.#catalog = null;
      throw error;
    }
  }

  /** The stored selection, read from the shared connector table. */
  #selections(): (GitHubSelection & { binding: string; grantId: string | null })[] {
    const authority = this.#github.authority();
    const connectionId = githubConnectionId(authority.accountId);
    if (!connectionId) throw new GitHubConnectionError("sign_in_required");
    return this.#storedSelections(connectionId).filter(
      (selection) => selection.grantId === authority.grantId,
    );
  }

  #storedSelections(connectionId: string): (GitHubSelection & { binding: string; grantId: string | null })[] {
    const rows = this.#store.connectorSelections(connectionId);
    const normalized = rows.flatMap((row) => {
      const repositoryId = githubRepositoryIdOf(row.resourceId);
      const facts = decodeGitHubResourceFacts(row.address);
      // A row whose facts cannot be decoded proves nothing, so it is not
      // reported as a usable choice.
      return repositoryId === null || facts === null
        ? []
        : [{ repositoryId, selectionId: row.selectionId, binding: facts.binding, grantId: facts.grantId }];
    });
    return normalized;
  }

  /**
   * Drops this Bot's whole GitHub selection. A disconnect leaves no current
   * account to scope it to, so every GitHub account's rows go; other providers'
   * choices are untouched.
   */
  clear(): void {
    this.#catalog = null;
    this.#clearGithubSelections();
  }

  /** Retire rows belonging to every GitHub account except `keep`. */
  #clearGithubSelections(keep?: string): void {
    for (const connectionId of this.#store.connectorSelectionConnectionIds()) {
      if (
        connectionId.startsWith(`${GITHUB_PROVIDER_ID}:`) &&
        connectionId !== keep
      ) {
        this.#store.replaceConnectorSelections(connectionId, []);
      }
    }
  }

  #selectionConnectionId(): string | null {
    return githubConnectionId(this.#github.snapshot().account?.id);
  }

  /** The connection a selection belongs to; GitHub's identity is the account. */
  #connectionId(): string {
    const connectionId = githubConnectionId(this.#github.authority().accountId);
    if (!connectionId) throw new GitHubConnectionError("sign_in_required");
    return connectionId;
  }
}
