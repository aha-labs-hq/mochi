import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import type { UpdatePhase } from "../shared/updates.ts";
import { Button, Toggle } from "./Controls.tsx";

const words: Record<UpdatePhase, string> = {
  unavailable: "此版本不接收公开更新",
  idle: "随时可以检查更新",
  checking: "正在检查更新…",
  current: "Mochi 已是最新版本",
  withdrawn: "这个版本暂时停止提供更新，当前版本可继续使用",
  available: "有新版本可用",
  downloading: "正在下载更新",
  paused: "下载已暂停",
  ready: "新版本已就绪",
  preparing: "正在准备更新",
  waiting: "等伙伴完成当前工作",
  closing: "正在准备重新打开",
  installing: "正在更新 Mochi",
  verifying: "正在恢复伙伴",
  restoring: "正在恢复原来的版本",
  completed: "更新完成",
  restored: "更新未完成，已恢复原来的版本",
  failed: "更新暂未完成",
};
export function UpdateSettings({
  snapshot,
  act,
}: {
  snapshot: DesktopSnapshot;
  act(action: DesktopAction): void;
}) {
  const u = snapshot.update;
  const error =
    u.error === "storage"
      ? "可用空间或下载文件无法使用。腾出一些空间后再试，当前版本仍可继续工作。"
      : u.error === "verification"
        ? "这个更新暂时无法验证或不适用于当前系统，当前版本继续保留。请稍后重新检查。"
        : u.error === "permission"
          ? "更新服务暂时无法继续，当前版本会保留。请确认系统设置的“登录项与扩展”允许 Mochi 在后台运行，再重试。"
          : u.error === "installation"
            ? "这次更新没有完成，当前版本已保留。可以重试。"
            : u.error === "recovery"
              ? "上次更新或修复没有完成。请继续恢复，完成前伙伴会保持暂停接收。"
              : "暂时连不上更新服务。下载进度会保留，可以稍后继续。";
  const bytes = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;
  return (
    <div className="max-w-xl space-y-8 text-sm leading-6">
      {snapshot.problem?.code === "product_uninstall_failed" && (
        <p role="alert" className="text-error">
          {snapshot.problem.message}
        </p>
      )}
      <section className="space-y-2">
        <p className="text-2xl font-medium">
          Mochi{" "}
          <span className="text-base text-muted">
            {snapshot.productVersion}
          </span>
        </p>
        <p role="status" aria-live="polite">
          {u.phase === "failed" && u.error === "recovery"
            ? "需要继续恢复"
            : words[u.phase]}
          {u.target && u.target !== snapshot.productVersion
            ? ` · ${u.target}`
            : ""}
        </p>
        {u.phase === "downloading" && (
          <>
            <progress
              className="h-1 w-full accent-ink"
              max={u.total || 1}
              value={u.received}
              aria-label="更新下载进度"
            />
            <p className="text-xs text-muted tabular-nums">
              {bytes(u.received)} / {bytes(u.total)}
            </p>
          </>
        )}
        {u.phase === "waiting" && (
          <p className="text-muted">
            当前工作和回复发送完成后，Mochi 会重新打开。账号、伙伴和记忆会保留。
          </p>
        )}
        {u.phase === "failed" && (
          <p className={u.error === "recovery" ? "text-error" : "text-muted"}>
            {error}
          </p>
        )}
        {u.notes && <p className="whitespace-pre-wrap text-muted">{u.notes}</p>}
        <div className="flex flex-wrap gap-2 pt-2">
          {["idle", "current", "withdrawn", "completed", "restored"].includes(
            u.phase,
          ) && (
            <Button size="small" onClick={() => act({ type: "checkUpdate" })}>
              检查更新…
            </Button>
          )}
          {["available", "paused"].includes(u.phase) && (
            <Button
              size="small"
              onClick={() => act({ type: "downloadUpdate" })}
            >
              {u.phase === "paused" ? "继续下载" : "下载更新"}
            </Button>
          )}
          {u.phase === "downloading" && (
            <Button size="small" onClick={() => act({ type: "pauseUpdate" })}>
              暂停下载
            </Button>
          )}
          {u.phase === "ready" && (
            <Button size="small" onClick={() => act({ type: "installUpdate" })}>
              空闲时更新
            </Button>
          )}
          {["preparing", "waiting"].includes(u.phase) && (
            <Button size="small" onClick={() => act({ type: "cancelUpdate" })}>
              取消本次更新
            </Button>
          )}
          {u.phase === "failed" && (
            <Button size="small" onClick={() => act({ type: "retryUpdate" })}>
              {u.error === "recovery" ? "继续恢复" : "重试"}
            </Button>
          )}
        </div>
      </section>
      {u.phase !== "unavailable" && (
        <section className="space-y-5 border-t border-hairline pt-5">
          {(
            [
              ["check", "自动检查更新", "在后台检查，不打断正在进行的工作。"],
              ["download", "自动下载更新", "准备好后再决定何时安装。"],
              [
                "install",
                "空闲时自动安装",
                "仅在没有未完成工作和未保存设置时重新打开 Mochi。",
              ],
            ] as const
          ).map(([key, label, description]) => (
            <div key={key} className="flex items-start justify-between gap-5">
              <div>
                <label htmlFor={`update-${key}`}>{label}</label>
                <p className="text-xs text-muted">{description}</p>
              </div>
              <Toggle
                id={`update-${key}`}
                aria-label={label}
                checked={u.preferences[key]}
                onCheckedChange={(value) =>
                  act({
                    type: "setUpdatePreferences",
                    preferences: { ...u.preferences, [key]: value },
                  })
                }
              />
            </div>
          ))}
        </section>
      )}
      {!snapshot.development && (
        <section
          className="space-y-3 border-t border-hairline pt-5"
          aria-label="卸载 Mochi"
        >
          <h2 className="font-medium">卸载 Mochi</h2>
          <p className="text-muted">
            移除应用与后台组件。卸载前可以选择保留数据，或永久删除这台 Mac
            上所有伙伴、连接和记忆。
          </p>
          <p role="status" aria-live="polite" aria-atomic="true">
            {snapshot.busy === "uninstall"
              ? "正在准备卸载，等待已接工作与回复发送完成…"
              : ""}
          </p>
          <Button
            size="small"
            disabled={
              snapshot.busy !== "uninstall" &&
              (snapshot.busy !== null ||
                [
                  "preparing",
                  "waiting",
                  "closing",
                  "installing",
                  "verifying",
                  "restoring",
                ].includes(u.phase))
            }
            onClick={() =>
              act({
                type:
                  snapshot.busy === "uninstall"
                    ? "cancelUninstall"
                    : "uninstall",
              })
            }
          >
            {snapshot.busy === "uninstall" ? "取消卸载" : "卸载 Mochi…"}
          </Button>
        </section>
      )}
    </div>
  );
}
