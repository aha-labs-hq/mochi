import { describe, expect, test } from "bun:test";
import type {
  ConnectorCatalogProjection,
  ConnectorConnectionProjection,
} from "../../src/control/connectorSnapshot.ts";
import { initialSnapshot } from "../src/shared/model.ts";
import {
  connectorAuthorizationFor,
  connectorDirectoryModels,
} from "../src/ui/connectorDirectory.ts";

function snapshot(catalog: ConnectorCatalogProjection | null) {
  return { ...initialSnapshot("0.2.0", true), connectorCatalog: catalog };
}

function catalog(
  connections: ConnectorCatalogProjection["connections"],
): ConnectorCatalogProjection {
  return { revision: `sha256:${"a".repeat(64)}`, connections };
}

function connection(
  value: Partial<ConnectorConnectionProjection> &
    Pick<
      ConnectorConnectionProjection,
      "connectionId" | "providerId" | "providerDisplayName"
    >,
): ConnectorConnectionProjection {
  const resources = value.resources ?? [];
  return {
    status: "ready",
    accountDisplayName: "account",
    problem: null,
    grantedScopes: [],
    resourceScope: value.resourceScope ?? {
      status: "unavailable",
      selectedCount: 0,
    },
    resources,
    capabilities: [],
    ...value,
  };
}

describe("connector directory projection", () => {
  test("keeps Feishu current-message access separate from optional fixed scope", () => {
    expect(connectorAuthorizationFor("feishu-service").resources).toEqual([
      "message_context",
      "explicit_reference",
      "catalog_selection",
    ]);
  });

  test("keeps the shared mailbox user grant separate and read-only", () => {
    expect(connectorAuthorizationFor("feishu-mail")).toEqual({
      acquisition: { kind: "interactive", interaction: "qr" },
      principal: "user",
      resources: ["account_scope", "catalog_selection"],
      administratorApproval: "possible",
    });
  });

  test("uses one card model for provider identity, scope and capabilities", () => {
    const models = connectorDirectoryModels(
      snapshot(
        catalog([
          connection({
            connectionId: "github:1",
            providerId: "github",
            providerDisplayName: "GitHub",
            accountDisplayName: "customer",
            resources: [
              {
                resourceId: "repository:20",
                resourceType: "repository",
                displayName: "customer/mochi",
                selectionId: "c".repeat(32),
                selected: true,
                ownerId: "1",
                visibility: "private",
                writable: true,
              },
            ],
            capabilities: [
              {
                id: "issues.read",
                displayName: "读取 Issue",
                description: "读取 Issue",
                operation: "read",
                resourceSelection: "required",
                availability: "ready",
              },
            ],
          }),
        ]),
      ).connectorCatalog,
    );

    expect(models.map((model) => model.providerId)).toEqual([
      "github",
      "feishu-service",
      "feishu-mail",
    ]);
    const github = models[0]!;
    expect(github.connection.identity).toBe("customer");
    expect(github.access.summary).toBe("1 项已选择");
    expect(github.access.items).toEqual([
      {
        id: "repository:20",
        name: "customer/mochi",
        type: "repository",
      },
    ]);
    expect(
      github.operations.find((group) => group.kind === "read")?.available[0]
        ?.displayName,
    ).toBe("读取 Issue");
    expect(github.connection.status).toEqual({
      label: "已连接",
      tone: "good",
    });
  });

  test("keeps unknown catalog state distinct from an empty connection", () => {
    const unavailable = connectorDirectoryModels(
      snapshot(null).connectorCatalog,
    );
    expect(unavailable[0]?.connection.status).toEqual({
      label: "无法确认",
      tone: "muted",
    });

    const empty = connectorDirectoryModels(
      snapshot(catalog([])).connectorCatalog,
    );
    const github = empty.find((model) => model.providerId === "github")!;
    const mail = empty.find((model) => model.providerId === "feishu-mail")!;
    // The product's core needs GitHub: missing asks for attention and names
    // the action, while an optional connector stays quiet.
    expect(github.connection.status.tone).toBe("pending");
    expect(github.management.label).toContain("GitHub");
    expect(mail.connection.status.tone).toBe("muted");
    expect(github.connection.status.label).toBe(mail.connection.status.label);
  });

  test("a connection that lacks part of its grant is never shown as connected", () => {
    const ready = (availability: "ready" | "authorization_required") =>
      connectorDirectoryModels(
        snapshot(
          catalog([
            connection({
              connectionId: "feishu-mail:ou_fixture",
              providerId: "feishu-mail",
              providerDisplayName: "飞书共享邮箱",
              capabilities: [
                {
                  id: "thread.read",
                  displayName: "读取邮件会话",
                  description: "读取已选择邮箱中的会话。",
                  operation: "read",
                  resourceSelection: "required",
                  availability,
                },
              ],
            }),
          ]),
        ).connectorCatalog,
      ).find((model) => model.providerId === "feishu-mail")!.connection.status;
    expect(ready("ready").tone).toBe("good");
    expect(ready("authorization_required").tone).toBe("pending");
    expect(ready("authorization_required").label).not.toBe(
      ready("ready").label,
    );
  });

  test("keeps an actionable authorization problem distinct from an outage", () => {
    const models = connectorDirectoryModels(
      snapshot(
        catalog([
          connection({
            connectionId: "feishu:1",
            providerId: "feishu-service",
            providerDisplayName: "飞书服务",
            status: "reauthorization_required",
            accountDisplayName: "Mochi",
            problem: "permissions_required",
          }),
          connection({
            connectionId: "github:1",
            providerId: "github",
            providerDisplayName: "GitHub",
            status: "unavailable",
            accountDisplayName: "customer",
            problem: "provider_unavailable",
          }),
        ]),
      ).connectorCatalog,
    );
    expect(
      models.find((model) => model.providerId === "feishu-service")?.connection
        .status,
    ).toEqual({
      label: "需要重新授权",
      tone: "pending",
    });
    expect(
      models.find((model) => model.providerId === "github")?.connection.status,
    ).toEqual({
      label: "暂时不可用",
      tone: "muted",
    });
  });

  test("names a mailbox grant that never finished, is waiting or is being checked", () => {
    const mail = (
      status: ConnectorConnectionProjection["status"],
      problem: string | null,
    ) =>
      connectorDirectoryModels(
        snapshot(
          catalog([
            connection({
              connectionId: "feishu-mail:unverified:cli_fixture",
              providerId: "feishu-mail",
              providerDisplayName: "飞书共享邮箱",
              status,
              accountDisplayName: null,
              problem,
            }),
          ]),
        ).connectorCatalog,
      ).find((model) => model.providerId === "feishu-mail")!;
    expect(
      mail("reauthorization_required", "mail_authorization_incomplete"),
    ).toMatchObject({
      connection: {
        identity: "尚未授权",
        status: { label: "授权未完成", tone: "pending" },
      },
      access: { summary: "重新授权后设置" },
    });
    expect(mail("authorizing", null)).toMatchObject({
      connection: { identity: "尚未授权", status: { label: "等待授权" } },
      access: { summary: "授权完成后设置" },
    });
    expect(
      mail("unavailable", "resource_reconciliation_required"),
    ).toMatchObject({
      connection: {
        identity: "正在确认",
        status: { label: "正在确认", tone: "muted" },
      },
      access: { summary: "正在确认" },
    });
    // With no mail connection at all, the card is plainly not connected.
    expect(
      connectorDirectoryModels(snapshot(catalog([])).connectorCatalog).find(
        (model) => model.providerId === "feishu-mail",
      ),
    ).toMatchObject({
      connection: { identity: "尚未连接", status: { label: "未连接" } },
      access: { summary: "连接后设置" },
    });
  });

  test("keeps a connected Feishu service distinct from an unavailable fixed scope", () => {
    const models = connectorDirectoryModels(
      snapshot(
        catalog([
          connection({
            connectionId: "feishu:1",
            providerId: "feishu-service",
            providerDisplayName: "飞书服务",
            accountDisplayName: "Mochi",
            resources: [
              {
                resourceId: "document:1",
                resourceType: "document",
                displayName: "产品说明",
                selectionId: "f".repeat(32),
                selected: true,
                ownerId: null,
                visibility: null,
                writable: null,
              },
              {
                resourceId: "wiki:2",
                resourceType: "wiki",
                displayName: "团队知识",
                selectionId: "g".repeat(32),
                selected: true,
                ownerId: null,
                visibility: null,
                writable: null,
              },
            ],
            resourceScope: {
              status: "unavailable",
              selectedCount: 2,
              problem: "provider_unavailable",
            },
            capabilities: [
              {
                id: "document.read",
                displayName: "读取云文档",
                description: "读取云文档",
                operation: "read",
                resourceSelection: "optional",
                availability: "resource_unavailable",
              },
            ],
          }),
        ]),
      ).connectorCatalog,
    );
    const feishu = models.find(
      (model) => model.providerId === "feishu-service",
    )!;
    expect(feishu.connection.status.label).toBe("已连接");
    expect(feishu.access.summary).toBe("2 项固定资料暂不可用");
    expect(feishu.access.items).toEqual([
      { id: "document:1", name: "产品说明", type: "document" },
      { id: "wiki:2", name: "团队知识", type: "wiki" },
    ]);
    expect(feishu.operations[0]?.blockedCount).toBe(1);
  });

  test("renders future providers through the same card contract", () => {
    const models = connectorDirectoryModels(
      snapshot(
        catalog([
          connection({
            connectionId: "linear:1",
            providerId: "linear",
            providerDisplayName: "Linear",
            status: "reauthorization_required",
            accountDisplayName: "team",
            problem: "expired",
          }),
          connection({
            connectionId: "gmail:1",
            providerId: "gmail",
            providerDisplayName: "Gmail",
            accountDisplayName: "工作邮箱",
            resources: [
              {
                resourceId: "mailbox:primary",
                resourceType: "mailbox",
                displayName: "主收件箱",
                selectionId: "g".repeat(32),
                selected: true,
                ownerId: null,
                visibility: null,
                writable: null,
              },
            ],
            capabilities: [
              {
                id: "mail.read",
                displayName: "读取邮件",
                description: "读取已选邮箱中的邮件。",
                operation: "read",
                resourceSelection: "required",
                availability: "ready",
              },
            ],
          }),
          connection({
            connectionId: "google-drive:1",
            providerId: "google-drive",
            providerDisplayName: "Google Drive",
            accountDisplayName: "工作账号",
            resources: [
              {
                resourceId: "folder:team",
                resourceType: "folder",
                displayName: "团队资料",
                selectionId: "d".repeat(32),
                selected: true,
                ownerId: null,
                visibility: null,
                writable: true,
              },
            ],
            capabilities: [
              {
                id: "file.read",
                displayName: "读取文件",
                description: "读取已选文件夹中的文件。",
                operation: "read",
                resourceSelection: "required",
                availability: "ready",
              },
              {
                id: "file.write",
                displayName: "更改文件",
                description: "更改已选文件夹中的文件。",
                operation: "write",
                resourceSelection: "required",
                availability: "selection_required",
              },
            ],
          }),
          connection({
            connectionId: "notion:1",
            providerId: "notion",
            providerDisplayName: "Notion",
            accountDisplayName: "工作空间",
            resources: [
              {
                resourceId: "page:roadmap",
                resourceType: "page",
                displayName: "产品路线图",
                selectionId: "n".repeat(32),
                selected: true,
                ownerId: null,
                visibility: null,
                writable: true,
              },
              {
                resourceId: "database:issues",
                resourceType: "database",
                displayName: "事项数据库",
                selectionId: "m".repeat(32),
                selected: true,
                ownerId: null,
                visibility: null,
                writable: true,
              },
            ],
            capabilities: [
              {
                id: "page.read",
                displayName: "读取页面",
                description: "读取已选页面。",
                operation: "read",
                resourceSelection: "required",
                availability: "ready",
              },
              {
                id: "database.read",
                displayName: "读取数据库",
                description: "读取已选数据库。",
                operation: "read",
                resourceSelection: "required",
                availability: "ready",
              },
            ],
          }),
        ]),
      ).connectorCatalog,
    );
    const linear = models.find((model) => model.providerId === "linear");
    expect(linear?.icon).toBe("connectors");
    expect(linear?.connection.status).toEqual({
      label: "需要重新授权",
      tone: "pending",
    });
    expect(linear?.route).toBeNull();
    expect(linear?.management).toEqual({
      available: false,
      label: "当前版本暂无本地管理页",
    });
    expect(linear?.operationEmptyLabel).toBe("连接可用后显示");

    const gmail = models.find((model) => model.providerId === "gmail");
    expect(gmail?.access.items[0]?.type).toBe("mailbox");
    expect(gmail?.operations.map((group) => group.kind)).toEqual([
      "read",
      "write",
    ]);
    expect(
      gmail?.operations.find((group) => group.kind === "write")?.available,
    ).toHaveLength(0);

    const drive = models.find((model) => model.providerId === "google-drive");
    expect(
      drive?.operations.find((group) => group.kind === "write")
        ?.selectionRequiredCount,
    ).toBe(1);
    expect(
      drive?.operations.find((group) => group.kind === "write")?.blockedCount,
    ).toBe(0);

    const notion = models.find((model) => model.providerId === "notion");
    expect(notion?.access.items.map((item) => item.type)).toEqual([
      "page",
      "database",
    ]);
  });

  test("keeps multiple accounts of one provider as separate cards", () => {
    const models = connectorDirectoryModels(
      snapshot(
        catalog([
          connection({
            connectionId: "gmail:personal",
            providerId: "gmail",
            providerDisplayName: "Gmail",
            accountDisplayName: "个人邮箱",
          }),
          connection({
            connectionId: "gmail:work",
            providerId: "gmail",
            providerDisplayName: "Gmail",
            accountDisplayName: "工作邮箱",
          }),
        ]),
      ).connectorCatalog,
    );

    expect(models.filter((model) => model.providerId === "gmail")).toHaveLength(
      2,
    );
    expect(models.map((model) => model.connection.identity)).toContain(
      "个人邮箱",
    );
    expect(models.map((model) => model.connection.identity)).toContain(
      "工作邮箱",
    );
  });
});
