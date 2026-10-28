import type {
  ConnectorCatalogProjection,
  ConnectorConnectionProjection,
} from "../../../src/control/connectorSnapshot.ts";
import type { SettingsRoute } from "../shared/settings.ts";
import type { ConnectorAuthorizationDefinition } from "./connectorAuthorization.ts";
import type { SettingsIconName } from "./SettingsIcon.tsx";

export type ConnectionState =
  | ConnectorConnectionProjection["status"]
  | "missing"
  | "unknown";
type Capability = ConnectorConnectionProjection["capabilities"][number];

/** Presentation data contains identity and navigation, never access policy. */
interface ProviderPresentation {
  readonly title: string;
  /** The product's core needs it: a missing connection asks for attention. */
  readonly required: boolean;
  readonly description: string;
  readonly icon: SettingsIconName;
  readonly route: SettingsRoute;
  readonly connectionRoute?: SettingsRoute;
  readonly authorization: ConnectorAuthorizationDefinition;
  readonly resourceCopy: {
    readonly selected: string;
    readonly empty: string;
    readonly optional: string;
    readonly operationEmpty: string;
  };
}
const PROVIDERS: Readonly<Record<string, ProviderPresentation>> = {
  github: {
    title: "GitHub",
    required: true,
    description: "团队共享上下文",
    icon: "github",
    route: { page: "projects" },
    authorization: {
      acquisition: { kind: "interactive", interaction: "redirect" },
      principal: "user_and_application",
      resources: ["provider_selection", "catalog_selection"],
      administratorApproval: "possible",
    },
    resourceCopy: {
      selected: "已选择",
      empty: "尚未设置",
      optional: "可选范围",
      operationEmpty: "设置项目范围后显示",
    },
  },
  "feishu-service": {
    title: "文档与知识库",
    required: true,
    description: "文档与知识库",
    icon: "feishu",
    route: { page: "feishuServices" },
    connectionRoute: { page: "feishu" },
    authorization: {
      acquisition: { kind: "inherited", source: "群聊机器人" },
      principal: "application",
      resources: ["message_context", "explicit_reference", "catalog_selection"],
      administratorApproval: "possible",
    },
    resourceCopy: {
      selected: "已固定",
      empty: "按消息尝试读取，可选固定资料",
      optional: "可选固定",
      operationEmpty: "服务已授权；当前消息会尝试读取，固定资料为可选",
    },
  },
  "feishu-mail": {
    title: "共享邮箱",
    required: false,
    description: "团队共同处理的收件箱",
    icon: "feishu",
    route: { page: "feishuMail" },
    authorization: {
      acquisition: { kind: "interactive", interaction: "qr" },
      principal: "user",
      resources: ["account_scope", "catalog_selection"],
      administratorApproval: "possible",
    },
    resourceCopy: {
      selected: "已选择",
      empty: "尚未选择共享邮箱",
      optional: "可选范围",
      operationEmpty: "选择共享邮箱后显示",
    },
  },
};

export function connectorAuthorizationFor(
  providerId: "github" | "feishu-service" | "feishu-mail",
): ConnectorAuthorizationDefinition {
  return PROVIDERS[providerId]!.authorization;
}
const STATUS: Record<
  ConnectionState,
  { label: string; tone: "good" | "pending" | "muted" }
> = {
  ready: { label: "已连接", tone: "good" },
  authorizing: { label: "等待授权", tone: "pending" },
  reauthorization_required: { label: "需要重新授权", tone: "pending" },
  unavailable: { label: "暂时不可用", tone: "muted" },
  missing: { label: "未连接", tone: "muted" },
  unknown: { label: "无法确认", tone: "muted" },
};

/**
 * A provider's closed problem code can name the state more precisely than the
 * lifecycle alone: a first grant that never finished is not a lapsed one, and
 * a connection still being checked is not broken.
 */
const GRANT_INCOMPLETE = { label: "授权未完成", tone: "pending" } as const;
const PROBLEM_STATUS: Readonly<
  Record<string, { label: string; tone: "good" | "pending" | "muted" }>
> = {
  mail_authorization_incomplete: GRANT_INCOMPLETE,
  resource_reconciliation_required: { label: "正在确认", tone: "muted" },
};

export type ConnectorStatus = (typeof STATUS)[ConnectionState];

function connectorStatus(
  state: ConnectionState,
  problem: string | null = null,
): ConnectorStatus {
  return (
    (problem !== null && state !== "ready" && PROBLEM_STATUS[problem]) ||
    STATUS[state]
  );
}

/**
 * The one status a connection shows. A connection that is up but lacks part
 * of its grant is not "connected": green only ever means it can do its work.
 */
export function connectorStatusOf(
  connection: ConnectorConnectionProjection | undefined,
  catalogAvailable: boolean,
  providerId = connection?.providerId,
): ConnectorStatus {
  const state = connectorState(connection, catalogAvailable);
  if (
    state === "ready" &&
    connection?.capabilities.some(
      (capability) => capability.availability === "authorization_required",
    )
  )
    return GRANT_INCOMPLETE;
  if (
    state === "missing" &&
    providerId !== undefined &&
    PROVIDERS[providerId]?.required
  )
    return { label: STATUS.missing.label, tone: "pending" };
  return connectorStatus(state, connection?.problem ?? null);
}

export function connectorState(
  connection: ConnectorConnectionProjection | undefined,
  catalogAvailable: boolean,
): ConnectionState {
  return connection?.status ?? (catalogAvailable ? "missing" : "unknown");
}

/** Identity, access scope and operations are independent, provider-neutral facts. */
export interface ConnectorDirectoryModel {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly description: string;
  readonly icon: SettingsIconName;
  readonly connection: {
    readonly state: ConnectionState;
    readonly identity: string;
    readonly status: ConnectorStatus;
  };
  readonly access: {
    readonly summary: string;
    readonly items: readonly { id: string; name: string; type: string }[];
    readonly remainingCount: number;
  };
  readonly operations: readonly {
    readonly kind: "read" | "write";
    readonly available: readonly Capability[];
    /** Capabilities implemented and granted, but waiting for a selected resource. */
    readonly selectionRequiredCount: number;
    /** Optional durable scope is absent, while another bounded context path remains. */
    readonly selectionOptionalCount: number;
    /** Capabilities blocked for a reason other than selecting a resource. */
    readonly blockedCount: number;
  }[];
  readonly operationEmptyLabel: string;
  readonly selectionOptionalLabel: string;
  readonly management: {
    readonly available: boolean;
    readonly label: string;
  };
  readonly route: SettingsRoute | null;
}

/** One card per connection, including multiple identities of the same provider. */
export function connectorDirectoryModels(
  catalog: ConnectorCatalogProjection | null,
): ConnectorDirectoryModel[] {
  const connections = catalog?.connections ?? [];
  const builtinCards = Object.entries(PROVIDERS).flatMap(
    ([providerId, presentation]) => {
      const matching = connections.filter(
        (connection) => connection.providerId === providerId,
      );
      return matching.length > 0
        ? matching.map((connection) =>
            modelFor(connection, providerId, presentation, catalog !== null),
          )
        : [modelFor(undefined, providerId, presentation, catalog !== null)];
    },
  );
  return [
    ...builtinCards,
    ...connections
      .filter((connection) => !Object.hasOwn(PROVIDERS, connection.providerId))
      .map((connection) =>
        modelFor(connection, connection.providerId, undefined, true),
      ),
  ];
}

function modelFor(
  connection: ConnectorConnectionProjection | undefined,
  providerId: string,
  presentation: ProviderPresentation | undefined,
  catalogAvailable: boolean,
): ConnectorDirectoryModel {
  const state = connectorState(connection, catalogAvailable);
  const checking =
    state === "unavailable" &&
    connection?.problem === "resource_reconciliation_required";
  const resourceScope = connection?.resourceScope ?? {
    // A missing connection has no proven resource scope. Keep that fact
    // distinct from an empty, ready scope so the catalog cannot imply access.
    status: "unavailable" as const,
    selectedCount: 0,
  };
  // A saved range remains part of the connection's durable facts even while
  // the connection is unavailable. It is shown as saved, never as callable;
  // capability availability below carries that distinction.
  const selected = (connection?.resources ?? []).filter(
    (resource) => resource.selected,
  );
  const operations = (["read", "write"] as const).map((kind) => {
    const capabilities = (connection?.capabilities ?? []).filter(
      (capability) => capability.operation === kind,
    );
    const available = capabilities.filter(
      (capability) => state === "ready" && capability.availability === "ready",
    );
    const selectionRequiredCount = capabilities.filter(
      (capability) =>
        state === "ready" &&
        capability.availability === "selection_required" &&
        capability.resourceSelection === "required",
    ).length;
    const selectionOptionalCount = capabilities.filter(
      (capability) =>
        state === "ready" &&
        capability.availability === "selection_required" &&
        capability.resourceSelection === "optional",
    ).length;
    return {
      kind,
      available,
      selectionRequiredCount,
      selectionOptionalCount,
      blockedCount:
        capabilities.length -
        available.length -
        selectionRequiredCount -
        selectionOptionalCount,
    };
  });
  return {
    id: connection?.connectionId ?? `missing:${providerId}`,
    providerId,
    title: presentation?.title ?? connection?.providerDisplayName ?? providerId,
    description: presentation?.description ?? "外部服务",
    icon: presentation?.icon ?? "connectors",
    connection: {
      state,
      identity:
        connection?.accountDisplayName ??
        (state === "unknown"
          ? "尚未确认"
          : state === "missing"
            ? "尚未连接"
            : checking
              ? "正在确认"
              : state === "authorizing" || state === "reauthorization_required"
                ? "尚未授权"
                : "未提供身份名称"),
      status: connectorStatusOf(connection, catalogAvailable, providerId),
    },
    access: {
      summary:
        state === "ready"
          ? resourceScope.status === "checking" &&
            resourceScope.selectedCount > 0
            ? `正在确认 ${resourceScope.selectedCount} 项固定资料`
            : resourceScope.status === "unavailable" &&
                resourceScope.selectedCount > 0
              ? `${resourceScope.selectedCount} 项固定资料暂不可用`
              : selected.length > 0
                ? `${selected.length} 项${presentation?.resourceCopy.selected ?? "已选择"}`
                : (presentation?.resourceCopy.empty ?? "尚未设置")
          : state === "missing"
            ? "连接后设置"
            : selected.length > 0
              ? `${selected.length} 项范围已保存 · ${connectorStatus(state).label}`
              : checking
                ? "正在确认"
                : state === "authorizing"
                  ? "授权完成后设置"
                  : state === "reauthorization_required"
                    ? "重新授权后设置"
                    : "暂时无法确认",
      items: selected.slice(0, 3).map((resource) => ({
        id: resource.resourceId,
        name: resource.displayName,
        type: resource.resourceType,
      })),
      remainingCount: Math.max(0, selected.length - 3),
    },
    operations,
    operationEmptyLabel:
      state !== "ready"
        ? "连接可用后显示"
        : resourceScope.status === "checking" && resourceScope.selectedCount > 0
          ? "固定资料正在确认"
          : resourceScope.status === "unavailable" &&
              resourceScope.selectedCount > 0
            ? "固定资料暂不可用"
            : selected.length === 0
              ? (presentation?.resourceCopy.operationEmpty ??
                "设置访问范围后显示")
              : "暂无可用操作",
    selectionOptionalLabel: presentation?.resourceCopy.optional ?? "可选范围",
    management: presentation
      ? {
          available: true,
          label:
            state === "missing" ? `连接 ${presentation.title}` : "管理连接",
        }
      : { available: false, label: "当前版本暂无本地管理页" },
    route: presentation
      ? state === "ready"
        ? presentation.route
        : (presentation.connectionRoute ?? presentation.route)
      : null,
  };
}
