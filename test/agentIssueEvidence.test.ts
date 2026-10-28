import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolExecutor, type ToolTurnState } from "../src/agent/tools.ts";
import type { MessageContext } from "../src/domain.ts";
import { IssueWorkflow, type IssueRepository } from "../src/issueWorkflow.ts";
import { StateStore } from "../src/state.ts";
import { repositoryAccess, repositoryScope } from "./githubFixtures.ts";
import {
  BOT_ID,
  catalogRevision,
  fixedSelection,
  githubBroker,
} from "./connectorFixture.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openState(): StateStore {
  const directory = mkdtempSync(join(tmpdir(), "mochi-issue-evidence-"));
  directories.push(directory);
  return new StateStore(join(directory, "state.sqlite"));
}

const CONTEXT: MessageContext = {
  chatId: "oc_group", threadKey: "omt_topic", requesterId: "ou_requester", sourceMessageId: "om_current",
};

/** The provenance a Feishu channel would have resolved before the tool layer. */
const PROVENANCE = {
  sourceMessageLink: "https://applink.feishu.cn/client/thread/open?message=om_current",
  requesterName: "Derek",
  participantNames: ["Derek"],
};

const ISSUE_REPOSITORY: IssueRepository = {
  fullName: "customer/mochi",
  createIssue: async () => ({ number: 1, htmlUrl: "https://github.com/example/1" }),
  findIssueByMarker: async () => undefined,
  listOpenIssueCandidates: async () => [],
  applyIssueMutation: async () => ({
    number: 1, htmlUrl: "https://github.com/example/1", summary: "done",
  }),
};

describe("audited Issue boundaries", () => {
  test("oversized escaped JSON fails explicitly and does not become a delivered result", async () => {
    const store = openState();
    const issue = { number: 42, title: "Example", body: '"'.repeat(60_000) };
    const { broker, connectionId } = githubBroker({
      state: store,
      issues: new IssueWorkflow(store, async () => { throw new Error("Unexpected Issue write"); }),
      selection: fixedSelection(async () => repositoryAccess(
        (async () => Response.json(issue)) as unknown as typeof fetch,
      )),
    });
    const tools = new AgentToolExecutor(broker, BOT_ID);
    const turn: ToolTurnState = { mutationCount: 0, sourceText: "Read the Issue", issueOutcome: null };
    const request = {
      connection_id: connectionId,
      resource_id: "repository:20",
      capability_id: "get.issue",
      catalog_revision: await catalogRevision(broker),
      input: JSON.stringify({ number: 42 }),
    };
    try {
      await expect(tools.execute("connector_read", request, CONTEXT, turn))
        .rejects.toThrow("connector_result_too_large");
      issue.body = "Complete evidence";
      const result = await tools.execute("connector_read", request, CONTEXT, turn);
      const output = result[0];
      expect(output?.type).toBe("text");
      if (output?.type !== "text") throw new Error("Missing text result");
      expect(JSON.parse(output.text)).toEqual(issue);
      expect(turn.issueOutcome).toBeNull();
    } finally { store.close(); }
  });

  test("executes a typed write without requiring a prior repository read", async () => {
    const store = openState();
    const { broker, connectionId } = githubBroker({
      state: store,
      issues: new IssueWorkflow(store, async () => ISSUE_REPOSITORY),
      selection: fixedSelection(async () => repositoryAccess((async () => {
        throw new Error("Unexpected repository read");
      }) as unknown as typeof fetch)),
    });
    const tools = new AgentToolExecutor(broker, BOT_ID);
    const turn: ToolTurnState = {
      mutationCount: 0, sourceText: "提个 Issue", issueOutcome: null, provenance: PROVENANCE,
    };

    const output = await tools.execute("connector_write", {
      connection_id: connectionId,
      resource_id: `repository:${repositoryScope.repositoryId}`,
      capability_id: "manage.issue",
      catalog_revision: await catalogRevision(broker),
      authorization_quote: "提个 Issue",
      input: JSON.stringify({
        action: "create",
        title: "Trace the discussion",
        body: "## 要解决的问题\n\nKeep evidence.",
      }),
    }, CONTEXT, turn) as { type: string; text: string }[];

    const response = JSON.parse(output[0]?.text ?? "{}");
    expect(store.getIssueAction(response.readback.actionId)?.mutation).toMatchObject({
      kind: "create",
      provenance: PROVENANCE,
    });
    store.close();
  });

  test("fails closed when a new Issue has no authoritative provenance", async () => {
    const store = openState();
    const { broker, connectionId } = githubBroker({
      state: store,
      issues: new IssueWorkflow(store, async () => ISSUE_REPOSITORY),
      selection: fixedSelection(async () => repositoryAccess((async () => {
        throw new Error("Unexpected repository read");
      }) as unknown as typeof fetch)),
    });
    const tools = new AgentToolExecutor(broker, BOT_ID);
    // A turn with no provenance cannot attribute a new Issue to anyone.
    const turn: ToolTurnState = {
      mutationCount: 0, sourceText: "提个 Issue", issueOutcome: null,
    };

    await expect(tools.execute("connector_write", {
      connection_id: connectionId,
      resource_id: `repository:${repositoryScope.repositoryId}`,
      capability_id: "manage.issue",
      catalog_revision: await catalogRevision(broker),
      authorization_quote: "提个 Issue",
      input: JSON.stringify({
        action: "create",
        title: "Trace the discussion",
        body: "## 要解决的问题\n\nKeep evidence.",
      }),
    }, CONTEXT, turn)).rejects.toThrow();
    expect(store.awaitingIssueActions("oc_group", "omt_topic")).toEqual([]);
    store.close();
  });
});
