import { createHash, randomBytes } from "node:crypto";
import type { IssueAction, IssueActionDecision, IssueMutation, MessageContext } from "./domain.ts";
import type {
  CreatedIssue,
  IssueCandidate,
  IssueMutationResult,
} from "./github/client.ts";
import { appendProvenance } from "./issueProvenance.ts";
import { issueOverlapScore } from "./issueSimilarity.ts";
import type { StateStore } from "./state.ts";
import type { GitHubRepositoryScope } from "./github/repository.ts";

const ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
// These are retrieval bounds, not a decision that an Issue is a duplicate. The
// model receives the candidates and decides whether to reuse or create.
const DUPLICATE_RETRIEVAL_MIN_SCORE = 0.14;
const DUPLICATE_RETRIEVAL_LIMIT = 3;
const DUPLICATE_BODY_EXCERPT_LENGTH = 1_200;
export type WorkflowOutcome = "completed" | "waiting" | "blocked";

/** null means no Issue workflow was invoked; it says nothing about task completion. */
export function mergeIssueOutcomes(
  current: WorkflowOutcome | null,
  next: WorkflowOutcome | null,
): WorkflowOutcome | null {
  if (current === null) return next;
  if (next === null) return current;
  const rank: Record<WorkflowOutcome, number> = { completed: 0, waiting: 1, blocked: 2 };
  return rank[next] > rank[current] ? next : current;
}

export interface IssueActionResponse {
  outcome: WorkflowOutcome;
  message: string;
  actionId: string;
  result?: Record<string, unknown>;
}

export interface IssueRepository {
  readonly fullName: string;
  createIssue(title: string, body: string): Promise<CreatedIssue>;
  findIssueByMarker(marker: string, sinceMilliseconds: number): Promise<CreatedIssue | undefined>;
  listOpenIssueCandidates(): Promise<IssueCandidate[]>;
  applyIssueMutation(
    mutation: Exclude<IssueMutation, { kind: "create" }>,
    marker: string,
  ): Promise<IssueMutationResult>;
}

export class IssueWorkflow {
  readonly #state: StateStore;
  readonly #repository: (scope: GitHubRepositoryScope) => Promise<IssueRepository>;

  constructor(state: StateStore, repository: (scope: GitHubRepositoryScope) => Promise<IssueRepository>) {
    this.#state = state;
    this.#repository = repository;
  }

  /**
   * Executes one typed mutation, or returns duplicate candidates for a create.
   *
   * Authorization is proven before this is reached: the connector Broker checks
   * the current-message quote and the GitHub adapter holds it to the target, so
   * this owns only the audit, duplicate choice, execution and readback.
   */
  async submit(
    context: MessageContext,
    mutation: IssueMutation,
    scope: GitHubRepositoryScope,
  ): Promise<IssueActionResponse> {
    const github = await this.#repository(scope);
    const now = Date.now();
    const action = this.#state.saveIssueAction({
      id: randomBytes(4).toString("hex"),
      repositoryScope: scope,
      repositoryFullName: github.fullName,
      chatId: context.chatId,
      threadKey: context.threadKey,
      proposedBy: context.requesterId,
      proposalMessageId: context.sourceMessageId,
      mutation,
      fingerprint: mutationFingerprint(mutation, scope),
      status: "executing",
      createdAt: now,
      updatedAt: now,
    });

    if (action.status === "completed") return completedResponse(action);
    if (action.status === "awaiting_choice") return duplicateChoiceResponse(action);
    if (action.status === "executing" && mutation.kind === "create" && !duplicateCheckCompleted(action)) {
      const duplicates = await this.#findDuplicates(mutation, scope);
      if (duplicates.length > 0) {
        this.#state.markIssueActionAwaitingChoice(action.id, { duplicateCandidates: duplicates });
        return duplicateChoiceResponse(this.#state.getIssueAction(action.id) as IssueAction);
      }
      this.#state.updateIssueActionResult(action.id, { duplicateCandidates: [], checkedAt: Date.now() });
    }
    if (action.status === "executing") return this.#execute(action);
    return {
      outcome: action.status === "failed" ? "blocked" : "waiting",
      actionId: action.id,
      message: `Issue 操作 ${action.id} 当前状态为 ${action.status}。`,
    };
  }

  async resolve(
    context: MessageContext,
    decision: IssueActionDecision,
    scope: GitHubRepositoryScope,
  ): Promise<IssueActionResponse> {
    const selected = this.#selectAction(context, decision.actionId, scope);
    if ("message" in selected) {
      return { outcome: "waiting", actionId: decision.actionId ?? "", message: selected.message };
    }
    const action = selected.action;
    if (stableJson(action.repositoryScope) !== stableJson(scope)) {
      return { outcome: "blocked", actionId: action.id, message: "此操作的项目授权已改变，请重新发起。" };
    }
    await this.#repository(action.repositoryScope);
    if (Date.now() - action.createdAt > ACTION_TTL_MS) {
      return { outcome: "blocked", actionId: action.id, message: `Issue 操作 ${action.id} 已过期，请重新发起。` };
    }
    if (action.status === "completed") return completedResponse(action);

    if (decision.kind === "force_create" && (
      action.mutation.kind !== "create" || action.status !== "awaiting_choice"
    )) {
      return {
        outcome: "blocked",
        actionId: action.id,
        message: `Issue 操作 ${action.id} 不是等待“仍然创建”选择的新建操作。`,
      };
    }

    if (decision.kind === "reuse") {
      if (action.status !== "awaiting_choice") {
        return { outcome: "blocked", actionId: action.id, message: `Issue 操作 ${action.id} 当前没有待选择的重复项。` };
      }
      const candidate = duplicateCandidates(action).find((item) => item.number === decision.issueNumber);
      if (!candidate) {
        return { outcome: "blocked", actionId: action.id, message: `#${decision.issueNumber} 不在候选重复 Issue 中。` };
      }
      this.#state.cancelIssueActionForDuplicate(action.id, {
        reusedIssueNumber: candidate.number,
        reusedIssueUrl: candidate.htmlUrl,
      });
      return {
        outcome: "completed",
        actionId: action.id,
        message: `已取消新建，复用 [#${candidate.number}](${candidate.htmlUrl})。`,
        result: { issueNumber: candidate.number, issueUrl: candidate.htmlUrl, summary: "已复用现有 Issue" },
      };
    }

    if (action.status === "awaiting_choice" && decision.kind !== "force_create") {
      return duplicateChoiceResponse(action);
    }

    if (action.mutation.kind === "create" && decision.kind !== "force_create" && !duplicateCheckCompleted(action)) {
      const duplicates = await this.#findDuplicates(action.mutation, action.repositoryScope);
      if (duplicates.length > 0) {
        this.#state.markIssueActionAwaitingChoice(action.id, { duplicateCandidates: duplicates });
        return duplicateChoiceResponse(this.#state.getIssueAction(action.id) as IssueAction);
      }
      this.#state.updateIssueActionResult(action.id, { duplicateCandidates: [], checkedAt: Date.now() });
    }

    if (action.status === "executing" && Date.now() - action.updatedAt < 2 * 60_000) {
      return { outcome: "waiting", actionId: action.id, message: `Issue 操作 ${action.id} 正在执行。` };
    }
    const began = this.#state.beginIssueActionForDuplicate(action.id);
    if (!began) {
      const current = this.#state.getIssueAction(action.id);
      if (current?.status === "completed") return completedResponse(current);
      return { outcome: "blocked", actionId: action.id, message: `Issue 操作 ${action.id} 当前无法执行。` };
    }
    return this.#execute(this.#state.getIssueAction(action.id) as IssueAction);
  }

  async #execute(action: IssueAction): Promise<IssueActionResponse> {
    const marker = issueActionMarker(action);
    try {
      const github = await this.#repository(action.repositoryScope);
      let result: Record<string, unknown>;
      if (action.mutation.kind === "create") {
        const existing = await github.findIssueByMarker(marker, action.createdAt);
        const issue = existing ?? await github.createIssue(
          action.mutation.title,
          `${appendProvenance(action.mutation.body, action.mutation.provenance, "飞书原消息")}\n\n${marker}`,
        );
        const assignees = action.mutation.assignees ?? [];
        const assignment = assignees.length > 0
          ? await github.applyIssueMutation(
            { kind: "assign", issueNumber: issue.number, assignees },
            marker,
          )
          : undefined;
        result = {
          issueNumber: issue.number,
          issueUrl: issue.htmlUrl,
          summary: `${existing ? "Issue 已存在" : "Issue 已创建"}${assignment ? `，${assignment.summary}` : ""}`,
          ...(assignment ? { assignmentSummary: assignment.summary } : {}),
        };
      } else {
        const applied = await github.applyIssueMutation(action.mutation, marker);
        result = {
          issueNumber: applied.number,
          issueUrl: applied.htmlUrl,
          summary: applied.summary,
          ...(applied.commentUrl ? { commentUrl: applied.commentUrl } : {}),
        };
      }
      this.#state.completeIssueAction(action.id, result);
      return {
        outcome: "completed",
        actionId: action.id,
        result,
        message: formatCompletedResult(result),
      };
    } catch (error) {
      this.#state.failIssueAction(action.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  #selectAction(
    context: MessageContext,
    id: string | undefined,
    scope: GitHubRepositoryScope,
  ): { action: IssueAction } | { message: string } {
    if (id) {
      const action = this.#state.getIssueAction(id);
      if (!action) return { message: `未找到 Issue 操作 ${id}。` };
      if (action.chatId !== context.chatId || action.threadKey !== context.threadKey
        || action.repositoryScope.repositoryId !== scope.repositoryId) {
        return { message: `Issue 操作 ${id} 不属于当前飞书话题。` };
      }
      return { action };
    }
    const choices = this.#state.awaitingIssueActions(context.chatId, context.threadKey)
      .filter((action) => action.repositoryScope.repositoryId === scope.repositoryId);
    if (choices.length === 0) return { message: "当前话题没有待处理的重复 Issue 选择。" };
    if (choices.length > 1) {
      return {
        message: `当前话题有 ${choices.length} 个待处理的重复选择，请带上编号：${choices.map((item) => `\`${item.id}\``).join("、")}。`,
      };
    }
    return { action: choices[0] as IssueAction };
  }

  async #findDuplicates(mutation: Extract<IssueMutation, { kind: "create" }>, scope: GitHubRepositoryScope): Promise<DuplicateCandidate[]> {
    const candidates = await (await this.#repository(scope)).listOpenIssueCandidates();
    return candidates
      .map((candidate) => ({ ...candidate, score: issueOverlapScore(mutation, candidate) }))
      .filter((candidate) => candidate.score >= DUPLICATE_RETRIEVAL_MIN_SCORE)
      .sort((left, right) => right.score - left.score)
      .slice(0, DUPLICATE_RETRIEVAL_LIMIT)
      .map((candidate) => ({
        number: candidate.number,
        title: candidate.title,
        htmlUrl: candidate.htmlUrl,
        score: Math.round(candidate.score * 100) / 100,
        bodyExcerpt: boundedBodyExcerpt(candidate.body),
      }));
  }
}

interface DuplicateCandidate {
  number: number;
  title: string;
  htmlUrl: string;
  score: number;
  bodyExcerpt?: string;
}

function duplicateChoiceResponse(action: IssueAction): IssueActionResponse {
  const candidates = duplicateCandidates(action);
  const lines = candidates.map((candidate) => `- [#${candidate.number} ${candidate.title}](${candidate.htmlUrl})`).join("\n");
  return {
    outcome: "waiting",
    actionId: action.id,
    result: { duplicateCandidates: candidates },
    message: `新建操作 \`${action.id}\` 与现有开放 Issue 可能重叠：\n\n${lines}\n\n模型应结合当前上下文调用 reuse 或 force_create；只有无法判断时才向用户询问。`,
  };
}

function duplicateCandidates(action: IssueAction): DuplicateCandidate[] {
  const value = action.result?.duplicateCandidates;
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): DuplicateCandidate[] => {
    if (
      typeof candidate !== "object"
      || candidate === null
      || typeof candidate.number !== "number"
      || typeof candidate.title !== "string"
      || typeof candidate.htmlUrl !== "string"
      || typeof candidate.score !== "number"
      || (candidate.bodyExcerpt !== undefined && typeof candidate.bodyExcerpt !== "string")
    ) return [];
    return [candidate as DuplicateCandidate];
  });
}

function boundedBodyExcerpt(body: string): string {
  const excerpt = body.trim();
  return excerpt.length <= DUPLICATE_BODY_EXCERPT_LENGTH
    ? excerpt
    : `${excerpt.slice(0, DUPLICATE_BODY_EXCERPT_LENGTH)}…`;
}

function duplicateCheckCompleted(action: IssueAction): boolean {
  return Array.isArray(action.result?.duplicateCandidates);
}

function completedResponse(action: IssueAction): IssueActionResponse {
  const result = action.result ?? {};
  return {
    outcome: "completed",
    actionId: action.id,
    result,
    message: formatCompletedResult(result),
  };
}

function formatCompletedResult(result: Record<string, unknown>): string {
  const summary = typeof result.summary === "string" ? result.summary : "Issue 操作已完成";
  const issueNumber = typeof result.issueNumber === "number" ? result.issueNumber : undefined;
  const issueUrl = typeof result.issueUrl === "string" ? result.issueUrl : undefined;
  const commentUrl = typeof result.commentUrl === "string" ? result.commentUrl : undefined;
  if (commentUrl) return `${summary}：[查看评论](${commentUrl})`;
  if (issueNumber && issueUrl) return `${summary}：[${`#${issueNumber}`}](${issueUrl})`;
  return summary;
}

export function issueActionMarker(action: Pick<IssueAction, "id" | "fingerprint">): string {
  return `<!-- mochi-issue-action:${action.id}:${action.fingerprint} -->`;
}

function mutationFingerprint(mutation: IssueMutation, scope: GitHubRepositoryScope): string {
  return createHash("sha256").update(stableJson({ mutation, scope })).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export { ACTION_TTL_MS };
