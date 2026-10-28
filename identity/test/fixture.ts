import { InstallationTokenCache } from "../src/github.ts";
import { handleAuthorityRequest } from "../src/index.ts";
import { handleMaintainerRequest } from "../src/maintainer.ts";
import { AUTHORITY_PROTOCOL } from "../src/protocol.ts";

export const NOW = 1_800_000_000_000;
export const USER_TOKEN = "ghu_customer_fixture";
export const MAINTAINER_TOKEN = "maintainer_fixture_token_value_1234567890";

/** GitHub's repository roles, as `/user/installations/{id}/repositories` reports them. */
export const ROLES = {
  none: {
    pull: false,
    triage: false,
    push: false,
    maintain: false,
    admin: false,
  },
  read: {
    pull: true,
    triage: false,
    push: false,
    maintain: false,
    admin: false,
  },
  triage: {
    pull: true,
    triage: true,
    push: false,
    maintain: false,
    admin: false,
  },
  write: {
    pull: true,
    triage: true,
    push: true,
    maintain: false,
    admin: false,
  },
  maintain: {
    pull: true,
    triage: true,
    push: true,
    maintain: true,
    admin: false,
  },
  admin: { pull: true, triage: true, push: true, maintain: true, admin: true },
} as const;
export type Role = keyof typeof ROLES;

export class FixtureLimiter {
  allowed = true;
  readonly keys: string[] = [];

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(key);
    return { success: this.allowed };
  }
}

export interface Call {
  path: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/** One authority isolate in front of a scripted GitHub. */
export async function authorityFixture(
  role: "customer" | "maintainer" = "customer",
) {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateKey = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const pem = `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n${Buffer.from(
    privateKey,
  )
    .toString("base64")
    .match(/.{1,64}/g)
    ?.join("\n")}\n${["-----END", "PRIVATE KEY-----"].join(" ")}\n`;
  const limits = {
    request: new FixtureLimiter(),
    account: new FixtureLimiter(),
    installation: new FixtureLimiter(),
  };
  const env = {
    GITHUB_APP_ID: role === "maintainer" ? "900001" : "4850106",
    GITHUB_APP_SLUG:
      role === "maintainer" ? "mochi-maintainer" : "mochi-companion",
    GITHUB_APP_BOT_LOGIN:
      role === "maintainer" ? "mochi-maintainer[bot]" : "mochi-companion[bot]",
    GITHUB_API_VERSION: "2026-03-10",
    MAINTAINER_ACCOUNT_ID: "1",
    MAINTAINER_REPOSITORY_ID: "20",
    MAINTAINER_REPOSITORY_OWNER_ID: "10",
    MAINTAINER_REPOSITORY_FULL_NAME: "customer/selected",
    GITHUB_APP_PRIVATE_KEY: pem,
    MAINTAINER_AUTH_TOKEN: MAINTAINER_TOKEN,
    ACCOUNT_LIMIT: limits.account,
    REQUEST_LIMIT: limits.request,
    INSTALLATION_LIMIT: limits.installation,
  } as unknown as Env;
  const calls: Call[] = [];
  const state = {
    now: NOW,
    repositoryName: "customer/selected",
    role: "write" as Role,
    appIssues: "write",
    locked: false,
    mints: 0,
    /** A status GitHub answers the next Issue write with, instead of success. */
    writeStatus: undefined as number | undefined,
  };
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as unknown)
      : undefined;
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ path: url.pathname, method, authorization, body });
    if (url.pathname === "/user") return Response.json({ id: 1 });
    if (url.pathname === "/user/installations")
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 30,
            app_id: Number(env.GITHUB_APP_ID),
            account: { id: 10 },
            suspended_at: null,
            permissions: { metadata: "read", issues: state.appIssues },
          },
        ],
      });
    if (url.pathname === "/user/installations/30/repositories")
      return Response.json({
        total_count: 1,
        repositories: [
          {
            id: 20,
            owner: { id: 10 },
            full_name: state.repositoryName,
            permissions: ROLES[state.role],
          },
        ],
      });
    if (url.pathname === "/repositories/20/installation")
      return Response.json({
        id: 30,
        app_id: Number(env.GITHUB_APP_ID),
        account: { id: 10 },
        suspended_at: null,
      });
    if (url.pathname === "/app/installations/30/access_tokens") {
      state.mints++;
      return Response.json({
        token: `ghs_app_fixture${state.mints}`,
        expires_at: new Date(state.now + 3_600_000).toISOString(),
        permissions: (body as { permissions: Record<string, string> })
          .permissions,
        repositories: [{ id: 20, full_name: "customer/selected" }],
      });
    }
    if (url.pathname === "/repositories/20/issues/42" && method === "GET")
      return Response.json({ number: 42, locked: state.locked });
    if (url.pathname.startsWith("/repositories/20/issues")) {
      if (state.writeStatus !== undefined) {
        const status = state.writeStatus;
        state.writeStatus = undefined;
        return Response.json(
          { message: "provider refusal" },
          { status, headers: { "x-github-request-id": "fixture:403" } },
        );
      }
      if (url.pathname.endsWith("/lock"))
        return new Response(null, { status: 204 });
      return Response.json(
        {
          number: 42,
          html_url: "https://github.com/customer/selected/issues/42",
          user: { login: "mochi-companion[bot]" },
        },
        {
          status: method === "POST" ? 201 : 200,
          headers: { "x-github-request-id": "fixture:123" },
        },
      );
    }
    if (url.pathname === "/app")
      return Response.json({
        id: Number(env.GITHUB_APP_ID),
        slug: env.GITHUB_APP_SLUG,
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
        installations_count: 1,
      });
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  const tokens = new InstallationTokenCache();
  const handle = (request: Request) => {
    request.headers.set("CF-Connecting-IP", "203.0.113.10");
    const options = { tokens, fetchImplementation, now: () => state.now };
    return role === "maintainer"
      ? handleMaintainerRequest(
          request,
          env as unknown as MaintainerEnv,
          options,
        )
      : handleAuthorityRequest(request, env, options);
  };
  const invoke = (path: string, init: RequestInit) =>
    handle(new Request(`https://authority.mochi.invalid${path}`, init));
  const issue = (
    operation: { method: string; path: string; body?: unknown },
    version: unknown = AUTHORITY_PROTOCOL.maximum,
  ) =>
    invoke("/v1/issues", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${USER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version,
        accountId: 1,
        repository: {
          id: 20,
          ownerId: 10,
          installationId: 30,
          fullName: "customer/selected",
        },
        operation,
      }),
    });
  const maintainer = (
    route: "token" | "status",
    secret: string = MAINTAINER_TOKEN,
  ) =>
    invoke(`/v1/maintainer/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Mochi-Maintainer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        purpose: route === "token" ? "change_proposal" : "status",
      }),
    });
  return { calls, env, handle, invoke, issue, limits, maintainer, state };
}
