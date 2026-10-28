import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubConnection } from "../src/github/connection.ts";
import { GitHubClient } from "../src/github/client.ts";
import { GitHubFileCredentialStore, type GitHubCredential, type GitHubCredentialStore } from "../src/github/credentials.ts";
import { GITHUB_INTEGRATION } from "../src/github/integration.ts";
import { GitHubRequestError } from "../src/github/requestError.ts";
import { GitHubAuthorization, GitHubOAuth } from "../src/github/oauth.ts";
import { parseGitHubProjects, parseGitHubScope, type GitHubRepositoryScope } from "../src/github/repository.ts";
import { GitHubWriteAuthority } from "../src/github/writeAuthority.ts";

const CLIENT_SECRET = "fixture_native_client_secret";
const NOW = 1_800_000_000_000;
const ISSUER_QUERY = `&iss=${encodeURIComponent(GITHUB_INTEGRATION.authorizationIssuer)}`;
const tokenResponse = {
  access_token: "ghu_fixture", refresh_token: "ghr_fixture", token_type: "bearer", scope: "",
  expires_in: 28_800, refresh_token_expires_in: 15_897_600,
};
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function credential(): GitHubCredential {
  // The shared credential proves the account and the rotating token. A project
  // selection is per Bot and lives in that Bot's own state, never here.
  return { version: 2, account: { id: 1, login: "customer" }, grantId: "a".repeat(32),
    token: { accessToken: "ghu_fixture", refreshToken: "ghr_fixture",
      accessExpiresAt: NOW + 28_800_000, refreshExpiresAt: NOW + 15_897_600_000 },
  };
}
class MemoryStore implements GitHubCredentialStore {
  value: GitHubCredential | undefined = credential();
  writes = 0;
  read() { return structuredClone(this.value); }
  write(value: GitHubCredential) { this.value = structuredClone(value); this.writes++; }
  clear() { this.value = undefined; }
}
function remote() {
  const installation = { id: 30, app_id: GITHUB_INTEGRATION.appId, account: { id: 10 }, suspended_at: null,
    permissions: { metadata: "read", contents: "read", issues: "write" } };
  const repositories = [
    { id: 20, owner: { id: 10 }, full_name: "customer/selected", private: true,
      permissions: { pull: true, push: true } },
    { id: 21, owner: { id: 10 }, full_name: "customer/other", private: true,
      permissions: { pull: true, push: false } },
  ];
  const calls: { url: string; method: string; body: string; authorization: string | null; redirect?: RequestRedirect }[] = [];
  const state = { installation, repositories, invalidCount: false, status: 200, refreshes: 0 };
  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? ""), authorization, ...(init?.redirect ? { redirect: init.redirect } : {}) });
    if (url.endsWith("/login/oauth/access_token")) {
      state.refreshes++;
      return Response.json({ ...tokenResponse, access_token: `ghu_rotated${state.refreshes}`, refresh_token: `ghr_rotated${state.refreshes}` });
    }
    if (state.status !== 200) return Response.json({ message: "private provider error" }, { status: state.status });
    const path = new URL(url).pathname;
    if (path === "/user") return Response.json({ id: 1, login: "customer", email: "must-not-escape@example.test" });
    if (path === "/user/installations") return Response.json({ total_count: 1, installations: [state.installation] });
    if (path === `/user/installations/${state.installation.id}/repositories`) return Response.json({
      total_count: state.repositories.length + (state.invalidCount ? 1 : 0), repositories: state.repositories,
    });
    if (path === `/applications/${GITHUB_INTEGRATION.clientId}/token/scoped`) {
      const input = JSON.parse(String(init?.body));
      return Response.json({ token: "ghu_scoped_fixture", app: { client_id: GITHUB_INTEGRATION.clientId },
        user: { id: 1 }, scopes: [], installation: { account: { id: input.target_id },
          permissions: input.permissions, repository_selection: "selected" } });
    }
    if (url === `${GITHUB_INTEGRATION.authorityUrl}/v1/issues` && init?.method === "POST") {
      const input = JSON.parse(String(init.body));
      if (authorization !== "Bearer ghu_fixture" || input.accountId !== 1
        || JSON.stringify(input.repository) !== JSON.stringify({ id: 20, ownerId: 10, installationId: 30, fullName: "customer/selected" })
        || input.operation.path !== "/issues") throw new Error("Invalid authority request");
      return Response.json({ number: 42, html_url: "https://github.com/customer/selected/issues/42", user: { login: "mochi-companion[bot]" } }, { status: 201 });
    }
    if (path === "/repos/customer/selected") return Response.json(state.repositories[0]);
    if (path === "/repos/customer/selected/issues" && init?.method === "POST") return Response.json({ number: 42, html_url: "https://github.com/customer/selected/issues/42" }, { status: 201 });
    if (path === "/search/code") return Response.json({ items: [{ repository: { id: state.repositories[0]!.id } }] });
    throw new Error("Unexpected provider endpoint");
  }) as unknown as typeof fetch;
  return { state, calls, fetchImplementation };
}
/**
 * The scope one Bot would hand to a capability: its own selection identity plus
 * the repository facts the provider proved in its catalog.
 */
async function scopeFor(connection: GitHubConnection, repositoryId: number): Promise<GitHubRepositoryScope> {
  const authority = connection.authority();
  const project = (await connection.catalog()).find((candidate) => candidate.id === repositoryId);
  if (!project) throw new Error(`Fixture has no repository ${repositoryId}`);
  return { accountId: authority.accountId, grantId: authority.grantId, repositoryId,
    ownerId: project.ownerId, installationId: project.installationId, selectionId: "b".repeat(32) };
}

function connection(store = new MemoryStore(), provider = remote()) {
  const result = new GitHubConnection({ store, oauth: new GitHubOAuth(CLIENT_SECRET, provider.fetchImplementation, () => NOW),
    writeAuthority: new GitHubWriteAuthority(provider.fetchImplementation) });
  cleanup.push(() => result.close());
  return { connection: result, store, provider };
}

describe("GitHub native OAuth", () => {
  test("catalog reads cannot turn a never-connected account into a revoked grant", async () => {
    const store = new MemoryStore();
    store.clear();
    const f = connection(store);
    await expect(f.connection.catalog()).rejects.toThrow("sign_in_required");
    expect(f.connection.snapshot()).toEqual({ status: "disconnected", account: null, problem: null });
    expect(f.provider.calls).toHaveLength(0);
  });
  test("restores the saved grant with one provider proof, and a credentialless deployment proves nothing", async () => {
    const f = connection();
    expect(f.connection.snapshot()).toEqual({ status: "connected", account: { id: 1, login: "customer" }, problem: null });
    const catalog = await f.connection.restore();
    expect(catalog.map((project) => [project.fullName, project.canWriteIssues]))
      .toEqual([["customer/other", true], ["customer/selected", true]]);
    expect(f.provider.calls.some((call) => call.url.includes("oauth"))).toBe(false);
    const empty = new MemoryStore(); empty.value = undefined;
    const fresh = connection(empty);
    expect(await fresh.connection.restore()).toEqual([]);
    expect(fresh.provider.calls).toHaveLength(0);
  });

  test("reads use a single-repository user capability while Issue writes use the App authority", async () => {
    const f = connection();
    const access = await f.connection.repositoryAccess(await scopeFor(f.connection, 20));
    await access.request("/repos/customer/selected", "GET");
    await access.request("/repos/customer/selected/issues", "POST", { title: "fixture" });
    const scopes = f.provider.calls.filter((call) => call.url.endsWith("/token/scoped"));
    expect(scopes).toHaveLength(1);
    for (const call of scopes) {
      expect(call.authorization).toStartWith("Basic ");
      expect(JSON.parse(call.body)).toMatchObject({ target_id: 10, repository_ids: [20], access_token: "ghu_fixture" });
    }
    const readPermissions = JSON.parse(scopes[0]!.body).permissions;
    expect(Object.values(readPermissions).every((permission) => permission === "read")).toBe(true);
    const authority = f.provider.calls.filter((call) => call.url === `${GITHUB_INTEGRATION.authorityUrl}/v1/issues`);
    expect(authority).toHaveLength(1);
    expect(authority[0]?.authorization).toBe("Bearer ghu_fixture");
    expect(JSON.parse(authority[0]!.body).operation).toEqual({ method: "POST", path: "/issues", body: { title: "fixture" } });
    expect(f.provider.calls.filter((call) => call.url === "https://api.github.com/repos/customer/selected").map((call) => call.authorization))
      .toEqual(["Bearer ghu_scoped_fixture"]);
    expect(f.store.value?.token.accessToken).toBe("ghu_fixture");
  });

  test("a malformed scoped capability cannot reach any repository request", async () => {
    const provider = remote();
    const original = provider.fetchImplementation;
    provider.fetchImplementation = (async (url: string, init?: RequestInit) => {
      const response = await original(url, init);
      if (String(url).endsWith("/token/scoped")) {
        const value = await response.json() as { installation: { permissions: Record<string, string> } };
        value.installation.permissions.administration = "write";
        return Response.json(value);
      }
      return response;
    }) as unknown as typeof fetch;
    const f = connection(new MemoryStore(), provider);
    const access = await f.connection.repositoryAccess(await scopeFor(f.connection, 20));
    await expect(access.request("/repos/customer/selected", "GET")).rejects.toThrow("provider_response_invalid");
    expect(provider.calls.some((call) => call.url === `${GITHUB_INTEGRATION.authorityUrl}/v1/issues`)).toBe(false);
  });
  test("a setup-to-duty presentation handoff preserves the same authorization and publishes only to the new observer", async () => {
    const store = new MemoryStore();
    store.value = undefined;
    const fixture = connection(store);
    const first: string[] = [];
    const unsubscribe = fixture.connection.subscribe((snapshot) => first.push(snapshot.status));
    const { authorizationUrl } = await fixture.connection.startAuthorization();
    unsubscribe();
    const completed = Promise.withResolvers<void>();
    const second: string[] = [];
    fixture.connection.subscribe((snapshot) => {
      second.push(snapshot.status);
      if (snapshot.status === "connected") completed.resolve();
    });
    const state = new URL(authorizationUrl).searchParams.get("state");
    await fetch(`${GITHUB_INTEGRATION.callback}?code=fixture&state=${state}${ISSUER_QUERY}`);
    await completed.promise;
    expect(first).toEqual(["authorizing"]);
    expect(second).toEqual(["connected"]);
    expect(store.writes).toBe(1);
    expect(store.read()?.account).toEqual({ id: 1, login: "customer" });
  });
  test("binds the registered loopback callback and redeems a single state-bound S256 code", async () => {
    const provider = remote();
    const oauth = new GitHubOAuth(CLIENT_SECRET, provider.fetchImplementation, () => NOW);
    const attempt = await GitHubAuthorization.start(oauth);
    cleanup.push(() => attempt.cancel());
    const url = new URL(attempt.authorizationUrl);
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("redirect_uri")).toBe(GITHUB_INTEGRATION.callback);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(attempt.authorizationUrl).not.toContain(CLIENT_SECRET);
    const response = await fetch(`${GITHUB_INTEGRATION.callback}?code=fixture&state=${url.searchParams.get("state")}${ISSUER_QUERY}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const page = await response.text();
    expect(page).toContain("GitHub 授权已收到，可以回到 Mochi 了");
    expect(page).toContain('history.replaceState(null, "", location.pathname)');
    expect(page).not.toContain("fixture");
    const token = await attempt.completion;
    expect(token).toMatchObject({ kind: "authorization", token: { accessToken: "ghu_rotated1" } });
    const call = provider.calls[0];
    const body = new URLSearchParams(call?.body);
    expect(body.get("redirect_uri")).toBe(GITHUB_INTEGRATION.callback);
    expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url"))
      .toBe(url.searchParams.get("code_challenge") ?? "");
    expect(call?.redirect).toBe("error");
    expect(provider.calls).toHaveLength(1);
  });

  test("installation notifications never redeem a code, even without state or issuer", async () => {
    const provider = remote();
    const oauth = new GitHubOAuth(CLIENT_SECRET, provider.fetchImplementation, () => NOW);
    for (const suffix of ["&code=attacker-code", ""]) {
      const attempt = await GitHubAuthorization.startInstallation(oauth);
      cleanup.push(() => attempt.cancel());
      const url = new URL(attempt.authorizationUrl);
      expect(url.pathname).toBe("/apps/mochi-companion/installations/new");
      expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      const response = await fetch(`${GITHUB_INTEGRATION.callback}?installation_id=99999&setup_action=install${suffix}`);
      expect(response.status).toBe(200);
      const page = await response.text();
      expect(page).toContain("Mochi 会重新核对 GitHub 项目权限");
      expect(page).not.toContain("attacker-code");
      expect(await attempt.completion).toEqual({ kind: "installation" });
      expect(provider.calls).toHaveLength(0);
    }
    const attempt = await GitHubAuthorization.startInstallation(oauth);
    cleanup.push(() => attempt.cancel());
    for (const query of [
      "installation_id=not-a-number&setup_action=install",
      "installation_id=12345&setup_action=delete",
      "installation_id=12345&setup_action=install&state=forged",
      "installation_id=12345&setup_action=install&iss=https://example.test",
      "installation_id=12345&setup_action=install&installation_id=54321",
    ]) {
      expect((await fetch(`${GITHUB_INTEGRATION.callback}?${query}`)).status).toBe(400);
      expect(provider.calls).toHaveLength(0);
    }
    const state = new URL(attempt.authorizationUrl).searchParams.get("state");
    const response = await fetch(`${GITHUB_INTEGRATION.callback}?installation_id=12345&setup_action=update&state=${state}`);
    expect(response.status).toBe(200);
    await response.text();
    expect(await attempt.completion).toEqual({ kind: "installation" });
  });

  test("installation return rechecks the saved grant without replacing its account or selection identity", async () => {
    const f = connection();
    const before = f.store.read();
    const scope = await scopeFor(f.connection, 20);
    const completed = Promise.withResolvers<void>();
    f.connection.subscribe((snapshot) => {
      if (snapshot.status === "connected") completed.resolve();
    });
    await f.connection.startInstallation();
    const response = await fetch(`${GITHUB_INTEGRATION.callback}?code=attacker-code&installation_id=99999&setup_action=install`);
    await response.text();
    await completed.promise;
    expect(f.store.read()).toEqual(before);
    expect(f.store.writes).toBe(0);
    expect(f.provider.calls.some((call) => call.url.includes("oauth"))).toBe(false);
    expect(f.provider.calls.filter((call) => call.url.includes("/user/installations")).every(
      (call) => call.authorization === "Bearer ghu_fixture" && !call.url.includes("99999"),
    )).toBe(true);
    expect((await f.connection.verifyRepository(scope, false)).id).toBe(20);
  });

  test("installation requires an existing login and cannot hide a revoked grant", async () => {
    const store = new MemoryStore();
    store.clear();
    const fresh = connection(store);
    await expect(fresh.connection.startInstallation()).rejects.toThrow("sign_in_required");
    expect(fresh.provider.calls).toHaveLength(0);
    const f = connection();
    const failed = Promise.withResolvers<void>();
    f.connection.subscribe((snapshot) => {
      if (snapshot.status === "unavailable") failed.resolve();
    });
    await f.connection.startInstallation();
    f.provider.state.status = 401;
    const response = await fetch(`${GITHUB_INTEGRATION.callback}?installation_id=30&setup_action=update`);
    await response.text();
    await failed.promise;
    expect(f.connection.snapshot().problem).toBe("sign_in_required");
    expect(f.store.writes).toBe(0);
    expect(f.provider.calls.some((call) => call.url.includes("oauth"))).toBe(false);
  });

  test("rejects forged state without exchanging a code", async () => {
    const provider = remote();
    const attempt = await GitHubAuthorization.start(new GitHubOAuth(CLIENT_SECRET, provider.fetchImplementation));
    cleanup.push(() => attempt.cancel());
    expect((await fetch(`${GITHUB_INTEGRATION.callback}?code=private-code&state=forged${ISSUER_QUERY}`)).status).toBe(400);
    expect(provider.calls).toHaveLength(0);
    const state = new URL(attempt.authorizationUrl).searchParams.get("state");
    expect((await fetch(`${GITHUB_INTEGRATION.callback}?code=valid&state=${state}${ISSUER_QUERY}`)).status).toBe(200);
    expect(await attempt.completion).toMatchObject({ kind: "authorization", token: { accessToken: "ghu_rotated1" } });
  });

  test("requires the observed GitHub issuer and rejects missing, forged or repeated issuer claims", async () => {
    const provider = remote();
    const attempt = await GitHubAuthorization.start(new GitHubOAuth(CLIENT_SECRET, provider.fetchImplementation));
    cleanup.push(() => attempt.cancel());
    const state = new URL(attempt.authorizationUrl).searchParams.get("state");
    const callback = `${GITHUB_INTEGRATION.callback}?code=fixture&state=${state}`;
    for (const suffix of ["", "&iss=https%3A%2F%2Fexample.test", `${ISSUER_QUERY}${ISSUER_QUERY}`,
      `${ISSUER_QUERY}%2F`, `${ISSUER_QUERY}&unexpected=value`]) {
      expect((await fetch(callback + suffix)).status).toBe(400);
      expect(provider.calls).toHaveLength(0);
    }
    expect((await fetch(callback + ISSUER_QUERY)).status).toBe(200);
    expect(await attempt.completion).toMatchObject({ kind: "authorization", token: { accessToken: "ghu_rotated1" } });
    expect(provider.calls).toHaveLength(1);
  });

  test("cancellation terminates the attempt, and a subsequent attempt gets fresh state", async () => {
    const oauth = new GitHubOAuth(CLIENT_SECRET, remote().fetchImplementation);
    const first = await GitHubAuthorization.start(oauth);
    first.cancel();
    await expect(first.completion).rejects.toThrow("authorization_cancelled");
    const next = await GitHubAuthorization.start(oauth);
    cleanup.push(() => next.cancel());
    expect(next.authorizationUrl).not.toBe(first.authorizationUrl);
  });

  test("reports an occupied callback port instead of choosing an unregistered port", async () => {
    const oauth = new GitHubOAuth(CLIENT_SECRET, remote().fetchImplementation);
    const first = await GitHubAuthorization.start(oauth);
    cleanup.push(() => first.cancel());
    await expect(GitHubAuthorization.start(oauth)).rejects.toThrow("callback_unavailable");
  });

  test("missing issuer configuration never starts a fake authorization", async () => {
    await expect(GitHubAuthorization.start(new GitHubOAuth(""))).rejects.toThrow("issuer_not_configured");
  });

  test("rejects nonexpiring, malformed and unexpected token responses without leaking bodies", async () => {
    for (const response of [
      { ...tokenResponse, expires_in: undefined },
      { ...tokenResponse, expires_in: 0 },
      { ...tokenResponse, access_token: "ghs_not_a_user_token" },
      { ...tokenResponse, scope: "repo" },
      { error: "bad_verification_code", error_description: "private-code-secret" },
    ]) {
      const oauth = new GitHubOAuth(CLIENT_SECRET, (async () => Response.json(response)) as unknown as typeof fetch);
      try { await oauth.exchange("code", "verifier", new AbortController().signal); throw new Error("expected rejection"); }
      catch (error) {
        expect(String(error)).not.toContain("private-code-secret");
        expect(String(error)).toMatch(/provider_response_invalid|authorization_invalid/);
      }
    }
  });
});
describe("GitHub grant authorization", () => {
  test("search cannot conceal a foreign repository by projecting away its metadata", async () => {
    const provider = remote();
    const original = provider.fetchImplementation;
    provider.fetchImplementation = (async (url, init) => new URL(String(url)).pathname === "/search/code"
      ? Response.json({ items: [{ name: "file.ts", path: "file.ts", repository: { id: 999 } }] })
      : original(url, init)) as typeof fetch;
    const f = connection(new MemoryStore(), provider);
    const client = new GitHubClient(await f.connection.repositoryAccess(await scopeFor(f.connection, 20)));
    await expect(client.searchCode({ query: "symbol", limit: 10 })).rejects.toThrow("repository_changed");
    expect(f.connection.snapshot()).toMatchObject({
      status: "connected",
      account: { id: 1, login: "customer" },
      problem: null,
    });
  });

  test("resource failures remain local; subsequent reads re-prove the same grant without a sign-in cascade", async () => {
    for (const status of [400, 403, 404, 409, 422, 429, 500]) {
      const provider = remote();
      const original = provider.fetchImplementation;
      provider.fetchImplementation = (async (url, init) => {
        if (new URL(String(url)).pathname === "/repos/customer/selected/contents/missing.ts") {
          return Response.json({ message: "private provider body" }, {
            status, headers: { "x-github-request-id": "ABC:123:DEF" },
          });
        }
        return original(url, init);
      }) as typeof fetch;
      const f = connection(new MemoryStore(), provider);
      const before = f.connection.snapshot();
      const scope = await scopeFor(f.connection, 20);
      const access = await f.connection.repositoryAccess(scope);
      let caught: unknown;
      try { await access.request("/repos/customer/selected/contents/missing.ts", "GET"); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(GitHubRequestError);
      expect(caught).toMatchObject({ status, requestId: "ABC:123:DEF" });
      expect(String(caught)).not.toContain("private provider body");
      // A missing resource is not a credential event: the grant is unchanged.
      expect(f.connection.snapshot()).toEqual(before);
      provider.calls.length = 0;
      expect(await access.request("/repos/customer/selected", "GET")).toMatchObject({ id: 20 });
      expect(provider.calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/user/installations", "/user/installations/30/repositories",
        `/applications/${GITHUB_INTEGRATION.clientId}/token/scoped`, "/repos/customer/selected",
      ]);
      provider.state.repositories = [];
      await expect(access.request("/repos/customer/selected", "GET")).rejects.toThrow("repository_changed");
      expect(f.connection.snapshot()).toEqual(before);
    }
  });

  test("a refused write keeps GitHub's sanitized reason, while a server failure stays opaque", async () => {
    const rejection = {
      message: "Validation Failed: token ghu_redactme00000000",
      errors: [{ resource: "Issue", field: "title", code: "missing_field" }],
    };
    for (const [status, reason] of [
      [422, { message: "Validation Failed: token [redacted]", errors: rejection.errors }],
      [500, undefined],
    ] as const) {
      const provider = remote();
      const original = provider.fetchImplementation;
      provider.fetchImplementation = (async (url, init) => String(url) === `${GITHUB_INTEGRATION.authorityUrl}/v1/issues`
        ? Response.json(rejection, { status })
        : original(url, init)) as typeof fetch;
      const f = connection(new MemoryStore(), provider);
      const access = await f.connection.repositoryAccess(await scopeFor(f.connection, 20));
      let caught: unknown;
      try { await access.request("/repos/customer/selected/issues", "POST", { title: "" }); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(GitHubRequestError);
      expect(caught).toMatchObject({ status });
      expect((caught as GitHubRequestError).reason).toEqual(reason);
      expect(String(caught)).not.toContain("redactme");
    }
  });

  test("a repository 401 invalidates the grant, while a catalog 404 remains a grant failure", async () => {
    const provider = remote();
    const original = provider.fetchImplementation;
    provider.fetchImplementation = (async (url, init) => String(url).includes("/repos/")
      ? new Response(null, { status: 401 }) : original(url, init)) as typeof fetch;
    const f = connection(new MemoryStore(), provider);
    const access = await f.connection.repositoryAccess(await scopeFor(f.connection, 20));
    await expect(access.request("/repos/customer/selected", "GET")).rejects.toThrow("sign_in_required");
    expect(f.connection.snapshot()).toMatchObject({ problem: "sign_in_required" });

    const catalog = connection();
    catalog.provider.state.status = 404;
    await expect(catalog.connection.catalog()).rejects.toThrow("grant_unavailable");
  });

  test("a scoped capability sends only the proven repository request and validates search result identity", async () => {
    const fixture = connection();
    const access = await fixture.connection.repositoryAccess(await scopeFor(fixture.connection, 20));
    expect(await access.request("/repos/customer/selected", "GET")).toMatchObject({ id: 20 });
    expect(await access.request("/repos/customer/selected/issues", "POST", { title: "Fixture" })).toMatchObject({ number: 42 });
    expect(fixture.provider.calls.at(-1)).toMatchObject({ method: "POST", authorization: "Bearer ghu_fixture", redirect: "error" });
    expect(JSON.parse(fixture.provider.calls.at(-1)!.body).operation).toEqual({ method: "POST", path: "/issues", body: { title: "Fixture" } });
    expect(await access.request("/search/code?q=term+repo%3Acustomer%2Fselected", "GET")).toMatchObject({ items: [{ repository: { id: 20 } }] });
  });

  test("the catalog is the verified app/user intersection and carries no selection decision", async () => {
    const fixture = connection();
    const catalog = await fixture.connection.catalog();
    expect(catalog.map((project) => [project.fullName, project.canWriteIssues]))
      .toEqual([["customer/other", true], ["customer/selected", true]]);
    expect(JSON.stringify(fixture.connection.snapshot())).not.toMatch(/ghu_|ghr_|example.test/);
    expect(fixture.provider.calls.every((call) => call.redirect === "error")).toBe(true);
  });

  test("a replacement installation cannot inherit the previous installation's scope", async () => {
    const fixture = connection();
    const scope = await scopeFor(fixture.connection, 20);
    fixture.provider.state.installation.id = 31;
    // The scope names installation 30, which the live grant no longer proves.
    await expect(fixture.connection.verifyRepository(scope, true)).rejects.toThrow("repository_changed");
    // Re-proving the catalog replaces the failed grant proof, so the Bot can then
    // derive a scope against the installation that actually exists now.
    await fixture.connection.catalog();
    const fresh = await scopeFor(fixture.connection, 20);
    expect(fresh.installationId).toBe(31);
    await expect(fixture.connection.verifyRepository(fresh, true)).resolves.toMatchObject({ installationId: 31 });
    await expect(fixture.connection.verifyRepository(scope, true)).rejects.toThrow("repository_changed");
  });

  test("rename follows the same stable repository identity", async () => {
    const fixture = connection();
    const scope = await scopeFor(fixture.connection, 20);
    fixture.provider.state.repositories[0]!.full_name = "customer/renamed";
    expect((await fixture.connection.verifyRepository(scope, true)).fullName).toBe("customer/renamed");
  });

  test("name reuse cannot turn an old scope into a different repository", async () => {
    const fixture = connection();
    const scope = await scopeFor(fixture.connection, 20);
    fixture.provider.state.repositories[0]!.id = 99;
    await expect(fixture.connection.verifyRepository(scope, true)).rejects.toThrow("repository_changed");
  });

  test("a read role opens Issues, while operations needing triage are refused before anything is sent", async () => {
    const fixture = connection();
    fixture.provider.state.repositories[0]!.permissions = { pull: true, push: false };
    const scope = await scopeFor(fixture.connection, 20);
    await expect(fixture.connection.verifyRepository(scope, true)).resolves.toMatchObject({ id: 20, canWriteIssues: true });
    const access = await fixture.connection.repositoryAccess(scope);
    expect(await access.request("/repos/customer/selected/issues", "POST", { title: "Fixture" })).toMatchObject({ number: 42 });
    const sent = fixture.provider.calls.length;
    for (const [path, method, body] of [
      ["/repos/customer/selected/issues/42", "PATCH", { state: "closed" }],
      ["/repos/customer/selected/issues", "POST", { title: "Fixture", labels: ["bug"] }],
      ["/repos/customer/selected/issues/42/assignees", "POST", { assignees: ["customer"] }],
    ] as const) {
      await expect(access.request(path, method, body)).rejects.toMatchObject({ code: "permission_denied", status: 403 });
    }
    expect(fixture.provider.calls.slice(sent).some((call) => call.url.startsWith(GITHUB_INTEGRATION.authorityUrl))).toBe(false);
    expect(fixture.connection.snapshot()).toMatchObject({ status: "connected", problem: null });
  });

  test("an installation that cannot write Issues grants no role an Issue write", async () => {
    const fixture = connection();
    fixture.provider.state.installation.permissions.issues = "read";
    const scope = await scopeFor(fixture.connection, 20);
    await expect(fixture.connection.verifyRepository(scope, false)).resolves.toMatchObject({ id: 20, canWriteIssues: false });
    await expect(fixture.connection.verifyRepository(scope, true)).rejects.toThrow("issue_write_not_granted");
    const access = await fixture.connection.repositoryAccess(scope);
    await expect(access.request("/repos/customer/selected/issues", "POST", { title: "Fixture" })).rejects.toThrow("issue_write_not_granted");
    expect(fixture.provider.calls.some((call) => call.url.startsWith(GITHUB_INTEGRATION.authorityUrl))).toBe(false);
    expect(fixture.connection.snapshot()).toMatchObject({
      status: "connected",
      account: { id: 1, login: "customer" },
      problem: null,
    });
  });

  test("partial inventories fail the catalog rather than returning a shorter one", async () => {
    const fixture = connection();
    await fixture.connection.catalog();
    fixture.provider.state.invalidCount = true;
    await expect(fixture.connection.catalog()).rejects.toThrow("provider_response_invalid");
    expect(fixture.connection.snapshot()).toMatchObject({ problem: "provider_response_invalid" });
  });

  test("revoked user access remains unavailable, not signed out", async () => {
    const fixture = connection();
    await fixture.connection.catalog();
    fixture.provider.state.status = 401;
    await expect(fixture.connection.catalog()).rejects.toThrow("sign_in_required");
    expect(fixture.connection.snapshot()).toMatchObject({ problem: "sign_in_required" });
  });

  test("concurrent access rotates the token once and commits both tokens together", async () => {
    const store = new MemoryStore();
    store.value!.token.accessExpiresAt = NOW - 1;
    const fixture = connection(store);
    await Promise.all([fixture.connection.catalog(), fixture.connection.catalog()]);
    expect(fixture.provider.state.refreshes).toBe(1);
    expect(store.value?.token).toMatchObject({ accessToken: "ghu_rotated1", refreshToken: "ghr_rotated1" });
    expect(store.value?.grantId).toBe("a".repeat(32));
  });

  test("a refresh GitHub never answered keeps the grant and offers the same token next time", async () => {
    for (const unanswered of [
      () => { throw new Error("private-url-secret"); },
      () => Response.json({ message: "private provider error" }, { status: 502 }),
    ]) {
      const store = new MemoryStore();
      store.value!.token.accessExpiresAt = NOW - 1;
      const provider = remote();
      const original = provider.fetchImplementation;
      const offered: (string | null)[] = [];
      provider.fetchImplementation = (async (url, init) => {
        if (String(url).endsWith("/login/oauth/access_token")) {
          offered.push(new URLSearchParams(String(init?.body)).get("refresh_token"));
          if (offered.length === 1) return unanswered();
        }
        return original(url, init);
      }) as typeof fetch;
      const f = connection(store, provider);
      await expect(f.connection.catalog()).rejects.toThrow("provider_unavailable");
      // A temporary problem on a kept account, not a request to sign in again.
      expect(f.connection.snapshot()).toEqual({ status: "unavailable", account: { id: 1, login: "customer" }, problem: "provider_unavailable" });
      expect(store.value).toMatchObject({ grantId: "a".repeat(32), token: { refreshToken: "ghr_fixture" } });
      await f.connection.catalog();
      expect(offered).toEqual(["ghr_fixture", "ghr_fixture"]);
      // The same grant survives, so every Bot's project selection does too.
      expect(store.value).toMatchObject({ grantId: "a".repeat(32), token: { refreshToken: "ghr_rotated1" } });
      expect(f.connection.snapshot()).toMatchObject({ status: "connected", problem: null });
    }
  });

  test("a refresh token GitHub refuses ends the grant, including one rotated by a lost reply", async () => {
    const store = new MemoryStore();
    store.value!.token.accessExpiresAt = NOW - 1;
    let calls = 0;
    const oauth = new GitHubOAuth(CLIENT_SECRET, (async () => {
      calls++;
      if (calls === 1) throw new Error("private-url-secret");
      return Response.json({ error: "bad_refresh_token", error_description: "private" });
    }) as unknown as typeof fetch, () => NOW);
    const value = new GitHubConnection({ store, oauth });
    cleanup.push(() => value.close());
    await expect(value.catalog()).rejects.toThrow("provider_unavailable");
    await expect(value.catalog()).rejects.toThrow("sign_in_required");
    expect(calls).toBe(2);
    expect(store.value).toBeUndefined();
    expect(value.snapshot()).toEqual({ status: "unavailable", account: null, problem: "sign_in_required" });
    await expect(value.catalog()).rejects.toThrow("sign_in_required");
    expect(calls).toBe(2);
  });

  test("disconnect durably removes the local grant without claiming a remote uninstall", async () => {
    const fixture = connection();
    await fixture.connection.disconnect();
    expect(fixture.store.value).toBeUndefined();
    expect(fixture.connection.snapshot()).toEqual({ status: "disconnected", account: null, problem: null });
    expect(fixture.provider.calls).toHaveLength(0);
  });

  test("rejects foreign endpoints, search escape and non-Issue writes before any target request", async () => {
    for (const [path, method] of [
      ["/repos/customer/other/issues", "GET"],
      ["/repos/customer/selected/../other/issues", "GET"],
      ["/repos/customer/selected/actions/runs/1/rerun", "POST"],
      ["/repos/customer/selected/pulls/1", "PATCH"],
      ["/search/code?q=repo:customer/other%20repo:customer/selected", "GET"],
      ["https://outside.invalid/repos/customer/selected", "GET"],
    ] as const) {
      const fixture = connection();
      const access = await fixture.connection.repositoryAccess(await scopeFor(fixture.connection, 20));
      await expect(access.request(path, method)).rejects.toThrow();
      expect(fixture.provider.calls.every((call) => new URL(call.url).pathname.startsWith("/user/"))).toBeTrue();
    }
  });

  test("an already-created request capability cannot survive a grant change", async () => {
    const fixture = connection();
    const access = await fixture.connection.repositoryAccess(await scopeFor(fixture.connection, 20));
    fixture.provider.state.installation.id = 31;
    await expect(access.request("/repos/customer/selected/issues", "GET")).rejects.toThrow("repository_changed");
    expect(fixture.provider.calls.every((call) => !call.url.includes("/repos/"))).toBeTrue();
  });

  test("strict renderer and audit parsers reject credentials and arbitrary addresses", async () => {
    const fixture = connection();
    const scope = await scopeFor(fixture.connection, 20);
    expect(() => parseGitHubScope({ ...scope, token: "private" })).toThrow();
    expect(() => parseGitHubProjects([{ id: 1, fullName: "https://attacker.test", ownerId: 2,
      installationId: 3, private: true, selected: true, canWriteIssues: true }])).toThrow();
  });
});

describe("GitHub credential custody", () => {
  test("explicit disconnect can remove a corrupt owned credential without reading it as a valid grant", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mochi-corrupt-credential-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "connections", "github.json");
    const store = new GitHubFileCredentialStore(path);
    store.write(credential());
    writeFileSync(path, "{incomplete");
    expect(() => store.read()).toThrow("credential_unavailable");
    store.clear();
    expect(store.read()).toBeUndefined();
    store.write(credential());
    expect(store.read()?.account.id).toBe(1);
  });
  function fixture() {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-github-credentials-")));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    return { directory, store: new GitHubFileCredentialStore(join(directory, "github.json")) };
  }
  test("persists an atomic private record and round trips without a terminal or keychain command", () => {
    const { directory, store } = fixture();
    expect(store.read()).toBeUndefined();
    store.write(credential());
    expect(store.read()).toEqual(credential());
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(store.path).mode & 0o777).toBe(0o600);
    store.clear();
    expect(store.read()).toBeUndefined();
  });
  test("rejects symlink and loose permissions instead of repairing them silently", () => {
    const { directory, store } = fixture();
    const target = join(directory, "unrelated.json");
    writeFileSync(target, "untouched", { mode: 0o600 });
    symlinkSync(target, store.path);
    expect(() => store.write(credential())).toThrow("credential_unavailable");
    expect(readFileSync(target, "utf8")).toBe("untouched");
    const other = fixture().store;
    other.write(credential());
    chmodSync(other.path, 0o644);
    expect(() => other.read()).toThrow("credential_unavailable");
  });
});
