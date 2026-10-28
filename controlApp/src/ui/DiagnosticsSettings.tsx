import type { ReactNode } from "react";
import { githubProjectsOf, githubStatusOf } from "../shared/connectorView.ts";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import { SUPPORT_EMAIL } from "../shared/support.ts";
import { botDisplayLabel, botStatus, MEMORY } from "../shared/vocabulary.ts";
import { accountPresentation } from "./accountPresentation.ts";
import { Button } from "./Controls.tsx";
import { connectionStatus } from "./connectionStatus.ts";
import { groupSummary } from "./groupPresentation.ts";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";
import { inlineError } from "./styles.ts";

type Action = (action: DesktopAction) => Promise<void>;

export function DiagnosticsSettings({
  snapshot,
  act,
}: {
  snapshot: DesktopSnapshot;
  act: Action;
}) {
  const busy = snapshot.busy !== null;
  const selectedBot = snapshot.bots.find(
    (bot) => bot.botId === snapshot.selectedBotId,
  );
  return (
    <div className="space-y-10">
      <section aria-label="应用运行状态">
        <SettingsSectionHeader title="应用" />
        <Facts
          rows={[
            {
              label: "后台组件",
              value: snapshot.installed ? "已准备" : "未准备",
            },
            {
              label: "后台服务",
              value: snapshot.controlReady
                ? "已就绪"
                : snapshot.loaded
                  ? "尚未就绪"
                  : "没有运行",
            },
            {
              label: "模型连接",
              value: accountPresentation[snapshot.account.status].status,
            },
          ]}
        />
      </section>
      {snapshot.bots.length > 0 &&
        (snapshot.bots.length > 1 || !selectedBot) && (
          <section aria-label="伙伴运行状态">
            <SettingsSectionHeader title="伙伴" />
            <Facts
              rows={snapshot.bots.map((bot) => ({
                key: bot.botId,
                label: (
                  <span
                    title={botDisplayLabel(bot, snapshot.bots)}
                    className="block truncate text-ink"
                  >
                    {botDisplayLabel(bot, snapshot.bots)}
                  </span>
                ),
                value: (
                  <span className="text-muted">
                    {snapshot.controlReady
                      ? botStatus(bot).label
                      : "暂时无法确认"}
                  </span>
                ),
              }))}
            />
          </section>
        )}
      {selectedBot && (
        <section aria-label="当前伙伴的运行状态">
          <SettingsSectionHeader
            title={botDisplayLabel(selectedBot, snapshot.bots)}
          />
          <Facts
            rows={[
              { label: "群聊", value: connectionStatus(snapshot) },
              {
                label: "值班群",
                value: <span dir="auto">{groupSummary(snapshot)}</span>,
              },
              {
                label: "GitHub",
                value: {
                  connected: "已连接",
                  disconnected: "未连接",
                  authorizing: "等待授权",
                  reauthorization_required: "需要重新授权",
                  unavailable: "暂时无法确认",
                }[githubStatusOf(snapshot.connectorCatalog)],
              },
              {
                label: "已选项目",
                value: githubProjectsOf(snapshot.connectorCatalog).filter(
                  (project) => project.selected,
                ).length,
              },
              { label: "等候消息", value: snapshot.queueDepth ?? "—" },
              {
                label: MEMORY.used,
                value:
                  snapshot.contextPercent === null
                    ? "—"
                    : `${snapshot.contextPercent}%`,
              },
            ]}
          />
        </section>
      )}
      {snapshot.problem && (
        <p className={inlineError}>
          {snapshot.problem.title}
          <br />
          {snapshot.problem.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <Button
          type="button"
          disabled={busy || !snapshot.installed}
          onClick={() => {
            void act({ type: "service", operation: "restart" });
          }}
        >
          重新连接后台
        </Button>
        {!snapshot.development && (
          <Button
            type="button"
            disabled={busy || !snapshot.locationReady}
            onClick={() => {
              void act({ type: "prepare" });
            }}
          >
            修复后台…
          </Button>
        )}
      </div>
      <section aria-label="最近动态">
        <SettingsSectionHeader title="最近动态" />
        <ol className="list-none divide-y divide-hairline border-b border-hairline p-0 [&>li]:settings-grid [&>li]:py-2.5 [&>li]:text-sm [&>li]:leading-5 [&_time]:col-span-2 [&_time]:text-right [&_time]:text-xs [&_time]:whitespace-nowrap [&_time]:text-muted [&_time]:tabular-nums">
          {snapshot.activity.map((item) => (
            <li key={item.id}>
              <span className="col-span-4">{item.title}</span>
              <time>
                {new Date(item.time).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </li>
          ))}
          {!snapshot.activity.length && (
            <li className="text-muted">
              <span className="col-span-6">暂时没有新的动态。</span>
            </li>
          )}
        </ol>
      </section>
      <footer className="settings-grid items-center border-t border-hairline pt-4 text-xs leading-5 text-muted">
        <p className="col-span-6 mb-3">
          需要帮助时，导出诊断后发送到{" "}
          <span className="text-ink select-text">{SUPPORT_EMAIL}</span>
          ，并说明出问题的步骤和时间。诊断不包含聊天正文、账号凭据或项目目录。
        </p>
        <span className="col-span-4 @max-[560px]/settings:col-span-3">
          Mochi {snapshot.productVersion}
          {snapshot.development ? " · Development" : ""}
        </span>
        <Button
          className="col-span-2 justify-self-end @max-[560px]/settings:col-span-3"
          disabled={busy}
          onClick={() => void act({ type: "exportDiagnostics" })}
        >
          导出诊断…
        </Button>
      </footer>
    </div>
  );
}

/**
 * Facts read as a two-column table: one rule between rows, values on the
 * same axis as every form field in Settings, numbers in tabular figures.
 */
function Facts({
  rows,
}: {
  rows: readonly { key?: string; label: ReactNode; value: ReactNode }[];
}) {
  return (
    <dl className="border-b border-hairline text-sm leading-5">
      {rows.map((row) => (
        <div
          key={row.key ?? String(row.label)}
          className="settings-grid border-t border-hairline py-2.5 first:border-t-0"
        >
          <dt className="settings-label leading-5 font-normal text-muted">
            {row.label}
          </dt>
          <dd className="settings-value tabular-nums [overflow-wrap:anywhere]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
