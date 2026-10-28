import type { ConnectorCatalogProjection } from "../../src/control/connectorSnapshot.ts";
import type { DesktopSnapshot } from "../src/shared/model.ts";

/** One Bot's own catalogue, proven against the Bot’s own GitHub grant. */
export const connectedProjects = [
  {
    id: 20,
    ownerId: 1,
    installationId: 30,
    fullName: "customer/mochi",
    private: true,
    canWriteIssues: true,
    selected: true,
  },
] as const;

export const connectedBotId = "11111111-2222-4333-8444-555555555555";

/** The scope inventory captured from the verified Feishu Bot projection. */
export const connectedFeishuScopes = [
  "application:app_slash_command:read",
  "application:app_slash_command:write",
  "application:application:self_manage",
  "application:bot.basic_info:read",
  "application:bot.menu:write",
  "cardkit:card:read",
  "cardkit:card:write",
  "contact:contact.base:readonly",
  "contact:user.basic_profile:readonly",
  "docs:document.comment:create",
  "docs:document.comment:delete",
  "docs:document.comment:read",
  "docs:document.comment:update",
  "docs:document.comment:write_only",
  "docx:document.block:convert",
  "docx:document:readonly",
  "docx:document:write_only",
  "drive:drive.metadata:readonly",
  "im:chat.members:bot_access",
  "im:chat.members:read",
  "im:chat:create",
  "im:chat:read",
  "im:chat:update",
  "im:message.group_at_msg.include_bot:readonly",
  "im:message.group_at_msg:readonly",
  "im:message.group_msg",
  "im:message.group_msg.include_bot:read",
  "im:message.p2p_msg:readonly",
  "im:message.pins:read",
  "im:message.pins:write_only",
  "im:message.reactions:read",
  "im:message.reactions:write_only",
  "im:message:readonly",
  "im:message:recall",
  "im:message:send_as_bot",
  "im:message:send_multi_users",
  "im:message:send_sys_msg",
  "im:message:update",
  "im:resource",
  "wiki:node:read",
  "wiki:node:retrieve",
] as const;

/**
 * Feishu's connector catalog: a ready connection whose one selected document is
 * what the read capabilities are scoped to.
 */
export const connectedConnectorCatalog: ConnectorCatalogProjection = {
  revision: `sha256:${"a".repeat(64)}`,
  connections: [
    {
      connectionId: "github:1",
      providerId: "github",
      providerDisplayName: "GitHub",
      status: "ready",
      accountDisplayName: "customer",
      problem: null,
      grantedScopes: [],
      resourceScope: {
        status: "ready",
        selectedCount: connectedProjects.filter((project) => project.selected)
          .length,
      },
      resources: connectedProjects.map((project) => ({
        resourceId: `repository:${project.id}`,
        resourceType: "repository",
        displayName: project.fullName,
        selectionId: "c".repeat(32),
        selected: project.selected,
        ownerId: String(project.ownerId),
        visibility: project.private ? "private" : "public",
        writable: project.canWriteIssues,
      })),
      capabilities: [
        {
          id: "list.issues",
          displayName: "列出 Issue",
          description: "List issues from the selected repository.",
          operation: "read",
          resourceSelection: "required",
          availability: "ready",
        },
        {
          id: "manage.issue",
          displayName: "管理 Issue",
          description: "按当前授权管理 Issue。",
          operation: "write",
          resourceSelection: "required",
          availability: "ready",
        },
      ],
    },
    {
      connectionId: "feishu:app_fixture",
      providerId: "feishu-service",
      providerDisplayName: "飞书服务",
      status: "ready",
      accountDisplayName: "Mochi",
      problem: null,
      grantedScopes: connectedFeishuScopes,
      resourceScope: { status: "ready", selectedCount: 1 },
      resources: [
        {
          resourceId: "document:AAA111",
          resourceType: "document",
          displayName: "产品说明",
          selectionId: "b".repeat(32),
          selected: true,
          ownerId: "1",
          visibility: "public",
          writable: true,
        },
      ],
      capabilities: [
        {
          id: "document.read",
          displayName: "读取云文档",
          description: "读取一个已固定到 Bot 的飞书云文档正文。",
          operation: "read",
          resourceSelection: "optional",
          availability: "ready",
        },
        {
          id: "wiki.read",
          displayName: "读取知识库文档",
          description: "读取一个已固定到 Bot 的飞书知识库节点正文。",
          operation: "read",
          resourceSelection: "optional",
          availability: "selection_required",
        },
      ],
    },
  ],
};

/**
 * The same deployment with GitHub authorized but nothing selected yet.
 *
 * It is derived rather than declared so a test cannot describe a state the
 * catalog could not actually produce: only the GitHub connection's resources
 * differ from the connected fixture.
 */
export function withNoSelectedProjects(
  catalog: ConnectorCatalogProjection | null,
): ConnectorCatalogProjection | null {
  if (catalog === null) return null;
  return {
    revision: catalog.revision,
    connections: catalog.connections.map((connection) =>
      connection.providerId === "github"
        ? {
            ...connection,
            resources: connection.resources.map((resource) => ({
              ...resource,
              selected: false,
              selectionId: null,
            })),
            capabilities: connection.capabilities.map((capability) => ({
              ...capability,
              availability: "selection_required" as const,
            })),
          }
        : connection,
    ),
  };
}

/**
 * A Bot whose catalog carries both connectors. Every GitHub-shaped view the
 * desktop shows is derived from this catalog, so the fixture declares the
 * catalog and nothing else.
 */
export const connectedFacts: Pick<
  DesktopSnapshot,
  "feishu" | "bots" | "selectedBotId" | "connectorCatalog"
> = {
  feishu: {
    active: {
      brand: "feishu" as const,
      state: "ready",
      bot: { name: "Mochi", avatarUrl: null },
    },
    candidate: null,
  },

  bots: [
    {
      botId: connectedBotId,
      label: "麻薯",
      characterId: "mochi",
      groupCount: 1,
      projectCount: 1,
      enabled: true,
      lifecycle: "listening",
      phase: "listening",
      problemCode: null,
    },
  ],
  selectedBotId: connectedBotId,
  connectorCatalog: connectedConnectorCatalog,
};

/**
 * The same catalog with exactly these GitHub repositories selected.
 *
 * It models the one thing a selection change changes, so a test proves the
 * desktop reads selection through the catalog rather than a second field.
 */
export function withSelectedProjects(
  catalog: ConnectorCatalogProjection | null,
  repositoryIds: readonly number[],
): ConnectorCatalogProjection | null {
  if (catalog === null) return null;
  return {
    revision: catalog.revision,
    connections: catalog.connections.map((connection) =>
      connection.providerId === "github"
        ? {
            ...connection,
            resources: connection.resources.map((resource) => {
              const selected = repositoryIds.includes(
                Number(resource.resourceId.split(":")[1]),
              );
              return {
                ...resource,
                selected,
                selectionId: selected
                  ? (resource.selectionId ?? "c".repeat(32))
                  : null,
              };
            }),
            capabilities: connection.capabilities.map((capability) => ({
              ...capability,
              availability:
                repositoryIds.length === 0
                  ? "selection_required"
                  : capability.operation === "write" &&
                      !connection.resources.some(
                        (resource) =>
                          repositoryIds.includes(
                            Number(resource.resourceId.split(":")[1]),
                          ) && resource.writable === true,
                      )
                    ? "read_only"
                    : "ready",
            })),
          }
        : connection,
    ),
  };
}

/**
 * A catalog holding one GitHub connection over these repositories.
 *
 * Tests describe the repositories they care about rather than a GitHub-specific
 * list, so every screen under test reads the same single source of truth.
 */
export function catalogWithRepositories(
  repositories: readonly {
    number: number;
    fullName: string;
    selected: boolean;
    ownerId?: number;
  }[],
  connection: {
    status: "connected" | "authorizing" | "unavailable" | "disconnected";
    login: string | null;
    problem?: string | null;
  } = { status: "connected", login: "customer" },
): ConnectorCatalogProjection {
  const status: ConnectorCatalogProjection["connections"][number]["status"] =
    connection.status === "connected"
      ? "ready"
      : connection.status === "authorizing"
        ? "authorizing"
        : connection.status === "unavailable"
          ? "unavailable"
          : "reauthorization_required";
  if (connection.status === "disconnected") {
    return { revision: `sha256:${"d".repeat(64)}`, connections: [] };
  }
  return {
    revision: `sha256:${"d".repeat(64)}`,
    connections: [
      {
        // The account identity the ConnectionId encodes; a test that changes
        // the account must change the connection, exactly as production does.
        connectionId: `github:${connection.login === "customer" ? 1 : connection.login ? 2 : 0}`,
        providerId: "github",
        providerDisplayName: "GitHub",
        status,
        accountDisplayName: connection.login,
        problem: connection.problem ?? null,
        grantedScopes: [],
        resourceScope: {
          status: status === "ready" ? "ready" : "unavailable",
          selectedCount: repositories.filter(
            (repository) => repository.selected,
          ).length,
          ...(status === "ready" ? {} : { problem: "connection_unavailable" }),
        },
        // Every authorized repository is listed; `selected` says which are chosen,
        // because a settings screen must offer the rest.
        resources: repositories.map((repository) => ({
          resourceId: `repository:${repository.number}`,
          resourceType: "repository",
          displayName: repository.fullName,
          selectionId: repository.selected ? "e".repeat(32) : null,
          selected: repository.selected,
          ownerId: String(repository.ownerId ?? 1),
          visibility: "public",
          writable: true,
        })),
        capabilities:
          connectedConnectorCatalog.connections[0]!.capabilities.map(
            (capability) => ({
              ...capability,
              availability:
                status !== "ready"
                  ? "connection_unavailable"
                  : repositories.some((resource) => resource.selected)
                    ? "ready"
                    : "selection_required",
            }),
          ),
      },
    ],
  };
}

/**
 * Folds GitHub-shaped facts a test describes into an existing catalog.
 *
 * Only the GitHub connection is replaced; every other connection survives, so a
 * test that changes GitHub's state cannot silently drop another provider.
 */
export function withGithubFacts(
  catalog: ConnectorCatalogProjection | null,
  connection: {
    status: "connected" | "authorizing" | "unavailable" | "disconnected";
    login: string | null;
    problem?: string | null;
  },
  repositories: readonly {
    number: number;
    fullName: string;
    selected: boolean;
  }[],
): ConnectorCatalogProjection {
  const built = catalogWithRepositories(repositories, connection);
  const github = built.connections[0];
  const others = (catalog?.connections ?? []).filter(
    (entry) => entry.providerId !== "github",
  );
  return {
    revision: catalog?.revision ?? built.revision,
    connections: github ? [github, ...others] : others,
  };
}

/**
 * The facts a test may publish into the desktop fixture.
 *
 * It is the desktop's own snapshot plus the GitHub-shaped shorthand tests use to
 * describe a connection. The fixture folds that shorthand into the single
 * connector catalog, so no test can publish a second source of GitHub facts.
 */
export interface DesktopFactPatch extends Partial<DesktopSnapshot> {
  github?: {
    status?: "connected" | "authorizing" | "unavailable" | "disconnected";
    account?: { id?: number; login: string } | null;
    problem?: string | null;
  };
  githubProjects?:
    | readonly {
        id: number;
        fullName: string;
        selected: boolean;
        /** The owner's identity, which the fixture carries into the catalog. */
        ownerId?: number;
      }[]
    | null;
}

/**
 * The Feishu shared mailbox connection in each state the Bridge publishes.
 * A Bot that never granted mail access publishes no mail connection at all.
 */
export function feishuMailConnection(
  state:
    | "checking"
    | "authorizing"
    | "incomplete"
    | "partial"
    | "ready"
    | "selected",
): ConnectorCatalogProjection["connections"][number] {
  const capabilities = (
    availability:
      | "ready"
      | "selection_required"
      | "authorization_required"
      | "connection_unavailable",
  ) => [
    {
      id: "thread.list",
      displayName: "列出邮件会话",
      description: "读取已选择邮箱中的会话摘要。",
      operation: "read" as const,
      resourceSelection: "required" as const,
      availability,
    },
    {
      id: "thread.read",
      displayName: "读取邮件会话",
      description: "读取已选择邮箱中的会话。",
      operation: "read" as const,
      resourceSelection: "required" as const,
      availability,
    },
  ];
  const proved = {
    connectionId: "feishu-mail:ou_fixture_user",
    providerId: "feishu-mail",
    providerDisplayName: "飞书共享邮箱",
    accountDisplayName: "林小满",
    problem: null,
    grantedScopes: [
      "mail:user_mailbox:readonly",
      "mail:user_mailbox.message:readonly",
      "mail:user_mailbox.message.address:read",
      "mail:user_mailbox.message.subject:read",
      "mail:user_mailbox.message.body:read",
    ],
  };
  const option = (address: string, selected: boolean) => ({
    resourceId: `mailbox:${address === "support@example.com" ? "a".repeat(32) : "b".repeat(32)}`,
    resourceType: "mailbox",
    displayName: address,
    selectionId: selected ? "c".repeat(32) : null,
    selected,
    ownerId: null,
    visibility: null,
    writable: null,
  });
  switch (state) {
    case "authorizing":
      return {
        ...proved,
        connectionId: "feishu-mail:unverified:cli_fixture",
        status: "authorizing",
        accountDisplayName: null,
        grantedScopes: [],
        resourceScope: { status: "ready", selectedCount: 0 },
        resources: [],
        capabilities: capabilities("connection_unavailable"),
      };
    case "checking":
      return {
        ...proved,
        connectionId: "feishu-mail:unverified:cli_fixture",
        status: "unavailable",
        accountDisplayName: null,
        problem: "resource_reconciliation_required",
        grantedScopes: [],
        resourceScope: { status: "ready", selectedCount: 0 },
        resources: [],
        capabilities: capabilities("connection_unavailable"),
      };
    case "incomplete":
      return {
        ...proved,
        connectionId: "feishu-mail:unverified:cli_fixture",
        status: "reauthorization_required",
        accountDisplayName: null,
        problem: "mail_authorization_incomplete",
        grantedScopes: [],
        resourceScope: { status: "ready", selectedCount: 0 },
        resources: [],
        capabilities: capabilities("connection_unavailable"),
      };
    case "partial":
      return {
        ...proved,
        status: "ready",
        grantedScopes: ["mail:user_mailbox:readonly"],
        resourceScope: { status: "ready", selectedCount: 0 },
        resources: [option("support@example.com", false)],
        capabilities: capabilities("authorization_required"),
      };
    case "ready":
      return {
        ...proved,
        status: "ready",
        resourceScope: { status: "ready", selectedCount: 0 },
        resources: [
          option("support@example.com", false),
          option("billing@example.com", false),
        ],
        capabilities: capabilities("selection_required"),
      };
    case "selected":
      return {
        ...proved,
        status: "ready",
        resourceScope: { status: "ready", selectedCount: 1 },
        resources: [
          option("support@example.com", true),
          option("billing@example.com", false),
        ],
        capabilities: capabilities("ready"),
      };
  }
}
