import type {
  IssueActionDecision,
  IssueMutation,
  IssueProvenance,
} from "../../domain.ts";
import type { GitHubClient } from "../../github/client.ts";
import type { RuntimeToolSpec } from "../../runtime/protocol.ts";
import { ConnectorError } from "../errors.ts";
import {
  CONNECTOR_AUTHORIZATION_QUOTE_MIN_CHARACTERS,
  type JsonValue,
} from "../protocol.ts";

/**
 * GitHub's operations, declared once.
 *
 * These are the schemas the connector catalog publishes, because the manifest is
 * generated from them. Nothing here carries a repository selector: in the
 * connector model a repository is the resource a call names, so the schema and
 * the resource together identify the target and neither can be forged.
 *
 * Each operation is declared beside the code that reads its input: a read names
 * the client call that serves it, and the Issue write's field names are read by
 * `issueRequestFrom` in this module, so a field cannot be renamed on one side
 * only.
 *
 * Descriptions keep GitHub's own vocabulary — a branch is a branch, a milestone
 * is a milestone — while anything naming the chat product a request arrived on
 * is neutralised, because this text also describes a capability to a reader that
 * has no chat product at all.
 */

const integer = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
const string = (description: string) => ({ type: "string", description });
const stringArray = (description: string) => ({
  type: "array",
  description,
  items: { type: "string" },
  minItems: 0,
  maxItems: 20,
});

/** One read capability: the schema it publishes and the client call that serves it. */
export interface GitHubReadOperation {
  readonly spec: RuntimeToolSpec;
  readonly read: (
    client: GitHubClient,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}

const READ_OPERATIONS: readonly GitHubReadOperation[] = [
  {
    spec: tool(
      "github_repository_overview",
      "Read metadata for the selected repository.",
      {},
      [],
    ),
    read: (client) => client.repositoryOverview(),
  },
  {
    spec: tool(
      "github_list_issues",
      "List issues from the selected repository. Pull requests are excluded.",
      {
        state: { type: "string", enum: ["open", "closed", "all"] },
        labels: string("Comma-separated labels, or an empty string."),
        limit: integer(1, 50),
      },
    ),
    read: (client, input) => client.listIssues(input),
  },
  {
    spec: tool(
      "github_get_issue",
      "Read one issue by number from the selected repository.",
      {
        number: integer(1, 10_000_000),
      },
    ),
    read: (client, input) => client.getIssue(input),
  },
  {
    spec: tool(
      "github_list_issue_comments",
      "Read comments on one issue from the selected repository.",
      {
        number: integer(1, 10_000_000),
        limit: integer(1, 100),
      },
    ),
    read: (client, input) => client.listIssueComments(input),
  },
  {
    spec: tool(
      "github_list_labels",
      "List repository labels that can be applied to issues.",
      {
        limit: integer(1, 100),
      },
    ),
    read: (client, input) => client.listLabels(input),
  },
  {
    spec: tool(
      "github_list_milestones",
      "List repository milestones that can be applied to issues.",
      {
        state: { type: "string", enum: ["open", "closed", "all"] },
        limit: integer(1, 100),
      },
    ),
    read: (client, input) => client.listMilestones(input),
  },
  {
    spec: tool(
      "github_list_assignees",
      "List GitHub users eligible for issue assignment.",
      {
        limit: integer(1, 100),
      },
    ),
    read: (client, input) => client.listAssignees(input),
  },
  {
    spec: tool(
      "github_list_pull_requests",
      "List pull requests from the selected repository.",
      {
        state: { type: "string", enum: ["open", "closed", "all"] },
        limit: integer(1, 50),
      },
    ),
    read: (client, input) => client.listPullRequests(input),
  },
  {
    spec: tool(
      "github_get_pull_request",
      "Read one pull request by number from the selected repository.",
      {
        number: integer(1, 10_000_000),
      },
    ),
    read: (client, input) => client.getPullRequest(input),
  },
  {
    spec: tool(
      "github_get_pull_request_files",
      "Read changed files and patches for one pull request.",
      {
        number: integer(1, 10_000_000),
        limit: integer(1, 100),
      },
    ),
    read: (client, input) => client.getPullRequestFiles(input),
  },
  {
    spec: tool(
      "github_get_commit_checks",
      "Read check runs and combined commit statuses for a branch, tag, or SHA.",
      {
        ref: string("Branch, tag, or commit SHA."),
      },
    ),
    read: (client, input) => client.getCommitChecks(input),
  },
  {
    spec: tool(
      "github_list_actions_runs",
      "List GitHub Actions workflow runs.",
      {
        branch: string("Branch filter, or an empty string."),
        status: string(
          "Status filter such as completed or in_progress, or an empty string.",
        ),
        limit: integer(1, 50),
      },
    ),
    read: (client, input) => client.listActionsRuns(input),
  },
  {
    spec: tool(
      "github_get_actions_run",
      "Read one GitHub Actions workflow run.",
      {
        run_id: integer(1, Number.MAX_SAFE_INTEGER),
      },
    ),
    read: (client, input) => client.getActionsRun(input),
  },
  {
    spec: tool(
      "github_list_actions_jobs",
      "Read jobs and steps for one GitHub Actions workflow run.",
      {
        run_id: integer(1, Number.MAX_SAFE_INTEGER),
      },
    ),
    read: (client, input) => client.listActionsJobs(input),
  },
  {
    spec: tool(
      "github_get_content",
      "Read a file or list a directory in the selected repository.",
      {
        path: string(
          "Repository-relative file or directory path, or an empty string for the repository root.",
        ),
        ref: string(
          "Branch, tag, or commit SHA, or an empty string for the default branch.",
        ),
      },
    ),
    read: (client, input) => client.getContent(input),
  },
  {
    spec: tool(
      "github_list_commits",
      "List recent commits, optionally filtered by ref and path.",
      {
        ref: string("Branch, tag, or commit SHA, or an empty string."),
        path: string("Repository-relative path, or an empty string."),
        limit: integer(1, 50),
      },
    ),
    read: (client, input) => client.listCommits(input),
  },
  {
    spec: tool(
      "github_search_code",
      "Search code inside the selected repository.",
      {
        query: string("GitHub code-search query without a repo qualifier."),
        limit: integer(1, 50),
      },
    ),
    read: (client, input) => client.searchCode(input),
  },
];

export const READ_ONLY_TOOLS: readonly RuntimeToolSpec[] = READ_OPERATIONS.map(
  (operation) => operation.spec,
);

/** The read a tool name dispatches to, or undefined when none is declared. */
export function readOperationFor(
  toolName: string,
): GitHubReadOperation | undefined {
  return READ_OPERATIONS.find((operation) => operation.spec.name === toolName);
}

type IssueAction = IssueMutation["kind"] | IssueActionDecision["kind"];
type IssueField =
  | "action_id"
  | "issue_number"
  | "title"
  | "body"
  | "assignees"
  | "labels"
  | "milestone"
  | "reason";

/**
 * The fields each action reads. Every other field must be empty, because a
 * value the Bridge silently dropped — labels on a close, a title on a
 * comment — would let the caller believe a change happened that did not.
 */
const ISSUE_ACTION_FIELDS: Readonly<
  Record<IssueAction, readonly IssueField[]>
> = {
  create: ["title", "body", "assignees"],
  edit: ["issue_number", "title", "body"],
  comment: ["issue_number", "body"],
  assign: ["issue_number", "assignees"],
  unassign: ["issue_number", "assignees"],
  add_labels: ["issue_number", "labels"],
  remove_labels: ["issue_number", "labels"],
  set_milestone: ["issue_number", "milestone"],
  clear_milestone: ["issue_number"],
  close: ["issue_number", "reason"],
  reopen: ["issue_number"],
  lock: ["issue_number", "reason"],
  unlock: ["issue_number"],
  reuse: ["issue_number", "action_id"],
  force_create: ["action_id"],
};
const ISSUE_FIELDS: readonly IssueField[] = [
  "action_id",
  "issue_number",
  "title",
  "body",
  "assignees",
  "labels",
  "milestone",
  "reason",
];
const CLOSE_REASONS = ["completed", "not_planned"] as const;
const LOCK_REASONS = ["off-topic", "too heated", "resolved", "spam"] as const;
const TITLE_LENGTH = 256;
const BODY_LENGTH = 60_000;
const LOGIN_LENGTH = 39;
const LABEL_LENGTH = 100;

export const ISSUE_ACTION_TOOL: RuntimeToolSpec = tool(
  "github_manage_issue",
  `Manage GitHub Issues in the selected repository through the audited Bridge. Interpret the user's natural language yourself, then submit one typed mutation, or resolve a duplicate choice with reuse or force_create; the Bridge never infers intent from phrases. Each field names the actions that use it; leave every other field empty, because a field the action does not use is rejected rather than ignored. The connector_write authorization_quote is an exact excerpt of the current user message with at least ${CONNECTOR_AUTHORIZATION_QUOTE_MIN_CHARACTERS} letters or digits, or the whole message when it is shorter; when it names Issue numbers, the target must be one of them. Duplicate candidates are returned for your judgment, and you should choose reuse or force_create in the same turn when the context is clear.`,
  {
    action: { type: "string", enum: Object.keys(ISSUE_ACTION_FIELDS) },
    action_id: string(
      "Eight-character action ID of a duplicate choice, optional for reuse and force_create; an empty string selects the only awaiting choice in the current topic.",
    ),
    issue_number: {
      ...integer(0, 10_000_000),
      description:
        "Target Issue number, required by every action except create and force_create; 0 when unused.",
    },
    title: string(
      "Issue title, required by create and optional for edit; otherwise an empty string.",
    ),
    body: string(
      "Issue body for create (required) or edit (optional), or the comment text for comment (required); otherwise an empty string.",
    ),
    assignees: stringArray(
      "GitHub logins, required by assign and unassign and optional for create; otherwise an empty array.",
    ),
    labels: stringArray(
      "Exact label names, required by add_labels and remove_labels; otherwise an empty array.",
    ),
    milestone: string(
      "Exact milestone title or number, required by set_milestone; otherwise an empty string.",
    ),
    reason: string(
      "Required by close: completed or not_planned. Optional for lock: off-topic, too heated, resolved or spam. Otherwise an empty string.",
    ),
  },
  // Only the action is unconditional. Every other field belongs to some actions
  // and not others, and a closed schema cannot express that, so the fields are
  // optional here, each field's description names the actions that use it, and
  // `issueRequestFrom` enforces exactly that.
  ["action"],
);

export type IssueRequest =
  | { readonly kind: "mutation"; readonly mutation: IssueMutation }
  | { readonly kind: "decision"; readonly decision: IssueActionDecision };

/**
 * Reads one `manage.issue` input into the typed request it names.
 *
 * The Broker has already checked types and ranges against the schema. This
 * checks what a flat schema cannot — which fields an action needs and which it
 * does not use — and names the exact field when a request is wrong, so nothing
 * reaches GitHub without its target. Provenance is the turn's, resolved by the
 * channel that received the request, never input a model could fabricate.
 */
export function issueRequestFrom(
  value: JsonValue,
  provenance: IssueProvenance | undefined,
): IssueRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("action", "input must be an object naming an action");
  const input = value as Readonly<Record<string, JsonValue | undefined>>;
  const action = input.action as IssueAction;
  const used = ISSUE_ACTION_FIELDS[action];
  if (!used) throw invalid("action", "is not a known Issue action");
  for (const field of ISSUE_FIELDS) {
    if (!used.includes(field) && !isEmpty(input[field]))
      throw invalid(
        field,
        `is not used by ${action}; leave it empty or submit a separate action`,
      );
  }
  const read = new IssueInput(input, action);
  switch (action) {
    case "create": {
      const assignees = read.optionalNames("assignees", LOGIN_LENGTH);
      return mutation({
        kind: action,
        title: read.line("title", TITLE_LENGTH),
        body: read.body(),
        ...(assignees ? { assignees } : {}),
        ...(provenance ? { provenance } : {}),
      });
    }
    case "edit": {
      const title = read.optionalLine("title", TITLE_LENGTH);
      const body = read.optionalBody();
      if (title === undefined && body === undefined)
        throw invalid("title", "or body is required by edit");
      return mutation({
        kind: action,
        issueNumber: read.issueNumber(),
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
      });
    }
    case "comment":
      return mutation({
        kind: action,
        issueNumber: read.issueNumber(),
        body: read.body(),
      });
    case "assign":
    case "unassign":
      return mutation({
        kind: action,
        issueNumber: read.issueNumber(),
        assignees: read.names("assignees", LOGIN_LENGTH),
      });
    case "add_labels":
    case "remove_labels":
      return mutation({
        kind: action,
        issueNumber: read.issueNumber(),
        labels: read.names("labels", LABEL_LENGTH),
      });
    case "set_milestone":
      return mutation({
        kind: action,
        issueNumber: read.issueNumber(),
        milestone: read.line("milestone", TITLE_LENGTH),
      });
    case "close":
      return mutation({
        kind: action,
        issueNumber: read.issueNumber(),
        reason: read.choice("reason", CLOSE_REASONS),
      });
    case "lock": {
      const reason = isEmpty(input.reason)
        ? undefined
        : read.choice("reason", LOCK_REASONS);
      return mutation({
        kind: action,
        issueNumber: read.issueNumber(),
        ...(reason ? { reason } : {}),
      });
    }
    case "clear_milestone":
    case "reopen":
    case "unlock":
      return mutation({ kind: action, issueNumber: read.issueNumber() });
    case "reuse": {
      const actionId = read.actionId();
      return decision({
        kind: action,
        issueNumber: read.issueNumber(),
        ...(actionId ? { actionId } : {}),
      });
    }
    case "force_create": {
      const actionId = read.actionId();
      return decision({ kind: action, ...(actionId ? { actionId } : {}) });
    }
  }
}

/**
 * Holds a write's cited authorization to the Issue it changes.
 *
 * When the quote names Issue numbers ("把 #12 关掉"), the target must be one of
 * them: a request about #12 does not authorize a change to #13. A quote that
 * names no number ("把那个登录 bug 关掉") leaves the target to the model, which
 * found it from evidence; demanding a number there would force a confirmation
 * round on a request the user already made explicitly.
 */
export function assertQuoteNamesTarget(
  quote: string,
  request: IssueRequest,
): void {
  const target =
    request.kind === "mutation"
      ? request.mutation.kind === "create"
        ? undefined
        : request.mutation.issueNumber
      : request.decision.kind === "reuse"
        ? request.decision.issueNumber
        : undefined;
  if (target === undefined) return;
  const named = new Set<number>();
  for (const match of quote.matchAll(/(?:[#＃]|\/issues\/)(\d{1,8})(?!\d)/g))
    named.add(Number(match[1]));
  if (named.size === 0 || named.has(target)) return;
  throw new ConnectorError(
    "authorization_target_mismatch",
    `authorization_quote names ${[...named].map((number) => `#${number}`).join(", ")}, not the target #${target}`,
    { field: "authorization_quote" },
  );
}

/** Field reads for one action, each failing with the exact input path. */
class IssueInput {
  readonly #input: Readonly<Record<string, JsonValue | undefined>>;
  readonly #action: IssueAction;

  constructor(
    input: Readonly<Record<string, JsonValue | undefined>>,
    action: IssueAction,
  ) {
    this.#input = input;
    this.#action = action;
  }

  issueNumber(): number {
    const value = this.#input.issue_number;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
      return value;
    throw invalid(
      "issue_number",
      `is required by ${this.#action}: the Issue's number, 1 or greater`,
    );
  }

  line(field: "title" | "milestone", maximum: number): string {
    const value = this.optionalLine(field, maximum);
    if (value === undefined) throw this.#required(field);
    return value;
  }

  optionalLine(
    field: "title" | "milestone",
    maximum: number,
  ): string | undefined {
    const value = this.#input[field];
    if (isEmpty(value)) return undefined;
    if (typeof value !== "string") throw invalid(field, "must be a string");
    const line = value.trim();
    if (line.length > maximum)
      throw invalid(field, `must have at most ${maximum} characters`);
    return line;
  }

  body(): string {
    const value = this.optionalBody();
    if (value === undefined) throw this.#required("body");
    return value;
  }

  optionalBody(): string | undefined {
    const value = this.#input.body;
    if (isEmpty(value)) return undefined;
    if (typeof value !== "string") throw invalid("body", "must be a string");
    if (value.length > BODY_LENGTH)
      throw invalid("body", `must have at most ${BODY_LENGTH} characters`);
    return value;
  }

  names(field: "assignees" | "labels", maximum: number): string[] {
    const value = this.optionalNames(field, maximum);
    if (!value) throw this.#required(field);
    return value;
  }

  optionalNames(
    field: "assignees" | "labels",
    maximum: number,
  ): string[] | undefined {
    const value = this.#input[field];
    if (isEmpty(value)) return undefined;
    if (!Array.isArray(value)) throw invalid(field, "must be an array");
    return value.map((item, index) => {
      const name = typeof item === "string" ? item.trim() : "";
      if (!name || name.length > maximum)
        throw invalid(
          `${field}[${index}]`,
          `must be a name of 1 to ${maximum} characters`,
        );
      return name;
    });
  }

  choice<const T extends string>(field: "reason", allowed: readonly T[]): T {
    const value = this.#input[field];
    if (typeof value === "string" && allowed.includes(value as T))
      return value as T;
    throw invalid(
      field,
      `must be one of ${allowed.join(", ")} for ${this.#action}`,
    );
  }

  actionId(): string | undefined {
    const value = this.#input.action_id;
    if (isEmpty(value)) return undefined;
    const id = typeof value === "string" ? value.toLowerCase() : "";
    if (!/^[0-9a-f]{8}$/.test(id))
      throw invalid(
        "action_id",
        "must be the eight-character action ID from a duplicate choice, or empty",
      );
    return id;
  }

  #required(field: string): ConnectorError {
    return invalid(field, `is required by ${this.#action}`);
  }
}

function mutation(value: IssueMutation): IssueRequest {
  return { kind: "mutation", mutation: value };
}

function decision(value: IssueActionDecision): IssueRequest {
  return { kind: "decision", decision: value };
}

/** The schema's own "unused" values: empty strings, empty arrays and number 0. */
function isEmpty(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === 0 ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function invalid(field: string, problem: string): ConnectorError {
  return new ConnectorError("input_invalid", `input.${field} ${problem}`, {
    field: `input.${field}`,
  });
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): RuntimeToolSpec {
  return {
    type: "function",
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
