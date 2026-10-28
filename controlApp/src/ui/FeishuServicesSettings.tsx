import { useState } from "react";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import type { DesktopProblem } from "../shared/problem.ts";
import { companionName, zh } from "../shared/vocabulary.ts";
import {
  ConnectorDetailPage,
  ConnectorManagement,
  ConnectorOperations,
  ConnectorSection,
  useConnectorEditorFocus,
} from "./ConnectorDetailPage.tsx";
import { Button, StatusMark } from "./Controls.tsx";
import { authorizationMethodLabel } from "./connectorAuthorization.ts";
import {
  connectorAuthorizationFor,
  connectorState,
  connectorStatusOf,
} from "./connectorDirectory.ts";
import { FeishuAuthorizationSummary } from "./FeishuAuthorizationSummary.tsx";
import { feishuPresentation } from "./FeishuConnection.tsx";
import { Glyph } from "./Glyph.tsx";
import { SettingsIcon } from "./SettingsIcon.tsx";
import { SettingsList, SettingsRow } from "./SettingsList.tsx";
import { inlineError } from "./styles.ts";

/** Scope mutations are verified individually; drafts never imply access. */
export function FeishuServicesSettings({
  snapshot,
  perform,
  shownProblem,
  openConnection,
  draft,
  change,
  onBusyChange,
}: {
  snapshot: DesktopSnapshot;
  perform(action: DesktopAction): Promise<boolean>;
  shownProblem: DesktopProblem | null;
  openConnection(): void;
  draft: string;
  change(value: string): void;
  onBusyChange(busy: boolean): void;
}) {
  const connection = snapshot.connectorCatalog?.connections.find(
    (candidate) => candidate.providerId === "feishu-service",
  );
  const state = connectorState(connection, snapshot.connectorCatalog !== null);
  const connected = state === "ready";
  const status = connectorStatusOf(
    connection,
    snapshot.connectorCatalog !== null,
  );
  const hasConnection = connection !== undefined;
  const resourceScope = connection?.resourceScope ?? {
    // No connection means there is no resource proof to present as ready.
    status: "unavailable" as const,
    selectedCount: 0,
  };
  const fixedCount = resourceScope.selectedCount;
  const fixedScopeReady = resourceScope.status === "ready";
  const resources = (connection?.resources ?? []).filter(
    (resource) => resource.selected,
  );
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const { input, entry: addButton, requestFocus } = useConnectorEditorFocus();
  const editorOpen = editing || draft.length > 0;
  const idle =
    snapshot.setup !== "initializing" &&
    !["working", "organizingContext"].includes(snapshot.phase) &&
    (snapshot.queueDepth ?? 0) === 0;
  const pendingAction = snapshot.busy !== null || pending !== null;
  // Removing a saved range is a local operation and remains available while
  // the provider is unavailable. Adding or rechecking content still needs a
  // live connection and a proven current scope.
  const localScopeActionDisabled =
    !hasConnection || !snapshot.controlReady || pendingAction || !idle;
  const addDisabled =
    localScopeActionDisabled || !connected || !fixedScopeReady;
  const connectionView = feishuPresentation(snapshot);
  const name = companionName(snapshot);

  async function addResource() {
    if (!connection || addDisabled || !draft.trim()) return;
    setPending("add");
    setFailedAt(null);
    setFeedback(null);
    onBusyChange(true);
    try {
      if (
        await perform({
          type: "addConnectorResources",
          connectionId: connection.connectionId,
          references: [draft.trim()],
        })
      ) {
        requestFocus("entry");
        change("");
        setEditing(false);
        setFeedback(zh`已固定。之后的消息里，${name}也会参考这份资料。`);
      } else setFailedAt("add");
    } finally {
      setPending(null);
      onBusyChange(false);
    }
  }
  async function removeResource(resource: (typeof resources)[number]) {
    if (
      !connection ||
      localScopeActionDisabled ||
      resource.selectionId === null
    )
      return;
    setPending(resource.resourceId);
    setFailedAt(null);
    setFeedback(null);
    onBusyChange(true);
    try {
      if (
        await perform({
          type: "removeConnectorResource",
          connectionId: connection.connectionId,
          resourceId: resource.resourceId,
          selectionId: resource.selectionId,
        })
      ) {
        setFeedback("已取消固定，原文保留。");
        requestFocus(resources.length === 1 && editorOpen ? "input" : "entry");
      } else setFailedAt(resource.resourceId);
    } finally {
      setPending(null);
      onBusyChange(false);
    }
  }
  const error = shownProblem && (
    <p className={inlineError} role="alert">
      {shownProblem.message}
    </p>
  );
  return (
    <ConnectorDetailPage
      label="文档与知识库"
      icon="feishu"
      description="团队文档与知识库"
      identity={
        connection?.accountDisplayName ??
        snapshot.feishu.active?.bot?.name ??
        (state === "unknown" ? "群聊机器人暂未确认" : "尚未连接群聊机器人")
      }
      status={status}
      context="沿用群聊机器人的连接"
      recovery={
        (!connected || (failedAt === null && error)) && (
          <>
            {!connected && (
              <>
                <p className="text-xs leading-relaxed text-muted">
                  {connection?.status === "unavailable" &&
                  snapshot.feishu.active?.state === "ready"
                    ? "群聊机器人已连接，固定的资料暂时无法确认。Mochi 会自动重试。"
                    : snapshot.connectorCatalog === null
                      ? "暂时无法确认服务连接。Mochi 会自动重试，确认后可以继续管理内容。"
                      : connectionView.detail}
                </p>
                <Button disabled={pendingAction} onClick={openConnection}>
                  {snapshot.feishu.active || snapshot.feishu.candidate
                    ? "查看群聊连接"
                    : "连接群聊机器人"}
                </Button>
              </>
            )}
            {failedAt === null && error}
          </>
        )
      }
    >
      <ConnectorSection
        id="feishu-access"
        title="访问范围"
        description={
          connected
            ? resourceScope.status === "checking" && fixedCount > 0
              ? `正在确认 ${fixedCount} 份固定的资料`
              : resourceScope.status === "unavailable" && fixedCount > 0
                ? `${fixedCount} 份固定的资料暂时读不到；群里临时发的链接仍会在那条消息里读取`
                : resources.length > 0
                  ? zh`这 ${String(resources.length)} 份资料${name}会一直参考；群里临时发的链接，只在那条消息里读取`
                  : "群里发的文档链接，会在那条消息里读取；想让它一直参考某份资料，再固定下来"
            : state === "unavailable" && resources.length > 0
              ? zh`${String(resources.length)} 份固定的资料仍保留在${name}这里，连接恢复后继续参考`
              : "连接恢复后，可以继续管理内容。"
        }
        aside={
          connected && fixedScopeReady && !editorOpen ? (
            <Button
              ref={addButton}
              size="small"
              disabled={pendingAction}
              onClick={() => {
                requestFocus("input");
                setEditing(true);
                setFeedback(null);
              }}
            >
              固定资料
            </Button>
          ) : null
        }
      >
        {hasConnection && fixedCount > 0 && !fixedScopeReady && !editorOpen && (
          <ScopeStatement
            state="unavailable"
            tone="pending"
            title={
              resourceScope.status === "checking"
                ? "正在确认固定资料"
                : "固定资料暂时无法确认"
            }
          >
            {connected
              ? "群聊机器人仍然连接着，Mochi 会自动重试；确认之前不会参考这些资料，群里临时发的链接不受影响。"
              : zh`连接暂时不可用；固定的资料仍保留在${name}这里，连接恢复并确认后继续参考。`}
          </ScopeStatement>
        )}
        {connected && fixedCount === 0 && !editorOpen && (
          <ScopeStatement tone="good" title="可以读取云文档">
            {zh`群里分享的文档和知识库链接，会在那条消息里读取，不用逐份授权。想让${name}一直参考某份资料，再把它固定下来。`}
          </ScopeStatement>
        )}
        {resources.length > 0 && (
          <SettingsList label="已固定资料" scroll>
            {resources.map((resource) => (
              <SettingsRow
                key={resource.resourceId}
                leading={
                  <span
                    aria-hidden
                    className="flex size-10 shrink-0 items-center justify-center rounded-md bg-field text-muted ring-1 ring-hairline ring-inset"
                  >
                    <Glyph
                      name={
                        resource.resourceType === "wiki" ? "book" : "document"
                      }
                      size={20}
                    />
                  </span>
                }
                title={<span dir="auto">{resource.displayName}</span>}
                detail={`${resource.resourceType === "wiki" ? "知识库节点" : "云文档"} · ${
                  state !== "ready"
                    ? "连接暂不可用 · 已固定"
                    : fixedScopeReady
                      ? "已验证可读 · 已固定"
                      : resourceScope.status === "checking"
                        ? "已固定 · 正在复核"
                        : "已固定 · 暂不可用"
                } · 只读`}
                trailing={
                  <Button
                    variant="icon"
                    className="size-8"
                    aria-label={`移除 ${resource.displayName}`}
                    disabled={localScopeActionDisabled}
                    onClick={() => void removeResource(resource)}
                  >
                    {pending === resource.resourceId ? (
                      <Glyph name="spinner" size={14} spin />
                    ) : (
                      <Glyph name="close" size={14} />
                    )}
                  </Button>
                }
                feedback={failedAt === resource.resourceId && error}
              />
            ))}
          </SettingsList>
        )}
        {editorOpen && (
          <form
            data-settings-primary
            className="settings-card space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void addResource();
            }}
          >
            <div>
              <h3 className="text-sm font-semibold">固定一份资料</h3>
              <p className="mt-1 text-xs leading-5 text-muted">
                {zh`粘贴一个已分享的链接。Mochi 会先确认能读到，再让${name}一直参考它。`}
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 basis-[220px] flex-1">
                <span className="sr-only">文档或知识库链接</span>
                <input
                  ref={input}
                  type="url"
                  inputMode="url"
                  maxLength={2048}
                  value={draft}
                  onChange={(event) => {
                    change(event.target.value);
                    setFeedback(null);
                  }}
                  aria-describedby="feishu-reference-help"
                  placeholder="粘贴已分享的文档或知识库链接"
                  disabled={pendingAction}
                  className="field-focus h-9 w-full rounded-md border border-field-border bg-field px-3 text-sm disabled:opacity-40"
                />
              </label>
              <Button
                type="submit"
                variant="primary"
                disabled={addDisabled || !draft.trim()}
              >
                {pending === "add" && <Glyph name="spinner" size={14} spin />}
                {pending === "add" ? "正在确认…" : "确认固定"}
              </Button>
              {(resources.length > 0 || draft.length > 0) && (
                <Button
                  variant="text"
                  className="m-0"
                  disabled={pendingAction}
                  onClick={() => {
                    requestFocus(resources.length === 0 ? "input" : "entry");
                    change("");
                    setEditing(false);
                  }}
                >
                  {draft.length > 0 ? "放弃输入" : "取消"}
                </Button>
              )}
            </div>
            <p
              id="feishu-reference-help"
              className="text-xs leading-5 text-muted"
            >
              只确认群聊机器人能否读到，不会改动原文。
            </p>
            {failedAt === "add" && error}
            {!idle && (
              <p role="status" className="text-xs text-muted">
                可以先粘贴链接，当前工作完成后再固定。
              </p>
            )}
          </form>
        )}
        {feedback && !shownProblem && (
          <p role="status" className="text-xs text-status-good">
            {feedback}
          </p>
        )}
        {resources.length > 0 && !connected && (
          <p className="text-xs leading-5 text-muted">
            连接恢复前不会参考固定的资料；可以随时取消固定。
          </p>
        )}
        <ConnectorOperations
          connection={connection}
          selectionCopy={{
            preview: "临时发的资料在那条消息里读取；固定的资料会一直参考",
            optional: "可选固定资料",
          }}
        />
      </ConnectorSection>
      <ConnectorManagement defaultOpen>
        <div className="space-y-4">
          <FeishuAuthorizationSummary
            grantedScopes={connection?.grantedScopes ?? []}
            selectedResourceCount={fixedCount}
            connectionState={state}
            resourceScopeStatus={resourceScope.status}
          />
          <div className="space-y-3">
            <SettingsList>
              <SettingsRow
                leading={<SettingsIcon name="groups" size={36} />}
                title={
                  <span className="flex flex-wrap items-center gap-x-3">
                    群聊机器人
                    <StatusMark tone={status.tone}>{status.label}</StatusMark>
                  </span>
                }
                detail={
                  snapshot.feishu.active?.bot?.name ??
                  "连接后，群聊和文档会一起可用。"
                }
              />
            </SettingsList>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                size="small"
                onClick={openConnection}
                disabled={pendingAction}
              >
                管理群聊机器人
                <Glyph name="chevronRight" size={12} />
              </Button>
              <Button
                variant="text"
                size="small"
                className="m-0 px-1 text-ink"
                onClick={() => void perform({ type: "feishuSettings" })}
                disabled={pendingAction || !snapshot.controlReady}
              >
                打开应用设置
                <Glyph name="external" size={12} />
              </Button>
            </div>
          </div>
          <div className="space-y-2 border-t border-hairline pt-3">
            <p>
              {authorizationMethodLabel(
                connectorAuthorizationFor("feishu-service"),
              )}
              ，不需要为文档另外登录。每份资料能否读到，看它分享给了谁。
            </p>
            <p>目前能读云文档和知识库，还不能读多维表格，也不会修改文档。</p>
            <p>
              取消固定不会改动原文。断开群聊机器人后，群聊和文档会一起停用，已有对话保留。
            </p>
          </div>
        </div>
      </ConnectorManagement>
    </ConnectorDetailPage>
  );
}

/** A fact about the whole access scope: its state leads, one sentence follows. */
function ScopeStatement({
  tone,
  title,
  state,
  children,
}: {
  tone: "good" | "pending";
  title: string;
  state?: string;
  children: string;
}) {
  return (
    <div data-feishu-resource-state={state ?? ""} className="max-w-[42em]">
      <p className="flex items-center gap-2 text-sm leading-5 font-medium">
        <span
          aria-hidden
          className={
            tone === "good"
              ? "size-1.5 rounded-full bg-status-good"
              : "size-1.5 rounded-full bg-status-attention"
          }
        />
        {title}
      </p>
      <p className="mt-1 pl-3.5 text-xs leading-5 text-muted">{children}</p>
    </div>
  );
}
