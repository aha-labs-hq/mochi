import { describe, expect, test } from "bun:test";
import { repositoryAccess } from "./githubFixtures.ts";
import { GitHubClient } from "../src/github/client.ts";

describe("GitHub reads", () => {
  test("empty commit path follows the advertised no-filter contract, while traversal is rejected", async () => {
    const requests: URL[] = [];
    const client = new GitHubClient(repositoryAccess((async (input: string | URL | Request) => {
      requests.push(new URL(String(input)));
      return Response.json([]);
    }) as unknown as typeof fetch));
    await client.listCommits({ path: "", ref: "", limit: 20 });
    expect(requests[0]!.searchParams.has("path")).toBe(false);
    await client.listCommits({ path: "src/feature.ts", ref: "topic", limit: 10 });
    expect(requests[1]!.searchParams.get("path")).toBe("src/feature.ts");
    expect(requests[1]!.searchParams.get("sha")).toBe("topic");
    await expect(client.listCommits({ path: "../outside", limit: 10 })).rejects.toThrow("cannot contain");
    expect(requests).toHaveLength(2);
  });

  test("search retains every match and source link without duplicating repository metadata", async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      name: `file-${index}.ts`, path: `src/file-${index}.ts`, sha: `sha-${index}`,
      html_url: `https://github.com/customer/project/blob/main/src/file-${index}.ts`,
      text_matches: [{ fragment: `export const value${index} = true;` }],
      repository: { id: 20, full_name: "customer/project", owner: { avatar_url: "unneeded" },
        description: "unneeded metadata".repeat(500) },
    }));
    const client = new GitHubClient(repositoryAccess((async () => Response.json({ items })) as unknown as typeof fetch));
    const result = await client.searchCode({ query: "value path:src", limit: 50 });
    expect(result).toEqual(items.map(({ repository: _repository, ...match }) => match));
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify({ items }).length / 10);
  });

  test("search bounds provider fragments so one oversized match cannot block file follow-up", async () => {
    const client = new GitHubClient(repositoryAccess((async () => Response.json({ items: [{
      name: "large.ts", path: "src/large.ts", sha: "sha-large",
      html_url: "https://github.com/customer/project/blob/main/src/large.ts",
      text_matches: [
        { fragment: "first:" + "x".repeat(10_000) },
        { fragment: "second:" + "y".repeat(10_000) },
        { fragment: "discarded:" + "z".repeat(10_000) },
      ],
    }] })) as unknown as typeof fetch));
    const result = await client.searchCode({ query: "large", limit: 50 }) as Record<string, unknown>[];
    const matches = result[0]!.text_matches as Record<string, string>[];
    expect(matches).toHaveLength(2);
    expect(matches[0]!.fragment).toHaveLength(400);
    expect(matches[1]!.fragment).toHaveLength(400);
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
  });

  test("fifty PR summaries preserve fork identity and comparison refs within the tool budget", async () => {
    const repo = { id: 20, full_name: "customer/project", unused: "metadata".repeat(2000) };
    const items = Array.from({ length: 50 }, (_, number) => ({
      number, title: `Change ${number}`, state: "open", draft: false,
      html_url: `https://github.com/customer/project/pull/${number}`,
      user: { login: "author", avatar_url: "unneeded", unused: "profile".repeat(100) },
      head: { label: "contributor:topic", ref: "topic", sha: `head-${number}`,
        repo: { ...repo, id: 21, full_name: "contributor/project" } },
      base: { label: "customer:main", ref: "main", sha: "base-sha", repo },
    }));
    const client = new GitHubClient(repositoryAccess((async () => Response.json(items)) as unknown as typeof fetch));
    const result = await client.listPullRequests({ state: "open", limit: 50 }) as Record<string, unknown>[];
    expect(result).toHaveLength(50);
    expect(result[49]).toMatchObject({
      number: 49, user: { login: "author" },
      head: { ref: "topic", sha: "head-49", repo: { id: 21, full_name: "contributor/project" } },
      base: { ref: "main", sha: "base-sha", repo: { id: 20, full_name: "customer/project" } },
    });
    expect(JSON.stringify(result)).not.toMatch(/avatar_url|unused/);
    expect(JSON.stringify(result).length).toBeLessThan(30_000);
  });

  test("Issue detail retains its evidence and workflow metadata with compact identity references", async () => {
    const issue = { number: 42, title: "Example", body: "Evidence and reproduction", state: "closed",
      state_reason: "completed", html_url: "https://github.com/customer/project/issues/42",
      locked: true, active_lock_reason: "resolved", comments: 3,
      user: { login: "author", avatar_url: "unneeded" },
      assignees: [{ login: "owner", node_id: "unneeded" }],
      labels: [{ name: "bug", id: 50 }, "confirmed"],
      milestone: { number: 2, title: "Release", state: "open", creator: { login: "unneeded" } },
    };
    const client = new GitHubClient(repositoryAccess((async () => Response.json(issue)) as unknown as typeof fetch));
    expect(await client.getIssue({ number: 42 })).toEqual({ ...issue,
      user: { login: "author" }, assignees: [{ login: "owner" }], labels: ["bug", "confirmed"],
      milestone: { number: 2, title: "Release", state: "open" },
    });
  });

  test("file prefix coverage is explicit and does not append a synthetic marker to source code", async () => {
    for (const source of ["short source", "x".repeat(80_001)]) {
      const client = new GitHubClient(repositoryAccess((async () => Response.json({
        type: "file", path: "file.ts", sha: "source-sha", encoding: "base64",
        content: Buffer.from(source).toString("base64"),
      })) as unknown as typeof fetch));
      expect(await client.getContent({ path: "file.ts", ref: "main" })).toMatchObject({
        sha: "source-sha", encoding: "utf-8", content: source.slice(0, 80_000),
        content_truncated: source.length > 80_000, total_characters: source.length,
      });
    }
  });

  test("paginates past pull requests before applying the Issue limit", async () => {
    const requests: string[] = [];
    const firstPage: Record<string, unknown>[] = Array.from({ length: 100 }, (_, index) => ({
      number: 1_000 - index,
      title: `PR ${index}`,
      pull_request: {},
    }));
    firstPage[99] = { number: 901, title: "Issue 901" };
    const secondPage = [
      { number: 900, title: "Issue 900" },
      { number: 899, title: "Issue 899" },
    ];
    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return Response.json(url.includes("page=2") ? secondPage : firstPage);
    }) as typeof fetch;

    const result = await new GitHubClient(repositoryAccess(mockFetch)).listIssues({ state: "open", limit: 3 });

    expect(result).toEqual([
      { number: 901, title: "Issue 901" },
      { number: 900, title: "Issue 900" },
      { number: 899, title: "Issue 899" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("per_page=100");
    expect(requests[0]).toContain("page=1");
    expect(requests[1]).toContain("page=2");
  });

  test("reconciles an exact audited Issue marker", async () => {
    const mockFetch = (async () => Response.json([{
      number: 73,
      html_url: "https://github.com/customer/project/issues/73",
      body: "<!-- mochi-issue-action:abcd1234:feedface -->",
    }])) as unknown as typeof fetch;
    const result = await new GitHubClient(repositoryAccess(mockFetch)).findIssueByMarker(
      "<!-- mochi-issue-action:abcd1234:feedface -->",
      Date.now(),
    );
    expect(result?.number).toBe(73);
  });
});

describe("GitHub Issue writes", () => {
  test("keeps write permissions Issue-only and dispatches typed assignment and close operations", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    let currentAssignees: string[] = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      if (method === "GET") {
        return Response.json({
          number: 820,
          html_url: "https://github.com/customer/project/issues/820",
          assignees: currentAssignees.map((login) => ({ login })),
          labels: [],
          locked: false,
        });
      }
      if (method === "POST" && url.endsWith("/assignees")) {
        currentAssignees = ((requests.at(-1)?.body as { assignees?: string[] }).assignees ?? []);
        return Response.json({}, { status: 201 });
      }
      if (method === "PATCH") {
        return Response.json({
          number: 820,
          html_url: "https://github.com/customer/project/issues/820",
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new GitHubClient(repositoryAccess(mockFetch));

    await client.applyIssueMutation(
      { kind: "assign", issueNumber: 820, assignees: ["cesigoo814-png"] },
      "<!-- marker -->",
    );
    await client.applyIssueMutation(
      { kind: "close", issueNumber: 820, reason: "completed" },
      "<!-- marker -->",
    );

    expect(requests).toContainEqual({
      url: "https://api.github.com/repos/customer/project/issues/820/assignees",
      method: "POST",
      body: { assignees: ["cesigoo814-png"] },
    });
    expect(requests).toContainEqual({
      url: "https://api.github.com/repos/customer/project/issues/820",
      method: "PATCH",
      body: { state: "closed", state_reason: "completed" },
    });
    expect(requests.filter((request) => request.method !== "GET").every((request) => request.url.includes("/issues/"))).toBeTrue();
  });

  test("fails closed when GitHub accepts an assignment without returning that assignee", async () => {
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          number: 820,
          html_url: "https://github.com/customer/project/issues/820",
          assignees: [], labels: [], locked: false,
        });
      }
      if (url.endsWith("/assignees")) return Response.json({}, { status: 201 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new GitHubClient(repositoryAccess(mockFetch));

    await expect(client.applyIssueMutation(
      { kind: "assign", issueNumber: 820, assignees: ["nobody"] },
      "<!-- marker -->",
    )).rejects.toThrow("GitHub did not assign: nobody");
  });
});
