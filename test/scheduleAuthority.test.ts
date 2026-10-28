import { expect, test } from "bun:test";
import type { ConnectorCatalog } from "../src/connectors/protocol.ts";
import {
  bindScheduleResources,
  scheduleResourcesStillSelected,
} from "../src/schedules/authority.ts";
import { MemoryConnectorSelections } from "./connectorFixture.ts";

function fixture() {
  const selections = new MemoryConnectorSelections();
  selections.replaceConnectorSelections("github:1", [
    {
      connectionId: "github:1",
      resourceId: "repository:2",
      resourceType: "repository",
      displayName: "team/project",
      address: "provider-bound-proof",
      selectionId: "a".repeat(32),
    },
  ]);
  const catalog: ConnectorCatalog = {
    botId: "bot-a",
    revision: "revision",
    connections: [
      {
        connectionId: "github:1",
        providerId: "github",
        providerVersion: "1.0.0",
        providerDisplayName: "GitHub",
        account: null,
        status: "ready",
        problem: null,
        grantedScopes: ["read"],
        resourceScope: { status: "ready", selectedCount: 1 },
        capabilities: [],
        resources: [
          {
            id: "repository:2",
            type: "repository",
            displayName: "team/project",
            selected: true,
          },
          {
            id: "repository:3",
            type: "repository",
            displayName: "team/another",
            selected: false,
          },
        ],
      },
    ],
  };
  return { selections, catalog };
}

test("scheduled work pins explicit resource selections, never new project choices", () => {
  const { catalog, selections } = fixture();
  const bindings = bindScheduleResources(
    "bot-a",
    [{ connectionId: "github:1", resourceId: "repository:2" }],
    catalog,
    selections,
  );
  expect(bindings).toEqual([
    {
      connectionId: "github:1",
      resourceId: "repository:2",
      selectionId: "a".repeat(32),
    },
  ]);
  expect(
    scheduleResourcesStillSelected("bot-a", bindings, catalog, selections),
  ).toBe(true);
  expect(() =>
    bindScheduleResources(
      "bot-a",
      [{ connectionId: "github:1", resourceId: "repository:3" }],
      catalog,
      selections,
    ),
  ).toThrow("选择");
  expect(() => bindScheduleResources("bot-b", [], catalog, selections)).toThrow(
    "范围",
  );
  expect(
    scheduleResourcesStillSelected("bot-b", bindings, catalog, selections),
  ).toBe(false);
});
test("disconnect, deselection, re-selection and account change revoke old schedule authority", () => {
  const { catalog, selections } = fixture();
  const bindings = bindScheduleResources(
    "bot-a",
    [{ connectionId: "github:1", resourceId: "repository:2" }],
    catalog,
    selections,
  );
  const unavailable = {
    ...catalog,
    connections: catalog.connections.map((connection) => ({
      ...connection,
      status: "unavailable" as const,
    })),
  };
  expect(
    scheduleResourcesStillSelected("bot-a", bindings, unavailable, selections),
  ).toBe(false);
  const deselected = {
    ...catalog,
    connections: catalog.connections.map((connection) => ({
      ...connection,
      resources: connection.resources.map((resource) => ({
        ...resource,
        selected: false,
      })),
    })),
  };
  expect(
    scheduleResourcesStillSelected("bot-a", bindings, deselected, selections),
  ).toBe(false);
  const original = selections.connectorSelections("github:1")[0]!;
  selections.replaceConnectorSelections("github:1", []);
  expect(
    scheduleResourcesStillSelected("bot-a", bindings, catalog, selections),
  ).toBe(false);
  selections.replaceConnectorSelections("github:1", [
    { ...original, selectionId: "b".repeat(32) },
  ]);
  expect(
    scheduleResourcesStillSelected("bot-a", bindings, catalog, selections),
  ).toBe(false);
  expect(
    scheduleResourcesStillSelected(
      "bot-a",
      bindings,
      { ...catalog, connections: [] },
      selections,
    ),
  ).toBe(false);
});
test("empty scopes support public research while malformed and duplicate refs fail", () => {
  const { catalog, selections } = fixture();
  expect(bindScheduleResources("bot-a", [], catalog, selections)).toEqual([]);
  const reference = { connectionId: "github:1", resourceId: "repository:2" };
  expect(() =>
    bindScheduleResources("bot-a", [reference, reference], catalog, selections),
  ).toThrow("引用");
  expect(() =>
    bindScheduleResources(
      "bot-a",
      [{ connectionId: "https://github.com", resourceId: "../another-bot" }],
      catalog,
      selections,
    ),
  ).toThrow("引用");
});
