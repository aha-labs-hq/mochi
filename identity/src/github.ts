import {
  AuthorityError,
  type IssueWriteRequest,
  issueOperationPolicy,
  type RepositoryIdentity,
  type RepositoryRole,
  repositoryRole,
  roleSatisfies,
} from "./protocol.ts";

const MAX_PROVIDER_BYTES = 2_000_000;
const MAX_INSTALLATIONS = 1_000;
const MAX_REPOSITORIES = 1_000;
const PROVIDER_TIMEOUT_MS = 15_000;
/** A cached installation token is handed out only while it has this long left. */
export const TOKEN_REUSE_MARGIN_MS = 10 * 60_000;
const MAX_CACHED_TOKENS = 1_000;
const ISSUE_PERMISSIONS = { metadata: "read", issues: "write" } as const;
const MAINTAINER_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
} as const;

type Permissions = Readonly<Record<string, "read" | "write">>;

export interface ProviderResult {
  status: number;
  body: unknown;
  requestId?: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
  installationId: number;
}

export interface GitHubAuthorityConfig {
  appId: number;
  appSlug: string;
  apiVersion: string;
  privateKey: string;
}

/** The surface of a Cloudflare rate-limit binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface AuthorityLimits {
  account: RateLimiter;
  installation: RateLimiter;
}

export async function enforceLimit(
  limiter: RateLimiter,
  key: string,
): Promise<void> {
  if (!(await limiter.limit({ key })).success) {
    throw new AuthorityError("rate_limited");
  }
}

/**
 * Installation tokens minted in this isolate, keyed by installation, repository
 * and permission set. Every request still re-proves its grant; the cache only
 * spares the App-wide budget one mint per write. An entry is dropped before it
 * expires and as soon as GitHub refuses it.
 */
export class InstallationTokenCache {
  readonly #entries = new Map<
    string,
    { issued: IssuedToken; expiresAt: number }
  >();

  take(key: string, now: number): IssuedToken | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt - now > TOKEN_REUSE_MARGIN_MS) return entry.issued;
    this.#entries.delete(key);
    return undefined;
  }

  put(key: string, issued: IssuedToken, expiresAt: number, now: number): void {
    this.#entries.delete(key);
    if (this.#entries.size >= MAX_CACHED_TOKENS) {
      for (const [candidate, entry] of this.#entries) {
        if (entry.expiresAt - now <= TOKEN_REUSE_MARGIN_MS)
          this.#entries.delete(candidate);
      }
    }
    const oldest = this.#entries.keys().next();
    if (this.#entries.size >= MAX_CACHED_TOKENS && !oldest.done)
      this.#entries.delete(oldest.value);
    this.#entries.set(key, { issued, expiresAt });
  }

  evict(key: string): void {
    this.#entries.delete(key);
  }
}

interface GitHubRequestOptions {
  token: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
}

export class GitHubAppAuthority {
  readonly #config: GitHubAuthorityConfig;
  readonly #tokens: InstallationTokenCache;
  readonly #limits: AuthorityLimits;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(
    config: GitHubAuthorityConfig,
    options: {
      tokens: InstallationTokenCache;
      limits: AuthorityLimits;
      fetchImplementation?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.#config = config;
    this.#tokens = options.tokens;
    this.#limits = options.limits;
    this.#fetch =
      options.fetchImplementation ??
      (((input, init) => globalThis.fetch(input, init)) as typeof fetch);
    this.#now = options.now ?? Date.now;
  }

  async executeIssue(
    userToken: string,
    request: IssueWriteRequest,
  ): Promise<ProviderResult> {
    const policy = issueOperationPolicy(request.operation);
    if (!policy) throw new AuthorityError("invalid_request");
    const user = await this.#json("/user", { token: userToken }, "user");
    if (user.id !== request.accountId) throw new AuthorityError("unauthorized");
    // Counted only once GitHub has proved the account, so nobody can spend
    // another person's budget by naming their account.
    await enforceLimit(this.#limits.account, `account:${request.accountId}`);
    const role = await this.#verifyUserGrant(userToken, request);
    if (!roleSatisfies(role, policy.role))
      throw new AuthorityError("permission_denied");
    await enforceLimit(
      this.#limits.installation,
      `installation:${request.repository.installationId}`,
    );

    const issued = await this.#installationToken(
      request.repository,
      ISSUE_PERMISSIONS,
    );
    const key = tokenKey(request.repository, ISSUE_PERMISSIONS);
    // Addressed by the stable ID the token is scoped to, so a rename or a
    // reused name can never move the write to another repository.
    const repository = `/repositories/${request.repository.id}`;
    if (policy.kind === "comment" && !roleSatisfies(role, "write")) {
      const issue = await this.#providerResult(
        `${repository}${request.operation.path.slice(0, -"/comments".length)}`,
        { token: issued.token },
        key,
      );
      if (issue.status !== 200) return issue;
      if (!record(issue.body) || typeof issue.body.locked !== "boolean")
        throw new AuthorityError("provider_response_invalid");
      // GitHub lets only people with write access comment on a locked conversation.
      if (issue.body.locked) throw new AuthorityError("permission_denied");
    }
    return this.#providerResult(
      `${repository}${request.operation.path}`,
      {
        token: issued.token,
        method: request.operation.method,
        ...(request.operation.body === undefined
          ? {}
          : { body: request.operation.body }),
      },
      key,
    );
  }

  async maintainerToken(
    repository: Omit<RepositoryIdentity, "installationId">,
  ): Promise<IssuedToken> {
    const jwt = await this.#jwt();
    const installation = await this.#json(
      `/repositories/${repository.id}/installation`,
      { token: jwt },
      "issuer",
    );
    if (
      !isId(installation.id) ||
      !isId(installation.app_id) ||
      installation.app_id !== this.#config.appId ||
      !record(installation.account) ||
      installation.account.id !== repository.ownerId ||
      installation.suspended_at !== null
    ) {
      throw new AuthorityError("provider_response_invalid");
    }
    return this.#installationToken(
      { ...repository, installationId: installation.id },
      MAINTAINER_PERMISSIONS,
    );
  }

  async verifyIssuer(): Promise<Record<string, unknown>> {
    const app = await this.#json(
      "/app",
      { token: await this.#jwt() },
      "issuer",
    );
    if (
      app.id !== this.#config.appId ||
      app.slug !== this.#config.appSlug ||
      !record(app.permissions)
    ) {
      throw new AuthorityError("provider_response_invalid");
    }
    return {
      appId: app.id,
      slug: app.slug,
      permissions: app.permissions,
      installationsCount: app.installations_count,
    };
  }

  /** Proves the user/App/installation/repository intersection and returns the user's role. */
  async #verifyUserGrant(
    userToken: string,
    request: IssueWriteRequest,
  ): Promise<RepositoryRole> {
    const installation = await this.#findPaged(
      "/user/installations",
      "installations",
      userToken,
      MAX_INSTALLATIONS,
      (item) => item.id === request.repository.installationId,
    );
    if (
      !installation ||
      installation.app_id !== this.#config.appId ||
      !record(installation.account) ||
      installation.account.id !== request.repository.ownerId ||
      installation.suspended_at !== null ||
      !record(installation.permissions) ||
      installation.permissions.issues !== "write"
    ) {
      throw new AuthorityError("grant_unavailable");
    }

    const repository = await this.#findPaged(
      `/user/installations/${request.repository.installationId}/repositories`,
      "repositories",
      userToken,
      MAX_REPOSITORIES,
      (item) => item.id === request.repository.id,
    );
    if (
      !repository ||
      !record(repository.owner) ||
      repository.owner.id !== request.repository.ownerId ||
      repository.full_name !== request.repository.fullName
    ) {
      throw new AuthorityError("repository_changed");
    }
    const role = repositoryRole(repository.permissions);
    if (!role) throw new AuthorityError("permission_denied");
    return role;
  }

  async #findPaged(
    path: string,
    key: "installations" | "repositories",
    token: string,
    maximum: number,
    predicate: (item: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown> | undefined> {
    let total: number | undefined;
    let seen = 0;
    for (let page = 1; page <= Math.ceil(maximum / 100); page++) {
      const value = await this.#json(
        `${path}?per_page=100&page=${page}`,
        { token },
        "user",
      );
      if (
        !Number.isSafeInteger(value.total_count) ||
        (value.total_count as number) < 0 ||
        (value.total_count as number) > maximum ||
        !Array.isArray(value[key]) ||
        value[key].length > 100 ||
        value[key].some((item) => !record(item)) ||
        (total !== undefined && total !== value.total_count)
      ) {
        throw new AuthorityError("provider_response_invalid");
      }
      total = value.total_count as number;
      const items = value[key] as Record<string, unknown>[];
      const match = items.find(predicate);
      if (match) return match;
      seen += items.length;
      if (seen === total) return undefined;
      if (seen > total || items.length !== 100)
        throw new AuthorityError("provider_response_invalid");
    }
    throw new AuthorityError("provider_response_invalid");
  }

  async #installationToken(
    repository: RepositoryIdentity,
    permissions: Permissions,
  ): Promise<IssuedToken> {
    const key = tokenKey(repository, permissions);
    const cached = this.#tokens.take(key, this.#now());
    if (cached) return cached;
    const value = await this.#json(
      `/app/installations/${repository.installationId}/access_tokens`,
      {
        token: await this.#jwt(),
        method: "POST",
        body: { repository_ids: [repository.id], permissions },
      },
      "issuer",
    );
    const expiresAt =
      typeof value.expires_at === "string"
        ? Date.parse(value.expires_at)
        : Number.NaN;
    if (
      typeof value.token !== "string" ||
      !/^ghs_[A-Za-z0-9._-]{1,4096}$/.test(value.token) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.#now() ||
      expiresAt > this.#now() + 3_700_000 ||
      !record(value.permissions) ||
      !samePermissions(value.permissions, permissions) ||
      !Array.isArray(value.repositories) ||
      value.repositories.length !== 1 ||
      !record(value.repositories[0]) ||
      value.repositories[0].id !== repository.id ||
      value.repositories[0].full_name !== repository.fullName
    ) {
      throw new AuthorityError("provider_response_invalid");
    }
    const issued = {
      token: value.token,
      expiresAt: value.expires_at as string,
      installationId: repository.installationId,
    };
    this.#tokens.put(key, issued, expiresAt, this.#now());
    return issued;
  }

  async #jwt(): Promise<string> {
    const nowSeconds = Math.floor(this.#now() / 1_000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(
      JSON.stringify({
        iat: nowSeconds - 60,
        exp: nowSeconds + 540,
        iss: this.#config.appId,
      }),
    );
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "pkcs8",
        pemBytes(this.#config.privateKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
    } catch {
      throw new AuthorityError("issuer_unavailable");
    }
    const message = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(message),
    );
    return `${message}.${base64Url(new Uint8Array(signature))}`;
  }

  async #json(
    path: string,
    options: GitHubRequestOptions,
    credential: "user" | "issuer",
  ): Promise<Record<string, unknown>> {
    const response = await this.#request(path, options);
    if (!response.ok) {
      await response.body?.cancel();
      if (credential === "user") {
        if (response.status === 401) throw new AuthorityError("unauthorized");
        if (response.status === 403 || response.status === 404)
          throw new AuthorityError("grant_unavailable");
        throw new AuthorityError("provider_unavailable");
      }
      if (response.status === 401)
        throw new AuthorityError("issuer_unavailable");
      if (response.status === 403 || response.status === 404)
        throw new AuthorityError("grant_unavailable");
      throw new AuthorityError("provider_unavailable");
    }
    const value = await boundedJson(response, MAX_PROVIDER_BYTES);
    if (!record(value)) throw new AuthorityError("provider_response_invalid");
    return value;
  }

  /** GitHub's answer to a request made with a (possibly cached) installation token. */
  async #providerResult(
    path: string,
    options: GitHubRequestOptions,
    tokenKey: string,
  ): Promise<ProviderResult> {
    const response = await this.#request(path, options);
    if (response.status === 401) {
      // Only a revoked token is refused for the repository it was minted
      // for. That is the authority's failure, never the person's sign-in.
      await response.body?.cancel();
      this.#tokens.evict(tokenKey);
      throw new AuthorityError("issuer_unavailable");
    }
    const requestId = safeRequestId(
      response.headers.get("x-github-request-id"),
    );
    if (response.status === 204) {
      await response.body?.cancel();
      return { status: 204, body: null, ...(requestId ? { requestId } : {}) };
    }
    const body = await boundedJson(response, MAX_PROVIDER_BYTES);
    return {
      status: response.status,
      body,
      ...(requestId ? { requestId } : {}),
    };
  }

  async #request(
    path: string,
    options: GitHubRequestOptions,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await deadline(
        this.#fetch(`https://api.github.com${path}`, {
          method: options.method ?? "GET",
          redirect: "manual",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${options.token}`,
            "X-GitHub-Api-Version": this.#config.apiVersion,
            "User-Agent": "mochi-github-authority",
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        }),
        PROVIDER_TIMEOUT_MS,
      );
    } catch {
      throw new AuthorityError("provider_unavailable");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AuthorityError("provider_response_invalid");
    }
    return response;
  }
}

function tokenKey(
  repository: RepositoryIdentity,
  permissions: Permissions,
): string {
  const scope = Object.entries(permissions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, level]) => `${name}=${level}`)
    .join(",");
  return `${repository.installationId}:${repository.id}:${scope}`;
}

async function deadline<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("provider deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function boundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  if (!response.body) throw new AuthorityError("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes)
        throw new AuthorityError("provider_response_invalid");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw new AuthorityError("provider_response_invalid");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function pemBytes(pem: string): ArrayBuffer {
  const begin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const end = ["-----END", "PRIVATE KEY-----"].join(" ");
  const match = pem.match(
    new RegExp(
      `^${escapeRegExp(begin)}\\s+([A-Za-z0-9+/=\\s]+)\\s+${escapeRegExp(end)}\\s*$`,
    ),
  );
  if (!match?.[1]) throw new AuthorityError("issuer_unavailable");
  const raw = atob(match[1].replace(/\s/g, ""));
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function base64Url(value: string | Uint8Array): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function samePermissions(
  actual: Record<string, unknown>,
  expected: Permissions,
): boolean {
  return (
    keys(actual) === Object.keys(expected).sort().join(",") &&
    Object.entries(expected).every(([key, level]) => actual[key] === level)
  );
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9:-]{1,128}$/.test(value) ? value : undefined;
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
