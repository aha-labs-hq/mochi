import collaboration from "../../config/protocol/feishu-collaboration.md?raw";
import github from "../../config/protocol/github-investigation.md?raw";
import issue from "../../config/protocol/issue-authoring.md?raw";
import materials from "../../config/protocol/message-contract.md?raw";
import { BUILTIN_SKILLS } from "../../src/agent/skillCatalog.ts";
import type { ScheduleView } from "../../src/schedules/view.ts";
import {
  type DesktopAction,
  type DesktopSnapshot,
  initialSnapshot,
} from "../src/shared/model.ts";
import { type ProblemCode, problem } from "../src/shared/problem.ts";
import type { ProductConnection } from "../src/ui/connection.ts";
import {
  connectedFacts,
  type DesktopFactPatch,
  withGithubFacts,
  withSelectedProjects,
} from "./connectedFacts.ts";

export function productFixture(publish: () => void) {
  let snapshot: DesktopSnapshot = {
    ...initialSnapshot("0.2.0", true),
    phase: "listening",
    installed: true,
    loaded: true,
    controlReady: true,
    accountChangeReady: true,
    eventStreamReady: true,
    feishuGroups: [
      { id: "oc_test", name: "Mochi 测试群", avatarUrl: null, enabled: true },
    ],
    ...connectedFacts,
    account: {
      status: "signedIn",
      account: {
        provider: "openai-codex",
        authType: "oauth",
        subscription: true,
      },
      connections: [
        { provider: "openai-codex", authType: "oauth", subscription: true },
      ],
    },
    policy: { model: "gpt-test-balanced", reasoningEffort: "max" },
    queueDepth: 0,
    contextPercent: 30,
    activity: [
      {
        id: "ready",
        time: "2026-09-01T00:00:00Z",
        title: "飞书连接好了",
        kind: "normal",
      },
    ],
  };
  const botFacts = new Map<string, Partial<DesktopSnapshot>>();
  const scopedKeys = [
    "connectorCatalog",
    "feishu",
    "feishuGroups",
    "policy",
    "setup",
    "phase",
    "eventStreamReady",
    "canOrganize",
    "contextPercent",
  ] as const;
  const saveFacts = () => {
    if (snapshot.selectedBotId)
      botFacts.set(
        snapshot.selectedBotId,
        Object.fromEntries(scopedKeys.map((key) => [key, snapshot[key]])),
      );
  };
  const instructionRecords = new Map<
    string,
    { content: string; revision: string }
  >();
  const botWrites: { botId: string | null; kind: string; content?: string }[] =
    [];
  const actions: DesktopAction[] = [];
  let modelRequests = 0;
  let skillRequests = 0;
  let scheduleRequests = 0;
  const scheduleRecords = new Map<string, readonly ScheduleView[]>();
  let scheduleGate: ReturnType<typeof Promise.withResolvers<void>> | null =
    null;
  const skillContent = {
    "feishu-collaboration": collaboration,
    "message-contract": materials,
    "issue-authoring": issue,
    "github-investigation": github,
  };
  let actionGate: { promise: Promise<void>; resolve(): void } | null = null;
  let actionFailure: ProblemCode | null = null;
  let failureAction: DesktopAction["type"] | null = null;
  const instructions = {
    content:
      "## 怎么说话\n\n先讲结论，用所有同事都能听懂的话。\n像一位熟悉项目的同事，不要写成技术报告。\n\n## 怎么帮忙\n\n先说发生了什么、会影响谁，再说下一步。\n有依据就附上来源；还不知道的事，直接说不知道。\n\n## 记住这件事\n\n简洁一点，也体贴一点。重要的细节别省略，\n不必要的术语就留在幕后。",
    revision: "a".repeat(64),
  };
  const connection: ProductConnection = {
    schedules: async (botId) => {
      scheduleRequests++;
      const id = botId ?? snapshot.selectedBotId;
      if (id !== snapshot.selectedBotId || id === null)
        return { ok: false, problem: problem("bot_view_changed") };
      const records = structuredClone(scheduleRecords.get(id) ?? []);
      if (scheduleGate) await scheduleGate.promise;
      if (actionFailure && !failureAction)
        return { ok: false, problem: problem(actionFailure) };
      return { ok: true, value: records };
    },
    skills: async () => {
      skillRequests++;
      if (actionFailure && !failureAction)
        return { ok: false, problem: problem(actionFailure) };
      return {
        ok: true,
        value: BUILTIN_SKILLS.map((skill) => ({
          ...skill,
          content: skillContent[skill.id],
        })),
      };
    },
    instructions: async (request) => {
      if (actionFailure && !failureAction)
        return { ok: false, problem: problem(actionFailure) };
      const id = snapshot.selectedBotId!;
      const current = instructionRecords.get(id) ?? instructions;
      if (request.type === "save") {
        botWrites.push({
          botId: id,
          kind: "instructions",
          content: request.document.content,
        });
        instructionRecords.set(id, {
          content: request.document.content,
          revision: "b".repeat(64),
        });
      }
      return { ok: true, value: instructionRecords.get(id) ?? current };
    },
    perform: async (action, botId) => {
      const displayedBot = botId ?? snapshot.selectedBotId;
      actions.push(action);
      botWrites.push({ botId: snapshot.selectedBotId, kind: action.type });
      if (actionGate) await actionGate.promise;
      if (actionFailure && (!failureAction || action.type === failureAction))
        return { ok: false, problem: problem(actionFailure) };
      if (
        action.type === "setScheduleEnabled" ||
        action.type === "cancelSchedule"
      ) {
        if (displayedBot !== snapshot.selectedBotId || displayedBot === null)
          return { ok: false, problem: problem("bot_view_changed") };
        const records = scheduleRecords.get(displayedBot) ?? [];
        const current = records.find((item) => item.id === action.scheduleId);
        if (!current || current.revision !== action.revision)
          return { ok: false, problem: problem("schedules_conflict") };
        if (
          action.type === "setScheduleEnabled" &&
          action.enabled &&
          current.rule.kind === "once" &&
          Date.parse(current.rule.at) <= Date.now()
        )
          return { ok: false, problem: problem("schedule_time_passed") };
        scheduleRecords.set(
          displayedBot,
          action.type === "cancelSchedule"
            ? records.filter((item) => item.id !== current.id)
            : records.map((item) =>
                item.id === current.id
                  ? {
                      ...item,
                      enabled: action.enabled,
                      revision: item.revision + 1,
                    }
                  : item,
              ),
        );
      }
      if (action.type === "selectProjects") {
        // A selection change reaches the desktop the same way it does in
        // production: the connector catalog is republished with the resource
        // set the Bot now holds.
        snapshot = {
          ...snapshot,
          connectorCatalog: withSelectedProjects(
            snapshot.connectorCatalog,
            action.resourceIds.map((resourceId) => {
              const match = /^repository:([1-9][0-9]*)$/.exec(resourceId);
              if (!match)
                throw new Error(`Invalid fixture resource id: ${resourceId}`);
              return Number(match[1]);
            }),
          ),
        };
        publish();
      }
      if (action.type === "addConnectorResources") {
        snapshot = {
          ...snapshot,
          connectorCatalog: snapshot.connectorCatalog && {
            ...snapshot.connectorCatalog,
            connections: snapshot.connectorCatalog.connections.map(
              (connection) => {
                if (connection.connectionId !== action.connectionId)
                  return connection;
                const added = action.references.map((reference) => ({
                  resourceId: `document:${new URL(reference).pathname.split("/").at(-1)}`,
                  resourceType: "document",
                  displayName: "新增文档",
                  selectionId: "f".repeat(32),
                  selected: true,
                  ownerId: null,
                  visibility: null,
                  writable: false,
                }));
                const resources = [
                  ...connection.resources,
                  ...added.filter(
                    (resource) =>
                      !connection.resources.some(
                        (current) => current.resourceId === resource.resourceId,
                      ),
                  ),
                ];
                return {
                  ...connection,
                  resources,
                  resourceScope: {
                    ...connection.resourceScope,
                    selectedCount: resources.filter(
                      (resource) => resource.selected,
                    ).length,
                  },
                };
              },
            ),
          },
        };
        publish();
      }
      if (action.type === "removeConnectorResource") {
        snapshot = {
          ...snapshot,
          connectorCatalog: snapshot.connectorCatalog && {
            ...snapshot.connectorCatalog,
            connections: snapshot.connectorCatalog.connections.map(
              (connection) =>
                connection.connectionId === action.connectionId
                  ? (() => {
                      const resources = connection.resources.filter(
                        (resource) => resource.resourceId !== action.resourceId,
                      );
                      return {
                        ...connection,
                        resources,
                        resourceScope: {
                          ...connection.resourceScope,
                          selectedCount: resources.filter(
                            (resource) => resource.selected,
                          ).length,
                        },
                      };
                    })()
                  : connection,
            ),
          },
        };
        publish();
      }
      if (action.type === "setBotEnabled") {
        const connected = snapshot.feishu.active?.state === "ready";
        snapshot = {
          ...snapshot,
          setup: action.enabled ? null : snapshot.setup,
          phase: action.enabled
            ? connected
              ? "listening"
              : "attention"
            : "stopped",
          eventStreamReady: action.enabled && connected,
          bots: snapshot.bots.map((bot) =>
            bot.botId === action.botId
              ? {
                  ...bot,
                  enabled: action.enabled,
                  lifecycle: action.enabled
                    ? connected
                      ? "listening"
                      : "awaitingConnection"
                    : "paused",
                  phase: action.enabled
                    ? connected
                      ? "listening"
                      : "attention"
                    : "stopped",
                }
              : bot,
          ),
        };
        publish();
      }
      if (action.type === "setBotCharacter") {
        snapshot = {
          ...snapshot,
          bots: snapshot.bots.map((bot) =>
            bot.botId === action.botId
              ? { ...bot, characterId: action.characterId }
              : bot,
          ),
        };
        publish();
      }
      if (action.type === "createBot") {
        saveFacts();
        const botId = crypto.randomUUID();
        const empty = initialSnapshot("0.2.0", true);
        snapshot = {
          ...snapshot,
          ...Object.fromEntries(scopedKeys.map((key) => [key, empty[key]])),
          setup:
            snapshot.account.status === "signedIn"
              ? "ready"
              : snapshot.account.status === "signingIn"
                ? "signingIn"
                : snapshot.account.status === "unknown"
                  ? "checking"
                  : "signIn",
          phase: "stopped",
          selectedBotId: botId,
          bots: [
            ...snapshot.bots,
            {
              botId,
              label: "新伙伴",
              characterId: "mochi",
              enabled: false,
              lifecycle: "setup",
              phase: "stopped",
              groupCount: 0,
              projectCount: 0,
              problemCode: null,
            },
          ],
        };
        publish();
      }
      if (action.type === "selectBot") {
        saveFacts();
        snapshot = {
          ...snapshot,
          ...(botFacts.get(action.botId) ?? {}),
          selectedBotId: action.botId,
        };
        publish();
      }
      if (action.type === "updatePolicy") {
        snapshot = { ...snapshot, policy: action.policy };
        publish();
      }
      if (action.type === "updateGroupParticipation") {
        snapshot = {
          ...snapshot,
          feishuGroups:
            snapshot.feishuGroups?.map((group) =>
              group.id === action.chatId
                ? { ...group, enabled: action.enabled }
                : group,
            ) ?? null,
        };
        publish();
      }
      return { ok: true, value: null };
    },
    models: async () => {
      modelRequests++;
      if (snapshot.busy !== null)
        return { ok: false, problem: problem("action_in_progress") };
      snapshot = { ...snapshot, busy: "models" };
      publish();
      // Like the host, a read pushes busy/idle facts independently of its RPC
      // result. Let the renderer observe both frames before the result settles.
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        if (actionFailure && !failureAction)
          return { ok: false, problem: problem(actionFailure) };
        return {
          ok: true,
          value: [
            {
              id: "gpt-test-balanced",
              displayName: "Balanced",
              description: "Provider-owned model description.",
              supportedEfforts: [
                { id: "high", description: "Deep reasoning" },
                { id: "max", description: "Maximum depth" },
              ],
              defaultEffort: "high",
            },
            {
              id: "gpt-test-seven",
              displayName: "Seven levels",
              description: "A model with seven reasoning steps.",
              supportedEfforts: [
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ].map((id) => ({ id, description: id })),
              defaultEffort: "high",
            },
            {
              id: "gpt-test-fast",
              displayName: "Fast",
              description: "A faster model.",
              supportedEfforts: [{ id: "low", description: "Everyday tasks" }],
              defaultEffort: "low",
            },
          ],
        };
      } finally {
        snapshot = { ...snapshot, busy: null };
        publish();
      }
    },
  };
  return {
    connection,
    get snapshot() {
      return snapshot;
    },
    actions,
    botWrites,
    modelRequests: () => modelRequests,
    skillRequests: () => skillRequests,
    scheduleRequests: () => scheduleRequests,
    setSchedules(
      records: readonly ScheduleView[],
      botId = snapshot.selectedBotId!,
    ) {
      scheduleRecords.set(botId, structuredClone(records));
    },
    holdSchedules() {
      scheduleGate = Promise.withResolvers<void>();
    },
    releaseSchedules() {
      scheduleGate?.resolve();
      scheduleGate = null;
    },
    /**
     * Accepts the GitHub-shaped facts a test describes and folds them into the
     * one catalog the desktop reads.
     *
     * Tests name repositories because that is what they mean; they must not
     * restate the catalog's structure, and nothing here may publish a second
     * source of GitHub facts. The catalog's other connections are preserved.
     */
    update(patch: DesktopFactPatch) {
      const { github, githubProjects, ...rest } = patch;
      if (githubProjects === null) {
        // An explicit null means no catalog has been published yet, which is a
        // different state from a catalog holding no connectors.
        rest.connectorCatalog = null;
      } else if (github !== undefined || githubProjects !== undefined) {
        const connection = github ?? {};
        const projects = githubProjects ?? [];
        rest.connectorCatalog = withGithubFacts(
          snapshot.connectorCatalog,
          {
            status: connection.status ?? "connected",
            login: connection.account?.login ?? null,
            problem: connection.problem ?? null,
          },
          projects.map((project) => ({
            number: project.id,
            fullName: project.fullName,
            selected: project.selected,
            ...(project.ownerId === undefined
              ? {}
              : { ownerId: project.ownerId }),
          })),
        );
      }
      snapshot = { ...snapshot, ...rest };
      const patch2 = rest as Partial<DesktopSnapshot>;
      if (patch2.phase && !patch2.bots)
        snapshot = {
          ...snapshot,
          bots: snapshot.bots.map((bot) =>
            bot.botId === snapshot.selectedBotId
              ? { ...bot, phase: patch2.phase! }
              : bot,
          ),
        };
      publish();
    },
    problem(code: ProblemCode | null) {
      snapshot = { ...snapshot, problem: code ? problem(code) : null };
      publish();
    },
    holdActions() {
      const gate = Promise.withResolvers<void>();
      actionGate = { promise: gate.promise, resolve: gate.resolve };
    },
    releaseActions() {
      actionGate?.resolve();
      actionGate = null;
    },
    failAction(code: ProblemCode | null, type?: DesktopAction["type"]) {
      actionFailure = code;
      failureAction = type ?? null;
    },
    skillContent(content: string) {
      skillContent["github-investigation"] = content;
    },
  };
}
