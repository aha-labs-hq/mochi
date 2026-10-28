import { randomBytes } from "node:crypto";
import { log } from "../log.ts";
import { GitHubRequestError } from "./requestError.ts";
import type { GitHubCredential, GitHubCredentialStore } from "./credentials.ts";
import { GITHUB_API_VERSION, GITHUB_INTEGRATION, GITHUB_REQUEST_TIMEOUT_MS,
  GitHubConnectionError, type GitHubConnectionFailure } from "./integration.ts";
import { boundedGitHubJson, boundedGitHubValue, GitHubAuthorization, GitHubOAuth, type GitHubUserToken } from "./oauth.ts";
import { isGitHubFullName, isGitHubId, type GitHubRepositoryScope } from "./repository.ts";
import type { GitHubCatalogRepository, GitHubConnectionSnapshot } from "./repository.ts";
import type { GitHubRepositoryAccess } from "./botAccess.ts";
import { GitHubWriteAuthority } from "./writeAuthority.ts";
import { allowedIssueWrite, repositoryRole, type RepositoryRole } from "../../identity/src/protocol.ts";

/** This Bot's credential identity, proof that never depends on a selection. */
export interface GitHubAuthority {
  accountId: number;
  grantId: string;
}

/**
 * A catalog entry with the account's own role on the repository. The role stays
 * with the connection, which hands it to every Issue write; a Bot's view needs
 * only whether the installation lets Issues be written at all.
 */
type ProvenRepository = GitHubCatalogRepository & { role: RepositoryRole };

/** Owns one Bot’s OAuth grant and rotating token. Project selection lives in BotGitHubSelection. */
export class GitHubConnection {
  readonly #store: GitHubCredentialStore;
  readonly #oauth: GitHubOAuth;
  readonly #writeAuthority: GitHubWriteAuthority;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #changed: (snapshot: GitHubConnectionSnapshot) => void;
  readonly #listeners = new Set<(snapshot: GitHubConnectionSnapshot) => void>();
  readonly #shutdown = new AbortController();
  #operationSignal: AbortSignal | undefined;
  #credential: GitHubCredential | undefined;
  #problem: GitHubConnectionFailure | null = null;
  #attempt: GitHubAuthorization | undefined;
  #closed = false;
  #published: string | undefined;
  #admission: Promise<unknown> = Promise.resolve();

  constructor(options: {
    store: GitHubCredentialStore;
    oauth: GitHubOAuth;
    writeAuthority?: GitHubWriteAuthority;
    changed?: (snapshot: GitHubConnectionSnapshot) => void;
  }) {
    this.#store = options.store;
    this.#oauth = options.oauth;
    this.#writeAuthority = options.writeAuthority ?? new GitHubWriteAuthority();
    this.#fetch = options.oauth.fetchImplementation;
    this.#now = options.oauth.now;
    this.#changed = options.changed ?? (() => undefined);
    try { this.#credential = this.#store.read(); }
    catch { this.#problem = "credential_unavailable"; }
    try { this.#oauth.assertConfigured(); }
    catch { this.#problem = "issuer_not_configured"; }
  }

  snapshot(): GitHubConnectionSnapshot {
    return {
      status: this.#attempt ? "authorizing" : this.#problem ? "unavailable" : this.#credential ? "connected" : "disconnected",
      account: this.#credential ? { ...this.#credential.account } : null,
      problem: this.#problem,
    };
  }

  /**
   * One startup proof of a saved grant; not a retry loop or a second token owner.
   * The catalog is proven here and handed to the caller, because a Bot's own
   * selection can only be reconciled against a catalog that was just verified.
   */
  async restore(): Promise<readonly GitHubCatalogRepository[]> {
    if (!this.#credential) return [];
    return this.catalog();
  }

  /** Presentation owners may change at first-Session handoff; the authorization must not. */
  subscribe(listener: (snapshot: GitHubConnectionSnapshot) => void): () => void {
    if (this.#closed) throw new GitHubConnectionError("authorization_cancelled");
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  startAuthorization(): Promise<{ authorizationUrl: string }> {
    return this.#startAttempt((oauth) => GitHubAuthorization.start(oauth));
  }

  /** Starts the bounded GitHub App installation flow and keeps its callback local. */
  startInstallation(): Promise<{ authorizationUrl: string }> {
    return this.#startAttempt(async (oauth) => {
      await this.#access();
      return GitHubAuthorization.startInstallation(oauth);
    });
  }

  #startAttempt(start: (oauth: GitHubOAuth) => Promise<GitHubAuthorization>): Promise<{ authorizationUrl: string }> {
    return this.#serialize(async () => {
      if (this.#attempt) throw new GitHubConnectionError("authorization_in_progress");
      const attempt = await start(this.#oauth);
      this.#attempt = attempt;
      this.#problem = null;
      this.#publish();
      void attempt.completion.then(
        (result) => this.#serialize(async () => {
          if (this.#attempt !== attempt) return;
          try {
            if (result.kind === "authorization") await this.#accept(result.token, attempt);
            else {
              this.#attempt = undefined;
              const credential = await this.#access();
              await this.#catalog(credential.token.accessToken);
              this.#problem = null;
            }
          }
          catch (error) { this.#problem = failure(error); }
          this.#attempt = undefined;
          this.#publish();
        }),
        (error: unknown) => this.#serialize(async () => {
          if (this.#attempt !== attempt) return;
          this.#attempt = undefined;
          this.#problem = failure(error);
          this.#publish();
        }),
      ).catch(() => undefined); // close() owns cancellation; no callback may resurrect a closed connection.
      return { authorizationUrl: attempt.authorizationUrl };
    });
  }

  cancelAuthorization(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt) return this.#serialize(async () => undefined);
    this.#attempt = undefined;
    attempt.cancel();
    return this.#serialize(async () => {
      this.#problem = null;
      this.#publish();
    });
  }

  /** Local disconnect stops access; it does not claim to uninstall the App from GitHub. */
  disconnect(): Promise<void> {
    return this.#serialize(async () => {
      const attempt = this.#attempt;
      this.#attempt = undefined;
      attempt?.cancel();
      this.#credential = undefined;
      try {
        this.#store.clear();
        this.#problem = null;
      } catch {
        this.#problem = "credential_unavailable";
        throw new GitHubConnectionError("credential_unavailable");
      } finally { this.#publish(); }
    });
  }

  /**
   * The verified catalog the current grant proves, with no selection applied.
   *
   * A re-authenticated or switched account invalidates every previous selection,
   * so the caller must reconcile its stored selection against exactly this list.
   */
  catalog(): Promise<readonly GitHubCatalogRepository[]> {
    return this.#serialize(async () => {
      const credential = await this.#access();
      const catalog = await this.#catalog(credential.token.accessToken);
      // A successful proof clears the previous failure: the grant the customer
      // just re-authorized is the one in force, and a stale problem would keep
      // reporting a condition that no longer exists.
      this.#problem = null;
      this.#publish();
      return catalog;
    });
  }

  /** The credential identity a Bot stamps into every scope it derives. */
  authority(): GitHubAuthority {
    const credential = this.#credential;
    if (this.#closed) throw new GitHubConnectionError("authorization_cancelled");
    if (this.#attempt) throw new GitHubConnectionError("authorization_in_progress");
    if (this.#problem) throw new GitHubConnectionError(this.#problem);
    if (!credential) throw new GitHubConnectionError("sign_in_required");
    return { accountId: credential.account.id, grantId: credential.grantId };
  }

  /**
   * Re-proves a Bot's scope against the live grant before any read or write.
   *
   * The scope carries the Bot's own selection identity, so a repository the Bot
   * never selected, or one whose owner, installation or account has moved, is
   * refused here rather than trusted from storage.
   */
  verifyRepository(scope: GitHubRepositoryScope, write: boolean): Promise<GitHubCatalogRepository> {
    return this.#serialize(async () => {
      const credential = await this.#access();
      if (scope.accountId !== credential.account.id || scope.grantId !== credential.grantId) {
        throw new GitHubConnectionError("repository_changed");
      }
      const project = (await this.#catalog(credential.token.accessToken)).find((candidate) => candidate.id === scope.repositoryId);
      if (!project || project.ownerId !== scope.ownerId || project.installationId !== scope.installationId) {
        throw new GitHubConnectionError("repository_changed");
      }
      if (write && !project.canWriteIssues) throw new GitHubConnectionError("issue_write_not_granted");
      return project;
    }, "resource");
  }

  async repositoryAccess(scope: GitHubRepositoryScope): Promise<GitHubRepositoryAccess> {
    const project = await this.verifyRepository(scope, false);
    return Object.freeze({
      scope: Object.freeze({ ...scope }),
      fullName: project.fullName,
      request: (path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown) =>
        this.#serialize(async () => {
          const credential = await this.#access();
          if (scope.accountId !== credential.account.id || scope.grantId !== credential.grantId) {
            throw new GitHubConnectionError("repository_changed");
          }
          const current = (await this.#catalog(credential.token.accessToken)).find((repo) => repo.id === scope.repositoryId);
          if (!current) throw new GitHubConnectionError("repository_changed");
          if (current.ownerId !== scope.ownerId || current.installationId !== scope.installationId || current.fullName !== project.fullName) {
            throw new GitHubConnectionError("repository_changed");
          }
          const prefix = `/repos/${current.fullName}`;
          const url = new URL(path, "https://api.github.com");
          const scoped = url.origin === "https://api.github.com"
            && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
          const search = method === "GET" && url.pathname === "/search/code"
            && safeSearchQuery(url.searchParams.get("q") ?? "", current.fullName);
          if ((!scoped && !search) || url.href !== `https://api.github.com${path}`) {
            throw new GitHubConnectionError("repository_not_selected");
          }
          if (method !== "GET") {
            if (!current.canWriteIssues) throw new GitHubConnectionError("issue_write_not_granted");
            if (!url.pathname.startsWith(`${prefix}/issues`) || url.search) throw new GitHubConnectionError("issue_write_not_granted");
            const suffix = url.pathname.slice(prefix.length);
            if (!allowedIssueWrite(suffix, method)) throw new GitHubConnectionError("issue_write_not_granted");
          }
          // Refuse redirects; stale names must never silently move a mutation to another repository.
          // Reads use a single-repository user capability. Writes go to the remote
          // App authority, which repeats the grant proof and owns the installation token.
          const response = method === "GET"
            ? await this.#response(path, await this.#oauth.repositoryReadToken(
              credential.token, scope.accountId, scope.ownerId, scope.repositoryId, this.#requestSignal(),
            ), method, body)
            : await this.#writeAuthority.issue(
              credential.token.accessToken, scope, current.fullName, current.role,
              url.pathname.slice(prefix.length), method, body, this.#requestSignal(),
            );
          if (!response.ok) {
            const error = await GitHubRequestError.fromResponse(response);
            log.warn("github.request.failed", {
              repositoryId: scope.repositoryId,
              method,
              httpStatus: response.status,
              requestId: error.requestId,
              errorCode: response.status === 401 ? "sign_in_required" : error.code,
            });
            if (response.status === 401) throw new GitHubConnectionError("sign_in_required");
            throw error;
          }
          if (response.status === 204) return null;
          const value = await boundedGitHubValue(response);
          if (search && (!record(value) || !Array.isArray(value.items)
            || value.items.some((item: unknown) => !record(item) || !record(item.repository) || item.repository.id !== scope.repositoryId))) {
            throw new GitHubConnectionError("repository_changed");
          }
          return value;
        }, "resource"),
    });
  }

  close(): void {
    this.#closed = true;
    this.#shutdown.abort();
    this.#attempt?.cancel();
    this.#attempt = undefined;
    this.#listeners.clear();
  }

  async #accept(token: GitHubUserToken, attempt: GitHubAuthorization): Promise<void> {
    const user = await this.#get("/user", token.accessToken);
    if (!isGitHubId(user.id) || typeof user.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)) {
      throw new GitHubConnectionError("provider_response_invalid");
    }
    if (this.#closed || this.#attempt !== attempt) return;
    // Every newly authenticated grant invalidates prior Issue actions, including a same-user re-login.
    this.#save({ version: 2, account: { id: user.id, login: user.login }, grantId: nonce(), token });
    this.#problem = null;
  }

  async #access(): Promise<GitHubCredential> {
    const credential = this.#credential;
    if (this.#attempt) throw new GitHubConnectionError("authorization_in_progress");
    if (!credential) throw new GitHubConnectionError("sign_in_required");
    if (credential.token.accessExpiresAt - this.#now() > 60_000) return credential;
    let token: GitHubUserToken;
    try {
      token = await this.#oauth.refresh(credential.token, this.#requestSignal());
    } catch (error) {
      // Only GitHub refusing this refresh token proves it unusable. After any
      // other failure (no answer, a server failure, an unreadable reply) the
      // grant stays and the next access offers the same token. If GitHub had
      // rotated it before the reply was lost, that attempt is refused and clears
      // the grant then: the worst case is one attempt later than clearing now,
      // and an offline moment no longer forces a new authorization, whose new
      // grant drops every Bot's project selection.
      if (failure(error) === "sign_in_required") {
        this.#credential = undefined;
        this.#store.clear();
      }
      throw error;
    }
    if (this.#closed) throw new GitHubConnectionError("authorization_cancelled");
    const updated = { ...credential, token };
    try { this.#save(updated); }
    catch (error) {
      this.#credential = undefined;
      this.#store.clear();
      throw error;
    }
    return updated;
  }

  #save(credential: GitHubCredential): void {
    if (this.#closed) throw new GitHubConnectionError("authorization_cancelled");
    this.#store.write(credential);
    this.#credential = credential;
  }

  async #catalog(token: string): Promise<ProvenRepository[]> {
    const installations = await this.#pages("/user/installations", "installations", token, 100);
    if (new Set(installations.map((installation) => installation.id)).size !== installations.length) {
      throw new GitHubConnectionError("provider_response_invalid");
    }
    const projects: ProvenRepository[] = [];
    for (const installation of installations) {
      if (installation.app_id !== GITHUB_INTEGRATION.appId || !isGitHubId(installation.id)
        || !record(installation.permissions) || !record(installation.account) || !isGitHubId(installation.account.id)) {
        throw new GitHubConnectionError("provider_response_invalid");
      }
      if (installation.suspended_at !== null) continue;
      const permission = installation.permissions;
      if (!["read", "write"].includes(String(permission.metadata))
        || !["read", "write"].includes(String(permission.contents))
        || !["read", "write"].includes(String(permission.issues))) continue;
      const repositories = await this.#pages(`/user/installations/${installation.id}/repositories`, "repositories", token, 1000);
      for (const repo of repositories) {
        if (!isGitHubId(repo.id) || !record(repo.owner) || !isGitHubId(repo.owner.id)
          || !isGitHubFullName(repo.full_name) || typeof repo.private !== "boolean"
          || !record(repo.permissions) || typeof repo.permissions.pull !== "boolean"
          || repo.owner.id !== installation.account.id) throw new GitHubConnectionError("provider_response_invalid");
        const role = repositoryRole(repo.permissions);
        if (!role) continue;
        if (projects.some((project) => project.id === repo.id)) throw new GitHubConnectionError("provider_response_invalid");
        // Every role may open Issues and comment, so the installation decides whether
        // Issues are writable here, and the role decides which operations, per write.
        projects.push({ id: repo.id, ownerId: repo.owner.id, fullName: repo.full_name,
          installationId: installation.id, private: repo.private,
          canWriteIssues: permission.issues === "write", role,
        });
        if (projects.length > 1000) throw new GitHubConnectionError("provider_response_invalid");
      }
    }
    return projects.sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  async #pages(path: string, key: "installations" | "repositories", token: string, maximum: number): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let total: number | undefined;
    for (let page = 1; page <= Math.max(1, Math.ceil(maximum / 100)); page++) {
      const data = await this.#get(`${path}?per_page=100&page=${page}`, token);
      if (typeof data.total_count !== "number" || !Number.isSafeInteger(data.total_count)
        || data.total_count < 0 || data.total_count > maximum || !Array.isArray(data[key])
        || data[key].length > 100 || data[key].some((item: unknown) => !record(item))
        || (total !== undefined && total !== data.total_count)) throw new GitHubConnectionError("provider_response_invalid");
      total = data.total_count;
      items.push(...data[key] as Record<string, unknown>[]);
      if (items.length === total) return items;
      if (items.length > total || data[key].length !== 100) throw new GitHubConnectionError("provider_response_invalid");
    }
    throw new GitHubConnectionError("provider_response_invalid");
  }

  async #get(path: string, token: string): Promise<Record<string, unknown>> {
    const response = await this.#response(path, token, "GET");
    if (!response.ok) {
      void response.body?.cancel();
      throw new GitHubConnectionError(response.status === 401 ? "sign_in_required"
        : response.status === 403 || response.status === 404 ? "grant_unavailable" : "provider_unavailable");
    }
    return boundedGitHubJson(response);
  }

  async #response(path: string, token: string, method: string, body?: unknown): Promise<Response> {
    const signal = this.#requestSignal();
    let response: Response;
    try {
      response = await this.#fetch(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "mochi",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch { throw new GitHubConnectionError("provider_unavailable"); }
    return response;
  }

  #serialize<T>(
    operation: () => Promise<T>,
    scope: "connection" | "resource" = "connection",
  ): Promise<T> {
    const task = this.#admission.then(async () => {
      if (this.#closed) throw new GitHubConnectionError("authorization_cancelled");
      // One deadline covers the entire paginated operation, not thirty seconds per page.
      this.#operationSignal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
      const wasSignedOut = !this.#credential && this.#problem === null;
      try { return await operation(); }
      catch (error) {
        if (error instanceof GitHubRequestError) throw error;
        if (!this.#attempt && (scope === "connection" || !isResourceFailure(error))) {
          const problem = failure(error);
          // An unconnected Bot has nothing to read; that is not a revoked grant.
          // A failed rotation or saved-grant proof still records its failure.
          if (!(wasSignedOut && problem === "sign_in_required")) this.#problem = problem;
        }
        this.#publish();
        throw error;
      } finally { this.#operationSignal = undefined; }
    });
    this.#admission = task.catch(() => undefined);
    return task;
  }

  #requestSignal(): AbortSignal {
    if (this.#closed) throw new GitHubConnectionError("authorization_cancelled");
    if (!this.#operationSignal) throw new Error("GitHub request requires serialized admission");
    this.#operationSignal.throwIfAborted();
    return AbortSignal.any([this.#operationSignal, this.#shutdown.signal]);
  }

  /**
   * Publishes only a real change.
   *
   * Reading the catalog is also how a caller re-proves the grant, and every Bot
   * reconciles its selection against it. Re-notifying listeners for a snapshot
   * they already have would make a Bot reconcile because it reconciled, turning
   * one read into a loop.
   */
  #publish(): void {
    if (this.#closed) return;
    const snapshot = this.snapshot();
    const encoded = JSON.stringify(snapshot);
    if (encoded === this.#published) return;
    this.#published = encoded;
    this.#changed(snapshot);
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function nonce(): string { return randomBytes(16).toString("hex"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function failure(error: unknown): GitHubConnectionFailure {
  return error instanceof GitHubConnectionError ? error.code : "provider_unavailable";
}

function isResourceFailure(error: unknown): boolean {
  return error instanceof GitHubConnectionError && (
    error.code === "repository_changed" ||
    error.code === "repository_not_selected" ||
    error.code === "issue_write_not_granted"
  );
}

function safeSearchQuery(query: string, fullName: string): boolean {
  const suffix = ` repo:${fullName}`;
  return query.endsWith(suffix) && !/(?:^|\s)(?:repo|org|user):|\b(?:OR|NOT)\b/i.test(query.slice(0, -suffix.length));
}
