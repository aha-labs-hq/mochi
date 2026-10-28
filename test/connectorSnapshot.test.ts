import { describe, expect, test } from "bun:test";
import { projectConnectorCatalog } from "../src/control/connectorSnapshot.ts";
import type { ConnectorCatalog } from "../src/connectors/protocol.ts";

const CATALOG: ConnectorCatalog = {
  botId: "bot-1",
  revision: `sha256:${"a".repeat(64)}`,
  connections: [
    {
      connectionId: "feishu:app_fixture",
      providerId: "feishu-service",
      providerVersion: "1.0.0",
      providerDisplayName: "飞书服务",
      status: "ready",
      account: { displayName: "飞书服务" },
      problem: null,
      grantedScopes: ["docx:document:readonly"],
      resourceScope: { status: "ready", selectedCount: 1 },
      resources: [
        { id: "document:AAA111", type: "document", displayName: "产品说明", selected: true },
      ],
      capabilities: [
        {
          id: "document.read",
          displayName: "读取云文档",
          description: "读取正文。",
          operation: "read",
          resourceTypes: ["document"],
          resourceSelection: "optional",
          requestAuthorization: "none",
          requiredScopes: ["docx:document:readonly"],
          idempotency: "none",
          readback: "none",
          manifestRevision: `sha256:${"b".repeat(64)}`,
        },
      ],
    },
  ],
};

describe("connector catalog projection", () => {
  test("carries the stored selection identity through to the renderer", () => {
    const projected = projectConnectorCatalog(CATALOG, () => "c".repeat(32));
    expect(projected).toEqual({
      revision: CATALOG.revision,
      connections: [
        {
          connectionId: "feishu:app_fixture",
          providerId: "feishu-service",
          providerDisplayName: "飞书服务",
          status: "ready",
          accountDisplayName: "飞书服务",
          problem: null,
          resourceScope: { status: "ready", selectedCount: 1 },
          grantedScopes: ["docx:document:readonly"],
          resources: [
            {
              resourceId: "document:AAA111",
              resourceType: "document",
              displayName: "产品说明",
              selectionId: "c".repeat(32),
              selected: true,
              // A provider that reports no owner, visibility or write ability
              // says so rather than defaulting to an answer it did not give.
              ownerId: null,
              visibility: null,
              writable: null,
            },
          ],
          capabilities: [
            {
              id: "document.read",
              displayName: "读取云文档",
              description: "读取正文。",
              operation: "read",
              resourceSelection: "optional",
              availability: "ready",
            },
          ],
        },
      ],
    });
  });

  test("never emits a provider address", () => {
    const projected = projectConnectorCatalog(CATALOG, () => "c".repeat(32));
    // A document URL embeds a provider token, so it must not leave the Bot.
    expect(JSON.stringify(projected)).not.toContain("feishu.cn");
    expect(JSON.stringify(projected)).not.toContain("http");
  });

  test("refuses to publish a resource whose selection identity is missing", () => {
    // An empty identity would be sent back as a valid selection and match
    // nothing, so the projection fails rather than fabricating one.
    expect(() => projectConnectorCatalog(CATALOG, () => undefined)).toThrow(
      "missing its selection identity",
    );
    expect(() => projectConnectorCatalog(CATALOG, () => "")).toThrow(
      "missing its selection identity",
    );
  });

  test("reports a capability as not ready when its resource type is unselected", () => {
    const withoutResources: ConnectorCatalog = {
      ...CATALOG,
      connections: [{ ...CATALOG.connections[0]!, resources: [] }],
    };
    const projected = projectConnectorCatalog(withoutResources, () => "c".repeat(32));
    expect(projected.connections[0]!.capabilities[0]!.availability).toBe("selection_required");
  });

  test("keeps a connected provider distinct from an unavailable fixed scope", () => {
    const catalog: ConnectorCatalog = {
      ...CATALOG,
      connections: [
        {
          ...CATALOG.connections[0]!,
          resources: [
            {
              ...CATALOG.connections[0]!.resources[0]!,
              selected: true,
            },
          ],
          resourceScope: {
            status: "unavailable",
            selectedCount: 1,
            problem: "provider_unavailable",
          },
        },
      ],
    };
    const projected = projectConnectorCatalog(catalog, () => "c".repeat(32));
    expect(projected.connections[0]!.status).toBe("ready");
    expect(projected.connections[0]!.resourceScope).toEqual({
      status: "unavailable",
      selectedCount: 1,
      problem: "provider_unavailable",
    });
    expect(projected.connections[0]!.capabilities[0]!.availability).toBe(
      "resource_unavailable",
    );
  });
  test("treats the durable resource proof as one atomic connection scope", () => {
    const catalog: ConnectorCatalog = {
      ...CATALOG,
      connections: [{
        ...CATALOG.connections[0]!,
        resources: [{
          id: "folder:AAA111",
          type: "folder",
          displayName: "共享文件夹",
          selected: true,
        }, {
          ...CATALOG.connections[0]!.resources[0]!,
          selected: true,
        }],
        resourceScope: {
          status: "unavailable",
          selectedCount: 2,
          problem: "provider_unavailable",
        },
      }],
    };
    expect(projectConnectorCatalog(catalog, () => "c".repeat(32)).connections[0]!.capabilities[0]!.availability)
      .toBe("resource_unavailable");
  });
  test("an authorized but unselected resource does not make its capability ready", () => {
    const catalog: ConnectorCatalog = { ...CATALOG, connections: [{ ...CATALOG.connections[0]!, resources: [{ ...CATALOG.connections[0]!.resources[0]!, selected: false }] }] };
    expect(projectConnectorCatalog(catalog, () => "c".repeat(32)).connections[0]!.capabilities[0]!.availability).toBe("selection_required");
  });

  test("unselected choices never receive a fabricated selection identity", () => {
    const catalog: ConnectorCatalog = { ...CATALOG, connections: [{ ...CATALOG.connections[0]!, resources: [{ ...CATALOG.connections[0]!.resources[0]!, selected: false }] }] };
    const projected = projectConnectorCatalog(catalog, () => { throw new Error("must not look up unselected authority"); });
    expect(projected.connections[0]!.resources[0]!.selectionId).toBeNull();
  });

  test("a known read-only resource cannot advertise a ready write", () => {
    const catalog: ConnectorCatalog = { ...CATALOG, connections: [{ ...CATALOG.connections[0]!, resources: [{ ...CATALOG.connections[0]!.resources[0]!, writable: false }], capabilities: [{ ...CATALOG.connections[0]!.capabilities[0]!, operation: "write" }] }] };
    expect(projectConnectorCatalog(catalog, () => "c".repeat(32)).connections[0]!.capabilities[0]!.availability).toBe("read_only");
  });

  test("unknown write authority cannot advertise readiness", () => {
    const catalog: ConnectorCatalog = { ...CATALOG, connections: [{ ...CATALOG.connections[0]!, capabilities: [{ ...CATALOG.connections[0]!.capabilities[0]!, operation: "write" }] }] };
    expect(projectConnectorCatalog(catalog, () => "c".repeat(32)).connections[0]!.capabilities[0]!.availability).toBe("access_unconfirmed");
  });
  test("a write operation is available only when some selected matching resource is proven writable", () => {
    const catalog: ConnectorCatalog = { ...CATALOG, connections: [{ ...CATALOG.connections[0]!, resources: [{ ...CATALOG.connections[0]!.resources[0]!, writable: true }], capabilities: [{ ...CATALOG.connections[0]!.capabilities[0]!, operation: "write" }] }] };
    expect(projectConnectorCatalog(catalog, () => "c".repeat(32)).connections[0]!.capabilities[0]!.availability).toBe("ready");
  });
  test("an unavailable connection never claims a selected resource is usable", () => {
    const catalog: ConnectorCatalog = { ...CATALOG, connections: [{ ...CATALOG.connections[0]!, status: "unavailable" }] };
    expect(projectConnectorCatalog(catalog, () => "c".repeat(32)).connections[0]!.capabilities[0]!.availability).toBe("connection_unavailable");
  });

  test("missing provider grants are not misreported as optional resource selection", () => {
    const catalog: ConnectorCatalog = {
      ...CATALOG,
      connections: [{ ...CATALOG.connections[0]!, grantedScopes: [], resources: [] }],
    };
    const capability = projectConnectorCatalog(catalog, () => undefined).connections[0]!.capabilities[0]!;
    expect(capability.resourceSelection).toBe("optional");
    expect(capability.availability).toBe("authorization_required");
  });
});
