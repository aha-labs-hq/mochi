import { githubCallbackPages, oauthCallbackContentSecurityPolicy } from "../oauthPage.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  GITHUB_INTEGRATION,
  GITHUB_API_VERSION,
  GITHUB_REQUEST_TIMEOUT_MS,
  GitHubConnectionError,
} from "./integration.ts";

export interface GitHubUserToken {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}
type GitHubCallbackResult =
  | { kind: "authorization"; token: GitHubUserToken }
  | { kind: "installation" };
/** One bounded loopback attempt. No ambient listener, browser automation, or credential UI. */
export class GitHubAuthorization {
  readonly authorizationUrl: string;
  readonly completion: Promise<GitHubCallbackResult>;
  readonly #server: Server;
  readonly #abort = new AbortController();
  readonly #resolve: (result: GitHubCallbackResult) => void;
  readonly #reject: (error: GitHubConnectionError) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #settled = false;
  #claimed = false;

  private constructor(oauth: GitHubOAuth, readonly installation: boolean) {
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(installation ? GITHUB_INTEGRATION.installationUrl : "https://github.com/login/oauth/authorize");
    authorize.search = new URLSearchParams(installation ? { state } : {
      client_id: GITHUB_INTEGRATION.clientId,
      redirect_uri: GITHUB_INTEGRATION.callback,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    this.authorizationUrl = authorize.href;
    const deferred = Promise.withResolvers<GitHubCallbackResult>();
    this.completion = deferred.promise;
    this.#resolve = deferred.resolve;
    this.#reject = deferred.reject;
    // Cancellation may precede the caller installing its observer; never emit an unhandled rejection.
    void this.completion.catch(() => undefined);
    const callback = new URL(GITHUB_INTEGRATION.callback);
    this.#server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000 }, (request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "close");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", `${oauthCallbackContentSecurityPolicy}; frame-ancestors 'none'`);
      response.setHeader("X-Content-Type-Options", "nosniff");
      // The one-shot response closes its own socket after flushing. Bun's
      // server.close() can truncate a large embedded page even after end's
      // callback, so release the listener only once that socket has closed.
      const delivered = new Promise<void>((resolve) => response.socket!.once("close", resolve));
      response.setTimeout(5_000, () => response.destroy());
      const finishAfterResponse = (result: GitHubCallbackResult | GitHubConnectionError) => {
        void delivered.then(() => this.#finish(result));
      };
      const rejectRequest = () => {
        response.writeHead(400).end(githubCallbackPages.rejected);
      };
      if (this.#settled || this.#claimed || request.method !== "GET"
        || request.headers.host !== callback.host || request.headers.origin
        || !request.url?.startsWith(`${callback.pathname}?`) || request.url.length > 8192) {
        rejectRequest();
        return;
      }
      const url = new URL(request.url, callback.origin);
      const params = url.searchParams;
      const received = params.get("state") ?? "";
      const stateMatches = this.installation
        ? (!params.has("state") || (params.getAll("state").length === 1 && sameSecret(received, state)))
        : (params.getAll("state").length === 1 && sameSecret(received, state));
      if (url.origin !== callback.origin || url.pathname !== callback.pathname
        || !stateMatches
        || (!this.installation && params.get("iss") !== GITHUB_INTEGRATION.authorizationIssuer)
        || (this.installation && params.has("iss") && params.get("iss") !== GITHUB_INTEGRATION.authorizationIssuer)
        || [...params.keys()].some((key) => !["code", "state", "iss", "error", "error_description", "error_uri", "installation_id", "setup_action"].includes(key))
        || [...new Set(params.keys())].some((key) => params.getAll(key).length !== 1)) {
        rejectRequest();
        return;
      }
      if (this.installation && (!/^\d{1,20}$/.test(params.get("installation_id") ?? "")
        || !["install", "update"].includes(params.get("setup_action") ?? ""))) {
        rejectRequest();
        return;
      }
      if (params.has("error")) {
        this.#claimed = true;
        response.end(githubCallbackPages.rejected);
        finishAfterResponse(new GitHubConnectionError("authorization_denied"));
        return;
      }
      if (this.installation) {
        // Installation callbacks do not carry our PKCE challenge. Treat even a
        // state-less callback only as a request to recheck the EXISTING grant;
        // never redeem its code or trust its installation/account identity.
        this.#claimed = true;
        response.end(githubCallbackPages.installation);
        finishAfterResponse({ kind: "installation" });
        return;
      }
      const code = params.get("code");
      if (!code || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) {
        rejectRequest();
        finishAfterResponse(new GitHubConnectionError("authorization_invalid"));
        return;
      }
      this.#claimed = true;
      response.end(githubCallbackPages.received);
      void oauth.exchange(code, verifier, this.#abort.signal).then(
        (token) => finishAfterResponse({ kind: "authorization", token }),
        (error: unknown) => finishAfterResponse(connectionError(error)),
      );
    });
    this.#server.on("clientError", (_error, socket) => socket.destroy());
  }

  static async start(oauth: GitHubOAuth): Promise<GitHubAuthorization> {
    return this.#start(oauth, false);
  }

  static async startInstallation(oauth: GitHubOAuth): Promise<GitHubAuthorization> {
    return this.#start(oauth, true);
  }

  static async #start(oauth: GitHubOAuth, installation: boolean): Promise<GitHubAuthorization> {
    oauth.assertConfigured();
    const attempt = new GitHubAuthorization(oauth, installation);
    const callback = new URL(GITHUB_INTEGRATION.callback);
    try {
      await new Promise<void>((resolve, reject) => {
        attempt.#server.once("error", reject);
        attempt.#server.listen(Number(callback.port), callback.hostname, () => {
          attempt.#server.off("error", reject);
          resolve();
        });
      });
    } catch {
      attempt.#finish(new GitHubConnectionError("callback_unavailable"));
      throw new GitHubConnectionError("callback_unavailable");
    }
    attempt.#server.on("error", () => attempt.#finish(new GitHubConnectionError("callback_unavailable")));
    attempt.#timer = setTimeout(() => attempt.#finish(new GitHubConnectionError("authorization_expired")), 10 * 60_000);
    attempt.#timer.unref();
    return attempt;
  }

  cancel(): void {
    this.#finish(new GitHubConnectionError("authorization_cancelled"));
  }

  #finish(result: GitHubCallbackResult | GitHubConnectionError): void {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timer);
    this.#abort.abort();
    this.#server.close();
    if (result instanceof GitHubConnectionError) this.#reject(result);
    else this.#resolve(result);
  }
}

/** Native public-client secret is distinct from the issuer's never-distributed RSA key. */
export class GitHubOAuth {
  readonly #clientSecret: string | undefined;
  constructor(
    clientSecret: string | undefined,
    readonly fetchImplementation: typeof fetch = fetch,
    readonly now: () => number = Date.now,
  ) { this.#clientSecret = clientSecret; }

  assertConfigured(): void {
    this.#configuredSecret();
  }

  #configuredSecret(): string {
    if (!this.#clientSecret || !/^[A-Za-z0-9_]{20,256}$/.test(this.#clientSecret)) {
      throw new GitHubConnectionError("issuer_not_configured");
    }
    return this.#clientSecret;
  }

  exchange(code: string, verifier: string, signal: AbortSignal): Promise<GitHubUserToken> {
    return this.#token({ code, code_verifier: verifier, redirect_uri: GITHUB_INTEGRATION.callback }, signal);
  }

  refresh(token: GitHubUserToken, signal: AbortSignal): Promise<GitHubUserToken> {
    if (token.refreshExpiresAt <= this.now()) throw new GitHubConnectionError("sign_in_required");
    return this.#token({ grant_type: "refresh_token", refresh_token: token.refreshToken }, signal);
  }

  /** GitHub owns the repository-ID boundary, including a concurrent name reuse.
   * The parent token is only used for identity/catalog/rotation. A data request
   * receives a fresh single-repository capability, never that broad parent token.
   * No cache or durable copy of the derived token is retained.
   */
  async repositoryReadToken(token: GitHubUserToken, accountId: number, ownerId: number, repositoryId: number,
    signal: AbortSignal): Promise<string> {
    const permissions = {
      metadata: "read", issues: "read", contents: "read", pull_requests: "read",
      actions: "read", checks: "read", statuses: "read",
    };
    let response: Response;
    try {
      response = await this.fetchImplementation(`https://api.github.com/applications/${GITHUB_INTEGRATION.clientId}/token/scoped`, {
        method: "POST", redirect: "error",
        headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${GITHUB_INTEGRATION.clientId}:${this.#configuredSecret()}`).toString("base64")}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "mochi" },
        body: JSON.stringify({ access_token: token.accessToken, target_id: ownerId, repository_ids: [repositoryId], permissions }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)]),
      });
    } catch { throw new GitHubConnectionError("provider_unavailable"); }
    if (!response.ok) {
      void response.body?.cancel();
      throw new GitHubConnectionError(response.status === 401 ? "sign_in_required" : "grant_unavailable");
    }
    const value = await boundedGitHubValue(response);
    if (!isRecord(value) || typeof value.token !== "string" || !/^ghu_[A-Za-z0-9_]{1,2048}$/.test(value.token)
      || value.token === token.accessToken || !isRecord(value.app) || value.app.client_id !== GITHUB_INTEGRATION.clientId
      || !isRecord(value.user) || value.user.id !== accountId || !isRecord(value.installation)
      || !isRecord(value.installation.account) || value.installation.account.id !== ownerId
      || !Array.isArray(value.scopes) || value.scopes.length !== 0
      || value.installation.repository_selection !== "selected" || !isRecord(value.installation.permissions)
      || value.installation.permissions.metadata !== "read" || value.installation.permissions.issues !== "read"
      || Object.entries(value.installation.permissions).some(([key, level]) =>
        !(key in permissions) || permissions[key as keyof typeof permissions] !== level)) {
      throw new GitHubConnectionError("provider_response_invalid");
    }
    return value.token;
  }

  async #token(fields: Record<string, string>, signal: AbortSignal): Promise<GitHubUserToken> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await this.fetchImplementation("https://github.com/login/oauth/access_token", {
        method: "POST",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: GITHUB_INTEGRATION.clientId, client_secret: this.#configuredSecret(), ...fields }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)]),
      });
    } catch {
      throw new GitHubConnectionError(signal.aborted ? "authorization_cancelled" : "provider_unavailable");
    }
    if (!response.ok) {
      void response.body?.cancel();
      throw new GitHubConnectionError(response.status < 500 ? "authorization_invalid" : "provider_unavailable");
    }
    const data = await boundedGitHubJson(response);
    if (data.error === "bad_refresh_token") throw new GitHubConnectionError("sign_in_required");
    if (data.error !== undefined) throw new GitHubConnectionError("authorization_invalid");
    if (typeof data.access_token !== "string" || !/^ghu_[A-Za-z0-9_]{1,252}$/.test(data.access_token)
      || typeof data.refresh_token !== "string" || !/^ghr_[A-Za-z0-9_]{1,252}$/.test(data.refresh_token)
      || data.token_type !== "bearer" || data.scope !== ""
      || !positiveSeconds(data.expires_in, 28_800) || !positiveSeconds(data.refresh_token_expires_in, 15_897_600)) {
      throw new GitHubConnectionError("provider_response_invalid");
    }
    return {
      accessToken: data.access_token,
      accessExpiresAt: this.now() + data.expires_in * 1000,
      refreshToken: data.refresh_token,
      refreshExpiresAt: this.now() + data.refresh_token_expires_in * 1000,
    };
  }
}

export async function boundedGitHubJson(response: Response, maximumBytes = 2_000_000): Promise<Record<string, unknown>> {
  const value = await boundedGitHubValue(response, maximumBytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubConnectionError("provider_response_invalid");
  }
  return value as Record<string, unknown>;
}

export async function boundedGitHubValue(response: Response, maximumBytes = 2_000_000): Promise<unknown> {
  if (!response.body) throw new GitHubConnectionError("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw new GitHubConnectionError("provider_response_invalid");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GitHubConnectionError("provider_response_invalid");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function positiveSeconds(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function connectionError(error: unknown): GitHubConnectionError {
  return error instanceof GitHubConnectionError ? error : new GitHubConnectionError("provider_unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
