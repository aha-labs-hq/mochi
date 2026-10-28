import { describe, expect, test } from "bun:test";
import { FeishuServiceConnector } from "../src/connectors/feishu-service/adapter.ts";
import type { FeishuServiceResourceReader } from "../src/connectors/feishu-service/adapter.ts";
import type {
  ConnectorResourceSelection,
  ConnectorSelectionStore,
} from "../src/connectors/selectionStore.ts";
import { FeishuServiceResourceError } from "../src/lark/serviceResourceResolver.ts";
import { parseFeishuResourceId } from "../src/lark/serviceResourceResolver.ts";

const BINDING = {
  cliPath: "/usr/local/bin/lark-cli",
  configDirectory: "/private/tmp/feishu-connection",
  targetAppId: "app_fixture",
  displayName: "客户机器人",
  grantedScopes: ["docx:document:readonly", "drive:drive.metadata:readonly", "wiki:node:read"],
  status: "ready" as const,
  problem: null,
};
const CONNECTION_ID = `feishu:${BINDING.targetAppId}`;

/** A store that behaves like the Bot database without a SQLite file. */
class MemorySelections implements ConnectorSelectionStore {
  readonly rows = new Map<string, ConnectorResourceSelection[]>();
  connectorSelections(connectionId: string) {
    return this.rows.get(connectionId) ?? [];
  }
  connectorSelectionConnectionIds() {
    return [...this.rows.keys()];
  }
  replaceConnectorSelections(connectionId: string, selections: readonly ConnectorResourceSelection[]) {
    this.rows.set(connectionId, [...selections]);
  }
}

/**
 * Records what the provider was asked, so the tests can assert that the catalog
 * never calls it and that a read addresses the stored token.
 */
class FakeReader implements FeishuServiceResourceReader {
  resolveCalls: string[] = [];
  readCalls: { resourceType: string; token: string; scope: string }[] = [];
  unresolvable = new Set<string>();
  unreadable = new Set<string>();
  providerUnavailable = new Set<string>();
  metadataIncomplete = new Set<string>();
  providerResponseInvalid = new Set<string>();
  partial = new Set<string>();
  /** Titles the provider reports for a resolvable URL. */
  titles = new Map<string, string>();
  /** Optional identity returned during reconciliation, used to test retargeting. */
  resolvedResources = new Map<string, {
    resourceId: string;
    resourceType: string;
    displayName: string;
    address: string;
  }>();

  async resolve(url: string) {
    this.resolveCalls.push(url);
    const replacement = this.resolvedResources.get(url);
    if (replacement) return replacement;
    if (this.unresolvable.has(url)) throw new Error("url_not_feishu");
    if (this.providerUnavailable.has(url)) {
      throw new FeishuServiceResourceError("provider_unavailable");
    }
    if (this.metadataIncomplete.has(url)) {
      throw new FeishuServiceResourceError("metadata_incomplete");
    }
    if (this.providerResponseInvalid.has(url)) {
      throw new FeishuServiceResourceError("provider_response_invalid");
    }
    const token = url.slice(url.lastIndexOf("/") + 1);
    const resourceType = url.includes("/wiki/") ? "wiki" : "document";
    if (this.unreadable.has(url)) throw new FeishuServiceResourceError("not_readable");
    return {
      resourceId: `${resourceType}:${token}`,
      resourceType,
      displayName: this.titles.get(url) ?? `文档 ${token}`,
      address: url,
    };
  }

  async read(resourceType: string, token: string, scope: "full" | "outline") {
    this.readCalls.push({ resourceType, token, scope });
    if (this.unreadable.has(`read:${token}`)) {
      return { content: null, limitation: "document_content_partial" };
    }
    return {
      content: { title: `正文 ${token}`, body: "hello" },
      ...(this.partial.has(`read:${token}`)
        ? { limitation: "document_content_partial" }
        : {}),
    };
  }
}

function build() {
  const selections = new MemorySelections();
  const reader = new FakeReader();
  const connector = new FeishuServiceConnector(() => BINDING, selections, () => reader);
  return { selections, reader, connector };
}

describe("Feishu service connector", () => {
  test("stores a resource only after the provider proves it readable", async () => {
    const { selections, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    expect(selections.connectorSelections(CONNECTION_ID)).toEqual([
      {
        connectionId: CONNECTION_ID,
        resourceId: "document:AAA111",
        resourceType: "document",
        displayName: "文档 AAA111",
        address: "https://acme.feishu.cn/docx/AAA111",
        selectionId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
      },
    ]);
  });

  test("forgetting a replaced App clears only that App's fixed scope", async () => {
    const { selections, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    const kept = { ...selections.connectorSelections(CONNECTION_ID)[0]!, connectionId: "feishu:cli_other" };
    selections.replaceConnectorSelections("feishu:cli_other", [kept]);
    connector.forget(CONNECTION_ID);
    expect(selections.connectorSelections(CONNECTION_ID)).toEqual([]);
    expect(selections.connectorSelections("feishu:cli_other")).toEqual([kept]);
    expect(() => connector.forget("github:1")).toThrow("Not a Feishu");
  });

  test("refuses a resource the Bot cannot read instead of storing it", async () => {
    const { selections, reader, connector } = build();
    reader.unreadable.add("https://acme.feishu.cn/docx/LOCKED");
    await expect(connector.add(["https://acme.feishu.cn/docx/LOCKED"])).rejects.toThrow();
    expect(selections.connectorSelections(CONNECTION_ID)).toEqual([]);
  });

  test("refuses a URL that does not resolve at all", async () => {
    const { selections, reader, connector } = build();
    reader.unresolvable.add("https://example.com/docx/NOPE");
    await expect(connector.add(["https://example.com/docx/NOPE"])).rejects.toThrow();
    expect(selections.connectorSelections(CONNECTION_ID)).toEqual([]);
  });

  test("keeps selection identity when the same resource is added again", async () => {
    const { selections, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    const first = selections.connectorSelections(CONNECTION_ID)[0]!.selectionId;
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    expect(selections.connectorSelections(CONNECTION_ID)[0]!.selectionId).toBe(first);
  });

  test("deduplicates repeated new references within one add request", async () => {
    const { selections, connector } = build();
    await connector.add([
      "https://acme.feishu.cn/docx/AAA111",
      "https://acme.feishu.cn/docx/AAA111",
    ]);
    expect(selections.connectorSelections(CONNECTION_ID)).toHaveLength(1);
  });

  test("does not accept provider URL types as stored resource types", () => {
    expect(parseFeishuResourceId("docx:AAA111")).toBeNull();
    expect(parseFeishuResourceId("document:AAA111")).toEqual({
      resourceType: "document",
      token: "AAA111",
    });
  });

  test("adds to the selection without dropping or restating what is already there", async () => {
    const { selections, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    const firstId = selections.connectorSelections(CONNECTION_ID)[0]!.selectionId;
    await connector.add(["https://acme.feishu.cn/wiki/BBB222"]);
    expect(selections.connectorSelections(CONNECTION_ID).map((row) => row.resourceId))
      .toEqual(["document:AAA111", "wiki:BBB222"]);
    // The earlier resource keeps its identity across an unrelated addition.
    expect(selections.connectorSelections(CONNECTION_ID)[0]!.selectionId).toBe(firstId);
  });

  test("leaves the selection untouched when an addition is refused", async () => {
    const { selections, reader, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    reader.unreadable.add("https://acme.feishu.cn/docx/LOCKED");
    await expect(
      connector.add(["https://acme.feishu.cn/docx/BBB222", "https://acme.feishu.cn/docx/LOCKED"]),
    ).rejects.toThrow();
    // Nothing was written: a partially applied addition would be worse than a
    // refused one, because the user would not know which half landed.
    expect(selections.connectorSelections(CONNECTION_ID).map((row) => row.resourceId))
      .toEqual(["document:AAA111"]);
  });

  test("reports the connection from stored facts without calling the provider", async () => {
    const { reader, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    reader.resolveCalls = [];
    reader.readCalls = [];

    const connections = await connector.snapshot("bot-1");
    expect(reader.resolveCalls).toEqual([]);
    expect(reader.readCalls).toEqual([]);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.connectionId).toBe(CONNECTION_ID);
    expect(connections[0]!.status).toBe("ready");
    expect(connections[0]!.resources).toEqual([
      {
        id: "document:AAA111",
        type: "document",
        displayName: "文档 AAA111",
        selected: true,
      },
    ]);
    // Every declared capability's scopes are reported, deduplicated and sorted.
    expect(connections[0]!.grantedScopes).toEqual([
      "docx:document:readonly",
      "drive:drive.metadata:readonly",
      "wiki:node:read",
    ]);
  });

  test("reports when reconciliation leaves the fixed scope unchanged", async () => {
    const { connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    expect(await connector.reconcile()).toBe(false);
  });

  test("reports no connection at all when Feishu is not bound", async () => {
    const selections = new MemorySelections();
    const connector = new FeishuServiceConnector(() => undefined, selections, () => new FakeReader());
    expect(await connector.snapshot("bot-1")).toEqual([]);
  });

  test("reads by the stored token rather than a remembered URL", async () => {
    const { reader, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    reader.readCalls = [];

    const connections = await connector.snapshot("bot-1");
    const result = await connector.read({
      context: { botId: "bot-1", sourceMessageId: "m1", sourceText: "", topicKey: "t", requesterId: "u" },
      grant: {
        botId: "bot-1",
        connectionId: CONNECTION_ID,
        resourceId: "document:AAA111",
        capabilityId: "document.read",
        sourceMessageId: "m1",
        topicKey: "t",
        requesterId: "u",
        authorizationQuote: null,
        catalogRevision: `sha256:${"0".repeat(64)}`,
      },
      connection: connections[0]!,
      resource: connections[0]!.resources[0]!,
      capability: connector.manifest.capabilities[0]!,
      input: { scope: "outline" },
    });
    expect(reader.readCalls).toEqual([
      { resourceType: "document", token: "AAA111", scope: "outline" },
    ]);
    expect(result).toEqual({
      content: { title: "正文 AAA111", body: "hello" },
    });
  });

  test("keeps the connection ready while an invalidated fixed scope is rechecked", async () => {
    const { connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    connector.invalidateResourceProof();
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      status: "ready",
      account: { displayName: BINDING.displayName },
      grantedScopes: BINDING.grantedScopes,
      resourceScope: {
        status: "checking",
        selectedCount: 1,
        problem: "resource_reconciliation_required",
      },
      resources: [
        {
          id: "document:AAA111",
          type: "document",
          displayName: "文档 AAA111",
          selected: true,
        },
      ],
    });
  });

  test("returns readable partial content with an explicit limitation", async () => {
    const { reader, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    reader.partial.add("read:AAA111");
    const connections = await connector.snapshot("bot-1");

    await expect(
      connector.read({
        context: { botId: "bot-1", sourceMessageId: "m1", sourceText: "", topicKey: "t", requesterId: "u" },
        grant: {
          botId: "bot-1",
          connectionId: CONNECTION_ID,
          resourceId: "document:AAA111",
          capabilityId: "document.read",
          sourceMessageId: "m1",
          topicKey: "t",
          requesterId: "u",
          authorizationQuote: null,
          catalogRevision: `sha256:${"0".repeat(64)}`,
        },
        connection: connections[0]!,
        resource: connections[0]!.resources[0]!,
        capability: connector.manifest.capabilities[0]!,
        input: {},
      }),
    ).resolves.toEqual({
      content: { title: "正文 AAA111", body: "hello" },
      limitation: "document_content_partial",
    });
  });

  test("does not inherit a proof when the saved resource set changes at the same size", async () => {
    const { selections, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    selections.replaceConnectorSelections(CONNECTION_ID, [{
      connectionId: CONNECTION_ID,
      resourceId: "document:CCC333",
      resourceType: "document",
      displayName: "文档 CCC333",
      address: "https://acme.feishu.cn/docx/CCC333",
      selectionId: "1".repeat(32),
    }]);

    const [connection] = await connector.snapshot("bot-1");
    expect(connection?.resourceScope).toEqual({
      status: "checking",
      selectedCount: 1,
      problem: "resource_reconciliation_required",
    });
  });

  test("drops a stored resource the provider no longer proves readable", async () => {
    const { selections, reader, connector } = build();
    await connector.add([
      "https://acme.feishu.cn/docx/AAA111",
      "https://acme.feishu.cn/docx/BBB222",
    ]);
    reader.unreadable.add("https://acme.feishu.cn/docx/BBB222");

    expect(await connector.reconcile()).toBe(true);
    expect(selections.connectorSelections(CONNECTION_ID).map((row) => row.resourceId))
      .toEqual(["document:AAA111"]);
  });

  test("keeps fixed resources when reconciliation cannot reach Feishu", async () => {
    const { selections, reader, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    reader.providerUnavailable.add("https://acme.feishu.cn/docx/AAA111");

    await expect(connector.reconcile()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(selections.connectorSelections(CONNECTION_ID)).toHaveLength(1);
    expect(selections.connectorSelections(CONNECTION_ID)[0]!.resourceId).toBe(
      "document:AAA111",
    );
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      status: "ready",
      resourceScope: {
        status: "unavailable",
        selectedCount: 1,
        problem: "provider_unavailable",
      },
      resources: [
        {
          id: "document:AAA111",
          type: "document",
          displayName: "文档 AAA111",
          selected: true,
        },
      ],
    });
  });

  test("asks for a recheck only while a saved range on a ready connection is unproven", async () => {
    const { reader, connector } = build();
    expect(connector.needsRecheck()).toBe(false);
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    expect(connector.needsRecheck()).toBe(false);
    reader.providerUnavailable.add("https://acme.feishu.cn/docx/AAA111");
    await expect(connector.reconcile()).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(connector.needsRecheck()).toBe(true);
    reader.providerUnavailable.clear();
    expect(await connector.reconcile()).toBe(false);
    expect(connector.needsRecheck()).toBe(false);
  });

  test("does not silently retarget a fixed resource during reconciliation", async () => {
    const { selections, reader, connector } = build();
    const address = "https://acme.feishu.cn/docx/AAA111";
    await connector.add([address]);
    reader.resolvedResources.set(address, {
      resourceId: "document:CCC333",
      resourceType: "document",
      displayName: "文档 CCC333",
      address: "https://acme.feishu.cn/docx/CCC333",
    });

    await expect(connector.reconcile()).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
    expect(selections.connectorSelections(CONNECTION_ID).map((row) => row.resourceId))
      .toEqual(["document:AAA111"]);
    expect((await connector.snapshot("bot-1"))[0]?.resourceScope).toMatchObject({
      status: "unavailable",
      problem: "provider_response_invalid",
    });
  });

  test("keeps the exact resource proof problem when provider metadata is incomplete", async () => {
    const { reader, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    reader.metadataIncomplete.add("https://acme.feishu.cn/docx/AAA111");

    await expect(connector.reconcile()).rejects.toMatchObject({
      code: "metadata_incomplete",
    });
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      status: "ready",
      resourceScope: {
        status: "unavailable",
        selectedCount: 1,
        problem: "metadata_incomplete",
      },
    });
  });

  test("reports an empty fixed scope as ready even when the Feishu connection is unavailable", async () => {
    const selections = new MemorySelections();
    const connector = new FeishuServiceConnector(
      () => ({ ...BINDING, status: "unavailable", problem: "provider_unavailable" }),
      selections,
      () => new FakeReader(),
    );
    const [connection] = await connector.snapshot("bot-1");
    expect(connection?.resourceScope).toEqual({ status: "ready", selectedCount: 0 });
  });

  test("does not let an unverified scope become ready through another add", async () => {
    const { reader, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111"]);
    reader.providerUnavailable.add("https://acme.feishu.cn/docx/AAA111");
    await expect(connector.reconcile()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(
      connector.add(["https://acme.feishu.cn/docx/BBB222"]),
    ).rejects.toMatchObject({ code: "resource_unavailable" });
  });
  test("publishes the verified identity and full granted scope inventory", async () => {
    const selections = new MemorySelections();
    const connector = new FeishuServiceConnector(() => ({ ...BINDING, grantedScopes: [...BINDING.grantedScopes, "docx:document:write_only"] }), selections, () => new FakeReader());
    const [connection] = await connector.snapshot("bot-1");
    expect(connection!.account).toEqual({ displayName: BINDING.displayName });
    expect(connection!.grantedScopes).toContain("docx:document:write_only");
    expect(connector.manifest.capabilities.every((capability) => capability.operation === "read")).toBe(true);
  });

  test("distinguishes missing Feishu setup authorization from a provider outage", async () => {
    const selections = new MemorySelections();
    const needsApproval = new FeishuServiceConnector(
      () => ({
        ...BINDING,
        status: "unavailable",
        problem: "permissions_approval_required",
      }),
      selections,
      () => new FakeReader(),
    );
    expect((await needsApproval.snapshot("bot-1"))[0]).toMatchObject({
      status: "reauthorization_required",
      problem: "permissions_approval_required",
    });
    const outage = new FeishuServiceConnector(
      () => ({
        ...BINDING,
        status: "unavailable",
        problem: "provider_unavailable",
      }),
      selections,
      () => new FakeReader(),
    );
    expect((await outage.snapshot("bot-1"))[0]).toMatchObject({
      status: "unavailable",
      problem: "provider_unavailable",
    });
  });

  test("removes only the current selection and rejects stale or unknown resources", async () => {
    const { selections, connector } = build();
    await connector.add(["https://acme.feishu.cn/docx/AAA111", "https://acme.feishu.cn/wiki/BBB222"]);
    const original = selections.connectorSelections(CONNECTION_ID);
    expect(() => connector.remove("document:AAA111", "0".repeat(32))).toThrow("连接器资源选择已变化");
    expect(() => connector.remove("document:MISSING", original[0]!.selectionId)).toThrow();
    expect(selections.connectorSelections(CONNECTION_ID)).toEqual(original);
    connector.remove(original[0]!.resourceId, original[0]!.selectionId);
    expect(selections.connectorSelections(CONNECTION_ID)).toEqual([original[1]!]);
    expect(() => connector.remove(original[0]!.resourceId, original[0]!.selectionId)).toThrow();
  });

});
