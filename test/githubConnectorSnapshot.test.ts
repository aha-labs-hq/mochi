import { expect, test } from "bun:test";
import { ConnectorBroker } from "../src/connectors/broker.ts";
import { GitHubConnector } from "../src/connectors/github/adapter.ts";
import { ConnectorRegistry } from "../src/connectors/registry.ts";
import { projectConnectorCatalog } from "../src/control/connectorSnapshot.ts";
import type { GitHubConnectionSnapshot } from "../src/github/repository.ts";
import { GitHubConnectionError } from "../src/github/integration.ts";
import type { IssueWorkflow } from "../src/issueWorkflow.ts";
import { fixedSelection } from "./connectorFixture.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";
function build(snapshot: GitHubConnectionSnapshot, selected: boolean, proved = true, saved = false) {
  const adapter = new GitHubConnector({
    snapshot: () => snapshot,
    selection: {
      ...fixedSelection(async () => { throw new Error("must not reach provider access"); }),
      savedProjectsSnapshot: () => saved ? [{ id: 20, ownerId: 1, fullName: "customer/alpha", installationId: 30, private: true, canWriteIssues: true, selected: true }] : [],
    },
    catalogSnapshot: () => proved ? [{ id: 20, ownerId: 1, fullName: "customer/alpha", installationId: 30, private: true, canWriteIssues: true, selected }] : null,
  }, {} as IssueWorkflow);
  const registry = new ConnectorRegistry();
  registry.register(adapter);
  return { adapter, broker: new ConnectorBroker(registry) };
}

test("GitHub publishes a proven unselected option without granting calls", async () => {
  const { broker } = build({ status: "connected", account: { id: 1, login: "customer" }, problem: null }, false);
  const catalog = await broker.catalog(BOT_ID);
  expect(catalog.connections[0]!.resources).toMatchObject([{ id: "repository:20", selected: false }]);
  expect(catalog.connections[0]!.capabilities.length).toBeGreaterThan(0);
  const projected = projectConnectorCatalog(catalog, () => undefined);
  expect(projected.connections[0]!.resources[0]!.selectionId).toBeNull();
  expect(projected.connections[0]!.capabilities.every((capability) => capability.availability !== "ready")).toBe(true);
  await expect(broker.read({ botId: BOT_ID, sourceMessageId: "msg-1", sourceText: "读取项目", topicKey: "topic-1", requesterId: "user-1" }, { connectionId: "github:1", resourceId: "repository:20", capabilityId: catalog.connections[0]!.capabilities.find((capability) => capability.operation === "read")!.id, catalogRevision: catalog.revision, input: {} })).rejects.toMatchObject({ code: "resource_not_selected" });
});

test("GitHub pending authorization and issuer failures survive without an account", async () => {
  const pending = build({ status: "authorizing", account: null, problem: null }, false);
  expect((await pending.adapter.snapshot(BOT_ID))[0]).toMatchObject({ status: "authorizing", account: null, resources: [] });
  const pendingCatalog = await pending.broker.catalog(BOT_ID);
  expect(pendingCatalog.connections[0]).toMatchObject({ status: "authorizing", account: null, resources: [] });
  expect(pendingCatalog.connections[0]!.capabilities.length).toBeGreaterThan(0);
  expect(projectConnectorCatalog(pendingCatalog, () => undefined).connections[0]!.capabilities.every(
    (capability) => capability.availability === "connection_unavailable",
  )).toBe(true);
  const unavailable = build({ status: "unavailable", account: null, problem: "issuer_not_configured" }, false);
  expect((await unavailable.adapter.snapshot(BOT_ID))[0]).toMatchObject({ status: "unavailable", problem: "issuer_not_configured" });
  expect((await unavailable.broker.catalog(BOT_ID)).connections[0]).toMatchObject({ status: "unavailable", problem: "issuer_not_configured" });
});

test("GitHub distinguishes a grant that needs user action from a provider outage", async () => {
  const reauthorize = build({
    status: "unavailable",
    account: { id: 1, login: "customer" },
    problem: "sign_in_required",
  }, false);
  expect((await reauthorize.adapter.snapshot(BOT_ID))[0]).toMatchObject({
    status: "reauthorization_required",
    problem: "sign_in_required",
  });
  const outage = build({
    status: "unavailable",
    account: { id: 1, login: "customer" },
    problem: "provider_unavailable",
  }, false);
  expect((await outage.adapter.snapshot(BOT_ID))[0]).toMatchObject({
    status: "unavailable",
    problem: "provider_unavailable",
  });
});

test("GitHub has no usable project list before a complete directory proof", async () => {
  const { adapter } = build({ status: "connected", account: { id: 1, login: "customer" }, problem: null }, true, false);
  expect((await adapter.snapshot(BOT_ID))[0]).toMatchObject({ status: "unavailable", problem: "provider_unavailable", resources: [] });
});

test("GitHub keeps a saved project visible while its live directory is unavailable", async () => {
  const { adapter, broker } = build(
    { status: "unavailable", account: { id: 1, login: "customer" }, problem: "provider_unavailable" },
    true,
    false,
    true,
  );
  const snapshot = (await adapter.snapshot(BOT_ID))[0]!;
  expect(snapshot).toMatchObject({
    status: "unavailable",
    resourceScope: { status: "unavailable", selectedCount: 1 },
    resources: [{ id: "repository:20", selected: true }],
  });
  const catalog = await broker.catalog(BOT_ID);
  expect(catalog.connections[0]!.resources).toHaveLength(1);
  expect(catalog.connections[0]!.resourceScope.selectedCount).toBe(1);
});

test("GitHub treats a changed repository proof as a resource failure", async () => {
  const adapter = new GitHubConnector({
    snapshot: () => ({
      status: "connected",
      account: { id: 1, login: "customer" },
      problem: null,
    }),
    selection: {
      ...fixedSelection(async () => {
        throw new GitHubConnectionError("repository_changed");
      }),
    },
    catalogSnapshot: () => [{
      id: 20,
      ownerId: 1,
      fullName: "customer/alpha",
      installationId: 30,
      private: true,
      canWriteIssues: true,
      selected: true,
    }],
  }, {} as IssueWorkflow);
  const [connection] = await adapter.snapshot(BOT_ID);
  const capability = adapter.manifest.capabilities.find(
    (candidate) => candidate.operation === "read",
  )!;

  await expect(adapter.read({
    context: {
      botId: BOT_ID,
      sourceMessageId: "message-1",
      sourceText: "读取项目",
      topicKey: "topic-1",
      requesterId: "user-1",
    },
    grant: {
      botId: BOT_ID,
      connectionId: connection!.connectionId,
      resourceId: "repository:20",
      capabilityId: capability.id,
      sourceMessageId: "message-1",
      topicKey: "topic-1",
      requesterId: "user-1",
      authorizationQuote: null,
      catalogRevision: `sha256:${"0".repeat(64)}`,
    },
    connection: connection!,
    resource: connection!.resources[0]!,
    capability,
    input: {},
  })).rejects.toMatchObject({ code: "resource_unavailable" });
});
