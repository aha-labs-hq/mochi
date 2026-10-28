import { describe, expect, test } from "bun:test";
import { TOKEN_REUSE_MARGIN_MS } from "../src/github.ts";
import { RATE_LIMIT_PERIOD_SECONDS } from "../src/http.ts";
import {
  AUTHORITY_ERROR_HEADER,
  allowedIssueWrite,
  type RepositoryRole,
} from "../src/protocol.ts";
import {
  authorityFixture,
  MAINTAINER_TOKEN,
  NOW,
  type Role,
  USER_TOKEN,
} from "./fixture.ts";

const mints = (calls: { path: string }[]) =>
  calls.filter((call) => call.path.endsWith("/access_tokens")).length;

describe("Mochi GitHub App authority", () => {
  test("exposes only the stable public actor and the accepted protocol range on health", async () => {
    const f = await authorityFixture();
    const response = await f.invoke("/health", { method: "GET" });
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      version: 1,
      status: "ok",
      actor: {
        appId: 4850106,
        slug: "mochi-companion",
        login: "mochi-companion[bot]",
      },
      protocol: { minimum: 1, maximum: 1 },
    });
    expect(f.calls).toHaveLength(0);
  });

  test("re-proves the human grant but writes only as the App, addressed by repository ID", async () => {
    const f = await authorityFixture();
    const response = await f.issue({
      method: "POST",
      path: "/issues",
      body: { title: "fixture" },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-github-request-id")).toBe("fixture:123");
    expect(response.headers.get(AUTHORITY_ERROR_HEADER)).toBeNull();
    const writes = f.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.path)).toEqual([
      "/app/installations/30/access_tokens",
      "/repositories/20/issues",
    ]);
    expect(writes[0]?.authorization).toStartWith("Bearer eyJ");
    expect(writes[0]?.body).toEqual({
      repository_ids: [20],
      permissions: { metadata: "read", issues: "write" },
    });
    expect(writes[1]?.authorization).toBe("Bearer ghs_app_fixture1");
    expect(
      f.calls
        .filter((call) => call.authorization === `Bearer ${USER_TOKEN}`)
        .map((call) => call.path),
    ).toEqual([
      "/user",
      "/user/installations",
      "/user/installations/30/repositories",
    ]);
  });

  // GitHub Docs, "Repository roles for an organization": read opens Issues and
  // comments; triage applies labels and milestones and closes, reopens and
  // assigns any Issue; editing anyone's title or body and locking need write.
  const operations: Array<
    [
      string,
      string,
      string,
      Record<string, unknown> | undefined,
      RepositoryRole,
    ]
  > = [
    ["open an Issue", "POST", "/issues", { title: "t", body: "b" }, "read"],
    [
      "open a labelled Issue",
      "POST",
      "/issues",
      { title: "t", labels: ["x"] },
      "triage",
    ],
    [
      "open an assigned Issue",
      "POST",
      "/issues",
      { title: "t", assignees: ["a"] },
      "triage",
    ],
    ["comment", "POST", "/issues/42/comments", { body: "b" }, "read"],
    ["edit a title", "PATCH", "/issues/42", { title: "t" }, "write"],
    ["edit a body", "PATCH", "/issues/42", { body: "b" }, "write"],
    [
      "close",
      "PATCH",
      "/issues/42",
      { state: "closed", state_reason: "completed" },
      "triage",
    ],
    ["reopen", "PATCH", "/issues/42", { state: "open" }, "triage"],
    ["set a milestone", "PATCH", "/issues/42", { milestone: 3 }, "triage"],
    ["clear a milestone", "PATCH", "/issues/42", { milestone: null }, "triage"],
    [
      "close and retitle",
      "PATCH",
      "/issues/42",
      { state: "closed", title: "t" },
      "write",
    ],
    ["assign", "POST", "/issues/42/assignees", { assignees: ["a"] }, "triage"],
    [
      "unassign",
      "DELETE",
      "/issues/42/assignees",
      { assignees: ["a"] },
      "triage",
    ],
    ["add labels", "POST", "/issues/42/labels", { labels: ["bug"] }, "triage"],
    [
      "remove a label",
      "DELETE",
      "/issues/42/labels/kind%3Abug",
      undefined,
      "triage",
    ],
    ["lock", "PUT", "/issues/42/lock", { lock_reason: "resolved" }, "write"],
    ["unlock", "DELETE", "/issues/42/lock", undefined, "write"],
  ];
  const strength: Record<Role, number> = {
    none: -1,
    read: 0,
    triage: 1,
    write: 2,
    maintain: 2,
    admin: 2,
  };
  const needed: Record<RepositoryRole, number> = {
    read: 0,
    triage: 1,
    write: 2,
  };

  for (const [name, method, path, body, role] of operations) {
    test(`to ${name} a person needs the ${role} role GitHub requires`, async () => {
      for (const held of Object.keys(strength) as Role[]) {
        const f = await authorityFixture();
        f.state.role = held;
        const response = await f.issue({
          method,
          path,
          ...(body ? { body } : {}),
        });
        if (strength[held] >= needed[role]) {
          expect({ held, succeeded: response.status < 300 }).toEqual({
            held,
            succeeded: true,
          });
          expect(f.calls.at(-1)?.path).toBe(`/repositories/20${path}`);
        } else {
          expect({ held, status: response.status }).toEqual({
            held,
            status: 403,
          });
          expect(response.headers.get(AUTHORITY_ERROR_HEADER)).toBe(
            "permission_denied",
          );
          expect(mints(f.calls)).toBe(0);
        }
      }
    });
  }

  test("commenting on a locked conversation needs write, as on GitHub", async () => {
    for (const [held, status] of [
      ["read", 403],
      ["triage", 403],
      ["write", 201],
    ] as const) {
      const f = await authorityFixture();
      f.state.role = held;
      f.state.locked = true;
      const response = await f.issue({
        method: "POST",
        path: "/issues/42/comments",
        body: { body: "b" },
      });
      expect({ held, status: response.status }).toEqual({ held, status });
      expect(
        f.calls.some(
          (call) => call.path === "/repositories/20/issues/42/comments",
        ),
      ).toBe(status === 201);
    }
    const open = await authorityFixture();
    open.state.role = "read";
    expect(
      (
        await open.issue({
          method: "POST",
          path: "/issues/42/comments",
          body: { body: "b" },
        })
      ).status,
    ).toBe(201);
    expect(
      open.calls.slice(-2).map((call) => `${call.method} ${call.path}`),
    ).toEqual([
      "GET /repositories/20/issues/42",
      "POST /repositories/20/issues/42/comments",
    ]);
  });

  test("refuses fields and routes outside the closed surface before reaching GitHub", async () => {
    for (const operation of [
      { method: "PATCH", path: "/issues/42", body: { type: "Bug" } },
      { method: "POST", path: "/issues", body: { title: "t", assignee: "a" } },
      {
        method: "POST",
        path: "/issues/42/comments",
        body: { body: "b", x: 1 },
      },
      { method: "PATCH", path: "/issues/42", body: { constructor: "x" } },
      { method: "DELETE", path: "/issues/42/labels/.." },
      { method: "DELETE", path: "/issues/42/lock", body: { lock_reason: "x" } },
      { method: "DELETE", path: "/issues/42/comments/1" },
      { method: "POST", path: "/pulls", body: { title: "t" } },
    ]) {
      const f = await authorityFixture();
      const response = await f.issue(operation);
      expect({ operation, status: response.status }).toEqual({
        operation,
        status: 400,
      });
      expect(response.headers.get(AUTHORITY_ERROR_HEADER)).toBe(
        "invalid_request",
      );
      expect(f.calls).toHaveLength(0);
    }
    expect(allowedIssueWrite("/issues", "POST")).toBeTrue();
    expect(allowedIssueWrite("/issues/42/comments", "POST")).toBeTrue();
    expect(allowedIssueWrite("/issues/42/lock", "DELETE")).toBeTrue();
    expect(
      allowedIssueWrite(
        `/issues/42/labels/${encodeURIComponent("won't fix (ok)")}`,
        "DELETE",
      ),
    ).toBeTrue();
    expect(allowedIssueWrite("/issues/42/labels/a/b", "DELETE")).toBeFalse();
    expect(allowedIssueWrite("/issues/42?state=closed", "PATCH")).toBeFalse();
    expect(allowedIssueWrite("/issues/0", "PATCH")).toBeFalse();
  });

  test("fails closed on repository identity or grant drift before minting an App token", async () => {
    const renamed = await authorityFixture();
    renamed.state.repositoryName = "customer/renamed";
    const response = await renamed.issue({
      method: "PATCH",
      path: "/issues/42",
      body: { state: "closed" },
    });
    expect(response.status).toBe(409);
    expect(response.headers.get(AUTHORITY_ERROR_HEADER)).toBe(
      "repository_changed",
    );
    expect(mints(renamed.calls)).toBe(0);

    const revoked = await authorityFixture();
    revoked.state.appIssues = "read";
    const refused = await revoked.issue({
      method: "POST",
      path: "/issues",
      body: { title: "t" },
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get(AUTHORITY_ERROR_HEADER)).toBe(
      "grant_unavailable",
    );
    expect(mints(revoked.calls)).toBe(0);
  });

  test("limits writes per proven GitHub account and per installation, before minting", async () => {
    const f = await authorityFixture();
    f.limits.account.allowed = false;
    const limited = await f.issue({
      method: "POST",
      path: "/issues",
      body: { title: "t" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get(AUTHORITY_ERROR_HEADER)).toBe("rate_limited");
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(f.limits.account.keys).toEqual(["account:1"]);
    expect(f.calls.map((call) => call.path)).toEqual(["/user"]);

    const installation = await authorityFixture();
    installation.limits.installation.allowed = false;
    expect(
      (
        await installation.issue({
          method: "POST",
          path: "/issues",
          body: { title: "t" },
        })
      ).status,
    ).toBe(429);
    expect(installation.limits.installation.keys).toEqual(["installation:30"]);
    expect(mints(installation.calls)).toBe(0);

    // Naming someone else's account never spends their budget, and a refused
    // role never spends the installation's.
    const spoofed = await authorityFixture();
    const other = await spoofed.invoke("/v1/issues", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${USER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        accountId: 2,
        repository: {
          id: 20,
          ownerId: 10,
          installationId: 30,
          fullName: "customer/selected",
        },
        operation: { method: "POST", path: "/issues", body: { title: "t" } },
      }),
    });
    expect(other.status).toBe(401);
    expect(spoofed.limits.account.keys).toEqual([]);
    spoofed.state.role = "read";
    await spoofed.issue({
      method: "PATCH",
      path: "/issues/42",
      body: { title: "t" },
    });
    expect(spoofed.limits.installation.keys).toEqual([]);
  });

  test("Retry-After matches the period of every configured limit", async () => {
    const config = Bun.JSONC.parse(
      await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text(),
    ) as {
      ratelimits: Array<{ name: string; simple: { period: number } }>;
    };
    expect(config.ratelimits.map((limit) => limit.name).sort()).toEqual([
      "ACCOUNT_LIMIT",
      "INSTALLATION_LIMIT",
      "REQUEST_LIMIT",
    ]);
    for (const limit of config.ratelimits)
      expect(limit.simple.period).toBe(RATE_LIMIT_PERIOD_SECONDS);
  });

  test("reuses an installation token per installation, repository and permission set until shortly before it expires", async () => {
    const f = await authorityFixture();
    const write = () =>
      f.issue({ method: "POST", path: "/issues", body: { title: "t" } });
    expect((await write()).status).toBe(201);
    expect((await write()).status).toBe(201);
    expect(mints(f.calls)).toBe(1);
    expect(
      f.calls
        .filter((call) => call.path === "/repositories/20/issues")
        .map((call) => call.authorization),
    ).toEqual(["Bearer ghs_app_fixture1", "Bearer ghs_app_fixture1"]);
    // Every reuse still re-proved the person's grant.
    expect(f.calls.filter((call) => call.path === "/user")).toHaveLength(2);

    f.state.now = NOW + 3_600_000 - TOKEN_REUSE_MARGIN_MS - 1;
    expect((await write()).status).toBe(201);
    expect(mints(f.calls)).toBe(1);
    f.state.now = NOW + 3_600_000 - TOKEN_REUSE_MARGIN_MS;
    expect((await write()).status).toBe(201);
    expect(mints(f.calls)).toBe(2);
    expect(f.calls.at(-1)?.authorization).toBe("Bearer ghs_app_fixture2");

    // A separate service/key/cache owns maintainer tokens.
    const maintainer = await authorityFixture("maintainer");
    expect((await maintainer.maintainer("token")).status).toBe(200);
    expect((await maintainer.maintainer("token")).status).toBe(200);
    expect(mints(maintainer.calls)).toBe(1);
    expect(mints(f.calls)).toBe(2);
  });

  test("a token GitHub refuses is dropped and reported as the authority's failure, never the person's sign-in", async () => {
    const f = await authorityFixture();
    const write = () =>
      f.issue({ method: "POST", path: "/issues", body: { title: "t" } });
    expect((await write()).status).toBe(201);
    f.state.writeStatus = 401;
    const refused = await write();
    expect(refused.status).toBe(503);
    expect(refused.headers.get(AUTHORITY_ERROR_HEADER)).toBe(
      "issuer_unavailable",
    );
    expect((await write()).status).toBe(201);
    expect(mints(f.calls)).toBe(2);

    // GitHub's own refusals are relayed unchanged and carry no authority code.
    f.state.writeStatus = 403;
    const forbidden = await write();
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get(AUTHORITY_ERROR_HEADER)).toBeNull();
    expect(forbidden.headers.get("x-github-request-id")).toBe("fixture:403");
  });

  test("accepts exactly the supported client protocol versions and names any other", async () => {
    for (const version of [0, 2]) {
      const f = await authorityFixture();
      const response = await f.issue(
        { method: "POST", path: "/issues", body: { title: "t" } },
        version,
      );
      expect(response.status).toBe(426);
      expect(response.headers.get(AUTHORITY_ERROR_HEADER)).toBe(
        "protocol_unsupported",
      );
      expect(await response.json()).toMatchObject({
        version: 1,
        error: "protocol_unsupported",
        supported: { minimum: 1, maximum: 1 },
      });
      expect(f.calls).toHaveLength(0);
    }
    const malformed = await authorityFixture();
    const response = await malformed.issue(
      { method: "POST", path: "/issues", body: { title: "t" } },
      "1",
    );
    expect(response.status).toBe(400);
    expect(response.headers.get(AUTHORITY_ERROR_HEADER)).toBe(
      "invalid_request",
    );
  });

  test("accepts the exact requests Apps built before the shared contract send", async () => {
    // Byte-for-byte what the v1 client serialized for each kind of write.
    for (const [body, status] of [
      [
        '{"version":1,"accountId":1,"repository":{"id":20,"ownerId":10,"installationId":30,"fullName":"customer/selected"},"operation":{"method":"POST","path":"/issues","body":{"title":"Fixture","body":"Text"}}}',
        201,
      ],
      [
        '{"version":1,"accountId":1,"repository":{"id":20,"ownerId":10,"installationId":30,"fullName":"customer/selected"},"operation":{"method":"PATCH","path":"/issues/42","body":{"state":"closed","state_reason":"not_planned"}}}',
        200,
      ],
      [
        '{"version":1,"accountId":1,"repository":{"id":20,"ownerId":10,"installationId":30,"fullName":"customer/selected"},"operation":{"method":"DELETE","path":"/issues/42/labels/kind%3Abug"}}',
        200,
      ],
      [
        '{"version":1,"accountId":1,"repository":{"id":20,"ownerId":10,"installationId":30,"fullName":"customer/selected"},"operation":{"method":"PUT","path":"/issues/42/lock"}}',
        204,
      ],
    ] as const) {
      const f = await authorityFixture();
      const response = await f.invoke("/v1/issues", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${USER_TOKEN}`,
          "Content-Type": "application/json",
        },
        body,
      });
      expect(response.status).toBe(status);
    }
  });

  test("maintainer tokens require a separate secret and are pinned to one repository and permission set", async () => {
    const f = await authorityFixture("maintainer");
    expect(
      (await f.maintainer("token", "wrong_wrong_wrong_wrong_wrong_wrong"))
        .status,
    ).toBe(401);
    expect(f.calls).toHaveLength(0);
    // A wrong secret spends nothing, so it cannot lock the maintainer out.
    expect(f.limits.account.keys).toEqual([]);

    const response = await f.maintainer("token");
    expect(response.status).toBe(200);
    const value = (await response.json()) as Record<string, unknown>;
    expect(value.token).toBe("ghs_app_fixture1");
    expect(value.permissions).toEqual({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
    });
    expect(value.repository).toEqual({
      id: 20,
      ownerId: 10,
      fullName: "customer/selected",
      installationId: 30,
    });
    expect(f.calls.map((call) => call.path)).toEqual([
      "/repositories/20/installation",
      "/app/installations/30/access_tokens",
    ]);
    expect(f.calls[1]?.body).toEqual({
      repository_ids: [20],
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
      },
    });
    expect(f.limits.account.keys).toEqual(["maintainer"]);

    f.limits.account.allowed = false;
    const limited = await f.maintainer("token");
    expect(limited.status).toBe(429);
    expect(limited.headers.get(AUTHORITY_ERROR_HEADER)).toBe("rate_limited");
  });

  test("maintainer status is an exact request and proves the live App registration", async () => {
    const f = await authorityFixture("maintainer");
    expect(
      (
        await f.invoke("/v1/maintainer/status", {
          method: "POST",
          headers: {
            Authorization: `Mochi-Maintainer ${MAINTAINER_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ version: 1, purpose: "change_proposal" }),
        })
      ).status,
    ).toBe(400);
    const response = await f.maintainer("status");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { issuer: unknown }).issuer).toEqual({
      appId: 900001,
      slug: "mochi-maintainer",
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
      installationsCount: 1,
    });
  });
});
