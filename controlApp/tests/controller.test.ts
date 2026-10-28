import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConnectorCatalogProjection } from "../../src/control/connectorSnapshot.ts";
import { mochiControlManifest } from "../../src/control/manifest.ts";
import {
  MOCHI_CONTROL_PROTOCOL_VERSION,
  type MochiControlRequest,
  type MochiControlResponse,
} from "../../src/control/protocol.ts";
import { FleetStatusProjection } from "../../src/control/statusSnapshot.ts";
import type { GitHubConnectionSnapshot } from "../../src/github/repository.ts";
import { memoryLogSink, setLogSink } from "../../src/log.ts";
import type { RuntimeAccountState } from "../../src/runtime/protocol.ts";
import { environmentFor } from "../src/host/contract.ts";
import {
  DesktopController,
  type NativeActions,
} from "../src/host/controller.ts";
import type { DesktopService } from "../src/host/service.ts";
import { githubStatusOf } from "../src/shared/connectorView.ts";
import { fail } from "../src/shared/problem.ts";
import {
  connectedConnectorCatalog,
  feishuMailConnection,
} from "./connectedFacts.ts";

/**
 * A catalog describing one GitHub connection.
 *
 * The desktop derives every GitHub-shaped fact from the catalog, so a fixture
 * that wants to change GitHub's state publishes a new catalog rather than a
 * second GitHub-specific projection.
 */
function catalogWithGithub(
  connection: GitHubConnectionSnapshot,
  repositories: readonly number[] = [],
): ConnectorCatalogProjection {
  const connectionId = connection.account
    ? `github:${connection.account.id}`
    : "github:0";
  const status: ConnectorCatalogProjection["connections"][number]["status"] =
    connection.status === "connected"
      ? "ready"
      : connection.status === "authorizing"
        ? "authorizing"
        : connection.status === "unavailable"
          ? "unavailable"
          : "reauthorization_required";
  if (connection.status === "disconnected") {
    return { revision: `sha256:${"e".repeat(64)}`, connections: [] };
  }
  return {
    revision: `sha256:${"e".repeat(64)}`,
    connections: [
      {
        connectionId,
        providerId: "github",
        providerDisplayName: "GitHub",
        status,
        accountDisplayName: connection.account?.login ?? null,
        problem: connection.problem,
        grantedScopes: [],
        resourceScope: {
          status: status === "ready" ? "ready" : "unavailable",
          selectedCount: repositories.length,
          ...(status === "ready" ? {} : { problem: "connection_unavailable" }),
        },
        resources: repositories.map((repositoryId) => ({
          resourceId: `repository:${repositoryId}`,
          resourceType: "repository",
          displayName: `customer/project-${repositoryId}`,
          selectionId: "f".repeat(32),
          selected: true,
          ownerId: "1",
          visibility: "public",
          writable: true,
        })),
        capabilities: connectedConnectorCatalog.connections
          .find((candidate) => candidate.providerId === "github")!
          .capabilities.map((capability) => ({
            ...capability,
            availability:
              status !== "ready"
                ? ("connection_unavailable" as const)
                : repositories.length > 0
                  ? ("ready" as const)
                  : ("selection_required" as const),
          })),
      },
    ],
  };
}

const BOT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_BOT_ID = "22222222-3333-4444-8555-666666666666";
const CREATED_BOT_ID = "33333333-4444-4555-8666-777777777777";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "mochi-controller-test-")),
  );
  roots.push(home);
  const env = environmentFor(
    mochiControlManifest("development", "0.2.0"),
    join(home, "Mochi.app"),
    home,
  );
  const fleet = new FleetStatusProjection(env.statusPath);
  fleet.roster([
    { id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true },
    { id: OTHER_BOT_ID, label: "小麻薯", characterId: "mochi", enabled: true },
  ]);
  const bot = fleet.bot(BOT_ID);
  const otherBot = fleet.bot(OTHER_BOT_ID);
  // A created Bot is only addressable after the Bridge has rostered it, so the
  // fixture publishes it inside the create_bot response, as production does.
  const createdBotId: string = CREATED_BOT_ID;
  // The renderer's facts come from one atomic fleet write, so the same
  // projection drives the fixture's status file and the assertions below.
  const status = {
    ...fleet,
    // The controller reads the fleet object, then resolves the Bot it names;
    // this double must expose both levels for those reads to be meaningful.
    snapshot: () => fleet.snapshot(),
    starting: () => bot.starting(),
    controlReady: () => fleet.controlReady(),
    accountChanged: (account: RuntimeAccountState) =>
      fleet.accountChanged(
        account.status === "signedIn"
          ? {
              status: "signedIn",
              account: account.account,
              connections: account.connections,
            }
          : { status: account.status },
      ),
    eventStreamReady: () => bot.eventStreamReady(),
    eventStreamUnavailable: () => bot.eventStreamUnavailable(),
    stopping: () => fleet.stopping(),
    policy: (policy: { model: string; reasoningEffort: string }) =>
      bot.policy(policy as never),
    // GitHub facts reach the desktop only through the connector catalog, so the
    // fixture publishes them the same way the Bridge does.
    githubChanged: (snapshot: GitHubConnectionSnapshot) =>
      bot.connectorCatalogChanged(catalogWithGithub(snapshot)),
    groupsChanged: (groups: Parameters<typeof bot.groupsChanged>[0]) =>
      bot.groupsChanged(groups),
    feishuChanged: (snapshot: Parameters<typeof bot.feishuChanged>[0]) =>
      bot.feishuChanged(snapshot),
    setup: (
      stage: Parameters<typeof bot.setup>[0],
      problemCode?: Parameters<typeof bot.setup>[1],
    ) => bot.setup(stage, problemCode),
    blocked: (code: Parameters<typeof bot.blocked>[0]) => bot.blocked(code),
    awaitingLogin: (code?: Parameters<typeof bot.awaitingLogin>[0]) =>
      bot.awaitingLogin(code),
  };
  fleet.accountChanged({
    status: "signedIn",
    account: {
      provider: "openai-codex",
      authType: "oauth",
      subscription: true,
    },
    connections: [
      { provider: "openai-codex", authType: "oauth", subscription: true },
    ],
  });
  bot.starting();
  otherBot.policy({ model: "gpt-other", reasoningEffort: "low" });
  otherBot.starting();
  fleet.controlReady();
  bot.eventStreamReady();
  const requests: MochiControlRequest[] = [],
    urls: string[] = [],
    reports: object[] = [],
    copied: string[] = [],
    operations: string[] = [];
  let confirmed = true;
  const confirmations: Array<Parameters<NativeActions["confirm"]>[0]> = [];
  const native: NativeActions = {
    backgroundStatus: () => 1,
    openLoginItems: () => {
      operations.push("open-login-items");
    },
    confirm: async (action) => {
      confirmations.push(action);
      return confirmed;
    },
    openExternal: (url) => {
      urls.push(url);
      return true;
    },
    copyText: (text) => {
      copied.push(text);
    },
    openApplications() {
      operations.push("open-applications");
    },
    promptByok: async () => {},
    exportDiagnostics: async (report) => {
      reports.push(report);
    },
  };
  const service: Pick<
    DesktopService,
    "inspect" | "perform" | "requireControl"
  > = {
    inspect: async () => ({
      installed: true,
      launch: { state: "running", pid: process.pid, identity: {} },
      status: status.snapshot(),
      problem: null,
    }),
    perform: async (operation) => {
      operations.push(operation);
    },
    requireControl: async () => status.snapshot(),
  };
  let onControl: ((request: MochiControlRequest) => void) | null = null;
  const control = async (
    _path: string,
    request: MochiControlRequest,
  ): Promise<MochiControlResponse> => {
    requests.push(request);
    onControl?.(request);
    if (request.command === "start_chatgpt_login") {
      fleet.accountChanged({ status: "signingIn" });
      for (const entry of fleet.snapshot().bots)
        fleet.bot(entry.botId).awaitingLogin();
      return {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        ok: true,
        authorizationUrl: "https://auth.openai.com/test-private-authorization",
      };
    }
    if (
      request.command === "start_github_login" ||
      request.command === "start_github_installation"
    ) {
      bot.connectorCatalogChanged(
        catalogWithGithub({
          status: "authorizing",
          account: null,
          problem: null,
        }),
      );
      return {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        ok: true,
        authorizationUrl:
          request.command === "start_github_installation"
            ? "https://github.com/apps/mochi-companion/installations/new?state=private-state"
            : "https://github.com/login/oauth/authorize?state=private-state",
      };
    }
    if (request.command === "read_byok") {
      return {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        ok: true,
        connections: [
          {
            provider: "mochi-byok-12345678",
            baseUrl: "https://api.example.com/v1",
            model: "gpt-5",
            label: "Example service",
          },
        ],
      };
    }
    if (request.command === "rename_bot") {
      fleet.roster(
        fleet.snapshot().bots.map((bot) => ({
          id: bot.botId,
          label: bot.botId === request.botId ? request.label : bot.label,
          characterId: bot.characterId,
          enabled: bot.enabled,
        })),
      );
      return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true };
    }
    if (request.command === "create_bot") {
      // The Bridge rosters, provisions and starts the Bot before it answers, so
      // the fixture publishes the new Bot the same way production does.
      fleet.roster([
        ...fleet.snapshot().bots.map((bot) => ({
          id: bot.botId,
          label: bot.label,
          characterId: bot.characterId,
          enabled: bot.enabled,
        })),
        ...(createdBotId
          ? [
              {
                id: createdBotId,
                label: "第三个分身",
                characterId: "mochi",
                enabled: false,
              },
            ]
          : []),
      ]);
      fleet.bot(createdBotId).starting();
      return {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        ok: true,
        botId: createdBotId,
      };
    }
    if (request.command === "feishu_settings")
      return {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        ok: true,
        authorizationUrl: FEISHU_APPROVAL_URL,
      };
    if (request.command === "start_feishu_connection")
      return {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        ok: true,
        authorizationUrl:
          "https://open.feishu.cn/page/cli?user_code=ABCD-1234&lpv=1.0.93&ocv=1.0.93&from=cli",
      };
    if (
      request.command === "cancel_github_login" ||
      request.command === "disconnect_github"
    ) {
      bot.connectorCatalogChanged(
        catalogWithGithub({
          status: "disconnected",
          account: null,
          problem: null,
        }),
      );
    }
    return { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true };
  };
  // The fixture never mutates status for a bot-scoped command, so a control
  // round trip that would change one is answered without effect; tests publish
  // the new fact explicitly to model a Bridge that has or has not applied it.
  const controller = new DesktopController(
    env,
    native,
    service,
    control,
    async () => "cancelled",
  );
  return {
    controller,
    status,
    fleet,
    bot,
    otherBot,
    service,
    requests,
    urls,
    reports,
    copied,
    operations,
    confirmations,
    env,
    native,
    onControl(handler: (request: MochiControlRequest) => void) {
      onControl = handler;
    },
    confirm(value: boolean) {
      confirmed = value;
    },
  };
}
const FEISHU_APPROVAL_URL =
  "https://open.feishu.cn/page/scope-apply?clientID=cli_fixture&scopes=im%3Amessage";
describe("companion orchestration", () => {
  test("verified service recovery supersedes a start timeout without another action", async () => {
    const f = fixture();
    f.status.eventStreamUnavailable();
    f.service.perform = async () => fail("service_readiness_timeout");
    expect(
      await f.controller.perform({ type: "service", operation: "start" }),
    ).toMatchObject({
      ok: false,
      problem: { code: "service_readiness_timeout" },
    });
    await f.controller.refresh();
    expect(f.controller.snapshot.controlReady).toBe(true);
    expect(f.controller.snapshot.problem?.code).toBe(
      "service_readiness_timeout",
    );
    f.status.eventStreamReady();
    await f.controller.refresh();
    expect(f.controller.snapshot.phase).toBe("listening");
    expect(f.controller.snapshot.problem).toBeNull();
    // Once reconciled, the historical timeout cannot return after disconnect.
    f.status.eventStreamUnavailable();
    await f.controller.refresh();
    expect(f.controller.snapshot.problem).toBeNull();
    f.status.stopping();
  });

  test("shutdown waits for the current operation, rejects new actions and joins repeated quit requests", async () => {
    const f = fixture();
    const operation = deferred();
    const stopping = deferred();
    f.service.perform = async (action) => {
      f.operations.push(action);
      await (action === "stop" ? stopping.promise : operation.promise);
    };
    const starting = f.controller.perform({
      type: "service",
      operation: "start",
    });
    const shutdown = f.controller.shutdown();
    expect(f.controller.shutdown()).toBe(shutdown);
    expect(
      (await f.controller.perform({ type: "service", operation: "start" })).ok,
    ).toBe(false);
    expect(f.operations).toEqual(["start"]);
    operation.resolve();
    await starting;
    await Bun.sleep(0);
    expect(f.operations).toEqual(["start", "stop"]);
    expect(f.controller.snapshot.busy).toBe("shutdown");
    stopping.resolve();
    expect((await shutdown).ok).toBe(true);
    expect(
      (await f.controller.perform({ type: "service", operation: "start" })).ok,
    ).toBe(false);
    f.status.stopping();
  });
  test("unproven shutdown keeps the App actionable and allows a verified retry", async () => {
    const f = fixture();
    f.service.perform = async () => fail("service_shutdown_failed");
    expect(await f.controller.shutdown()).toMatchObject({
      ok: false,
      problem: { code: "service_shutdown_failed" },
    });
    expect(f.controller.snapshot.problem?.code).toBe("service_shutdown_failed");
    f.service.perform = async () => {};
    expect((await f.controller.shutdown()).ok).toBe(true);
    f.status.stopping();
  });
  test.each(["loginGitHub", "manageGitHubAccess"] as const)(
    "%s stays in the host and preserves browser recovery",
    async (action) => {
      const f = fixture();
      f.native.openExternal = () => false;
      // Dismissing returns to the GitHub page's own reopen; the ChatGPT
      // login has nothing to do with it.
      expect(await f.controller.perform({ type: action })).toMatchObject({
        ok: false,
        problem: { code: "browser_unavailable", recoveryAction: "retry" },
      });
      expect(f.controller.snapshot.canReopenGitHubLogin).toBe(true);
      expect(JSON.stringify(f.controller.snapshot)).not.toContain(
        "private-state",
      );
      f.native.openExternal = (url) => {
        f.urls.push(url);
        return true;
      };
      expect(
        (await f.controller.perform({ type: "reopenGitHubLogin" })).ok,
      ).toBe(true);
      expect(f.requests.map((request) => request.command)).toEqual([
        action === "loginGitHub"
          ? "start_github_login"
          : "start_github_installation",
      ]);
      await f.controller.perform({ type: "cancelGitHubLogin" });
      expect(f.controller.snapshot.canReopenGitHubLogin).toBe(false);
      expect(
        (await f.controller.perform({ type: "reopenGitHubLogin" })).ok,
      ).toBe(false);
      f.status.stopping();
    },
  );
  test("project writes require authoritative read-back; native cancellation does not disconnect", async () => {
    const f = fixture();
    // The grant is deployment-wide; the catalog the write is verified against is
    // the selected Bot's own.
    f.bot.connectorCatalogChanged(
      catalogWithGithub(
        {
          status: "connected",
          account: { id: 1, login: "customer" },
          problem: null,
        },
        [],
      ),
    );
    await f.controller.refresh();
    expect(
      await f.controller.perform({
        type: "selectProjects",
        resourceIds: ["repository:20"],
      }),
    ).toMatchObject({
      ok: false,
      problem: { code: "github_selection_failed" },
    });
    f.bot.connectorCatalogChanged(
      catalogWithGithub(
        {
          status: "connected",
          account: { id: 1, login: "customer" },
          problem: null,
        },
        [20],
      ),
    );
    expect(
      (
        await f.controller.perform({
          type: "selectProjects",
          resourceIds: ["repository:20"],
        })
      ).ok,
    ).toBe(true);
    f.confirm(false);
    await f.controller.perform({ type: "disconnectGitHub" });
    expect(
      f.requests.some((request) => request.command === "disconnect_github"),
    ).toBe(false);
    await f.controller.perform({ type: "exportDiagnostics" });
    expect(JSON.stringify(f.reports)).not.toMatch(
      /customer|private-project|installationId/,
    );
    f.confirm(true);
    expect((await f.controller.perform({ type: "disconnectGitHub" })).ok).toBe(
      true,
    );
    expect(githubStatusOf(f.controller.snapshot.connectorCatalog)).toBe(
      "disconnected",
    );
    f.status.stopping();
  });
  test("returning to Mochi asks the selected Bot to recheck without dimming anything", async () => {
    const f = fixture();
    await f.controller.refresh();
    const published: (string | null)[] = [];
    f.controller.subscribe((snapshot) => published.push(snapshot.busy));
    await f.controller.recheck();
    expect(
      f.requests.filter((request) => request.command === "recheck_connections"),
    ).toEqual([
      {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "recheck_connections",
        botId: f.controller.snapshot.selectedBotId!,
      },
    ]);
    // Never exclusive: no busy state is published and a real action still runs.
    expect(published.every((busy) => busy === null)).toBe(true);
    expect((await f.controller.perform({ type: "clearProblem" })).ok).toBe(
      true,
    );
    f.status.stopping();
  });
  test("disconnecting the mail grant asks first and sends nothing when declined", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.confirm(false);
    expect(
      (await f.controller.perform({ type: "disconnectFeishuMail" })).ok,
    ).toBe(true);
    expect(
      f.requests.some(
        (request) => request.command === "disconnect_feishu_mail",
      ),
    ).toBe(false);
    f.confirm(true);
    await f.controller.perform({ type: "disconnectFeishuMail" });
    expect(
      f.requests.filter(
        (request) => request.command === "disconnect_feishu_mail",
      ),
    ).toHaveLength(1);
    f.status.stopping();
  });
  test("resource additions preserve old selections and permit duplicate references", async () => {
    const f = fixture();
    const catalog = structuredClone(connectedConnectorCatalog);
    const connection = catalog.connections.find(
      (candidate) => candidate.providerId === "feishu-service",
    )!;
    f.bot.connectorCatalogChanged(catalog);
    await f.controller.refresh();
    f.onControl((request) => {
      if (request.command !== "add_connector_resources") return;
      const added = {
        ...connection.resources[0]!,
        resourceId: "document:SECOND",
        displayName: "第二份文档",
        selectionId: "d".repeat(32),
      };
      f.bot.connectorCatalogChanged({
        ...catalog,
        connections: catalog.connections.map((candidate) =>
          candidate.connectionId === connection.connectionId
            ? {
                ...candidate,
                resourceScope: { ...candidate.resourceScope, selectedCount: 2 },
                resources: [...candidate.resources, added],
              }
            : candidate,
        ),
      });
    });
    expect(
      await f.controller.perform({
        type: "addConnectorResources",
        connectionId: connection.connectionId,
        references: ["https://acme.feishu.cn/docx/SECOND"],
      }),
    ).toEqual({ ok: true, value: null });
    f.onControl(() => {});
    expect(
      await f.controller.perform({
        type: "addConnectorResources",
        connectionId: connection.connectionId,
        references: ["https://acme.feishu.cn/docx/SECOND"],
      }),
    ).toEqual({ ok: true, value: null });
    f.onControl(() =>
      f.bot.connectorCatalogChanged({
        ...catalog,
        connections: catalog.connections.map((candidate) =>
          candidate.connectionId === connection.connectionId
            ? {
                ...candidate,
                resourceScope: { ...candidate.resourceScope, selectedCount: 0 },
                resources: [],
              }
            : candidate,
        ),
      }),
    );
    expect(
      await f.controller.perform({
        type: "addConnectorResources",
        connectionId: connection.connectionId,
        references: ["https://acme.feishu.cn/docx/THIRD"],
      }),
    ).toMatchObject({
      ok: false,
      problem: { code: "connector_selection_failed" },
    });
  });

  test("a mailbox chosen from proven options, then unchosen, reads back as a success", async () => {
    // Shared mailboxes are published as unselected options. Choosing one turns
    // that option into a selection; removing it leaves the option behind.
    const f = fixture();
    const ready = feishuMailConnection("ready");
    const selected = feishuMailConnection("selected");
    const publish = (connection: typeof ready) =>
      f.bot.connectorCatalogChanged({
        ...connectedConnectorCatalog,
        connections: [...connectedConnectorCatalog.connections, connection],
      });
    publish(ready);
    await f.controller.refresh();
    f.onControl((request) => {
      if (request.command === "add_connector_resources") publish(selected);
      if (request.command === "remove_connector_resource") publish(ready);
    });
    expect(
      await f.controller.perform({
        type: "addConnectorResources",
        connectionId: ready.connectionId,
        references: ["support@example.com"],
      }),
    ).toEqual({ ok: true, value: null });
    const chosen = selected.resources.find((resource) => resource.selected)!;
    expect(
      await f.controller.perform({
        type: "removeConnectorResource",
        connectionId: selected.connectionId,
        resourceId: chosen.resourceId,
        selectionId: chosen.selectionId!,
      }),
    ).toEqual({ ok: true, value: null });
    // A removal the Bridge did not apply still fails the readback.
    publish(selected);
    await f.controller.refresh();
    f.onControl(() => {});
    expect(
      await f.controller.perform({
        type: "removeConnectorResource",
        connectionId: selected.connectionId,
        resourceId: chosen.resourceId,
        selectionId: chosen.selectionId!,
      }),
    ).toMatchObject({
      ok: false,
      problem: { code: "connector_selection_failed" },
    });
    f.status.stopping();
  });

  test("resource removal requires exact authority and exact readback", async () => {
    const f = fixture();
    const catalog = structuredClone(connectedConnectorCatalog);
    const connection = catalog.connections.find(
      (candidate) => candidate.providerId === "feishu-service",
    )!;
    const resource = connection.resources[0]!;
    const action = {
      type: "removeConnectorResource" as const,
      connectionId: connection.connectionId,
      resourceId: resource.resourceId,
      selectionId: resource.selectionId!,
    };
    f.bot.connectorCatalogChanged(catalog);
    await f.controller.refresh();
    expect(
      await f.controller.perform({ ...action, selectionId: "0".repeat(32) }),
    ).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(0);
    expect(await f.controller.perform(action)).toMatchObject({
      ok: false,
      problem: { code: "connector_selection_failed" },
    });
    f.onControl((request) => {
      if (request.command === "remove_connector_resource")
        f.bot.connectorCatalogChanged({
          ...catalog,
          connections: catalog.connections.map((candidate) =>
            candidate.connectionId === connection.connectionId
              ? {
                  ...candidate,
                  resourceScope: {
                    ...candidate.resourceScope,
                    selectedCount: 0,
                  },
                  resources: [],
                }
              : candidate,
          ),
        });
    });
    expect(await f.controller.perform(action)).toEqual({
      ok: true,
      value: null,
    });
    expect(f.requests.at(-1)).toEqual({
      version: MOCHI_CONTROL_PROTOCOL_VERSION,
      command: "remove_connector_resource",
      botId: BOT_ID,
      connectionId: connection.connectionId,
      resourceId: resource.resourceId,
      selectionId: resource.selectionId!,
    });
  });

  test("only verified live status supplies the group name; diagnostics export omits it", async () => {
    const f = fixture();
    f.status.groupsChanged([
      { id: "oc_team", name: "Private Team", avatarUrl: null, enabled: true },
    ]);
    await f.controller.refresh();
    expect(f.controller.snapshot.feishuGroups).toEqual([
      { id: "oc_team", name: "Private Team", avatarUrl: null, enabled: true },
    ]);
    await f.controller.perform({ type: "exportDiagnostics" });
    expect(JSON.stringify(f.reports)).not.toContain("Private Team");
    expect(JSON.stringify(f.reports)).not.toContain("feishuGroups");
    f.service.inspect = async () => ({
      installed: true,
      launch: null,
      status: null,
      problem: null,
    });
    await f.controller.refresh();
    expect(f.controller.snapshot.phase).toBe("stopped");
    expect(f.controller.snapshot.feishuGroups).toBeNull();
    f.status.stopping();
  });
  test("observation never starts a service, logs in or creates a Session", async () => {
    const f = fixture();
    await f.controller.refresh();
    await f.controller.refresh();
    expect(f.controller.snapshot.phase).toBe("listening");
    expect(f.controller.snapshot.eventStreamReady).toBe(true);
    expect(f.requests).toEqual([]);
    expect(f.operations).toEqual([]);
    await f.controller.perform({
      type: "setBotEnabled",
      botId: BOT_ID,
      enabled: true,
    });
    expect(f.requests.map((r) => r.command)).toEqual(["set_bot_enabled"]);
  });
  test("an earlier refresh cannot release the in-flight action gate", async () => {
    const f = fixture(),
      observation = deferred(),
      operation = deferred();
    const original = f.service.inspect;
    f.service.inspect = async () => {
      await observation.promise;
      return original();
    };
    f.service.perform = async () => operation.promise;
    const observing = f.controller.refresh(),
      performing = f.controller.perform({
        type: "service",
        operation: "restart",
      });
    observation.resolve();
    await observing;
    expect(f.controller.snapshot.busy).toBe("service");
    expect(
      await f.controller.perform({
        type: "setBotEnabled",
        botId: BOT_ID,
        enabled: true,
      }),
    ).toMatchObject({
      ok: false,
      problem: { code: "action_in_progress" },
    });
    expect(f.requests).toEqual([]);
    operation.resolve();
    await performing;
    expect(f.controller.snapshot.busy).toBeNull();
  });
  test("canceled native confirmation has no account side effect", async () => {
    const f = fixture();
    f.confirm(false);
    await f.controller.perform({ type: "logout" });
    await f.controller.perform({ type: "switchAccount" });
    expect(f.requests).toEqual([]);
  });
  test("BYOK credentials stay in the native host and never enter the renderer snapshot", async () => {
    const f = fixture();
    f.status.accountChanged({ status: "signedOut" });
    await f.controller.refresh();
    f.native.promptByok = async (submit) => {
      await submit({
        baseUrl: "https://api.example.com/v1",
        model: "gpt-5",
        label: "Example",
        apiKey: "as_live_private-fixture",
      });
    };
    expect((await f.controller.perform({ type: "configureByok" })).ok).toBe(
      true,
    );
    expect(f.requests).toContainEqual({
      version: MOCHI_CONTROL_PROTOCOL_VERSION,
      command: "configure_byok",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-5",
      label: "Example",
      apiKey: "as_live_private-fixture",
    });
    expect(JSON.stringify(f.controller.snapshot)).not.toContain(
      "as_live_private-fixture",
    );
  });

  test("adding BYOK while ChatGPT is connected keeps both connections", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.native.promptByok = async (submit) => {
      await submit({
        baseUrl: "https://api.example.com/v1",
        model: "gpt-5",
        label: "Example service",
        apiKey: "fixture-only-key",
      });
    };
    expect((await f.controller.perform({ type: "configureByok" })).ok).toBe(
      true,
    );
    expect(f.confirmations).toEqual([]);
    expect(f.requests.map((request) => request.command)).toEqual([
      "configure_byok",
    ]);
  });

  test("editing a model API pre-fills its saved declaration and leaves the key blank", async () => {
    const f = fixture();
    let initial: unknown;
    f.native.promptByok = async (submit, values) => {
      initial = values;
      await submit({
        baseUrl: values!.baseUrl,
        model: values!.model,
        label: values!.label,
        apiKey: "fixture-only-key",
      });
    };
    expect(
      (
        await f.controller.perform({
          type: "configureModelApi",
          connectionId: "mochi-byok-12345678",
        })
      ).ok,
    ).toBe(true);
    expect(initial).toEqual({
      baseUrl: "https://api.example.com/v1",
      model: "gpt-5",
      label: "Example service",
    });
    expect(f.requests).toContainEqual({
      version: MOCHI_CONTROL_PROTOCOL_VERSION,
      command: "configure_byok",
      connectionId: "mochi-byok-12345678",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-5",
      label: "Example service",
      apiKey: "fixture-only-key",
    });
  });
  test("native BYOK corrections validate fields before requests and keep secrets out of snapshots", async () => {
    const f = fixture();
    const draft = {
      baseUrl: "http://wrong.example",
      model: "gpt-5",
      label: "Example",
      apiKey: "fixture-only-key",
    };
    f.native.promptByok = async (submit) => {
      expect(await submit(draft)).toMatchObject({ field: "baseUrl" });
      expect(f.requests).toEqual([]);
      expect(
        await submit({
          ...draft,
          baseUrl: "https://example.com/v1",
          apiKey: "bad key",
        }),
      ).toMatchObject({ field: "apiKey" });
      expect(f.requests).toEqual([]);
      expect(JSON.stringify(f.controller.snapshot)).not.toContain(
        "fixture-only-key",
      );
      expect(
        await submit({
          ...draft,
          baseUrl: " https://example.com/v1/ ",
          apiKey: " fixture-only-key\n",
        }),
      ).toBeNull();
    };
    expect((await f.controller.perform({ type: "configureByok" })).ok).toBe(
      true,
    );
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({
      baseUrl: "https://example.com/v1",
      apiKey: "fixture-only-key",
    });
  });

  test("browser authorization is private to the host and can be reopened only while pending", async () => {
    const f = fixture();
    await f.controller.perform({ type: "login" });
    expect(f.controller.snapshot.canReopenLogin).toBe(true);
    expect(JSON.stringify(f.controller.snapshot)).not.toContain(
      "authorization",
    );
    await f.controller.perform({ type: "reopenLogin" });
    expect(f.urls).toHaveLength(2);
    f.status.accountChanged({ status: "signedOut" });
    await f.controller.refresh();
    expect((await f.controller.perform({ type: "reopenLogin" })).ok).toBe(
      false,
    );
    expect(f.urls).toHaveLength(2);
  });
  test("a failed browser open preserves the pending authorization for explicit reopening", async () => {
    const f = fixture();
    f.native.openExternal = () => false;
    const result = await f.controller.perform({ type: "login" });
    expect(result).toMatchObject({
      ok: false,
      problem: {
        code: "login_browser_unavailable",
        recoveryAction: "reopenBrowser",
      },
    });
    expect(f.controller.snapshot.canReopenLogin).toBe(true);
    f.native.openExternal = () => true;
    expect((await f.controller.perform({ type: "reopenLogin" })).ok).toBe(true);
    expect(f.requests.map((request) => request.command)).toEqual([
      "start_chatgpt_login",
    ]);
  });
  test("the shared login works before creating a Bot and never invents one", async () => {
    const f = fixture();
    f.fleet.roster([]);
    f.fleet.accountChanged({ status: "signedOut" });
    await f.controller.refresh();
    expect(f.controller.snapshot.selectedBotId).toBeNull();
    expect((await f.controller.perform({ type: "login" })).ok).toBe(true);
    expect(f.requests).toEqual([
      {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "start_chatgpt_login",
      },
    ]);
    expect(f.controller.snapshot.bots).toHaveLength(0);
    expect(f.controller.snapshot.canReopenLogin).toBe(true);
  });
  test("a pending ChatGPT authorization belongs to the app across Bot selection", async () => {
    const f = fixture();
    await f.controller.perform({ type: "login" });
    await f.controller.perform({ type: "selectBot", botId: OTHER_BOT_ID });
    expect(f.controller.snapshot.canReopenLogin).toBe(true);
    expect((await f.controller.perform({ type: "reopenLogin" })).ok).toBe(true);
    expect(f.urls).toHaveLength(2);
    expect(f.urls[0]).toBe(f.urls[1]);
    expect(f.requests).toEqual([
      {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "start_chatgpt_login",
      },
    ]);
  });
  test("account change readiness is the Bridge's answer, including a Bot outside the selected view", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(f.controller.snapshot.selectedBotId).toBe(BOT_ID);
    expect(f.controller.snapshot.accountChangeReady).toBe(true);
    // Displayed activity alone does not decide readiness; the Bridge does.
    f.otherBot.runtimeStateChanged({
      activeTurn: false,
      queueDepth: 1,
      organizingContext: false,
      contextOrganizationAvailable: false,
    });
    await f.controller.refresh();
    expect(f.controller.snapshot.accountChangeReady).toBe(true);
    f.otherBot.idleChanged(false);
    await f.controller.refresh();
    expect(f.controller.snapshot.accountChangeReady).toBe(false);
    f.otherBot.idleChanged(true);
    await f.controller.refresh();
    expect(f.controller.snapshot.accountChangeReady).toBe(true);
  });
  test("reconnecting a Bot addresses only the selected Bot, never the service", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect((await f.controller.perform({ type: "recoverBot" })).ok).toBe(true);
    expect(f.requests).toEqual([
      {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "recover_bot",
        botId: BOT_ID,
      },
    ]);
    expect(f.operations).toEqual([]);
  });
  test("a ChatGPT login beside a model API keeps its browser link until it settles", async () => {
    const f = fixture();
    const modelApi = {
      provider: "mochi-byok",
      authType: "api_key",
      subscription: false,
      label: "API",
      model: "mochi-byok/gpt-test",
    } as const;
    f.fleet.accountChanged({
      status: "signedIn",
      account: modelApi,
      connections: [modelApi],
    });
    f.onControl((request) => {
      if (request.command === "start_chatgpt_login")
        queueMicrotask(() =>
          f.fleet.accountChanged({
            status: "signedIn",
            account: modelApi,
            connections: [modelApi],
            pendingLogin: "openai-codex",
          }),
        );
    });
    await f.controller.refresh();
    await f.controller.perform({ type: "login" });
    await f.controller.refresh();
    expect(f.controller.snapshot.canReopenLogin).toBe(true);
    expect((await f.controller.perform({ type: "reopenLogin" })).ok).toBe(true);
  });
  test("wrong-location app refuses control before crossing the Bridge boundary", async () => {
    const f = fixture();
    f.env.manifest = mochiControlManifest("installed", "0.2.0");
    await f.controller.refresh();
    expect(f.controller.snapshot.setup).toBe("install");
    expect(f.controller.snapshot.problem).toBeNull();
    expect((await f.controller.perform({ type: "openApplications" })).ok).toBe(
      true,
    );
    expect(
      (
        await f.controller.perform({
          type: "setBotEnabled",
          botId: BOT_ID,
          enabled: true,
        })
      ).ok,
    ).toBe(false);
    expect(
      (await f.controller.perform({ type: "service", operation: "stop" })).ok,
    ).toBe(false);
    expect((await f.controller.shutdown()).ok).toBe(true);
    expect(f.operations).toEqual(["open-applications"]);
    expect(f.requests).toEqual([]);
  });
  test("model writes are not reported successful until the authoritative status agrees", async () => {
    const f = fixture();
    const result = await f.controller.perform({
      type: "updatePolicy",
      policy: { model: "changed", reasoningEffort: "high" },
    });
    expect(result).toMatchObject({
      ok: false,
      problem: { code: "model_policy_out_of_sync" },
    });
  });
  test("group writes require authoritative read-back; an acknowledged but unapplied switch fails", async () => {
    const f = fixture();
    const group = {
      id: "oc_test",
      name: "Test",
      avatarUrl: null,
      enabled: true,
    };
    f.status.groupsChanged([group]);
    const action = {
      type: "updateGroupParticipation" as const,
      chatId: group.id,
      enabled: false,
    };
    expect(await f.controller.perform(action)).toMatchObject({
      ok: false,
      problem: { code: "group_participation_update_failed" },
    });
    expect(f.controller.snapshot.feishuGroups?.[0]?.enabled).toBe(true);
    f.status.groupsChanged([{ ...group, enabled: false }]);
    expect(await f.controller.perform(action)).toMatchObject({ ok: true });
    expect(f.controller.snapshot.feishuGroups?.[0]?.enabled).toBe(false);
    expect(f.requests).toEqual(
      Array(2).fill({
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "update_group_participation",
        botId: BOT_ID,
        chatId: group.id,
        enabled: false,
      }),
    );
    f.status.stopping();
  });
  test("losing current status clears connectivity and account facts, not just the headline", async () => {
    const f = fixture();
    f.status.groupsChanged([
      {
        id: "oc_team",
        name: "Previous Process Group",
        avatarUrl: null,
        enabled: true,
      },
    ]);
    await f.controller.refresh();
    expect(f.controller.snapshot.eventStreamReady).toBe(true);
    expect(f.controller.snapshot.feishuGroups?.[0]?.name).toBe(
      "Previous Process Group",
    );
    f.service.inspect = async () => ({
      installed: true,
      launch: { state: "running", pid: process.pid + 1, identity: {} },
      status: null,
      problem: null,
    });
    await f.controller.refresh();
    expect(f.controller.snapshot.eventStreamReady).toBe(false);
    expect(f.controller.snapshot.controlReady).toBe(false);
    expect(f.controller.snapshot.account.status).toBe("unknown");
    expect(f.controller.snapshot.feishuGroups).toBeNull();
  });
  test("diagnostics retain the failure being exported and never lower-layer error text", async () => {
    const f = fixture();
    f.service.perform = async () => fail("service_identity_mismatch");
    await f.controller.perform({ type: "service", operation: "restart" });
    await f.controller.perform({ type: "exportDiagnostics" });
    expect(JSON.stringify(f.reports[0])).toContain("service_identity_mismatch");
    expect(JSON.stringify(f.reports[0])).not.toContain(f.env.home);
  });
  test("diagnostics summarize every Bot and the recent coded events, never names or message identities", async () => {
    const f = fixture();
    const write = (path: string, records: object[]) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(
        path,
        records.map((record) => JSON.stringify(record)).join("\n"),
        { mode: 0o600 },
      );
    };
    write(f.env.logPath, [
      {
        timestamp: "2026-10-15T10:00:00.000Z",
        level: "warn",
        event: "lark.event.connection_unavailable",
        botId: OTHER_BOT_ID,
        reason: "disconnected",
      },
      {
        timestamp: "2026-10-15T10:00:01.000Z",
        level: "info",
        event: "bot.event.rejected",
        botId: BOT_ID,
        chatId: "oc_private_chat",
      },
      {
        timestamp: "2026-10-15T10:00:03.000Z",
        level: "error",
        event: "bot.event.failed",
        botId: BOT_ID,
        messageId: "om_private_message",
        chatId: "oc_private_chat",
        errorName: "RuntimeRequestError",
        errorMessage: "the customer's question",
      },
    ]);
    write(f.env.companionLogPath, [
      {
        timestamp: "2026-10-15T10:00:02.000Z",
        level: "warn",
        event: "action.failed",
        action: "exportDiagnostics",
        problem: "diagnostics_export_failed",
        reason: "EACCES",
      },
    ]);
    await f.controller.refresh();
    await f.controller.perform({ type: "exportDiagnostics" });
    const report = f.reports[0] as {
      schemaVersion: number;
      bots: { botId: string; selected: boolean }[];
      recentEvents: Record<string, unknown>[];
    };
    expect(report.schemaVersion).toBe(4);
    expect(report.bots.map((bot) => [bot.botId, bot.selected])).toEqual([
      [BOT_ID, true],
      [OTHER_BOT_ID, false],
    ]);
    expect(report.recentEvents).toEqual([
      {
        timestamp: "2026-10-15T10:00:00.000Z",
        level: "warn",
        event: "lark.event.connection_unavailable",
        botId: OTHER_BOT_ID,
        reason: "disconnected",
      },
      {
        timestamp: "2026-10-15T10:00:02.000Z",
        level: "warn",
        event: "action.failed",
        action: "exportDiagnostics",
        problem: "diagnostics_export_failed",
        reason: "EACCES",
      },
      {
        timestamp: "2026-10-15T10:00:03.000Z",
        level: "error",
        event: "bot.event.failed",
        botId: BOT_ID,
        errorName: "RuntimeRequestError",
      },
    ]);
    const text = JSON.stringify(report);
    for (const forbidden of [
      "麻薯",
      "oc_private_chat",
      "om_private_message",
      "customer",
      "gpt-other",
    ])
      expect(text).not.toContain(forbidden);
    f.status.stopping();
  });
  test("a failed native export keeps its underlying reason code in the private log", async () => {
    const f = fixture();
    f.native.exportDiagnostics = async () =>
      fail("diagnostics_export_failed", "ENOSPC");
    const sink = memoryLogSink();
    const previous = setLogSink(sink);
    try {
      expect(
        await f.controller.perform({ type: "exportDiagnostics" }),
      ).toMatchObject({
        ok: false,
        problem: { code: "diagnostics_export_failed" },
      });
    } finally {
      setLogSink(previous);
    }
    expect(
      sink.records.find((record) => record.event === "action.failed"),
    ).toMatchObject({
      level: "warn",
      action: "exportDiagnostics",
      problem: "diagnostics_export_failed",
      reason: "ENOSPC",
    });
    f.status.stopping();
  });
});

test.each(["feishu", "lark"] as const)(
  "open %s group rechecks membership and uses its verified platform",
  async (brand) => {
    const f = fixture();
    f.status.feishuChanged({
      active: {
        brand,
        state: "ready",
        bot: { name: "Customer Bot", avatarUrl: null },
      },
      candidate: null,
    });
    f.status.groupsChanged([
      {
        id: "oc_customer",
        name: "Customer group",
        enabled: true,
        avatarUrl: null,
      },
    ]);
    await f.controller.refresh();
    await f.controller.perform({
      type: "openFeishuGroup",
      chatId: "oc_customer",
    });
    expect(f.urls).toEqual([
      `https://applink.${brand === "lark" ? "larksuite.com" : "feishu.cn"}/client/chat/open?openChatId=oc_customer`,
    ]);
    expect(f.requests).toEqual([]);
    f.status.groupsChanged(null);
    await f.controller.perform({
      type: "openFeishuGroup",
      chatId: "oc_customer",
    });
    expect(f.urls).toHaveLength(1);
  },
);

describe("one Bot's settings, never another's", () => {
  test("selecting a Bot re-scopes every Bot-owned fact and refuses an unknown identity", async () => {
    const f = fixture();
    f.status.groupsChanged([
      { id: "oc_first", name: "First Group", avatarUrl: null, enabled: true },
    ]);
    f.otherBot.groupsChanged([
      { id: "oc_second", name: "Second Group", avatarUrl: null, enabled: true },
    ]);
    await f.controller.refresh();
    expect(f.controller.snapshot.selectedBotId).toBe(BOT_ID);
    expect(f.controller.snapshot.feishuGroups?.[0]?.id).toBe("oc_first");
    expect(f.controller.snapshot.bots.map((bot) => bot.label)).toEqual([
      "麻薯",
      "小麻薯",
    ]);
    // The second Bot is still starting, so the headline follows it rather than
    // reporting the first Bot's connection as if it described both.
    expect(
      await f.controller.perform({ type: "selectBot", botId: OTHER_BOT_ID }),
    ).toMatchObject({ ok: true });
    expect(f.controller.snapshot.selectedBotId).toBe(OTHER_BOT_ID);
    expect(f.controller.snapshot.feishuGroups?.[0]?.id).toBe("oc_second");
    expect(f.controller.snapshot.policy).toEqual({
      model: "gpt-other",
      reasoningEffort: "low",
    });
    expect(f.controller.snapshot.phase).toBe("starting");
    // Selection is a view decision: it reaches the Bridge for nothing.
    expect(f.requests).toEqual([]);
    expect(f.operations).toEqual([]);
    expect(
      await f.controller.perform({
        type: "selectBot",
        botId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toMatchObject({ ok: false, problem: { code: "bot_unknown" } });
    expect(f.controller.snapshot.selectedBotId).toBe(OTHER_BOT_ID);
    f.status.stopping();
  });

  test("creating a Bot adopts the identity the Bridge assigns and shows it", async () => {
    const f = fixture();
    await f.controller.refresh();
    const before = f.controller.snapshot.selectedBotId;
    expect(await f.controller.perform({ type: "createBot" })).toMatchObject({
      ok: true,
    });
    expect(f.requests).toEqual([
      { version: MOCHI_CONTROL_PROTOCOL_VERSION, command: "create_bot" },
    ]);
    // The window never invents an identity: it adopts the one it was answered with
    // and immediately describes that Bot, because it is what was just created.
    expect(f.controller.snapshot.selectedBotId).toBe(CREATED_BOT_ID);
    expect(f.controller.snapshot.selectedBotId).not.toBe(before);
    expect(f.controller.snapshot.bots.map((bot) => bot.botId)).toContain(
      CREATED_BOT_ID,
    );
    f.status.stopping();
  });

  test("first Feishu connection creates a paused Bot without starting duty or creating a Session", async () => {
    const f = fixture();
    f.fleet.roster([]);
    await f.controller.refresh();
    expect(f.requests).toEqual([]);
    expect((await f.controller.perform({ type: "connectFeishu" })).ok).toBe(
      true,
    );
    expect(f.requests).toEqual([
      { version: MOCHI_CONTROL_PROTOCOL_VERSION, command: "create_bot" },
      {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "start_feishu_connection",
        botId: CREATED_BOT_ID,
      },
    ]);
    expect(f.controller.snapshot.bots).toHaveLength(1);
    expect(f.controller.snapshot.bots[0]!.enabled).toBe(false);
    f.status.stopping();
  });

  test("the Feishu approval link goes to the pasteboard, never to a renderer frame", async () => {
    const f = fixture();
    await f.controller.refresh();
    const frames: string[] = [];
    const unsubscribe = f.controller.subscribe((snapshot) =>
      frames.push(JSON.stringify(snapshot)),
    );
    expect(
      (await f.controller.perform({ type: "copyFeishuApprovalLink" })).ok,
    ).toBe(true);
    unsubscribe();
    expect(f.copied).toEqual([FEISHU_APPROVAL_URL]);
    expect(f.urls).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).not.toContain("scope-apply");
    f.status.stopping();
  });

  test("renaming a Bot reads the name back from the roster instead of trusting the field", async () => {
    const f = fixture();
    await f.controller.refresh();
    // The Bridge is the only authority for a Bot's name, so the fixture renames
    // it inside the control double exactly as production does.
    expect(
      await f.controller.perform({
        type: "renameBot",
        botId: BOT_ID,
        label: "新名字",
      }),
    ).toMatchObject({ ok: true });
    expect(f.requests).toEqual([
      {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "rename_bot",
        botId: BOT_ID,
        label: "新名字",
      },
    ]);
    expect(
      f.controller.snapshot.bots.find((bot) => bot.botId === BOT_ID)?.label,
    ).toBe("新名字");
    f.status.stopping();
  });

  test("a Bot-scoped write after a switch is sent to, and read back from, the newly selected Bot", async () => {
    const f = fixture();
    const group = {
      id: "oc_second",
      name: "Second Group",
      avatarUrl: null,
      enabled: false,
    };
    f.status.groupsChanged([
      { id: "oc_first", name: "First Group", avatarUrl: null, enabled: true },
    ]);
    f.otherBot.groupsChanged([group]);
    await f.controller.refresh();
    await f.controller.perform({ type: "selectBot", botId: OTHER_BOT_ID });
    expect(
      await f.controller.perform({
        type: "updateGroupParticipation",
        chatId: group.id,
        enabled: false,
      }),
    ).toMatchObject({ ok: true });
    expect(f.requests).toEqual([
      {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "update_group_participation",
        botId: OTHER_BOT_ID,
        chatId: group.id,
        enabled: false,
      },
    ]);
    // The read-back followed the switch: the group named above exists only on the
    // second Bot, and the first Bot's roster is still described as it was.
    expect(f.controller.snapshot.feishuGroups).toEqual([group]);
    await f.controller.perform({ type: "selectBot", botId: BOT_ID });
    expect(f.controller.snapshot.feishuGroups?.[0]?.id).toBe("oc_first");
    f.status.stopping();
  });
});

test("background permission recovery only opens the native Login Items pane", async () => {
  const f = fixture();
  await f.controller.refresh();
  const result = await f.controller.perform({ type: "openLoginItems" });
  expect(result.ok).toBe(true);
  expect(f.operations).toEqual(["open-login-items"]);
  expect(f.requests).toEqual([]);
});
