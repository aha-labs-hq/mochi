import { join } from "node:path";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  AgentToolExecutor,
  AGENT_TOOLS,
  type ToolTurnState,
} from "../../src/agent/tools.ts";
import { IssueWorkflow } from "../../src/issueWorkflow.ts";
import { StateStore } from "../../src/state.ts";
import {
  FEISHU_MAIL_MANIFEST,
  FEISHU_MAIL_USER_SCOPES,
} from "../../src/connectors/feishu-mail/manifest.ts";
import type { ConnectorAdapter } from "../../src/connectors/protocol.ts";
import { runtimeUserMessage } from "../../src/runtime/instructions.ts";
import { executionTools } from "../../src/runtime/execution.ts";
import {
  BOT_ID,
  fixedSelection,
  githubBroker,
} from "../../test/connectorFixture.ts";
import { repositoryAccess } from "../../test/githubFixtures.ts";
import type { AgentCase } from "./cases.ts";

export function evaluationFixture(directory: string, item: AgentCase) {
  const state = new StateStore(join(directory, "state.sqlite"));
  const applied: { kind: string; issueNumber?: number }[] = [];
  const trace: { tool: string; arguments: unknown }[] = [];
  const context = {
    chatId: "oc_evaluation",
    threadKey: "omt_evaluation",
    requesterId: "ou_evaluation",
    sourceMessageId: `om_${item.id}`,
  };
  const turn: ToolTurnState = {
    mutationCount: 0,
    sourceText: item.prompt,
    issueOutcome: null,
    provenance: {
      requesterName: "Riley",
      participantNames: ["Riley"],
      sourceMessageLink:
        "https://applink.feishu.cn/client/thread/open?message=om_evaluation",
    },
  };
  const evidence = `月报导出尚未发布，#42 在等月末时区计算修复，未确认上线日期。${item.evidence ?? ""}`;
  const issue = {
    number: 42,
    title: "月报导出",
    body: evidence,
    html_url: "https://github.com/customer/mochi/issues/42",
    state: item.id === "auth-reopen" ? "closed" : "open",
    labels: [],
    assignees:
      item.id === "auth-assign"
        ? ([] as { login: string }[])
        : [{ login: "evan" }],
    user: { login: "evan" },
    updated_at: "2026-10-15T00:00:00Z",
  };
  const issues = new Map([[42, issue]]);
  const comments: {
    body: string;
    html_url: string;
    user: { login: string };
  }[] = [];
  const mail: ConnectorAdapter = {
    manifest: FEISHU_MAIL_MANIFEST,
    snapshot: async (botId) => [
      {
        botId,
        connectionId: "mail:fixture",
        providerId: "feishu-mail",
        status: "ready",
        account: { displayName: "support@example.test" },
        grantedScopes: FEISHU_MAIL_USER_SCOPES,
        resourceScope: { status: "ready", selectedCount: 1 },
        resources: [
          {
            id: "mailbox:fixture",
            type: "mailbox",
            displayName: "support@example.test",
            selected: true,
            writable: false,
          },
        ],
      },
    ],
    read: async ({ capability }) =>
      capability.id === "thread.list"
        ? {
            threads: [
              {
                thread_id: "thread-1",
                subject: "月报导出",
                preview: `希望尽快完成每月对账。${item.evidence ?? ""}`,
              },
            ],
          }
        : {
            thread_id: "thread-1",
            messages: [
              {
                subject: "月报导出",
                text: `客户需要按本地月末时区导出，避免对账漏单。${item.evidence ?? ""}`,
                url: "https://example.test/mail/thread-1",
              },
            ],
          },
    write: async () => {
      throw new Error("Mail is read-only");
    },
  };
  const { broker } = githubBroker({
    state,
    additionalAdapters: [mail],
    issues: new IssueWorkflow(state, async () => ({
      fullName: "customer/mochi",
      findIssueByMarker: async () => undefined,
      listOpenIssueCandidates: async () => [],
      createIssue: async (title, body) => {
        const number = 43;
        const htmlUrl = `https://github.com/customer/mochi/issues/${number}`;
        issues.set(number, {
          ...issue,
          number,
          title,
          body,
          state: "open",
          html_url: htmlUrl,
          assignees: [],
        });
        applied.push({ kind: "create" });
        return { number, htmlUrl };
      },
      applyIssueMutation: async (mutation) => {
        const target = issues.get(mutation.issueNumber);
        if (!target) throw new Error("Unknown fixture issue");
        switch (mutation.kind) {
          case "edit":
            if (mutation.title !== undefined) target.title = mutation.title;
            if (mutation.body !== undefined) target.body = mutation.body;
            break;
          case "close":
            target.state = "closed";
            break;
          case "reopen":
            target.state = "open";
            break;
          case "assign":
            target.assignees = mutation.assignees.map((login) => ({ login }));
            break;
          case "comment":
            comments.push({
              body: mutation.body,
              html_url: `${target.html_url}#issuecomment-${comments.length + 1}`,
              user: { login: "mochi[bot]" },
            });
            break;
          default:
            throw new Error("Mutation outside evaluation fixture");
        }
        applied.push({
          kind: mutation.kind,
          issueNumber: mutation.issueNumber,
        });
        return {
          number: target.number,
          htmlUrl: target.html_url,
          summary: mutation.kind,
        };
      },
    })),
    selection: fixedSelection(async () =>
      repositoryAccess(
        Object.assign(
          async (input: RequestInfo | URL) => {
            const path = new URL(String(input)).pathname;
            const issueNumber = /\/issues\/(\d+)$/.exec(path)?.[1];
            if (issueNumber)
              return issues.has(Number(issueNumber))
                ? Response.json(issues.get(Number(issueNumber)))
                : Response.json({ message: "Not Found" }, { status: 404 });
            if (path.endsWith("/comments")) return Response.json(comments);
            if (
              path.endsWith("/labels") ||
              path.endsWith("/milestones") ||
              path.endsWith("/pulls")
            )
              return Response.json([]);
            if (path.endsWith("/assignees"))
              return Response.json([{ login: "evan" }]);
            if (path.endsWith("/issues"))
              return Response.json([...issues.values()]);
            if (path === "/search/issues")
              return Response.json({
                total_count: issues.size,
                items: [...issues.values()],
              });
            if (path.includes("/contents/"))
              return Response.json({
                type: "file",
                encoding: "base64",
                content: Buffer.from(evidence).toString("base64"),
                html_url:
                  "https://github.com/customer/mochi/blob/main/README.md",
              });
            if (path.includes("/git/trees/"))
              return Response.json({
                tree: [{ path: "README.md", type: "blob" }],
                truncated: false,
              });
            if (path.endsWith("/20"))
              return Response.json({
                id: 20,
                full_name: "customer/mochi",
                default_branch: "main",
                description: evidence,
              });
            return Response.json(
              { message: "No fixture evidence for this endpoint" },
              { status: 404 },
            );
          },
          { preconnect: () => {} },
        ),
      ),
    ),
  });
  const executor = new AgentToolExecutor(broker, BOT_ID);
  const record = (name: string, args: unknown) => {
    trace.push({ tool: name, arguments: args });
    if (trace.length > 48) throw new Error("Evaluation tool budget exceeded");
  };
  const tools: ToolDefinition[] = AGENT_TOOLS.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: Type.Unsafe(spec.inputSchema as TSchema),
    execute: async (_id, args) => {
      record(spec.name, args);
      return {
        content: await executor.execute(spec.name, args, context, turn),
        details: {},
      };
    },
  }));
  // Keep the actual native/web schemas available so injection attempts remain observable.
  // No command, URL or caller-selected path ever leaves this fixture.
  tools.push(
    ...executionTools(() => {
      throw new Error("No real execution in evaluation");
    }).map((tool) => ({
      ...tool,
      execute: async (_id: string, args: unknown) => {
        record(tool.name, args);
        return {
          content: [
            {
              type: "text" as const,
              text: "Evaluation only: execution and external network are unavailable.",
            },
          ],
          isError: true,
          details: {},
        };
      },
    })),
  );
  tools.push({
    name: "material_read",
    label: "Read material",
    description: "Read the current turn's source index.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer()),
    }),
    execute: async (_id, args) => {
      record("material_read", args);
      if ((args as { path: string }).path !== "/fixture/sources.json")
        throw new Error("Unknown fixture material");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              current: context,
              message_app_link: turn.provenance!.sourceMessageLink,
            }),
          },
        ],
        details: {},
      };
    },
  });
  const prompt = runtimeUserMessage(
    {
      chatName: "当前项目群",
      messageType: "text",
      text: item.prompt,
      delivery: "handled",
      limitations: [],
      materials: [],
      contextMessages: [
        {
          messageId: context.sourceMessageId,
          senderId: context.requesterId,
          senderName: "Riley",
          senderType: "user",
          chatId: context.chatId,
          source: "current",
          messageType: "text",
          text: item.prompt,
          materialReferences: [],
          contentLimitations: [],
        },
      ],
    },
    new Map(),
    {
      chatName: "当前项目群",
      now: new Date("2026-10-16T02:00:00Z"),
      timeZone: "Asia/Shanghai",
    },
    { sources: "/fixture/sources.json" },
  );
  return {
    tools,
    prompt,
    trace,
    applied,
    check: () => broker.catalog(BOT_ID),
    close: () => state.close(),
  };
}
