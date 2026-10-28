import { describe, expect, test } from "bun:test";
import { connectorCapabilityAvailability } from "../src/connectors/availability.ts";
import { ConnectorBroker } from "../src/connectors/broker.ts";
import type {
  ConnectorWriteRecord,
  ConnectorWriteStore,
} from "../src/connectors/ledger.ts";
import type {
  ConnectorAdapter,
  ConnectorConnectionSnapshot,
  ConnectorProviderManifest,
  ConnectorRequestContext,
  ConnectorTaskGrant,
  ConnectorWriteResult,
  JsonValue,
} from "../src/connectors/protocol.ts";
import { ConnectorRegistry } from "../src/connectors/registry.ts";

/**
 * An in-memory stand-in for the Bot's ledger, so the Broker's replay rules are
 * testable without a SQLite file. The real implementation is StateStore.
 */
class MemoryWriteStore implements ConnectorWriteStore {
  readonly records = new Map<string, ConnectorWriteRecord>();
  #key(connectionId: string, capabilityId: string, idempotencyKey: string) {
    return `${connectionId}\u0000${capabilityId}\u0000${idempotencyKey}`;
  }
  connectorWriteRecord(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
  ) {
    return this.records.get(
      this.#key(connectionId, capabilityId, idempotencyKey),
    );
  }
  claimConnectorWrite(
    record: Omit<ConnectorWriteRecord, "status" | "resultJson">,
  ): boolean {
    const key = this.#key(
      record.connectionId,
      record.capabilityId,
      record.idempotencyKey,
    );
    if (this.records.has(key)) return false;
    this.records.set(key, { ...record, status: "pending", resultJson: null });
    return true;
  }
  completeConnectorWrite(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
    resultJson: string,
  ) {
    const key = this.#key(connectionId, capabilityId, idempotencyKey);
    const existing = this.records.get(key)!;
    this.records.set(key, { ...existing, status: "applied", resultJson });
  }
  abandonConnectorWrite(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
  ) {
    this.records.delete(this.#key(connectionId, capabilityId, idempotencyKey));
  }
}

const BOT_ID = "bot-1";
const CONTEXT: ConnectorRequestContext = {
  botId: BOT_ID,
  sourceMessageId: "message-1",
  sourceText: "请把标题改成新的标题，并回读结果。",
  topicKey: "chat-1:thread-1",
  requesterId: "user-1",
};

describe("connector registry and broker", () => {
  test("builds a stable catalog from selected resources and declared scopes", async () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeAdapter());
    const first = await registry.catalog(BOT_ID);
    const second = await registry.catalog(BOT_ID);

    expect(first.revision).toBe(second.revision);
    expect(first.connections).toHaveLength(1);
    // Every authorized resource is listed so a screen can offer the rest;
    // `selected` is what distinguishes a choice from an option.
    expect(
      first.connections[0]?.resources.map((resource) => ({
        id: resource.id,
        selected: resource.selected,
      })),
    ).toEqual([
      { id: "repo-1", selected: true },
      { id: "repo-2", selected: false },
    ]);
    expect(first.connections[0]?.grantedScopes).toEqual([
      "repo:read",
      "repo:write",
    ]);
    expect(
      first.connections[0]?.capabilities.map((capability) => capability.id),
    ).toEqual(["issue.update", "repository.read"]);
    expect(first.connections[0]?.capabilities[0]).toMatchObject({
      id: "issue.update",
      manifestRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(first.connections[0]?.capabilities[0]).not.toHaveProperty(
      "inputSchema",
    );
  });

  test("validates read inputs and rejects stale catalog revisions", async () => {
    const adapter = fakeAdapter();
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);

    await expect(
      broker.read(CONTEXT, {
        connectionId: "github-1",
        resourceId: "repo-1",
        capabilityId: "repository.read",
        catalogRevision: catalog.revision,
        input: { path: "README.md" },
      }),
    ).resolves.toEqual({ path: "README.md", repository: "repo-1" });

    await expect(
      broker.read(CONTEXT, {
        connectionId: "github-1",
        resourceId: "repo-1",
        capabilityId: "repository.read",
        catalogRevision: `sha256:${"0".repeat(64)}`,
        input: { path: "README.md" },
      }),
    ).rejects.toMatchObject({ code: "catalog_changed" });

    await expect(
      broker.read(CONTEXT, {
        connectionId: "github-1",
        resourceId: "repo-1",
        capabilityId: "repository.read",
        catalogRevision: catalog.revision,
        input: { path: "README.md", endpoint: "https://example.com" },
      }),
    ).rejects.toMatchObject({ code: "input_invalid" });
  });

  test("keeps implemented operations discoverable without allowing an ungranted read or write", async () => {
    const adapter = fakeAdapter();
    const snapshot = adapter.snapshot.bind(adapter);
    adapter.snapshot = async (botId) =>
      (await snapshot(botId)).map((connection) => ({
        ...connection,
        grantedScopes: [],
      }));
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const ledger = new MemoryWriteStore();
    const broker = new ConnectorBroker(registry, ledger);
    const catalog = await broker.catalog(BOT_ID);
    const connection = catalog.connections[0]!;
    expect(connection.capabilities).toHaveLength(2);
    for (const capability of connection.capabilities) {
      expect(connectorCapabilityAvailability(connection, capability)).toBe(
        "authorization_required",
      );
    }
    const request = {
      connectionId: connection.connectionId,
      resourceId: "repo-1",
      catalogRevision: catalog.revision,
    };
    await expect(
      broker.read(CONTEXT, {
        ...request,
        capabilityId: "repository.read",
        input: { path: "README.md" },
      }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    await expect(
      broker.write(CONTEXT, {
        ...request,
        capabilityId: "issue.update",
        input: { title: "新的标题" },
        authorizationQuote: "把标题改成新的标题",
        idempotencyKey: "ungranted-request",
      }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(adapter.readCalls).toBe(0);
    expect(adapter.writeCalls).toBe(0);
    expect(ledger.records.size).toBe(0);
  });

  test("invalidates the catalog when a hidden capability schema changes", async () => {
    const firstRegistry = new ConnectorRegistry();
    firstRegistry.register(fakeAdapter());
    const first = await firstRegistry.catalog(BOT_ID);

    const changedManifest: ConnectorProviderManifest = {
      ...MANIFEST,
      capabilities: MANIFEST.capabilities.map((capability) =>
        capability.id === "repository.read"
          ? {
              ...capability,
              inputSchema: {
                ...capability.inputSchema,
                properties: { path: { type: "string", maxLength: 200 } },
              },
            }
          : capability,
      ),
    };
    const secondRegistry = new ConnectorRegistry();
    secondRegistry.register(fakeAdapter({ manifest: changedManifest }));
    const second = await secondRegistry.catalog(BOT_ID);

    expect(second.revision).not.toBe(first.revision);
    const firstRead = first.connections[0]?.capabilities.find(
      (capability) => capability.id === "repository.read",
    );
    const secondRead = second.connections[0]?.capabilities.find(
      (capability) => capability.id === "repository.read",
    );
    expect(secondRead?.manifestRevision).not.toBe(firstRead?.manifestRevision);
  });

  test("requires current-message authorization and authoritative readback for writes", async () => {
    const adapter = fakeAdapter();
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);
    const request = {
      connectionId: "github-1",
      resourceId: "repo-1",
      capabilityId: "issue.update",
      catalogRevision: catalog.revision,
      input: { title: "新的标题" },
    } as const;

    await expect(broker.write(CONTEXT, request)).rejects.toMatchObject({
      code: "authorization_missing",
      field: "authorization_quote",
    });
    await expect(
      broker.write(CONTEXT, {
        ...request,
        unexpected: true,
      } as never),
    ).rejects.toMatchObject({ code: "request_invalid" });
    await expect(
      broker.write(CONTEXT, {
        ...request,
        authorizationQuote: "把标题改成新的标题",
        idempotencyKey: "message-1:issue-1",
      }),
    ).resolves.toEqual({
      status: "applied",
      readback: { title: "新的标题", issue: 1 },
      summary: "updated",
    });
    expect(adapter.lastWriteGrant).toEqual({
      botId: BOT_ID,
      connectionId: "github-1",
      resourceId: "repo-1",
      capabilityId: "issue.update",
      sourceMessageId: "message-1",
      topicKey: "chat-1:thread-1",
      requesterId: "user-1",
      authorizationQuote: "把标题改成新的标题",
      catalogRevision: catalog.revision,
    });

    await expect(
      broker.write(CONTEXT, {
        ...request,
        authorizationQuote: "把标题改成新的标题",
      }),
    ).rejects.toThrow("idempotency");
    await expect(
      broker.write(
        { ...CONTEXT, sourceText: "请把标题\n改成新的标题，并回读结果。" },
        {
          ...request,
          authorizationQuote: "把标题\n改成新的标题",
          idempotencyKey: "message-1:issue-2",
        },
      ),
    ).resolves.toMatchObject({ status: "applied" });
  });

  test("requires an authorization quote with substance, not a fragment of a question", async () => {
    const adapter = fakeAdapter();
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);
    const write = (
      sourceText: string,
      authorizationQuote: string,
      key: string,
    ) =>
      broker.write(
        { ...CONTEXT, sourceText },
        {
          connectionId: "github-1",
          resourceId: "repo-1",
          capabilityId: "issue.update",
          catalogRevision: catalog.revision,
          input: { title: "新的标题" },
          authorizationQuote,
          idempotencyKey: key,
        },
      );

    // The review probe: a two-character fragment of a question proves nothing.
    await expect(
      write("看看 #12 现在是什么情况", "看看", "q-1"),
    ).rejects.toMatchObject({
      code: "authorization_too_short",
      field: "authorization_quote",
    });
    await expect(
      write("麻烦把 #12 关掉，谢谢", "关掉", "q-2"),
    ).rejects.toMatchObject({
      code: "authorization_too_short",
    });
    await expect(
      write("麻烦把 #12 关掉，谢谢", "把 #13 关掉", "q-3"),
    ).rejects.toMatchObject({
      code: "authorization_missing",
    });
    expect(adapter.writeCalls).toBe(0);
    // A real request passes, and a message shorter than the minimum is quoted whole.
    await expect(
      write("麻烦把 #12 关掉，谢谢", "把 #12 关掉", "q-4"),
    ).resolves.toMatchObject({
      status: "applied",
    });
    await expect(write("好", " 好 ", "q-5")).resolves.toMatchObject({
      status: "applied",
    });
    expect(adapter.lastWriteGrant?.authorizationQuote).toBe("好");
  });

  test("rejects an unselected resource before invoking the adapter", async () => {
    const adapter = fakeAdapter();
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);
    await expect(
      broker.read(CONTEXT, {
        connectionId: "github-1",
        resourceId: "repo-2",
        capabilityId: "repository.read",
        catalogRevision: catalog.revision,
        input: { path: "README.md" },
      }),
    ).rejects.toMatchObject({ code: "resource_not_selected" });
    expect(adapter.readCalls).toBe(0);
  });

  test("rejects a selected resource while its durable scope is unavailable", async () => {
    const adapter = fakeAdapter({
      resourceScope: {
        status: "unavailable",
        selectedCount: 1,
        problem: "provider_unavailable",
      },
    });
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);
    await expect(
      broker.read(CONTEXT, {
        connectionId: "github-1",
        resourceId: "repo-1",
        capabilityId: "repository.read",
        catalogRevision: catalog.revision,
        input: { path: "README.md" },
      }),
    ).rejects.toMatchObject({ code: "resource_unavailable" });
    expect(adapter.readCalls).toBe(0);
  });

  test("reports an unselected option before an unavailable selected scope", async () => {
    const adapter = fakeAdapter({
      resourceScope: {
        status: "unavailable",
        selectedCount: 1,
        problem: "provider_unavailable",
      },
    });
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);
    await expect(
      broker.read(CONTEXT, {
        connectionId: "github-1",
        resourceId: "repo-2",
        capabilityId: "repository.read",
        catalogRevision: catalog.revision,
        input: { path: "README.md" },
      }),
    ).rejects.toMatchObject({ code: "resource_not_selected" });
    expect(adapter.readCalls).toBe(0);
  });

  test("rejects an unavailable empty resource scope as an invalid adapter snapshot", async () => {
    const adapter = fakeAdapter({
      resourceSelected: false,
      resourceScope: {
        status: "unavailable",
        selectedCount: 0,
        problem: "provider_unavailable",
      },
    });
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    await expect(registry.catalog(BOT_ID)).rejects.toThrow(
      "with no selected resources",
    );
  });

  test("fails closed when a selected resource is not proven writable", async () => {
    const adapter = fakeAdapter({ resourceWritable: false });
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);
    await expect(
      broker.write(CONTEXT, {
        connectionId: "github-1",
        resourceId: "repo-1",
        capabilityId: "issue.update",
        catalogRevision: catalog.revision,
        input: { title: "新的标题" },
        authorizationQuote: "把标题改成新的标题",
        idempotencyKey: "message-1:read-only",
      }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(adapter.writeCalls).toBe(0);
  });

  test("fails closed when a selected resource omits write proof", async () => {
    const adapter = fakeAdapter({ resourceWritable: "unknown" });
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);
    await expect(
      broker.write(CONTEXT, {
        connectionId: "github-1",
        resourceId: "repo-1",
        capabilityId: "issue.update",
        catalogRevision: catalog.revision,
        input: { title: "新的标题" },
        authorizationQuote: "把标题改成新的标题",
        idempotencyKey: "message-1:unknown-write",
      }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(adapter.writeCalls).toBe(0);
  });

  test("describes only a capability present in the current catalog", async () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeAdapter());
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);

    await expect(
      broker.describe(CONTEXT, {
        connectionId: "github-1",
        capabilityId: "repository.read",
        catalogRevision: catalog.revision,
      }),
    ).resolves.toMatchObject({
      id: "repository.read",
      operation: "read",
      inputSchema: {
        properties: { path: { type: "string" } },
      },
    });
    await expect(
      broker.describe(CONTEXT, {
        connectionId: "github-1",
        capabilityId: "missing.read",
        catalogRevision: catalog.revision,
      }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  test("enforces declared string bounds and required readback", async () => {
    const manifest: ConnectorProviderManifest = {
      ...MANIFEST,
      capabilities: MANIFEST.capabilities.map((capability) =>
        capability.id === "issue.update"
          ? {
              ...capability,
              inputSchema: {
                ...capability.inputSchema,
                properties: {
                  title: { type: "string", minLength: 2, maxLength: 8 },
                },
              },
            }
          : capability,
      ),
    };
    const adapter = fakeAdapter({
      manifest,
      writeResult: { status: "applied", readback: null },
    });
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const catalog = await broker.catalog(BOT_ID);
    const request = {
      connectionId: "github-1",
      resourceId: "repo-1",
      capabilityId: "issue.update",
      catalogRevision: catalog.revision,
      authorizationQuote: "把标题改成新的标题",
      idempotencyKey: "message-1:issue-1",
      input: { title: "x" },
    } as const;
    await expect(broker.write(CONTEXT, request)).rejects.toMatchObject({
      code: "input_invalid",
      field: "input.title",
    });
    await expect(
      broker.write(CONTEXT, { ...request, input: { title: "valid" } }),
    ).rejects.toMatchObject({ code: "readback_missing" });
  });

  test("rejects open input schemas at registration", () => {
    const registry = new ConnectorRegistry();
    const adapter = fakeAdapter({
      manifest: {
        ...fakeAdapter().manifest,
        capabilities: [
          {
            ...fakeAdapter().manifest.capabilities[0]!,
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: true as never,
            },
          },
        ],
      },
    });
    expect(() => registry.register(adapter)).toThrow("closed object");
  });

  test("rejects deeply nested schemas before they can burden the agent", () => {
    let property: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 20; depth += 1) {
      property = {
        type: "object",
        properties: { nested: property },
        required: ["nested"],
        additionalProperties: false,
      };
    }
    const registry = new ConnectorRegistry();
    const adapter = fakeAdapter({
      manifest: {
        ...fakeAdapter().manifest,
        capabilities: [
          {
            ...fakeAdapter().manifest.capabilities[0]!,
            inputSchema: {
              type: "object",
              properties: { nested: property as never },
              required: ["nested"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
    expect(() => registry.register(adapter)).toThrow("nesting limit");
  });

  test("bounds catalog output before it reaches the agent", async () => {
    const registry = new ConnectorRegistry();
    const adapter = fakeAdapter({
      manifest: {
        ...MANIFEST,
        capabilities: Array.from({ length: 256 }, (_, index) => ({
          ...MANIFEST.capabilities[0]!,
          id: `repository.read_${index}`,
          description: "x".repeat(1_000),
        })),
      },
    });
    registry.register(adapter);
    await expect(registry.catalog(BOT_ID)).rejects.toThrow(
      "connector catalog exceeds",
    );
  });
});

function fakeAdapter(
  overrides: {
    manifest?: ConnectorProviderManifest;
    writeResult?: ConnectorWriteResult;
    resourceScope?: ConnectorConnectionSnapshot["resourceScope"];
    resourceWritable?: boolean | "unknown";
    resourceSelected?: boolean;
  } = {},
): FakeAdapter {
  return new FakeAdapter(
    overrides.manifest ?? MANIFEST,
    overrides.writeResult,
    overrides.resourceScope,
    overrides.resourceWritable,
    overrides.resourceSelected,
  );
}

const MANIFEST: ConnectorProviderManifest = {
  id: "fixture",
  version: "1.0.0",
  displayName: "Fixture provider",
  resourceTypes: [{ id: "repository", displayName: "Repository" }],
  capabilities: [
    {
      id: "repository.read",
      displayName: "Read repository",
      description: "Read one repository path.",
      operation: "read",
      resourceTypes: ["repository"],
      resourceSelection: "required",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      requestAuthorization: "none",
      requiredScopes: ["repo:read"],
      idempotency: "none",
      readback: "none",
    },
    {
      id: "issue.update",
      displayName: "Update issue",
      description: "Update one issue title.",
      operation: "write",
      resourceTypes: ["repository"],
      resourceSelection: "required",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      requestAuthorization: "current_message",
      requiredScopes: ["repo:write"],
      idempotency: "required",
      readback: "required",
    },
  ],
};

class FakeAdapter implements ConnectorAdapter {
  readonly manifest: ConnectorProviderManifest;
  readCalls = 0;
  writeCalls = 0;
  failNextWrite = false;
  catalogSalt = "1";
  lastWriteGrant: ConnectorTaskGrant | undefined;
  readonly writeResult: ConnectorWriteResult | undefined;
  readonly resourceScope: ConnectorConnectionSnapshot["resourceScope"];
  readonly resourceWritable: boolean | "unknown";
  readonly resourceSelected: boolean;

  constructor(
    manifest: ConnectorProviderManifest,
    writeResult?: ConnectorWriteResult,
    resourceScope?: ConnectorConnectionSnapshot["resourceScope"],
    resourceWritable: boolean | "unknown" = true,
    resourceSelected = true,
  ) {
    this.manifest = manifest;
    this.writeResult = writeResult;
    this.resourceScope = resourceScope ?? { status: "ready", selectedCount: 1 };
    this.resourceWritable = resourceWritable;
    this.resourceSelected = resourceSelected;
  }

  async snapshot(
    botId: string,
  ): Promise<readonly ConnectorConnectionSnapshot[]> {
    return [
      {
        botId,
        connectionId: "github-1",
        providerId: "fixture",
        status: "ready",
        account: { displayName: `test-account-${this.catalogSalt}` },
        grantedScopes: ["repo:read", "repo:write"],
        resources: [
          {
            id: "repo-1",
            type: "repository",
            displayName: "test/repo",
            selected: this.resourceSelected,
            ...(this.resourceWritable === "unknown"
              ? {}
              : { writable: this.resourceWritable }),
          },
          {
            id: "repo-2",
            type: "repository",
            displayName: "test/other",
            selected: false,
            writable: false,
          },
        ],
        resourceScope: this.resourceScope,
      },
    ];
  }

  async read(input: { input: unknown }): Promise<JsonValue> {
    this.readCalls += 1;
    return {
      path: (input.input as { path: string }).path,
      repository: "repo-1",
    };
  }

  async write(input: {
    input: unknown;
    grant: ConnectorTaskGrant;
  }): Promise<ConnectorWriteResult> {
    this.writeCalls += 1;
    this.lastWriteGrant = input.grant;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("provider unavailable");
    }
    if (this.writeResult) return this.writeResult;
    return {
      status: "applied",
      readback: { title: (input.input as { title: string }).title, issue: 1 },
      summary: "updated",
    };
  }
}

describe("connector write idempotency ledger", () => {
  /** A write request the fake adapter accepts, with a key it will record. */
  async function writable(broker: ConnectorBroker, key: string) {
    const catalog = await broker.catalog(BOT_ID);
    return {
      connectionId: "github-1",
      resourceId: "repo-1",
      capabilityId: "issue.update",
      catalogRevision: catalog.revision,
      input: { title: "新的标题" },
      authorizationQuote: "把标题改成新的标题",
      idempotencyKey: key,
    } as const;
  }

  test("answers a replay from the ledger without reaching the adapter", async () => {
    const adapter = fakeAdapter();
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const request = await writable(broker, "message-1:issue-1");

    await expect(broker.write(CONTEXT, request)).resolves.toMatchObject({
      status: "applied",
    });
    const writesAfterFirst = adapter.writeCalls;
    await expect(broker.write(CONTEXT, request)).resolves.toEqual({
      status: "already_applied",
      readback: { title: "新的标题", issue: 1 },
      summary: "updated",
    });
    // The side effect happened once; the replay is decided by the record alone.
    expect(adapter.writeCalls).toBe(writesAfterFirst);
  });

  test("refuses a key already recorded against a different request", async () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeAdapter());
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const request = await writable(broker, "message-1:issue-1");
    await broker.write(CONTEXT, request);

    const catalog = await broker.catalog(BOT_ID);
    await expect(
      broker.write(CONTEXT, { ...request, input: { title: "另一个标题" } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(catalog.revision).toBe(request.catalogRevision);
  });

  test("refuses reuse from a different source message, topic, requester or authorization", async () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeAdapter());
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const request = await writable(broker, "message-1:issue-1");
    await broker.write(CONTEXT, request);

    await expect(
      broker.write(
        { ...CONTEXT, sourceMessageId: "message-2" },
        { ...request },
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      broker.write({ ...CONTEXT, topicKey: "chat-1:thread-2" }, { ...request }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      broker.write({ ...CONTEXT, requesterId: "user-2" }, { ...request }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      broker.write(
        { ...CONTEXT, sourceText: "把标题改成另一个标题" },
        { ...request, authorizationQuote: "把标题改成另一个标题" },
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("replays after a catalog refresh when the operation identity is unchanged", async () => {
    const adapter = fakeAdapter();
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, new MemoryWriteStore());
    const first = await writable(broker, "message-1:issue-1");
    await broker.write(CONTEXT, first);

    adapter.catalogSalt = "2";
    const refreshedCatalog = await broker.catalog(BOT_ID);
    expect(refreshedCatalog.revision).not.toBe(first.catalogRevision);
    await expect(
      broker.write(CONTEXT, {
        ...first,
        catalogRevision: refreshedCatalog.revision,
      }),
    ).resolves.toMatchObject({ status: "already_applied" });
    expect(adapter.writeCalls).toBe(1);
  });

  test("fails closed when an in-flight key is reused", async () => {
    const store = new MemoryWriteStore();
    const registry = new ConnectorRegistry();
    registry.register(fakeAdapter());
    const broker = new ConnectorBroker(registry, store);
    const request = await writable(broker, "message-1:issue-1");
    // Claim the key as another writer would, then reuse it from this one.
    store.claimConnectorWrite({
      connectionId: request.connectionId,
      capabilityId: request.capabilityId,
      idempotencyKey: request.idempotencyKey,
      resourceId: request.resourceId,
      catalogRevision: request.catalogRevision,
      capabilityRevision: `sha256:${"1".repeat(64)}`,
      inputDigest: "0".repeat(64),
      sourceMessageId: CONTEXT.sourceMessageId,
      topicKey: CONTEXT.topicKey,
      requesterId: CONTEXT.requesterId,
      authorizationDigest: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await expect(broker.write(CONTEXT, { ...request })).rejects.toMatchObject({
      code: "idempotency_in_flight",
    });
  });

  test("refuses a write that declares idempotency when no ledger is configured", async () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeAdapter());
    const broker = new ConnectorBroker(registry);
    await expect(
      broker.write(CONTEXT, await writable(broker, "message-1:issue-1")),
    ).rejects.toMatchObject({ code: "idempotency_unavailable" });
  });

  test("releases its claim after an adapter failure so a retry can proceed", async () => {
    const adapter = fakeAdapter();
    const store = new MemoryWriteStore();
    const registry = new ConnectorRegistry();
    registry.register(adapter);
    const broker = new ConnectorBroker(registry, store);
    const request = await writable(broker, "message-1:issue-1");

    adapter.failNextWrite = true;
    await expect(broker.write(CONTEXT, request)).rejects.toMatchObject({
      code: "adapter_failed",
    });
    await expect(broker.write(CONTEXT, request)).resolves.toMatchObject({
      status: "applied",
    });
  });
});
