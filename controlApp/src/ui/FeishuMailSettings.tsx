import { type ReactNode, useState } from "react";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import type { DesktopProblem } from "../shared/problem.ts";
import { chatServiceName, zh } from "../shared/vocabulary.ts";
import {
  ConnectorDetailPage,
  ConnectorManagement,
  ConnectorOperations,
  ConnectorSection,
} from "./ConnectorDetailPage.tsx";
import { Button, Toggle } from "./Controls.tsx";
import { authorizationMethodLabel } from "./connectorAuthorization.ts";
import {
  connectorAuthorizationFor,
  connectorState,
  connectorStatusOf,
} from "./connectorDirectory.ts";
import { Glyph } from "./Glyph.tsx";
import { MailboxAvatar } from "./MailboxAvatar.tsx";
import { SettingsList, SettingsRow } from "./SettingsList.tsx";
import { inlineError } from "./styles.ts";

const spinner = (size: number) => <Glyph name="spinner" size={size} spin />;

/**
 * Feishu Mail is intentionally its own connector page. Setup is one grant and
 * one choice: the user approves read access in Feishu (Mochi notices on its
 * own), then picks shared mailboxes from the list Feishu proves accessible.
 * The page never exposes a mail mutation action.
 */
export function FeishuMailSettings({
  snapshot,
  perform,
  shownProblem,
  openFeishu,
  onBusyChange,
  busy,
}: {
  snapshot: DesktopSnapshot;
  perform(action: DesktopAction): Promise<boolean>;
  shownProblem: DesktopProblem | null;
  openFeishu(): void;
  onBusyChange(busy: boolean): void;
  /** The window is visibly busy; a moment-long action never sets it. */
  busy: boolean;
}) {
  const service = chatServiceName(snapshot);
  const connection = snapshot.connectorCatalog?.connections.find(
    (candidate) => candidate.providerId === "feishu-mail",
  );
  const state = connectorState(connection, snapshot.connectorCatalog !== null);
  const connected = state === "ready";
  const mailboxes = connection?.resources ?? [];
  const sortedMailboxes = [...mailboxes].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
  const resourceScope = connection?.resourceScope ?? {
    status: "unavailable" as const,
    selectedCount: 0,
  };
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const pendingAction = busy || pending !== null;
  const idle =
    snapshot.setup !== "initializing" &&
    !["working", "organizingContext"].includes(snapshot.phase) &&
    (snapshot.queueDepth ?? 0) === 0;
  const hasFeishuBot = snapshot.feishu.active?.state === "ready";
  // Something to end: a proven or remembered account, or a saved mailbox range.
  // A grant still waiting in Feishu is ended with "取消授权" instead.
  const disconnectable =
    hasFeishuBot &&
    state !== "authorizing" &&
    connection !== undefined &&
    (connection.accountDisplayName !== null ||
      connection.resourceScope.selectedCount > 0);
  const grantIncomplete =
    connected &&
    (connection?.capabilities ?? []).some(
      (capability) => capability.availability === "authorization_required",
    );
  const error = shownProblem && (
    <p className={inlineError} role="alert">
      {shownProblem.message}
    </p>
  );

  async function run(
    key: string,
    action: DesktopAction,
    success: string | null = null,
  ) {
    if (pendingAction || !snapshot.controlReady) return;
    setPending(key);
    setFailedAt(null);
    setFeedback(null);
    onBusyChange(true);
    try {
      if (await perform(action)) setFeedback(success);
      else setFailedAt(key);
    } finally {
      setPending(null);
      onBusyChange(false);
    }
  }

  const authorize = () =>
    void run("authorize", { type: "authorizeFeishuMail" });
  // A first grant may start while the Bot works; replacing the grant in use
  // pauses mailbox reads, so it waits until the current work is done.
  const authorizeDisabled =
    pendingAction || !snapshot.controlReady || (connected && !idle);
  const busyNote = (
    <p role="status" className="text-xs text-muted">
      这位伙伴正在处理消息，完成后就可以继续。
    </p>
  );

  const authorizeButton = (label: string) => (
    <Button variant="primary" disabled={authorizeDisabled} onClick={authorize}>
      {pending === "authorize" && spinner(14)}
      {label}
    </Button>
  );

  const appScopeRequired =
    failedAt === "authorize" &&
    shownProblem?.code === "feishu_mail_app_scope_required";
  const setupError =
    (failedAt === "authorize" ||
      failedAt === "cancel" ||
      failedAt === "settings") &&
    error;

  /** The one next step for the connection, shown with its identity. */
  let setup: ReactNode = null;
  if (!hasFeishuBot && state !== "ready") {
    // The mail grant rides on this Bot's Feishu App: either it was never
    // connected, or it needs attention on its own page.
    const feishuMissing = snapshot.feishu.active === null;
    setup = (
      <>
        <p className="text-xs leading-relaxed text-muted">
          {feishuMissing
            ? "邮箱授权要用到这位伙伴的群聊机器人，请先完成群聊连接。"
            : "这位伙伴的群聊连接需要处理。恢复后，邮箱授权和已选择的邮箱会继续生效。"}
        </p>
        <Button onClick={openFeishu} disabled={pendingAction}>
          {feishuMissing ? "连接群聊" : "查看群聊连接"}
          <Glyph name="chevronRight" size={14} />
        </Button>
      </>
    );
  } else if (state === "authorizing") {
    const qr = snapshot.feishuMailVerificationQr;
    setup = (
      <div className="settings-card flex flex-wrap items-start gap-4">
        {qr && (
          <img
            src={qr}
            alt={zh`用${service}扫码，授权读取共享邮箱`}
            className="size-[168px] shrink-0 rounded-sm bg-white"
          />
        )}
        <div className="min-w-0 flex-1 basis-[220px] space-y-3">
          <p className="text-sm leading-relaxed">
            {qr
              ? zh`在${service}授权页确认，或用手机${service}扫码。`
              : "授权页面还在等你确认。"}
          </p>
          <p
            role="status"
            className="inline-flex items-center gap-1.5 text-xs text-muted"
          >
            {spinner(13)}
            确认后这里会自动更新
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {qr ? (
              snapshot.canReopenFeishuMailAuthorization && (
                <Button
                  size="small"
                  disabled={pendingAction}
                  onClick={() =>
                    void run("reopen", {
                      type: "reopenFeishuMailAuthorization",
                    })
                  }
                >
                  在浏览器中打开 <Glyph name="external" size={12} />
                </Button>
              )
            ) : (
              <Button
                size="small"
                disabled={authorizeDisabled}
                onClick={authorize}
              >
                {pending === "authorize" && spinner(12)}
                继续授权
              </Button>
            )}
            <Button
              variant="text"
              size="small"
              className="m-0 text-muted"
              disabled={pendingAction}
              onClick={() =>
                void run(
                  "cancel",
                  { type: "cancelFeishuMailAuthorization" },
                  "已取消这次授权。",
                )
              }
            >
              取消授权
            </Button>
          </div>
        </div>
      </div>
    );
  } else if (state === "ready") {
    setup = grantIncomplete ? (
      <>
        <p className="text-xs leading-relaxed text-muted">
          这次授权没有包含读取邮件需要的全部权限，Mochi
          还不能读取会话。重新授权即可补齐。
        </p>
        {authorizeButton("重新授权")}
        {!idle && busyNote}
      </>
    ) : null;
  } else if (
    state === "unavailable" &&
    connection?.problem === "resource_reconciliation_required"
  ) {
    setup = (
      <p
        role="status"
        className="inline-flex items-center gap-1.5 text-xs text-muted"
      >
        {spinner(13)}
        正在确认邮箱授权
      </p>
    );
  } else if (state === "unavailable") {
    setup = (
      <p className="text-xs leading-relaxed text-muted">
        暂时无法确认邮箱授权，Mochi
        会自动重试；在此之前，已选择的邮箱不会被读取。
      </p>
    );
  } else if (state === "reauthorization_required") {
    setup = (
      <>
        <p className="text-xs leading-relaxed text-muted">
          {connection?.problem === "mail_authorization_incomplete"
            ? "上次授权没有完成，可能已过期或被取消。"
            : "邮箱授权已失效。重新授权后，已选择的邮箱会恢复读取。"}
        </p>
        {authorizeButton("重新授权")}
      </>
    );
  } else if (state === "missing") {
    setup = (
      <>
        <p className="text-xs leading-relaxed text-muted">
          {zh`用你的${service}账号授权一次只读访问，再选择要让 Mochi 读取的共享邮箱。`}
        </p>
        {authorizeButton("授权读取邮箱")}
      </>
    );
  }

  const setupFeedback = !connected && feedback && !shownProblem && (
    <p role="status" className="text-xs text-status-good">
      {feedback}
    </p>
  );
  const recovery = (setup || setupError || setupFeedback) && (
    <>
      {setup}
      {setupError}
      {appScopeRequired && (
        <Button
          disabled={pendingAction || !snapshot.controlReady}
          onClick={() =>
            void run(
              "settings",
              { type: "feishuMailSettings" },
              zh`已在浏览器打开${service}开放平台。开通邮件读取权限后，回到这里再授权一次。`,
            )
          }
        >
          {zh`去${service}开通权限`} <Glyph name="external" size={14} />
        </Button>
      )}
      {setupFeedback}
    </>
  );

  return (
    <ConnectorDetailPage
      label="共享邮箱"
      icon="feishu"
      description="团队共同处理的收件箱"
      identity={
        connection?.accountDisplayName ??
        (state === "unknown"
          ? "暂时无法确认"
          : connection?.problem === "resource_reconciliation_required"
            ? "正在确认"
            : "尚未授权")
      }
      status={connectorStatusOf(connection, snapshot.connectorCatalog !== null)}
      context={zh`${service}用户授权 · 只读`}
      recovery={recovery}
    >
      {connected && (
        <ConnectorSection
          id="feishu-mail-access"
          title="访问范围"
          description="开启的共享邮箱，Mochi 才会读取；邮件本身不会被改动。"
        >
          {mailboxes.length > 0 ? (
            <SettingsList label="共享邮箱" scroll>
              {sortedMailboxes.map((mailbox) => {
                const changing = pending === mailbox.resourceId;
                return (
                  <SettingsRow
                    key={mailbox.resourceId}
                    leading={<MailboxAvatar address={mailbox.displayName} />}
                    title={<span dir="auto">{mailbox.displayName}</span>}
                    detail={
                      changing
                        ? "正在更新…"
                        : !mailbox.selected
                          ? "不读取"
                          : resourceScope.status === "ready"
                            ? "读取邮件 · 只读"
                            : resourceScope.status === "checking"
                              ? "读取邮件 · 正在确认"
                              : "暂时无法读取"
                    }
                    trailing={
                      <Toggle
                        checked={mailbox.selected}
                        aria-label={`${mailbox.displayName}：读取邮件`}
                        aria-busy={changing}
                        disabled={
                          busy ||
                          !snapshot.controlReady ||
                          !idle ||
                          (mailbox.selected
                            ? mailbox.selectionId === null
                            : resourceScope.status !== "ready")
                        }
                        onCheckedChange={(read) =>
                          void run(
                            mailbox.resourceId,
                            read
                              ? {
                                  type: "addConnectorResources",
                                  connectionId: connection!.connectionId,
                                  references: [mailbox.displayName],
                                }
                              : {
                                  type: "removeConnectorResource",
                                  connectionId: connection!.connectionId,
                                  resourceId: mailbox.resourceId,
                                  selectionId: mailbox.selectionId!,
                                },
                          )
                        }
                      />
                    }
                    feedback={failedAt === mailbox.resourceId && error}
                  />
                );
              })}
            </SettingsList>
          ) : (
            <div className="settings-card">
              <h3 className="settings-section-title">还没有可读取的共享邮箱</h3>
              <p className="settings-note mt-2">
                {zh`你的${service}账号目前不是任何共享邮箱的成员。请邮箱管理员把你加为成员，加入后会自动出现在这里。`}
              </p>
            </div>
          )}
          {!idle && (
            <p role="status" className="text-xs text-muted">
              当前工作完成后，就可以调整邮箱。
            </p>
          )}
          <ConnectorOperations
            connection={connection}
            selectionCopy={{
              preview: "选择共享邮箱后才会读取邮件会话",
              optional: "可选邮箱范围",
            }}
          />
        </ConnectorSection>
      )}
      <ConnectorManagement>
        <p>
          {authorizationMethodLabel(connectorAuthorizationFor("feishu-mail"))}
          {zh`。授权使用你本人的${service}账号，只包含读取权限；组织审批由${service}决定。`}
        </p>
        <p>
          Mochi
          只能列出和读取已选择邮箱的会话，没有发送、回复、转发、草稿、删除、移动或修改收信规则的能力。邮件内容只当作资料分析，不会被当成指令执行。
        </p>
        {connected && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
            <p className="min-w-0 flex-1 basis-[220px]">
              授权错了账号？换账号后需要重新选择共享邮箱，确认前暂停读取。
            </p>
            <Button
              size="small"
              disabled={authorizeDisabled}
              onClick={authorize}
            >
              换一个账号授权
            </Button>
          </div>
        )}
        {disconnectable && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
            <p className="min-w-0 flex-1 basis-[220px]">
              断开后这位伙伴不再读取邮箱，已选择的邮箱会清除，邮件本身不会改动。
            </p>
            <Button
              size="small"
              className="text-error"
              disabled={pendingAction || !snapshot.controlReady || !idle}
              onClick={() =>
                void run("disconnect", { type: "disconnectFeishuMail" })
              }
            >
              {pending === "disconnect" && spinner(13)}
              断开授权…
            </Button>
          </div>
        )}
        {failedAt === "disconnect" && error}
        {disconnectable && !idle && <p>当前工作完成后，可以更换或断开授权。</p>}
      </ConnectorManagement>
    </ConnectorDetailPage>
  );
}
