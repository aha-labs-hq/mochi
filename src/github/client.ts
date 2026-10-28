import { Buffer } from "node:buffer";
import type { IssueMutation } from "../domain.ts";
import type { GitHubRepositoryAccess } from "./botAccess.ts";

type JsonRecord = Record<string, unknown>;

export interface CreatedIssue {
  number: number;
  htmlUrl: string;
}

export interface IssueCandidate extends CreatedIssue {
  title: string;
  body: string;
}

export interface IssueMutationResult extends CreatedIssue {
  summary: string;
  commentUrl?: string;
}

/**
 * A request GitHub cannot serve as asked, for a reason the caller can correct:
 * the number names a pull request, a milestone title matches nothing, an
 * assignee was not applied. Transport, grant and provider failures keep their
 * own types, so this never describes an outage as a wrong argument.
 */
export class GitHubOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubOperationError";
  }
}

export class GitHubClient {
  constructor(readonly access: GitHubRepositoryAccess) {}

  get fullName(): string { return this.access.fullName; }

  async repositoryOverview(): Promise<unknown> {
    const repo = await this.#read(`/repos/${this.access.fullName}`);
    return pick(repo, [
      "full_name", "private", "description", "html_url", "default_branch", "language",
      "open_issues_count", "archived", "pushed_at", "updated_at",
    ]);
  }

  async listIssues(args: JsonRecord): Promise<unknown> {
    const state = enumValue(args.state, ["open", "closed", "all"], "open");
    const limit = intValue(args.limit, 20, 1, 50);
    const labels = optionalString(args.labels, 200);
    const issues: unknown[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 10 && issues.length < limit; page += 1) {
      const query = params({
        state,
        per_page: pageSize,
        page,
        sort: "created",
        direction: "desc",
        ...(labels ? { labels } : {}),
      });
      const candidates = asArray(await this.#read(`/repos/${this.access.fullName}/issues?${query}`));
      for (const candidate of candidates) {
        if (!isRecord(candidate) || "pull_request" in candidate) continue;
        issues.push(summaryIssue(candidate));
        if (issues.length === limit) return issues;
      }
      if (candidates.length < pageSize) return issues;
    }
    throw new GitHubOperationError("Issue listing exceeded 1,000 mixed Issue/PR candidates; narrow the query with labels");
  }

  async getIssue(args: JsonRecord): Promise<unknown> {
    const number = intValue(args.number, undefined, 1);
    const issue = await this.#read(`/repos/${this.access.fullName}/issues/${number}`);
    if (isRecord(issue) && "pull_request" in issue) throw new GitHubOperationError(`#${number} is a pull request, not an issue`);
    return detailIssue(issue);
  }

  async listIssueComments(args: JsonRecord): Promise<unknown> {
    const number = intValue(args.number, undefined, 1);
    await this.#assertIssue(number);
    const limit = intValue(args.limit, 30, 1, 100);
    const comments = asArray(await this.#read(
      `/repos/${this.access.fullName}/issues/${number}/comments?${params({ per_page: limit })}`,
    ));
    return comments.map((comment) => compactReferences(pick(comment, [
      "id", "html_url", "body", "user", "author_association", "created_at", "updated_at",
    ])));
  }

  async listLabels(args: JsonRecord): Promise<unknown> {
    const limit = intValue(args.limit, 100, 1, 100);
    const labels = asArray(await this.#read(
      `/repos/${this.access.fullName}/labels?${params({ per_page: limit })}`,
    ));
    return labels.map((label) => pick(label, ["name", "description", "color", "default"]));
  }

  async listMilestones(args: JsonRecord): Promise<unknown> {
    const state = enumValue(args.state, ["open", "closed", "all"], "open");
    const limit = intValue(args.limit, 100, 1, 100);
    const milestones = asArray(await this.#read(
      `/repos/${this.access.fullName}/milestones?${params({ state, per_page: limit })}`,
    ));
    return milestones.map((milestone) => pick(milestone, [
      "number", "title", "description", "state", "open_issues", "closed_issues", "due_on", "html_url",
    ]));
  }

  async listAssignees(args: JsonRecord): Promise<unknown> {
    const limit = intValue(args.limit, 100, 1, 100);
    const assignees = asArray(await this.#read(
      `/repos/${this.access.fullName}/assignees?${params({ per_page: limit })}`,
    ));
    return assignees.map((assignee) => pick(assignee, ["login", "id", "html_url", "type"]));
  }

  async listPullRequests(args: JsonRecord): Promise<unknown> {
    const state = enumValue(args.state, ["open", "closed", "all"], "open");
    const limit = intValue(args.limit, 20, 1, 50);
    const query = params({ state, per_page: limit, sort: "updated", direction: "desc" });
    return asArray(await this.#read(`/repos/${this.access.fullName}/pulls?${query}`)).map(summaryPullRequest);
  }

  async getPullRequest(args: JsonRecord): Promise<unknown> {
    const number = intValue(args.number, undefined, 1);
    const pull = await this.#read(`/repos/${this.access.fullName}/pulls/${number}`);
    return detailPullRequest(pull);
  }

  async getPullRequestFiles(args: JsonRecord): Promise<unknown> {
    const number = intValue(args.number, undefined, 1);
    const limit = intValue(args.limit, 50, 1, 100);
    const files = asArray(await this.#read(
      `/repos/${this.access.fullName}/pulls/${number}/files?${params({ per_page: limit })}`,
    ));
    return files.map((file) => pick(file, [
      "filename", "status", "additions", "deletions", "changes", "blob_url", "raw_url", "patch",
    ]));
  }

  async getCommitChecks(args: JsonRecord): Promise<unknown> {
    const ref = requiredString(args.ref, 200);
    const [checks, status] = await Promise.all([
      this.#read(`/repos/${this.access.fullName}/commits/${encodeURIComponent(ref)}/check-runs?${params({ per_page: 100 })}`),
      this.#read(`/repos/${this.access.fullName}/commits/${encodeURIComponent(ref)}/status`),
    ]);
    const checkRuns = isRecord(checks) ? asArray(checks.check_runs).map((run) => pick(run, [
      "id", "name", "status", "conclusion", "started_at", "completed_at", "details_url", "html_url",
    ])) : [];
    return {
      checkRuns,
      combinedStatus: {
        ...pick(status, ["state", "sha", "total_count"]),
        statuses: asArray(recordValue(status).statuses).map((item) => pick(item, [
          "id", "state", "context", "description", "target_url", "created_at", "updated_at",
        ])),
      },
    };
  }

  async listActionsRuns(args: JsonRecord): Promise<unknown> {
    const limit = intValue(args.limit, 20, 1, 50);
    const branch = optionalString(args.branch, 200);
    const status = optionalString(args.status, 50);
    const query = params({ per_page: limit, ...(branch ? { branch } : {}), ...(status ? { status } : {}) });
    const result = await this.#read(`/repos/${this.access.fullName}/actions/runs?${query}`);
    return isRecord(result)
      ? asArray(result.workflow_runs).map((run) => pick(run, [
          "id", "name", "display_title", "event", "status", "conclusion", "workflow_id", "run_number",
          "head_branch", "head_sha", "html_url", "created_at", "updated_at", "run_started_at",
        ]))
      : [];
  }

  async getActionsRun(args: JsonRecord): Promise<unknown> {
    const runId = intValue(args.run_id, undefined, 1);
    const run = await this.#read(`/repos/${this.access.fullName}/actions/runs/${runId}`);
    return compactReferences(pick(run, [
      "id", "name", "display_title", "event", "status", "conclusion", "workflow_id", "run_number",
      "head_branch", "head_sha", "html_url", "jobs_url", "logs_url", "created_at", "updated_at",
      "run_started_at", "actor", "triggering_actor",
    ]));
  }

  async listActionsJobs(args: JsonRecord): Promise<unknown> {
    const runId = intValue(args.run_id, undefined, 1);
    const result = await this.#read(`/repos/${this.access.fullName}/actions/runs/${runId}/jobs?${params({ per_page: 100 })}`);
    return isRecord(result)
      ? asArray(result.jobs).map((job) => pick(job, [
          "id", "name", "status", "conclusion", "started_at", "completed_at", "html_url", "runner_name", "steps",
        ]))
      : [];
  }

  async getContent(args: JsonRecord): Promise<unknown> {
    const pathInput = typeof args.path === "string" ? args.path.trim() : "";
    const path = safeRepositoryPath(pathInput);
    const ref = optionalString(args.ref, 200);
    const query = ref ? `?${params({ ref })}` : "";
    const encodedPath = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
    const result = await this.#read(
      `/repos/${this.access.fullName}/contents${encodedPath}${query}`,
    );

    if (Array.isArray(result)) {
      return result.map((entry) => pick(entry, ["name", "path", "type", "size", "sha", "html_url", "download_url"]));
    }
    if (!isRecord(result)) return result;
    const metadata = pick(result, ["name", "path", "type", "size", "sha", "html_url", "download_url", "encoding"]);
    if (result.type === "file" && result.encoding === "base64" && typeof result.content === "string") {
      const content = Buffer.from(result.content.replaceAll("\n", ""), "base64").toString("utf8");
      return {
        ...metadata,
        encoding: "utf-8",
        content: content.slice(0, 80_000),
        content_truncated: content.length > 80_000,
        total_characters: content.length,
      };
    }
    return metadata;
  }

  async listCommits(args: JsonRecord): Promise<unknown> {
    const limit = intValue(args.limit, 20, 1, 50);
    const ref = optionalString(args.ref, 200);
    const path = safeRepositoryPath(optionalString(args.path, 1_000) ?? "");
    const query = params({ per_page: limit, ...(ref ? { sha: ref } : {}), ...(path ? { path } : {}) });
    const commits = asArray(await this.#read(`/repos/${this.access.fullName}/commits?${query}`));
    return commits.map((commit) => {
      if (!isRecord(commit)) return commit;
      const nested = isRecord(commit.commit) ? commit.commit : {};
      return {
        sha: commit.sha,
        html_url: commit.html_url,
        message: nested.message,
        author: pick(nested.author, ["name", "date"]),
        committer: pick(nested.committer, ["name", "date"]),
      };
    });
  }

  async searchCode(args: JsonRecord): Promise<unknown> {
    const query = requiredString(args.query, 500);
    const limit = intValue(args.limit, 20, 1, 50);
    const q = `${query} repo:${this.access.fullName}`;
    const result = await this.#read(`/search/code?${params({ q, per_page: limit })}`);
    return isRecord(result)
      ? asArray(result.items).map(searchCodeMatch)
      : [];
  }

  async listOpenIssueCandidates(): Promise<IssueCandidate[]> {
    const candidates: IssueCandidate[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const query = params({ state: "open", per_page: 100, page, sort: "updated", direction: "desc" });
      const items = asArray(await this.#read(`/repos/${this.access.fullName}/issues?${query}`));
      for (const item of items) {
        if (
          !isRecord(item)
          || "pull_request" in item
          || typeof item.number !== "number"
          || typeof item.title !== "string"
          || typeof item.html_url !== "string"
        ) continue;
        candidates.push({
          number: item.number,
          title: item.title,
          body: typeof item.body === "string" ? item.body : "",
          htmlUrl: item.html_url,
        });
      }
      if (items.length < 100) break;
      if (page === 10) throw new Error("Duplicate review exceeded 1,000 open Issues; operator review required");
    }
    return candidates;
  }

  async createIssue(title: string, body: string): Promise<CreatedIssue> {
    const result = await this.#write(
      `/repos/${this.access.fullName}/issues`,
      "POST",
      { title, body },
    );
    if (!isRecord(result) || typeof result.number !== "number" || typeof result.html_url !== "string") {
      throw new Error("GitHub create issue response is incomplete");
    }
    return { number: result.number, htmlUrl: result.html_url };
  }

  async applyIssueMutation(mutation: Exclude<IssueMutation, { kind: "create" }>, marker: string): Promise<IssueMutationResult> {
    const current = await this.#assertIssue(mutation.issueNumber);
    const issueUrl = requiredResponseString(current.html_url, "GitHub issue URL");

    switch (mutation.kind) {
      case "edit": {
        const result = await this.#write(
          `/repos/${this.access.fullName}/issues/${mutation.issueNumber}`,
          "PATCH",
          { ...(mutation.title ? { title: mutation.title } : {}), ...(mutation.body ? { body: mutation.body } : {}) },
        );
        return mutationResult(result, mutation.issueNumber, issueUrl, "Issue 已更新");
      }
      case "comment": {
        const existing = await this.#findCommentByMarker(mutation.issueNumber, marker);
        if (existing) {
          return {
            number: mutation.issueNumber,
            htmlUrl: issueUrl,
            commentUrl: existing,
            summary: "评论已存在",
          };
        }
        const result = await this.#write(
          `/repos/${this.access.fullName}/issues/${mutation.issueNumber}/comments`,
          "POST",
          { body: `${mutation.body}\n\n${marker}` },
        );
        return {
          number: mutation.issueNumber,
          htmlUrl: issueUrl,
          commentUrl: requiredResponseString(recordValue(result).html_url, "GitHub comment URL"),
          summary: "评论已发布",
        };
      }
      case "assign":
      case "unassign": {
        const existing = new Set(issueAssigneeLogins(current));
        const assignees = mutation.assignees.filter((login) => (
          mutation.kind === "assign" ? !existing.has(login.toLowerCase()) : existing.has(login.toLowerCase())
        ));
        if (assignees.length > 0) {
          await this.#write(
            `/repos/${this.access.fullName}/issues/${mutation.issueNumber}/assignees`,
            mutation.kind === "assign" ? "POST" : "DELETE",
            { assignees },
          );
        }
        // GitHub can accept the request while omitting an ineligible login from
        // the resulting Issue. Read the authoritative Issue after the write so
        // a successful HTTP response cannot be reported as a false assignment.
        const updated = await this.#assertIssue(mutation.issueNumber);
        const actual = new Set(issueAssigneeLogins(updated));
        const missing = mutation.kind === "assign"
          ? mutation.assignees.filter((login) => !actual.has(login.toLowerCase()))
          : mutation.assignees.filter((login) => actual.has(login.toLowerCase()));
        if (missing.length > 0) {
          throw new GitHubOperationError(
            mutation.kind === "assign"
              ? `GitHub did not assign: ${missing.join(", ")}`
              : `GitHub did not remove assignees: ${missing.join(", ")}`,
          );
        }
        return {
          number: mutation.issueNumber,
          htmlUrl: issueUrl,
          summary: mutation.kind === "assign" ? "负责人已添加" : "负责人已移除",
        };
      }
      case "add_labels": {
        const existing = new Set(labelNames(current.labels).map((label) => label.toLowerCase()));
        const labels = mutation.labels.filter((label) => !existing.has(label.toLowerCase()));
        if (labels.length > 0) {
          await this.#write(
            `/repos/${this.access.fullName}/issues/${mutation.issueNumber}/labels`,
            "POST",
            { labels },
          );
        }
        return { number: mutation.issueNumber, htmlUrl: issueUrl, summary: "标签已添加" };
      }
      case "remove_labels": {
        const existing = new Map(labelNames(current.labels).map((label) => [label.toLowerCase(), label]));
        for (const label of mutation.labels) {
          const actual = existing.get(label.toLowerCase());
          if (!actual) continue;
          await this.#write(
            `/repos/${this.access.fullName}/issues/${mutation.issueNumber}/labels/${encodeURIComponent(actual)}`,
            "DELETE",
          );
        }
        return { number: mutation.issueNumber, htmlUrl: issueUrl, summary: "标签已移除" };
      }
      case "set_milestone": {
        const milestone = await this.#resolveMilestone(mutation.milestone);
        const result = await this.#write(
          `/repos/${this.access.fullName}/issues/${mutation.issueNumber}`,
          "PATCH",
          { milestone },
        );
        return mutationResult(result, mutation.issueNumber, issueUrl, "里程碑已设置");
      }
      case "clear_milestone": {
        const result = await this.#write(
          `/repos/${this.access.fullName}/issues/${mutation.issueNumber}`,
          "PATCH",
          { milestone: null },
        );
        return mutationResult(result, mutation.issueNumber, issueUrl, "里程碑已清除");
      }
      case "close": {
        const result = await this.#write(
          `/repos/${this.access.fullName}/issues/${mutation.issueNumber}`,
          "PATCH",
          { state: "closed", state_reason: mutation.reason },
        );
        return mutationResult(result, mutation.issueNumber, issueUrl, "Issue 已关闭");
      }
      case "reopen": {
        const result = await this.#write(
          `/repos/${this.access.fullName}/issues/${mutation.issueNumber}`,
          "PATCH",
          { state: "open" },
        );
        return mutationResult(result, mutation.issueNumber, issueUrl, "Issue 已重新打开");
      }
      case "lock": {
        if (current.locked !== true) {
          await this.#write(
            `/repos/${this.access.fullName}/issues/${mutation.issueNumber}/lock`,
            "PUT",
            mutation.reason ? { lock_reason: mutation.reason } : undefined,
          );
        }
        return { number: mutation.issueNumber, htmlUrl: issueUrl, summary: "Issue 已锁定" };
      }
      case "unlock": {
        if (current.locked === true) {
          await this.#write(
            `/repos/${this.access.fullName}/issues/${mutation.issueNumber}/lock`,
            "DELETE",
          );
        }
        return { number: mutation.issueNumber, htmlUrl: issueUrl, summary: "Issue 已解锁" };
      }
    }
  }

  async findIssueByMarker(marker: string, sinceMilliseconds: number): Promise<CreatedIssue | undefined> {
    const since = new Date(Math.max(0, sinceMilliseconds - 60_000)).toISOString();
    for (let page = 1; page <= 5; page += 1) {
      const query = params({ state: "all", since, per_page: 100, page });
      const items = asArray(await this.#read(`/repos/${this.access.fullName}/issues?${query}`));
      for (const item of items) {
        if (!isRecord(item) || "pull_request" in item || typeof item.body !== "string") continue;
        const body = item.body;
        if (body.includes(marker) && typeof item.number === "number" && typeof item.html_url === "string") {
          return { number: item.number, htmlUrl: item.html_url };
        }
      }
      if (items.length < 100) return undefined;
    }
    throw new Error("Issue reconciliation exceeded 500 candidates; operator review required");
  }

  async #assertIssue(number: number): Promise<Record<string, unknown>> {
    const issue = recordValue(await this.#read(`/repos/${this.access.fullName}/issues/${number}`));
    if ("pull_request" in issue) throw new GitHubOperationError(`#${number} is a pull request, not an issue`);
    if (typeof issue.number !== "number" || typeof issue.html_url !== "string") {
      throw new Error(`GitHub Issue #${number} response is incomplete`);
    }
    return issue;
  }

  async #findCommentByMarker(issueNumber: number, marker: string): Promise<string | undefined> {
    for (let page = 1; page <= 5; page += 1) {
      const query = params({ per_page: 100, page });
      const comments = asArray(await this.#read(
        `/repos/${this.access.fullName}/issues/${issueNumber}/comments?${query}`,
      ));
      for (const comment of comments) {
        const item = recordValue(comment);
        if (typeof item.body === "string" && item.body.includes(marker) && typeof item.html_url === "string") {
          return item.html_url;
        }
      }
      if (comments.length < 100) return undefined;
    }
    throw new Error(`Issue #${issueNumber} comment reconciliation exceeded 500 comments`);
  }

  async #resolveMilestone(value: string): Promise<number> {
    if (/^[1-9]\d*$/.test(value)) return Number(value);
    const matches: number[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const query = params({ state: "all", per_page: 100, page });
      const milestones = asArray(await this.#read(
        `/repos/${this.access.fullName}/milestones?${query}`,
      ));
      for (const milestone of milestones) {
        const item = recordValue(milestone);
        if (
          typeof item.title === "string"
          && item.title.localeCompare(value, undefined, { sensitivity: "accent" }) === 0
          && typeof item.number === "number"
        ) matches.push(item.number);
      }
      if (milestones.length < 100) break;
    }
    if (matches.length !== 1) {
      throw new GitHubOperationError(matches.length === 0
        ? `Milestone not found: ${value}`
        : `Milestone title is ambiguous: ${value}`);
    }
    return matches[0] as number;
  }

  async #write(
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
  ): Promise<unknown> {
    return this.access.request(path, method, body);
  }

  async #read(path: string): Promise<unknown> {
    return this.access.request(path, "GET");
  }

}

function issueAssigneeLogins(value: unknown): string[] {
  return asArray(recordValue(value).assignees).flatMap((assignee) => {
    const login = recordValue(assignee).login;
    return typeof login === "string" ? [login.toLowerCase()] : [];
  });
}

function summaryIssue(value: unknown): unknown {
  return compactReferences(pick(value, ["number", "title", "state", "state_reason", "html_url", "labels", "assignees", "user", "created_at", "updated_at", "closed_at"]));
}

function detailIssue(value: unknown): unknown {
  return compactReferences(pick(value, [
    "number", "title", "body", "state", "state_reason", "html_url", "labels", "assignees",
    "milestone", "locked", "active_lock_reason", "user", "comments", "created_at", "updated_at", "closed_at",
  ]));
}

function summaryPullRequest(value: unknown): unknown {
  return compactReferences(pick(value, ["number", "title", "state", "draft", "html_url", "user", "head", "base", "created_at", "updated_at", "closed_at", "merged_at"]));
}

function detailPullRequest(value: unknown): unknown {
  return compactReferences(pick(value, [
    "number", "title", "body", "state", "draft", "merged", "mergeable", "mergeable_state", "html_url", "user",
    "head", "base", "labels", "requested_reviewers", "comments", "review_comments", "commits", "additions", "deletions",
    "changed_files", "created_at", "updated_at", "closed_at", "merged_at",
  ]));
}

/** Nested API objects are references, not another copy of the repository or account. */
function compactReferences(value: JsonRecord): JsonRecord {
  for (const key of ["user", "actor", "triggering_actor"]) {
    if (key in value && value[key] !== null) value[key] = pick(value[key], ["login"]);
  }
  for (const key of ["assignees", "requested_reviewers"]) {
    if (key in value) value[key] = asArray(value[key]).map((user) => pick(user, ["login"]));
  }
  if ("labels" in value) value.labels = labelNames(value.labels);
  if ("milestone" in value && value.milestone !== null) {
    value.milestone = pick(value.milestone, ["number", "title", "state", "html_url"]);
  }
  for (const key of ["head", "base"]) {
    if (!(key in value) || value[key] === null) continue;
    const branch = recordValue(value[key]);
    const reference = pick(branch, ["label", "ref", "sha"]);
    if ("repo" in branch) reference.repo = branch.repo === null ? null : pick(branch.repo, ["id", "full_name"]);
    value[key] = reference;
  }
  return value;
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(keys.flatMap((key) => key in value ? [[key, value[key]]] : []));
}

/**
 * Search is a locator, not a source-file transport. GitHub's text_matches can
 * contain arbitrarily large provider fragments, so keep only a small hint and
 * make the Agent use connector_read with the declared get.content capability
 * for authoritative file evidence.
 */
function searchCodeMatch(value: unknown): Record<string, unknown> {
  const match = pick(value, ["name", "path", "sha", "html_url"]);
  const snippets = asArray(recordValue(value).text_matches)
    .slice(0, 2)
    .flatMap((item) => {
      const fragment = recordValue(item).fragment;
      return typeof fragment === "string" && fragment.length > 0
        ? [{ fragment: fragment.slice(0, 400) }]
        : [];
    });
  if (snippets.length > 0) match.text_matches = snippets;
  return match;
}

function params(values: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) query.set(key, String(value));
  return query.toString();
}

function intValue(value: unknown, fallback: number | undefined, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed === undefined || parsed < min || parsed > max) {
    throw new GitHubOperationError(`Expected an integer between ${min} and ${max}`);
  }
  return parsed;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new GitHubOperationError(`Expected one of: ${allowed.join(", ")}`);
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new GitHubOperationError(`Expected a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, maxLength);
}

function safeRepositoryPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === ".") return "";
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "..")) {
    throw new GitHubOperationError("Repository path must be relative and cannot contain '..'");
  }
  return normalized;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requiredResponseString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function labelNames(value: unknown): string[] {
  return asArray(value).flatMap((label) => {
    if (typeof label === "string") return [label];
    const name = recordValue(label).name;
    return typeof name === "string" ? [name] : [];
  });
}

function mutationResult(
  value: unknown,
  number: number,
  fallbackUrl: string,
  summary: string,
): IssueMutationResult {
  const result = recordValue(value);
  return {
    number: typeof result.number === "number" ? result.number : number,
    htmlUrl: typeof result.html_url === "string" ? result.html_url : fallbackUrl,
    summary,
  };
}

export { safeRepositoryPath };
