import { describe, expect, test } from "bun:test";
import { GitHubConnectionError } from "../../src/github/integration.ts";
import type { GitHubRepositoryScope } from "../../src/github/repository.ts";
import { GitHubRequestError } from "../../src/github/requestError.ts";
import {
  GitHubAuthorityRefusal,
  GitHubWriteAuthority,
} from "../../src/github/writeAuthority.ts";
import {
  AUTHORITY_ERROR_HEADER,
  type RepositoryRole,
} from "../src/protocol.ts";
import { authorityFixture, USER_TOKEN } from "./fixture.ts";

const scope: GitHubRepositoryScope = {
  accountId: 1,
  grantId: "a".repeat(32),
  repositoryId: 20,
  ownerId: 10,
  installationId: 30,
  selectionId: "b".repeat(32),
};

/** The native client, talking to the authority in-process instead of over HTTPS. */
async function connected() {
  const f = await authorityFixture();
  const requests: unknown[] = [];
  const client = new GitHubWriteAuthority((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(String(input), init);
    requests.push(await request.clone().json());
    return f.handle(request);
  }) as typeof fetch);
  const write = (
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
    // The role the native catalog proved; the authority proves its own.
    role: RepositoryRole = "write",
  ) =>
    client.issue(
      USER_TOKEN,
      scope,
      "customer/selected",
      role,
      path,
      method,
      body,
      new AbortController().signal,
    );
  return { ...f, client, requests, write };
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to fail");
}

describe("native client and authority share one contract", () => {
  test("the request the client builds is the one the authority executes", async () => {
    const f = await connected();
    const response = await f.write("/issues", "POST", { title: "t" });
    expect(response.status).toBe(201);
    expect(f.requests).toEqual([
      {
        version: 1,
        accountId: 1,
        repository: {
          id: 20,
          ownerId: 10,
          installationId: 30,
          fullName: "customer/selected",
        },
        operation: { method: "POST", path: "/issues", body: { title: "t" } },
      },
    ]);
  });

  test("a client never sends what the authority would refuse", async () => {
    const f = await connected();
    const error = await failure(
      f.write("/issues/42", "PATCH", { title: "t", type: "Bug" }),
    );
    expect(error).toBeInstanceOf(GitHubRequestError);
    expect(error).toMatchObject({ code: "request_invalid" });
    expect(f.requests).toHaveLength(0);
  });

  test("the client refuses what its proven role cannot do, as the authority would", async () => {
    const f = await connected();
    f.state.role = "read";
    // GitHub lets a read role open Issues and comment, so the client sends both.
    expect(
      (await f.write("/issues", "POST", { title: "t" }, "read")).status,
    ).toBe(201);
    expect(
      (await f.write("/issues/42/comments", "POST", { body: "b" }, "read"))
        .status,
    ).toBe(201);
    const sent = f.requests.length;
    const local = await failure(
      f.write("/issues/42", "PATCH", { state: "closed" }, "read"),
    );
    expect(f.requests).toHaveLength(sent);
    // A role that changed since the catalog proved it reaches the authority,
    // which refuses the same operation the same way.
    const remote = await failure(
      f.write("/issues/42", "PATCH", { state: "closed" }, "write"),
    );
    expect(f.requests).toHaveLength(sent + 1);
    for (const error of [local, remote]) {
      expect(error).toBeInstanceOf(GitHubAuthorityRefusal);
      expect(error).toMatchObject({ code: "permission_denied", status: 403 });
    }
    expect(String(local)).toBe(String(remote));
  });

  test("a rate-limited write is a request-local error that says how long to wait", async () => {
    const f = await connected();
    f.limits.account.allowed = false;
    const error = await failure(f.write("/issues", "POST", { title: "t" }));
    expect(error).toBeInstanceOf(GitHubAuthorityRefusal);
    // A GitHubRequestError leaves the grant connected.
    expect(error).toBeInstanceOf(GitHubRequestError);
    expect(error).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 60,
    });
    expect(String(error)).toContain("Wait 60 seconds");
  });

  test("a role refusal names the role GitHub requires", async () => {
    const f = await connected();
    f.state.role = "triage";
    const error = await failure(f.write("/issues/42", "PATCH", { body: "b" }));
    expect(error).toBeInstanceOf(GitHubAuthorityRefusal);
    expect(error).toMatchObject({ code: "permission_denied", status: 403 });
    expect(String(error)).toContain("need write");
  });

  test("grant failures keep their connection meaning", async () => {
    const renamed = await connected();
    renamed.state.repositoryName = "customer/renamed";
    const changed = await failure(
      renamed.write("/issues", "POST", { title: "t" }),
    );
    expect(changed).toBeInstanceOf(GitHubConnectionError);
    expect(changed).toMatchObject({ code: "repository_changed" });

    const revoked = await connected();
    revoked.state.appIssues = "read";
    const ungranted = await failure(
      revoked.write("/issues", "POST", { title: "t" }),
    );
    expect(ungranted).toBeInstanceOf(GitHubConnectionError);
    expect(ungranted).toMatchObject({ code: "issue_write_not_granted" });
  });

  test("GitHub's own refusal reaches the caller unchanged", async () => {
    const f = await connected();
    f.state.writeStatus = 409;
    const response = await f.write("/issues/42", "PATCH", { state: "open" });
    expect(response.status).toBe(409);
    expect(response.headers.get(AUTHORITY_ERROR_HEADER)).toBeNull();
  });

  test("an authority that no longer speaks this client's version asks for an update", async () => {
    const client = new GitHubWriteAuthority((async () =>
      Response.json(
        { version: 1, error: "protocol_unsupported" },
        {
          status: 426,
          headers: { [AUTHORITY_ERROR_HEADER]: "protocol_unsupported" },
        },
      )) as unknown as typeof fetch);
    const error = await failure(
      client.issue(
        USER_TOKEN,
        scope,
        "customer/selected",
        "write",
        "/issues",
        "POST",
        { title: "t" },
        new AbortController().signal,
      ),
    );
    expect(error).toBeInstanceOf(GitHubAuthorityRefusal);
    expect(error).toMatchObject({ code: "protocol_unsupported", status: 426 });
    expect(String(error)).toContain("updated");
  });
});
