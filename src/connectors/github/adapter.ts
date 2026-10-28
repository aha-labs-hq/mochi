import type { MessageContext } from "../../domain.ts";
import type { BotGitHub } from "../../github/botAccess.ts";
import { GitHubClient, GitHubOperationError } from "../../github/client.ts";
import {
  GitHubConnectionError,
  type GitHubConnectionFailure,
} from "../../github/integration.ts";
import type { GitHubProject } from "../../github/repository.ts";
import { GitHubRequestError } from "../../github/requestError.ts";
import type { IssueWorkflow } from "../../issueWorkflow.ts";
import { ConnectorError, type ConnectorErrorCode } from "../errors.ts";
import type {
  ConnectorAdapter,
  ConnectorCapabilityManifest,
  ConnectorConnectionSnapshot,
  ConnectorRequestContext,
  ConnectorResourceSnapshot,
  ConnectorTaskGrant,
  ConnectorWriteResult,
  JsonValue,
} from "../protocol.ts";
import { githubConnectionId, githubRepositoryIdOf } from "./identity.ts";
import {
  GITHUB_CAPABILITIES,
  GITHUB_PROVIDER_ID,
  GITHUB_RESOURCE_TYPES,
  toolNameFor,
} from "./manifest.ts";
import {
  assertQuoteNamesTarget,
  issueRequestFrom,
  readOperationFor,
} from "./operations.ts";

/** The provider facts this adapter needs, kept narrower than the connection class. */
export interface GitHubConnectorSource {
  /** In-memory connection state; never a provider call. */
  snapshot(): {
    status: "disconnected" | "authorizing" | "connected" | "unavailable";
    account: { id: number; login: string } | null;
    problem: string | null;
  };
  /** This Bot's selected repositories and scope-bound access. */
  selection: BotGitHub;
  catalogSnapshot(): readonly GitHubProject[] | null;
}

/**
 * GitHub as a connector.
 *
 * Reads and writes go through the same authority the dedicated tools used, so no
 * boundary is re-implemented here: `repositoryAccess` still proves the grant,
 * the owner, the installation and the selection on every call, and the transport
 * still refuses anything outside the closed Issue allowlist.
 */
export class GitHubConnector implements ConnectorAdapter {
  readonly manifest = Object.freeze({
    id: GITHUB_PROVIDER_ID,
    version: "1.0.0",
    displayName: "GitHub",
    resourceTypes: GITHUB_RESOURCE_TYPES,
    capabilities: GITHUB_CAPABILITIES,
  });
  readonly #source: GitHubConnectorSource;
  readonly #issues: IssueWorkflow;

  constructor(source: GitHubConnectorSource, issues: IssueWorkflow) {
    this.#source = source;
    this.#issues = issues;
  }

  /**
   * Reports the connection from the last complete catalog proof or a durable
   * local selection snapshot when a live proof is unavailable.
   *
   * The catalog is rebuilt on every read and write, so a snapshot that fetched
   * the repository catalog would put a network round trip on every tool call.
   * Re-proving a selection is an explicit reconcile instead.
   */
  async snapshot(
    botId: string,
  ): Promise<readonly ConnectorConnectionSnapshot[]> {
    const connection = this.#source.snapshot();
    if (connection.status === "disconnected") return [];
    const connectionId =
      githubConnectionId(connection.account?.id) ?? "github:unbound";
    const provenProjects =
      connection.status === "connected" ? this.#source.catalogSnapshot() : null;
    // A saved range is a local display fact, not a live grant. Keep it visible
    // during authorization or an outage so the user can inspect/remove it, but
    // let `resourceScope` and the Broker make its non-callable state explicit.
    const projects =
      provenProjects ?? this.#source.selection.savedProjectsSnapshot();
    const problem =
      connection.problem ??
      (connection.status === "connected" && provenProjects === null
        ? "provider_unavailable"
        : null);
    const status =
      connection.status === "authorizing"
        ? "authorizing"
        : connection.status === "connected" && provenProjects !== null
          ? "ready"
          : isGitHubReauthorizationProblem(connection.problem)
            ? "reauthorization_required"
            : "unavailable";
    return [
      {
        botId,
        connectionId,
        providerId: GITHUB_PROVIDER_ID,
        status,
        ...(problem === null ? {} : { problem }),
        account: connection.account
          ? { displayName: connection.account.login }
          : null,
        // GitHub's OAuth response intentionally has no classic scope string.
        // Access is proven per repository through the App installation and the
        // selected resource, so do not invent account-level scopes here.
        grantedScopes: [],
        resources: (projects ?? []).map(
          (project): ConnectorResourceSnapshot => ({
            id: `repository:${project.id}`,
            type: "repository",
            displayName: project.fullName,
            selected: project.selected,
            ownerId: String(project.ownerId),
            visibility: project.private ? "private" : "public",
            writable: project.canWriteIssues,
          }),
        ),
        resourceScope:
          projects.some((project) => project.selected) &&
          provenProjects === null
            ? {
                status: "unavailable" as const,
                selectedCount: projects.filter((project) => project.selected)
                  .length,
                problem: problem ?? "provider_unavailable",
              }
            : {
                // No durable selection is a complete, empty range. A missing
                // provider catalog still blocks calls through connection.status,
                // but it does not make an empty range itself "unavailable".
                status: "ready" as const,
                selectedCount: projects.filter((project) => project.selected)
                  .length,
              },
      },
    ];
  }

  async read(input: {
    context: ConnectorRequestContext;
    grant: ConnectorTaskGrant;
    connection: ConnectorConnectionSnapshot;
    resource: ConnectorResourceSnapshot;
    capability: ConnectorCapabilityManifest;
    input: JsonValue;
    signal?: AbortSignal;
  }): Promise<JsonValue> {
    const operation = readOperationFor(toolNameFor(input.capability.id));
    if (!operation) {
      throw new ConnectorError(
        "capability_unavailable",
        `GitHub 能力未实现：${input.capability.id}`,
      );
    }
    try {
      const access = await this.#source.selection.repositoryAccess(
        repositoryIdOf(input.resource.id),
      );
      return (await operation.read(
        new GitHubClient(access),
        readArguments(input.input),
      )) as JsonValue;
    } catch (error) {
      throw connectorErrorFrom(error);
    }
  }

  async write(input: {
    context: ConnectorRequestContext;
    grant: ConnectorTaskGrant;
    connection: ConnectorConnectionSnapshot;
    resource: ConnectorResourceSnapshot;
    capability: ConnectorCapabilityManifest;
    input: JsonValue;
    idempotencyKey: string | null;
    signal?: AbortSignal;
  }): Promise<ConnectorWriteResult> {
    if (!input.idempotencyKey) {
      throw new ConnectorError("idempotency_invalid", "GitHub 写入需要幂等键");
    }
    const quote = input.grant.authorizationQuote;
    if (!quote) {
      throw new ConnectorError(
        "authorization_missing",
        "GitHub 写入需要当前消息的授权原话",
      );
    }
    // Issue actions and duplicate choices belong to one Feishu chat and topic.
    // Re-keying a topic moves them by the real chat id, which only the host can
    // supply; without it the write has no topic scope and is refused.
    const chatId = input.context.conversationId;
    if (!chatId) {
      throw new ConnectorError(
        "authorization_missing",
        "GitHub 写入需要当前飞书群的话题范围",
      );
    }
    const request = issueRequestFrom(input.input, input.context.provenance);
    assertQuoteNamesTarget(quote, request);
    // A newly created Issue records who raised it and where the discussion is.
    // Without resolved provenance there is nothing honest to record, so the
    // write is refused rather than producing an unattributable record.
    if (
      request.kind === "mutation" &&
      request.mutation.kind === "create" &&
      !request.mutation.provenance
    ) {
      throw new ConnectorError(
        "authorization_missing",
        "新建 Issue 需要可核对的来源信息，当前消息没有提供",
      );
    }
    const context: MessageContext = {
      chatId,
      threadKey: input.context.topicKey,
      requesterId: input.context.requesterId,
      sourceMessageId: input.context.sourceMessageId,
    };
    try {
      const { scope } = await this.#source.selection.repositoryAccess(
        repositoryIdOf(input.resource.id),
      );
      // The Issue workflow keeps its own audit and duplicate-choice record: it
      // answers a different question from the Broker's ledger, namely whether
      // this message already proposed this change in this topic. The Broker
      // decides whether the same invocation already ran; this decides what to
      // do about it.
      const response =
        request.kind === "decision"
          ? await this.#issues.resolve(context, request.decision, scope)
          : await this.#issues.submit(context, request.mutation, scope);
      return {
        status: "applied",
        readback: {
          outcome: response.outcome,
          message: response.message,
          actionId: response.actionId,
          ...(response.result ? { result: response.result } : {}),
        } as JsonValue,
      };
    } catch (error) {
      throw connectorErrorFrom(error);
    }
  }
}

/**
 * Turns a GitHub failure into the Broker's closed vocabulary.
 *
 * A refused request keeps GitHub's sanitized reason so the caller can correct
 * the argument it names; a grant or connection failure keeps its own code; an
 * argument the repository cannot serve, such as an unknown milestone, is an
 * input problem. Anything unrecognized propagates for the Broker to report as
 * an unexpected adapter failure.
 */
function connectorErrorFrom(error: unknown): unknown {
  if (error instanceof ConnectorError) return error;
  if (error instanceof GitHubRequestError) {
    return new ConnectorError("provider_request_failed", error.message, {
      cause: error,
      provider: {
        status: error.status,
        code: error.code,
        ...(error.reason ?? {}),
      },
    });
  }
  if (error instanceof GitHubOperationError) {
    return new ConnectorError("input_invalid", error.message, { cause: error });
  }
  if (error instanceof GitHubConnectionError) {
    return new ConnectorError(
      connectionErrorCode(error.code),
      `GitHub 连接不可用：${error.code}`,
      { cause: error },
    );
  }
  return error;
}

function connectionErrorCode(
  failure: GitHubConnectionFailure,
): ConnectorErrorCode {
  switch (failure) {
    case "repository_not_selected":
      return "resource_not_selected";
    case "repository_changed":
      return "resource_unavailable";
    case "issue_write_not_granted":
      return "capability_unavailable";
    case "provider_unavailable":
    case "provider_response_invalid":
      return failure;
    default:
      return "connection_unavailable";
  }
}

/**
 * A failed or revoked GitHub grant needs a user action. Provider transport and
 * response failures stay `unavailable`, so the UI does not send the user into
 * OAuth for a problem a retry can resolve.
 */
const GITHUB_REAUTHORIZATION_PROBLEMS = [
  "authorization_expired",
  "authorization_denied",
  "authorization_invalid",
  "callback_unavailable",
  "sign_in_required",
  "credential_unavailable",
  "grant_unavailable",
] as const;

function isGitHubReauthorizationProblem(problem: string | null): boolean {
  return (
    problem !== null &&
    GITHUB_REAUTHORIZATION_PROBLEMS.includes(
      problem as (typeof GITHUB_REAUTHORIZATION_PROBLEMS)[number],
    )
  );
}

function repositoryIdOf(resourceId: string): number {
  const repositoryId = githubRepositoryIdOf(resourceId);
  if (repositoryId === null) {
    throw new ConnectorError(
      "resource_not_selected",
      `无法解析的项目标识：${resourceId}`,
    );
  }
  return repositoryId;
}

/** A capability with no parameters receives an empty object, never null. */
function readArguments(input: JsonValue): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return {};
  return input as Record<string, unknown>;
}
