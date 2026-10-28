import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentToolExecutor,
  CONNECTOR_WRITES_PER_MESSAGE,
  type ToolTurnState,
} from "../src/agent/tools.ts";
import type { MessageContext } from "../src/domain.ts";
import { GitHubClient } from "../src/github/client.ts";
import { issueActionMarker, IssueWorkflow } from "../src/issueWorkflow.ts";
import { StateStore } from "../src/state.ts";
import { BOT_ID, catalogRevision, fixedSelection, githubBroker } from "./connectorFixture.ts";
import { repositoryAccess } from "./githubFixtures.ts";

/**
 * Issue writes driven the way the model drives them: `connector_write` through
 * the Broker, the GitHub adapter and the Issue workflow into the real
 * `GitHubClient`, with only GitHub's HTTP surface faked. Every layer between the
 * model's snake_case input and the HTTP request is real, so a field that is
 * renamed on one side only fails here.
 */

const REPOSITORY = "/repos/customer/project";
const PROVENANCE = {
  sourceMessageLink: "https://applink.feishu.cn/client/thread/open?message=om_source",
  requesterName: "Derek",
  participantNames: ["Derek", "Nora"],
};

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  assignees: string[];
  locked: boolean;
  milestone: number | null;
}

/** GitHub's Issue endpoints with enough state for the client's own readbacks. */
class FakeGitHub {
  readonly calls: Call[] = [];
  readonly issues = new Map<number, FakeIssue>();
  readonly milestones = [{ number: 3, title: "v1.0" }];
  readonly eligible = new Set(["nora", "derek"]);
  readonly comments: { issue: number; body: string; url: string }[] = [];
  reject: { status: number; body: unknown } | undefined;
  #next = 100;

  constructor() {
    const issues: (Partial<FakeIssue> & Pick<FakeIssue, "number" | "title">)[] = [
      { number: 12, title: "登录页白屏", labels: ["bug"] },
      { number: 13, title: "导出报表超时", assignees: ["derek"], milestone: 3 },
      { number: 14, title: "旧版图标模糊", state: "closed", stateReason: "completed" },
      { number: 15, title: "讨论区刷屏", locked: true },
    ];
    for (const issue of issues) {
      this.issues.set(issue.number, {
        body: "",
        state: "open",
        stateReason: null,
        labels: [],
        assignees: [],
        locked: false,
        milestone: null,
        ...issue,
      });
    }
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    this.calls.push({ method, path: `${url.pathname}${url.search}`, ...(body === undefined ? {} : { body }) });
    if (method !== "GET" && this.reject) {
      const rejection = this.reject;
      this.reject = undefined;
      return Response.json(rejection.body, { status: rejection.status });
    }
    return this.#respond(method, url, body);
  }) as unknown as typeof fetch;

  writes(): Call[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  #respond(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
    const segments = url.pathname.slice(REPOSITORY.length).split("/").filter(Boolean);
    if (segments[0] === "milestones") return Response.json(this.milestones);
    if (segments[0] !== "issues") throw new Error(`Unexpected GitHub path: ${url.pathname}`);
    if (segments.length === 1) {
      if (method === "POST") {
        const issue: FakeIssue = {
          number: this.#next++, title: String(body?.title), body: String(body?.body),
          state: "open", stateReason: null, labels: [], assignees: [], locked: false, milestone: null,
        };
        this.issues.set(issue.number, issue);
        return Response.json(this.#json(issue), { status: 201 });
      }
      const state = url.searchParams.get("state");
      return Response.json([...this.issues.values()]
        .filter((issue) => state === "all" || issue.state === state)
        .map((issue) => this.#json(issue)));
    }
    const issue = this.issues.get(Number(segments[1]));
    if (!issue) return Response.json({ message: "Not Found" }, { status: 404 });
    switch (segments[2]) {
      case undefined:
        if (method === "PATCH" && body) {
          if (typeof body.title === "string") issue.title = body.title;
          if (typeof body.body === "string") issue.body = body.body;
          if (body.state === "open" || body.state === "closed") issue.state = body.state;
          if ("state_reason" in body) issue.stateReason = body.state_reason as string;
          if ("milestone" in body) issue.milestone = body.milestone as number | null;
        }
        return Response.json(this.#json(issue));
      case "comments": {
        if (method === "GET") return Response.json(this.comments.filter((comment) => comment.issue === issue.number)
          .map((comment) => ({ body: comment.body, html_url: comment.url })));
        const url = `https://github.com/customer/project/issues/${issue.number}#issuecomment-${this.comments.length + 1}`;
        this.comments.push({ issue: issue.number, body: String(body?.body), url });
        return Response.json({ html_url: url }, { status: 201 });
      }
      case "assignees": {
        const logins = (body?.assignees as string[]).map((login) => login.toLowerCase());
        issue.assignees = method === "POST"
          ? [...new Set([...issue.assignees, ...logins.filter((login) => this.eligible.has(login))])]
          : issue.assignees.filter((login) => !logins.includes(login));
        return Response.json(this.#json(issue), { status: method === "POST" ? 201 : 200 });
      }
      case "labels":
        if (method === "POST") issue.labels = [...new Set([...issue.labels, ...(body?.labels as string[])])];
        else issue.labels = issue.labels.filter((label) => label !== decodeURIComponent(segments[3] ?? ""));
        return Response.json(issue.labels.map((name) => ({ name })));
      case "lock":
        issue.locked = method === "PUT";
        return new Response(null, { status: 204 });
      default:
        throw new Error(`Unexpected GitHub path: ${url.pathname}`);
    }
  }

  #json(issue: FakeIssue): Record<string, unknown> {
    const milestone = this.milestones.find((item) => item.number === issue.milestone);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.stateReason,
      html_url: `https://github.com/customer/project/issues/${issue.number}`,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      locked: issue.locked,
      milestone: milestone ?? null,
    };
  }
}

const directories: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Message {
  text: string;
  quote: string;
  turn?: ToolTurnState;
  /** The topic the message belongs to; one fixed thread unless a test moves it. */
  threadKey?: string;
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mochi-issue-writes-"));
  directories.push(directory);
  const state = new StateStore(join(directory, "state.sqlite"));
  stores.push(state);
  const github = new FakeGitHub();
  const access = repositoryAccess(github.fetch);
  const issues = new IssueWorkflow(state, async () => new GitHubClient(access));
  const { broker, connectionId } = githubBroker({
    state, issues, selection: fixedSelection(async () => access),
  });
  const tools = new AgentToolExecutor(broker, BOT_ID);
  let sequence = 0;
  const turnFor = (text: string): ToolTurnState => ({
    mutationCount: 0, sourceText: text, issueOutcome: null, provenance: PROVENANCE,
  });
  /** One `connector_write` from the user message `text`, as the model sends it. */
  async function write(message: Message, input: Record<string, unknown>) {
    sequence += 1;
    const context: MessageContext = {
      chatId: "oc_group", threadKey: message.threadKey ?? "omt_topic", requesterId: "ou_requester",
      sourceMessageId: message.turn ? "om_batch" : `om_${sequence}`,
    };
    const output = await tools.execute("connector_write", {
      connection_id: connectionId,
      resource_id: "repository:20",
      capability_id: "manage.issue",
      catalog_revision: await catalogRevision(broker),
      authorization_quote: message.quote,
      input: JSON.stringify(input),
    }, context, message.turn ?? turnFor(message.text));
    const first = output[0];
    if (first?.type !== "text") throw new Error("Missing text output");
    return JSON.parse(first.text) as {
      status: string;
      readback: { outcome: string; actionId: string; result?: Record<string, unknown> };
    };
  }
  /** The structured refusal the model receives instead of a result. */
  async function refusal(
    message: Message,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> & { text: string }> {
    try {
      await write(message, input);
    } catch (error) {
      const text = (error as Error).message;
      return { ...(JSON.parse(text).error as Record<string, unknown>), text };
    }
    throw new Error("Expected the write to be refused");
  }
  const marker = (actionId: string) => {
    const action = state.getIssueAction(actionId);
    if (!action) throw new Error(`No Issue action ${actionId}`);
    return issueActionMarker(action);
  };
  return { github, state, broker, connectionId, write, refusal, marker, turnFor };
}

const issue = (number: number) => `${REPOSITORY}/issues/${number}`;

describe("connector_write manage.issue reaches GitHub as typed requests", () => {
  const mutations: {
    action: string;
    message: Message;
    input: Record<string, unknown>;
    writes: (marker: string) => Call[];
  }[] = [
    {
      action: "edit",
      message: { text: "把 #12 标题改成“登录页白屏（iOS）”", quote: "把 #12 标题改成“登录页白屏（iOS）”" },
      input: { action: "edit", issue_number: 12, title: "登录页白屏（iOS）", body: "" },
      writes: () => [{ method: "PATCH", path: issue(12), body: { title: "登录页白屏（iOS）" } }],
    },
    {
      action: "comment",
      message: { text: "在 #12 下面补一句：复现步骤已补充", quote: "在 #12 下面补一句" },
      input: { action: "comment", issue_number: 12, body: "复现步骤已补充" },
      writes: (marker) => [{ method: "POST", path: `${issue(12)}/comments`, body: { body: `复现步骤已补充\n\n${marker}` } }],
    },
    {
      action: "assign",
      message: { text: "#12 交给 Nora", quote: "#12 交给 Nora" },
      input: { action: "assign", issue_number: 12, assignees: ["nora"] },
      writes: () => [{ method: "POST", path: `${issue(12)}/assignees`, body: { assignees: ["nora"] } }],
    },
    {
      action: "unassign",
      message: { text: "#13 不用 Derek 跟了", quote: "#13 不用 Derek 跟了" },
      input: { action: "unassign", issue_number: 13, assignees: ["derek"] },
      writes: () => [{ method: "DELETE", path: `${issue(13)}/assignees`, body: { assignees: ["derek"] } }],
    },
    {
      action: "add_labels",
      message: { text: "给 #12 打上 P1", quote: "给 #12 打上 P1" },
      input: { action: "add_labels", issue_number: 12, labels: ["P1"] },
      writes: () => [{ method: "POST", path: `${issue(12)}/labels`, body: { labels: ["P1"] } }],
    },
    {
      action: "remove_labels",
      message: { text: "#12 去掉 bug 标签", quote: "#12 去掉 bug 标签" },
      input: { action: "remove_labels", issue_number: 12, labels: ["bug"] },
      writes: () => [{ method: "DELETE", path: `${issue(12)}/labels/bug` }],
    },
    {
      action: "set_milestone",
      message: { text: "#12 放进 v1.0", quote: "#12 放进 v1.0" },
      input: { action: "set_milestone", issue_number: 12, milestone: "v1.0" },
      writes: () => [{ method: "PATCH", path: issue(12), body: { milestone: 3 } }],
    },
    {
      action: "clear_milestone",
      message: { text: "#13 先不排进版本", quote: "#13 先不排进版本" },
      input: { action: "clear_milestone", issue_number: 13 },
      writes: () => [{ method: "PATCH", path: issue(13), body: { milestone: null } }],
    },
    {
      action: "close",
      message: { text: "#12 修好了，关掉吧", quote: "#12 修好了，关掉吧" },
      input: { action: "close", issue_number: 12, reason: "completed" },
      writes: () => [{ method: "PATCH", path: issue(12), body: { state: "closed", state_reason: "completed" } }],
    },
    {
      action: "reopen",
      message: { text: "#14 又出现了，重新打开", quote: "#14 又出现了，重新打开" },
      input: { action: "reopen", issue_number: 14 },
      writes: () => [{ method: "PATCH", path: issue(14), body: { state: "open" } }],
    },
    {
      action: "lock",
      message: { text: "#12 已解决，锁上讨论", quote: "#12 已解决，锁上讨论" },
      input: { action: "lock", issue_number: 12, reason: "resolved" },
      writes: () => [{ method: "PUT", path: `${issue(12)}/lock`, body: { lock_reason: "resolved" } }],
    },
    {
      action: "unlock",
      message: { text: "#15 可以继续讨论了，解锁", quote: "#15 可以继续讨论了，解锁" },
      input: { action: "unlock", issue_number: 15 },
      writes: () => [{ method: "DELETE", path: `${issue(15)}/lock` }],
    },
  ];

  for (const testCase of mutations) {
    test(`${testCase.action} sends the exact GitHub request and reads it back`, async () => {
      const f = setup();
      const response = await f.write(testCase.message, testCase.input);
      expect(response).toMatchObject({
        status: "applied",
        readback: { outcome: "completed", result: { issueNumber: testCase.input.issue_number } },
      });
      expect(f.github.writes()).toEqual(testCase.writes(f.marker(response.readback.actionId)));
      expect(f.github.calls.some((call) => call.path.includes("undefined"))).toBeFalse();
    });
  }

  test("create posts one attributed Issue and records its marker", async () => {
    const f = setup();
    const body = "## 要解决的问题\n\n周报需要导出 CSV。";
    const response = await f.write(
      { text: "帮我提个 Issue：周报导出 CSV", quote: "帮我提个 Issue" },
      { action: "create", title: "Export weekly report as CSV", body, issue_number: 0, labels: [] },
    );
    expect(response.readback).toMatchObject({ outcome: "completed", result: { issueNumber: 100 } });
    const writes = f.github.writes();
    expect(writes).toEqual([{
      method: "POST", path: `${REPOSITORY}/issues`,
      body: { title: "Export weekly report as CSV", body: expect.any(String) },
    }]);
    const posted = (writes[0]?.body as { body: string }).body;
    expect(posted.startsWith(body)).toBeTrue();
    expect(posted).toContain(PROVENANCE.sourceMessageLink);
    expect(posted.endsWith(f.marker(response.readback.actionId))).toBeTrue();
  });

  test("reuse resolves a duplicate choice without writing", async () => {
    const f = setup();
    const text = "登录页白屏问题提个 Issue";
    const turn = f.turnFor(text);
    const created = await f.write(
      { text, quote: text, turn },
      { action: "create", title: "登录页白屏问题", body: "iOS 上打开登录页白屏。" },
    );
    expect(created.readback).toMatchObject({
      outcome: "waiting",
      result: { duplicateCandidates: [{ number: 12 }] },
    });
    // The pending choice is what the reply's waiting feedback reports.
    expect(turn.issueOutcome).toBe("waiting");
    const reused = await f.write(
      { text: "就用 #12 吧", quote: "就用 #12 吧" },
      { action: "reuse", issue_number: 12, action_id: created.readback.actionId },
    );
    expect(reused.readback).toMatchObject({ outcome: "completed", result: { issueNumber: 12 } });
    expect(f.github.writes()).toEqual([]);
  });

  test("a duplicate choice made before the conversation moved into a thread is resolved inside it", async () => {
    const f = setup();
    // An @Bot root message opens its topic under its own message id.
    const root = { chatId: "oc_group", threadKey: "om_root", requesterId: "ou_requester", sourceMessageId: "om_root" };
    f.state.resolveTopicIdentity(root.chatId, root.threadKey, [root.threadKey]);
    f.state.claimEvent(root.sourceMessageId, root, true);
    const text = "登录页白屏问题提个 Issue";
    const created = await f.write(
      { text, quote: text, threadKey: "om_root" },
      { action: "create", title: "登录页白屏问题", body: "iOS 上打开登录页白屏。" },
    );
    expect(created.readback).toMatchObject({ outcome: "waiting", result: { duplicateCandidates: [{ number: 12 }] } });
    // The first reply in the thread carries Feishu's thread id, which becomes the topic key.
    expect(f.state.resolveTopicIdentity("oc_group", "omt_topic", ["omt_topic", "om_root", "om_reply"]))
      .toEqual({ threadKey: "omt_topic", active: true });
    const reused = await f.write(
      { text: "就用 #12 吧", quote: "就用 #12 吧", threadKey: "omt_topic" },
      { action: "reuse", issue_number: 12 },
    );
    expect(reused.readback).toMatchObject({ outcome: "completed", result: { issueNumber: 12 } });
    expect(f.state.getIssueAction(created.readback.actionId)).toMatchObject({
      chatId: "oc_group", threadKey: "omt_topic", status: "cancelled",
    });
    expect(f.github.writes()).toEqual([]);
  });

  test("force_create creates despite a duplicate candidate", async () => {
    const f = setup();
    const created = await f.write(
      { text: "登录页白屏问题提个 Issue", quote: "登录页白屏问题提个 Issue" },
      { action: "create", title: "登录页白屏问题", body: "iOS 上打开登录页白屏。" },
    );
    expect(created.readback.outcome).toBe("waiting");
    const forced = await f.write(
      { text: "不是一回事，单独建一个", quote: "不是一回事，单独建一个" },
      { action: "force_create", action_id: created.readback.actionId },
    );
    expect(forced.readback).toMatchObject({ outcome: "completed", result: { issueNumber: 100 } });
    expect(f.github.writes()).toEqual([{
      method: "POST", path: `${REPOSITORY}/issues`,
      body: { title: "登录页白屏问题", body: expect.any(String) },
    }]);
  });

  test("a create retried from a later message surfaces the first Issue instead of a second one", async () => {
    // A turn that timed out after its write landed leaves the user to say
    // "继续". That message has its own idempotency key, so the protection is the
    // duplicate review: the same content is an exact title match.
    const f = setup();
    const input = { action: "create", title: "Export weekly report as CSV", body: "周报需要导出 CSV。" };
    const first = await f.write({ text: "帮我提个 Issue：周报导出 CSV", quote: "帮我提个 Issue" }, input);
    expect(first.readback.result).toMatchObject({ issueNumber: 100 });
    const retried = await f.write({ text: "继续", quote: "继续" }, input);
    expect(retried.readback).toMatchObject({
      outcome: "waiting",
      result: { duplicateCandidates: [{ number: 100, score: 1 }] },
    });
    expect(f.github.writes().filter((call) => call.path === `${REPOSITORY}/issues`)).toHaveLength(1);
  });
});

describe("refused Issue writes tell the model what to correct", () => {
  test("a write without the host's chat identity is refused before any GitHub request", async () => {
    const f = setup();
    await expect(f.broker.write({
      botId: BOT_ID, sourceMessageId: "om_unscoped", sourceText: "#12 交给 Nora",
      topicKey: "omt_topic", requesterId: "ou_requester",
    }, {
      connectionId: f.connectionId, resourceId: "repository:20", capabilityId: "manage.issue",
      catalogRevision: await catalogRevision(f.broker),
      input: { action: "assign", issue_number: 12, assignees: ["nora"] },
      authorizationQuote: "#12 交给 Nora", idempotencyKey: "connector-write-unscoped",
    })).rejects.toMatchObject({ code: "authorization_missing" });
    expect(f.github.calls).toEqual([]);
  });

  test("a missing target is refused with its field before any GitHub request", async () => {
    const f = setup();
    const message = { text: "把标题改成登录页白屏（iOS）", quote: "把标题改成登录页白屏（iOS）" };
    expect(await f.refusal(message, { action: "edit", title: "登录页白屏（iOS）" }))
      .toMatchObject({ code: "input_invalid", field: "input.issue_number" });
    expect(await f.refusal(message, { action: "edit", issue_number: 12 }))
      .toMatchObject({ code: "input_invalid", field: "input.title" });
    expect(await f.refusal({ text: "#12 关掉", quote: "#12 关掉" }, { action: "close", issue_number: 12 }))
      .toMatchObject({ code: "input_invalid", field: "input.reason" });
    expect(f.github.calls).toEqual([]);
  });

  test("a field the action does not use is refused rather than dropped", async () => {
    const f = setup();
    expect(await f.refusal(
      { text: "#12 关掉并打上 P1", quote: "#12 关掉并打上 P1" },
      { action: "close", issue_number: 12, reason: "completed", labels: ["P1"] },
    )).toMatchObject({ code: "input_invalid", field: "input.labels" });
    expect(await f.refusal(
      { text: "#12 关掉", quote: "#12 关掉" },
      { action: "close", issue_number: 12, reason: "completed", authorization_quote: "#12 关掉" },
    )).toMatchObject({ code: "input_invalid", field: "input.authorization_quote" });
    expect(f.github.calls).toEqual([]);
  });

  test("a quote must have substance and name the same Issue it authorizes", async () => {
    const f = setup();
    // The review probe: a question about #12 cannot close it on "看看".
    expect(await f.refusal(
      { text: "看看 #12 现在是什么情况", quote: "看看" },
      { action: "close", issue_number: 12, reason: "completed" },
    )).toMatchObject({ code: "authorization_too_short", field: "authorization_quote" });
    expect(await f.refusal(
      { text: "把 #12 关掉", quote: "把 #12 关掉" },
      { action: "close", issue_number: 13, reason: "completed" },
    )).toMatchObject({ code: "authorization_target_mismatch", field: "authorization_quote" });
    expect(f.github.calls).toEqual([]);
    // A target found from evidence rather than named by number stays the model's call.
    const response = await f.write(
      { text: "导出报表超时那个已经修好了，关掉吧", quote: "导出报表超时那个已经修好了，关掉吧" },
      { action: "close", issue_number: 13, reason: "completed" },
    );
    expect(response.readback.outcome).toBe("completed");
  });

  test("a GitHub validation failure carries its sanitized reason", async () => {
    const f = setup();
    f.github.reject = {
      status: 422,
      body: {
        message: "Validation Failed for ghp_redactme00000000 at https://user:secret@api.github.com/labels?access_token=leak",
        errors: [{ resource: "Label", field: "name", code: "invalid" }, { resource: "Label", field: "bad field!", code: "x" }],
        documentation_url: "https://docs.github.com/rest",
      },
    };
    const failure = await f.refusal(
      { text: "给 #12 打上 P1", quote: "给 #12 打上 P1" },
      { action: "add_labels", issue_number: 12, labels: ["P1"] },
    );
    expect(failure).toMatchObject({
      code: "provider_request_failed",
      provider: {
        status: 422,
        code: "request_invalid",
        message: "Validation Failed for [redacted] at https://api.github.com/labels",
        errors: [{ resource: "Label", field: "name", code: "invalid" }, { resource: "Label", code: "x" }],
      },
    });
    for (const secret of ["ghp_", "secret", "access_token", "leak", "docs.github.com"]) {
      expect(String(failure.text)).not.toContain(secret);
    }
  });

  test("an argument the repository cannot serve is an input problem, not an adapter failure", async () => {
    const f = setup();
    const failure = await f.refusal(
      { text: "#12 放进 v9", quote: "#12 放进 v9" },
      { action: "set_milestone", issue_number: 12, milestone: "v9" },
    );
    expect(failure.code).toBe("input_invalid");
    expect(String(failure.message)).toContain("v9");
    expect(f.github.writes()).toEqual([]);
  });
});

describe("per-message write budget", () => {
  test(`allows ${CONNECTOR_WRITES_PER_MESSAGE} writes from one message and refuses the next`, async () => {
    const f = setup();
    const text = "把 #12 打上 L1 到 L11 这些标签";
    const turn = f.turnFor(text);
    for (let index = 1; index <= CONNECTOR_WRITES_PER_MESSAGE; index += 1) {
      await f.write({ text, quote: text, turn }, { action: "add_labels", issue_number: 12, labels: [`L${index}`] });
    }
    expect(f.github.writes()).toHaveLength(CONNECTOR_WRITES_PER_MESSAGE);
    expect(turn.issueOutcome).toBe("completed");
    expect(await f.refusal({ text, quote: text, turn }, { action: "add_labels", issue_number: 12, labels: ["L11"] }))
      .toMatchObject({ code: "write_budget_exhausted" });
    expect(turn.issueOutcome).toBe("blocked");
    expect(f.github.writes()).toHaveLength(CONNECTOR_WRITES_PER_MESSAGE);
    // The next message carries its own authorization and its own budget.
    await f.write({ text: "继续", quote: "继续" }, { action: "add_labels", issue_number: 12, labels: ["L11"] });
    expect(f.github.writes()).toHaveLength(CONNECTOR_WRITES_PER_MESSAGE + 1);
  });
});
