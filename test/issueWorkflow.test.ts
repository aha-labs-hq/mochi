import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueMutation, MessageContext } from "../src/domain.ts";
import type { IssueCandidate, IssueMutationResult } from "../src/github/client.ts";
import { issueActionMarker, IssueWorkflow, type IssueRepository } from "../src/issueWorkflow.ts";
import { StateStore } from "../src/state.ts";

import { repositoryScope as scope } from "./githubFixtures.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeIssues implements IssueRepository {
  readonly fullName = "customer/project";
  creates: Array<{ title: string; body: string }> = [];
  mutations: Array<{ mutation: Exclude<IssueMutation, { kind: "create" }>; marker: string }> = [];
  candidates: IssueCandidate[] = [];
  existing?: { number: number; htmlUrl: string };

  async createIssue(title: string, body: string): Promise<{ number: number; htmlUrl: string }> {
    this.creates.push({ title, body });
    return { number: 73, htmlUrl: "https://github.com/customer/project/issues/73" };
  }

  async findIssueByMarker(): Promise<{ number: number; htmlUrl: string } | undefined> {
    return this.existing;
  }

  async listOpenIssueCandidates(): Promise<IssueCandidate[]> {
    return this.candidates;
  }

  async applyIssueMutation(
    mutation: Exclude<IssueMutation, { kind: "create" }>,
    marker: string,
  ): Promise<IssueMutationResult> {
    this.mutations.push({ mutation, marker });
    return {
      number: mutation.issueNumber,
      htmlUrl: `https://github.com/customer/project/issues/${mutation.issueNumber}`,
      summary: mutation.kind === "assign" ? "负责人已添加" : "Issue 操作已完成",
    };
  }
}

const context: MessageContext = {
  chatId: "oc_chat",
  threadKey: "omt_thread",
  requesterId: "ou_requester",
  sourceMessageId: "om_source",
};

function setup(): { state: StateStore; issues: FakeIssues; workflow: IssueWorkflow } {
  const directory = mkdtempSync(join(tmpdir(), "mochi-issue-"));
  directories.push(directory);
  const state = new StateStore(join(directory, "state.sqlite"));
  const issues = new FakeIssues();
  return { state, issues, workflow: new IssueWorkflow(state, async () => issues) };
}

describe("issue workflow", () => {
  test("executes a requested write immediately within its verified project scope", async () => {
    const { state, issues, workflow } = setup();
    const result = await workflow.submit(context, { kind: "create", title: "Scoped", body: "Body" }, scope);
    expect(result.outcome).toBe("completed");
    expect(state.getIssueAction(result.actionId)).toMatchObject({
      status: "completed",
      repositoryScope: scope,
      proposedBy: context.requesterId,
    });
    expect(issues.creates).toHaveLength(1);
    state.close();
  });

  test("identical requests in different projects have separate audit identities", async () => {
    const { state, issues, workflow } = setup();
    const mutation = { kind: "create", title: "Same words", body: "Different scope" } as const;
    const first = await workflow.submit(context, mutation, scope);
    const second = await workflow.submit(context, mutation, { ...scope, repositoryId: 21 });
    expect(first.actionId).not.toBe(second.actionId);
    expect(state.getIssueAction(first.actionId)?.repositoryScope.repositoryId).toBe(scope.repositoryId);
    expect(state.getIssueAction(second.actionId)?.repositoryScope.repositoryId).toBe(21);
    expect(issues.creates).toHaveLength(2);
    state.close();
  });
  test("executes a typed create once and keeps the requester audit trail", async () => {
    const { state, issues, workflow } = setup();
    const preview = await workflow.submit(
      context,
      {
        kind: "create",
        title: "Fix the boundary",
        body: "## Context\n\nKeep it narrow.",
        provenance: {
          sourceMessageLink: "https://applink.feishu.cn/client/thread/open?message=om_source",
          requesterName: "Derek",
          participantNames: ["Sherry", "Derek"],
        },
      },
      scope,
    );
    expect(preview.outcome).toBe("completed");
    const created = preview;
    expect(created.result?.issueNumber).toBe(73);
    expect(issues.creates).toHaveLength(1);
    const action = state.getIssueAction(preview.actionId)!;
    expect(issues.creates[0]?.body).toContain(issueActionMarker(action));
    expect(issues.creates[0]?.body).toContain("## 讨论来源");
    expect(issues.creates[0]?.body).toContain("参与讨论：Sherry、Derek");
    expect(action).toMatchObject({
      proposedBy: "ou_requester",
      proposalMessageId: "om_source",
      status: "completed",
    });

    const repeated = await workflow.submit(
      context,
      {
        kind: "create",
        title: "Fix the boundary",
        body: "## Context\n\nKeep it narrow.",
        provenance: {
          sourceMessageLink: "https://applink.feishu.cn/client/thread/open?message=om_source",
          requesterName: "Derek",
          participantNames: ["Sherry", "Derek"],
        },
      },
      scope,
    );
    expect(repeated.result?.issueNumber).toBe(73);
    expect(issues.creates).toHaveLength(1);
    state.close();
  });

  test("supports compound requests as multiple typed actions in the same agent turn", async () => {
    const { state, issues, workflow } = setup();
    const created = await workflow.submit(
      context,
      { kind: "create", title: "Compound", body: "Body" },
      scope,
    );
    expect(created.outcome).toBe("completed");
    const compoundContext = { ...context, sourceMessageId: "om_compound" };
    const assigned = await workflow.submit(
      compoundContext,
      { kind: "assign", issueNumber: 73, assignees: ["DuDoo97"] },
      scope,
    );
    expect(assigned.outcome).toBe("completed");
    expect(issues.mutations[0]?.mutation).toEqual({
      kind: "assign",
      issueNumber: 73,
      assignees: ["DuDoo97"],
    });
    state.close();
  });

  test("keeps assignment attached to a create action instead of dropping it", async () => {
    const { state, issues, workflow } = setup();
    const created = await workflow.submit(
      context,
      { kind: "create", title: "Assigned issue", body: "Body", assignees: ["DuDoo97"] },
      scope,
    );
    expect(created.outcome).toBe("completed");
    expect(created.message).toContain("负责人已添加");
    expect(issues.creates).toHaveLength(1);
    expect(issues.mutations).toContainEqual({
      mutation: { kind: "assign", issueNumber: 73, assignees: ["DuDoo97"] },
      marker: expect.any(String),
    });
    state.close();
  });

  test("stops an overlapping create and lets the model choose reuse or creation", async () => {
    const { state, issues, workflow } = setup();
    issues.candidates = [{
      number: 820,
      title: "优化邀请码奖励文案与展示层级",
      body: "注册页提示邀请码，准确说明 7 天 Plus 奖励条件。",
      htmlUrl: "https://github.com/customer/project/issues/820",
    }];
    const preview = await workflow.submit(
      context,
      { kind: "create", title: "在注册页显著提示邀请码福利", body: "准确说明 7 天 Plus 条件。" },
      scope,
    );
    expect(preview).toMatchObject({ outcome: "waiting" });
    expect(preview.message).toContain("#820");
    expect(preview.result).toMatchObject({
      duplicateCandidates: [{ number: 820, bodyExcerpt: "注册页提示邀请码，准确说明 7 天 Plus 奖励条件。" }],
    });
    expect(issues.creates).toHaveLength(0);

    const reused = await workflow.resolve(context, { kind: "reuse", issueNumber: 820 }, scope);
    expect(reused).toMatchObject({ outcome: "completed", result: { issueNumber: 820 } });
    expect(state.getIssueAction(preview.actionId)).toMatchObject({ status: "cancelled" });
    expect(issues.creates).toHaveLength(0);
    state.close();
  });

  test("lets the model choose force-create for an overlapping request", async () => {
    const { state, issues, workflow } = setup();
    issues.candidates = [{
      number: 820,
      title: "优化邀请码奖励文案与展示层级",
      body: "注册页提示邀请码，准确说明 7 天 Plus 奖励条件。",
      htmlUrl: "https://github.com/customer/project/issues/820",
    }];
    const preview = await workflow.submit(
      context,
      { kind: "create", title: "在注册页显著提示邀请码福利", body: "准确说明 7 天 Plus 条件。" },
      scope,
    );

    const created = await workflow.resolve(
      { ...context, sourceMessageId: "om_force" },
      { kind: "force_create", actionId: preview.actionId },
      scope,
    );
    expect(created).toMatchObject({ outcome: "completed", result: { issueNumber: 73 } });
    expect(issues.creates).toHaveLength(1);
    state.close();
  });

  test("executes a model-selected reversible assignment directly", async () => {
    const { state, issues, workflow } = setup();
    const response = await workflow.submit(
      context,
      { kind: "assign", issueNumber: 820, assignees: ["cesigoo814-png"] },
      scope,
    );
    expect(response).toMatchObject({ outcome: "completed" });
    expect(issues.mutations).toHaveLength(1);
    expect(state.getIssueAction(response.actionId)).toMatchObject({
      status: "completed",
      proposedBy: "ou_requester",
    });

    const typed = await workflow.submit(
      { ...context, sourceMessageId: "om_ambiguous" },
      { kind: "assign", issueNumber: 820, assignees: ["cesigoo814-png"] },
      scope,
    );
    expect(typed.outcome).toBe("completed");
    expect(issues.mutations).toHaveLength(2);
    state.close();
  });

  test("reconciles an already-created Issue before issuing another write", async () => {
    const { state, issues, workflow } = setup();
    issues.existing = { number: 88, htmlUrl: "https://github.com/customer/project/issues/88" };
    const result = await workflow.submit(
      context,
      { kind: "create", title: "Recovered issue", body: "Recovered body" },
      scope,
    );
    expect(result.result?.issueNumber).toBe(88);
    expect(issues.creates).toHaveLength(0);
    expect(state.getIssueAction(result.actionId)?.status).toBe("completed");
    state.close();
  });

  test("contains no regular expression in the user-intent boundary", async () => {
    const files = [
      "src/app.ts",
      "src/eventPolicy.ts",
      "src/agent/tools.ts",
      "src/issueWorkflow.ts",
    ];
    const forbidden = [
      "RegExp",
      ".exec(",
      ".match(",
      ".matchAll(",
      ".replace(",
      ".search(",
      ".split(",
      ".test(",
    ];
    for (const file of files) {
      const text = await Bun.file(join(import.meta.dir, "..", file)).text();
      expect(forbidden.filter((token) => text.includes(token))).toEqual([]);
    }
  });
});
