import { Menu } from "@base-ui/react/menu";
import { isByokAccountSummary } from "../shared/bridge.ts";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import type { DesktopProblem } from "../shared/problem.ts";
import { accountPresentation } from "./accountPresentation.ts";
import { Button } from "./Controls.tsx";
import { Glyph } from "./Glyph.tsx";
import { SettingsIcon } from "./SettingsIcon.tsx";
import { SettingsList, SettingsRow } from "./SettingsList.tsx";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";
import { inlineError } from "./styles.ts";

export function AccountSettings({
  snapshot,
  act,
  shownProblem,
  diagnose,
}: {
  snapshot: DesktopSnapshot;
  act(action: DesktopAction): Promise<void>;
  shownProblem: DesktopProblem | null;
  diagnose(): void;
}) {
  const status = snapshot.account.status;
  const connections =
    status === "signedIn"
      ? (snapshot.account.connections ?? [snapshot.account.account])
      : [];
  const modelApiConnections = connections.filter(isByokAccountSummary);
  const busy = snapshot.busy !== null || !snapshot.controlReady;
  const canChange = !busy && snapshot.accountChangeReady;
  return (
    <div className="space-y-10">
      {shownProblem && (
        <p className={inlineError} role="alert">
          {shownProblem.title}。{shownProblem.message}
        </p>
      )}
      {status === "signedIn" && connections.length > 0 && (
        <section aria-label="已连接模型">
          <SettingsSectionHeader
            title="已连接"
            description={
              <>
                <span>{connections.length} 个模型连接</span>
                <span> · 各位伙伴在自己的模型页选择使用哪一个。</span>
              </>
            }
            actions={
              modelApiConnections.length < 16 && (
                <Button
                  size="small"
                  disabled={!canChange}
                  onClick={() => void act({ type: "configureModelApi" })}
                >
                  <Glyph name="plus" size={12} />
                  添加模型 API
                </Button>
              )
            }
          />
          <SettingsList>
            {connections.map((connection) => {
              const byok = isByokAccountSummary(connection);
              return (
                <SettingsRow
                  key={connection.provider}
                  leading={<SettingsIcon name="account" size={36} />}
                  title={
                    <span
                      title={byok ? connection.label : "ChatGPT"}
                      className="block truncate"
                    >
                      {byok ? connection.label : "ChatGPT"}
                    </span>
                  }
                  detail={
                    byok
                      ? `模型 API · ${connection.model.split("/").slice(1).join("/")}`
                      : "订阅连接"
                  }
                  trailing={
                    <Menu.Root>
                      <Menu.Trigger
                        aria-label={`${byok ? connection.label : "ChatGPT"} 连接选项`}
                        title="连接选项"
                        className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-sm text-muted transition-colors duration-150 hover:bg-ink/5 hover:text-ink motion-reduce:transition-none control-focus"
                      >
                        <Glyph name="more" size={16} />
                      </Menu.Trigger>
                      <Menu.Portal>
                        <Menu.Positioner
                          align="end"
                          sideOffset={6}
                          collisionPadding={12}
                          className="z-50"
                        >
                          <Menu.Popup className="settings-theme min-w-44 rounded-lg border border-hairline bg-card p-1 shadow-surface outline-none">
                            {!byok && modelApiConnections.length < 16 && (
                              <Menu.Item
                                disabled={!canChange}
                                onClick={() =>
                                  void act({ type: "configureModelApi" })
                                }
                                className="flex min-h-8 cursor-default items-center rounded-sm px-2.5 text-sm outline-none data-highlighted:bg-control data-disabled:opacity-40"
                              >
                                添加模型 API…
                              </Menu.Item>
                            )}
                            {!byok && (
                              <>
                                <Menu.Item
                                  disabled={!canChange}
                                  onClick={() =>
                                    void act({ type: "switchAccount" })
                                  }
                                  className="flex min-h-8 cursor-default items-center rounded-sm px-2.5 text-sm outline-none data-highlighted:bg-control data-disabled:opacity-40"
                                >
                                  切换账号…
                                </Menu.Item>
                                <Menu.Item
                                  disabled={!canChange}
                                  onClick={() => void act({ type: "logout" })}
                                  className="flex min-h-8 cursor-default items-center rounded-sm px-2.5 text-sm text-error outline-none data-highlighted:bg-control data-disabled:opacity-40"
                                >
                                  退出 ChatGPT…
                                </Menu.Item>
                              </>
                            )}
                            {byok && (
                              <>
                                <Menu.Item
                                  disabled={!canChange}
                                  onClick={() =>
                                    void act({
                                      type: "configureModelApi",
                                      connectionId: connection.provider,
                                    })
                                  }
                                  className="flex min-h-8 cursor-default items-center rounded-sm px-2.5 text-sm outline-none data-highlighted:bg-control data-disabled:opacity-40"
                                >
                                  编辑模型 API…
                                </Menu.Item>
                                <Menu.Item
                                  disabled={!canChange}
                                  onClick={() =>
                                    void act({
                                      type: "removeModelApi",
                                      connectionId: connection.provider,
                                    })
                                  }
                                  className="flex min-h-8 cursor-default items-center rounded-sm px-2.5 text-sm text-error outline-none data-highlighted:bg-control data-disabled:opacity-40"
                                >
                                  断开模型 API…
                                </Menu.Item>
                              </>
                            )}
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.Root>
                  }
                />
              );
            })}
          </SettingsList>
        </section>
      )}
      {snapshot.account.status === "signedIn" &&
        snapshot.account.pendingLogin && (
          <section className="space-y-4" aria-label="ChatGPT 登录">
            <SettingsSectionHeader
              title="ChatGPT"
              description={accountPresentation.signingIn.status}
            />
            <p className="settings-note">
              等待你在 ChatGPT 中完成登录。使用其他连接的 Bot 照常工作。
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="primary"
                disabled={busy || !snapshot.canReopenLogin}
                onClick={() => void act({ type: "reopenLogin" })}
              >
                打开浏览器
                <Glyph name="external" size={14} />
              </Button>
              <Button
                disabled={busy}
                onClick={() => void act({ type: "cancelLogin" })}
              >
                取消登录
              </Button>
            </div>
          </section>
        )}
      {status !== "signedIn" && (
        <section className="space-y-4" aria-label="连接模型">
          <SettingsSectionHeader
            title="连接方式"
            description={accountPresentation[status].status}
          />
          <p className="settings-note">
            {status === "unknown"
              ? "暂时无法确认模型连接。"
              : status === "signingIn"
                ? "等待你在 ChatGPT 中完成登录。"
                : "选择 ChatGPT 订阅，或添加一个或多个模型 API 连接。"}
          </p>
          <div className="flex flex-wrap gap-3">
            {status === "unknown" && (
              <Button onClick={diagnose}>
                查看运行诊断
                <Glyph name="chevronRight" size={14} />
              </Button>
            )}
            {status === "signedOut" && (
              <>
                <Button
                  variant="primary"
                  disabled={!canChange}
                  onClick={() => void act({ type: "login" })}
                >
                  连接 ChatGPT
                  <Glyph name="external" size={14} />
                </Button>
                <Button
                  disabled={!canChange}
                  onClick={() => void act({ type: "configureModelApi" })}
                >
                  添加模型 API
                </Button>
              </>
            )}
            {status === "signingIn" && (
              <>
                <Button
                  variant="primary"
                  disabled={busy || !snapshot.canReopenLogin}
                  onClick={() => void act({ type: "reopenLogin" })}
                >
                  打开浏览器
                  <Glyph name="external" size={14} />
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void act({ type: "cancelLogin" })}
                >
                  取消登录
                </Button>
              </>
            )}
          </div>
        </section>
      )}
      {!snapshot.accountChangeReady && snapshot.controlReady && (
        <p className="settings-note">
          当前有进行中的任务，完成后即可切换或退出连接。
        </p>
      )}
    </div>
  );
}
