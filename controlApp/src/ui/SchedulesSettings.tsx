import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ScheduleView } from "../../../src/schedules/view.ts";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import { type DesktopProblem, problem } from "../shared/problem.ts";
import { Button, Toggle } from "./Controls.tsx";
import type { ProductConnection } from "./connection.ts";
import { Glyph } from "./Glyph.tsx";
import { QueryProblem } from "./queries.ts";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";
import {
  scheduleProblemCopy,
  scheduleRuleLabel,
  scheduleTime,
} from "./schedulePresentation.ts";

/** Same records as Feishu, scoped to the Bot the window actually displays. */
export function SchedulesSettings({
  snapshot,
  connection,
  active,
  onBusyChange,
}: {
  snapshot: DesktopSnapshot;
  connection: ProductConnection;
  active: boolean;
  onBusyChange(busy: boolean): void;
}) {
  const client = useQueryClient();
  const key = ["schedules", snapshot.selectedBotId];
  const available = snapshot.controlReady && snapshot.selectedBotId !== null;
  const [changing, setChanging] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    id: string;
    problem: DesktopProblem;
  } | null>(null);
  const query = useQuery({
    queryKey: key,
    staleTime: 15_000,
    enabled:
      active &&
      available &&
      (snapshot.busy === null || snapshot.busy === "schedules") &&
      changing === null,
    refetchInterval: active && available ? 15_000 : false,
    queryFn: async () => {
      const result = await connection.schedules().catch(() => {
        throw new QueryProblem(problem("control_unavailable"));
      });
      if (!result.ok) throw new QueryProblem(result.problem);
      return result.value;
    },
  });
  useEffect(() => {
    if (!available)
      client.removeQueries({ queryKey: ["schedules", snapshot.selectedBotId] });
  }, [available, client, snapshot.selectedBotId]);
  const busy = snapshot.busy !== null || changing !== null;
  const change = async (schedule: ScheduleView, action: DesktopAction) => {
    setChanging(schedule.id);
    setFailure(null);
    onBusyChange(true);
    try {
      const result = await connection.perform(action);
      if (!result.ok) setFailure({ id: schedule.id, problem: result.problem });
      else setConfirming(null);
      await query.refetch(); // No optimistic state: the record is authoritative.
    } catch {
      setFailure({ id: schedule.id, problem: problem("control_unavailable") });
    } finally {
      setChanging(null);
      onBusyChange(false);
    }
  };
  const items = available ? query.data : undefined;
  return (
    <section aria-label="安排列表">
      {/* The list rereads itself while it is open; there is nothing to refresh. */}
      <SettingsSectionHeader
        title="全部安排"
        description="在群里交代，安排会在约定时间接着发生。"
      />
      {!available ? (
        <p role="status" className="settings-card settings-note">
          后台连接后，可以查看这位伙伴的安排。
        </p>
      ) : query.isError ? (
        <p role="alert" className="text-sm leading-relaxed text-error">
          {query.error instanceof QueryProblem
            ? query.error.problem.message
            : "暂时无法读取安排，Mochi 会自动重试。"}
        </p>
      ) : !items ? (
        <p role="status" className="settings-card settings-note">
          正在读取安排…
        </p>
      ) : items.length === 0 ? (
        <div className="settings-card">
          <h2 className="settings-section-title">还没有安排</h2>
          <p className="settings-note mt-1">在群里告诉这位伙伴：</p>
          <blockquote className="my-3 border-l-2 border-hairline pl-3 text-sm leading-6">
            “每周五下午三点，核对发布事项的进展。”
          </blockquote>
          <p className="settings-note">
            结果默认发到同一群，也可以要求留在原话题。
          </p>
        </div>
      ) : (
        <ul className="list-none space-y-3">
          {items.map((schedule) => {
            const ended =
              schedule.rule.kind === "once" && schedule.nextDueAt === null;
            const state = ended
              ? schedule.lastRun?.status === "running"
                ? "正在处理"
                : schedule.lastRun?.status === "delivered"
                  ? "已结束"
                  : "这次未交付"
              : !schedule.enabled
                ? "已暂停"
                : schedule.lastRun?.status === "running"
                  ? "正在处理"
                  : "已开启";
            const currentProblem =
              schedule.enabled && !ended ? schedule.problem : null;
            const runProblem = schedule.lastRun?.problem;
            const running = schedule.lastRun?.status === "running";
            const stateTone = running ? "text-status-attention" : "text-muted";
            return (
              <li key={schedule.id}>
                <article
                  aria-label={schedule.title}
                  className="settings-card @container/settings"
                >
                  <div className="settings-grid items-start">
                    <h2 className="col-span-4 min-w-0 text-sm leading-7 font-semibold [overflow-wrap:anywhere] @max-[560px]/settings:col-span-3">
                      {schedule.title}
                    </h2>
                    <div className="col-span-2 flex min-h-7 items-center justify-end gap-2 @max-[560px]/settings:col-span-3">
                      <span
                        className={`text-xs ${stateTone}`}
                        role={
                          changing === schedule.id || running
                            ? "status"
                            : undefined
                        }
                      >
                        {changing === schedule.id ? "正在更新…" : state}
                      </span>
                      {!ended && (
                        <Toggle
                          size="compact"
                          checked={schedule.enabled}
                          disabled={!available || busy}
                          aria-label={`${schedule.title}：开启安排`}
                          onCheckedChange={(enabled) =>
                            void change(schedule, {
                              type: "setScheduleEnabled",
                              scheduleId: schedule.id,
                              revision: schedule.revision,
                              enabled,
                            })
                          }
                        />
                      )}
                    </div>
                  </div>
                  <p className="settings-note mt-1 [overflow-wrap:anywhere]">
                    {scheduleRuleLabel(schedule.rule)}
                  </p>
                  <dl className="settings-grid mt-4 items-baseline gap-y-2 text-xs leading-6 [&>dt]:settings-label [&>dt]:text-xs [&>dt]:font-normal [&>dt]:text-muted [&>dd]:settings-value">
                    {schedule.enabled && schedule.nextDueAt !== null && (
                      <>
                        <dt className="text-muted">下次</dt>
                        <dd className="font-medium tabular-nums [overflow-wrap:anywhere]">
                          <time>
                            {scheduleTime(
                              schedule.nextDueAt,
                              schedule.rule.timeZone,
                            )}
                          </time>
                        </dd>
                      </>
                    )}
                    <dt className="text-muted">去向</dt>
                    <dd className="min-w-0 [overflow-wrap:anywhere]">
                      {schedule.groupName ?? "原群"} ·{" "}
                      {schedule.delivery === "group"
                        ? "群里的一条新消息"
                        : "约定的话题内回复"}
                    </dd>
                    {schedule.lastRun?.status === "delivered" && (
                      <>
                        <dt className="text-muted">最近交付</dt>
                        <dd className="min-w-0 text-muted tabular-nums [overflow-wrap:anywhere]">
                          已发出 ·{" "}
                          <time>
                            {scheduleTime(
                              schedule.lastRun.finishedAt!,
                              schedule.rule.timeZone,
                            )}
                          </time>
                        </dd>
                      </>
                    )}
                  </dl>
                  {(currentProblem || runProblem) && (
                    <p className="mt-4 text-sm leading-relaxed text-error">
                      {scheduleProblemCopy[(currentProblem ?? runProblem)!]}
                    </p>
                  )}
                  <div className="settings-grid mt-4">
                    {/* The work keeps full width beneath the two reading actions. */}
                    <details className="group col-span-6 col-start-1 row-start-1 min-w-0 text-sm">
                      <summary className="-ml-1 flex min-h-9 w-fit cursor-pointer list-none items-center gap-1 rounded-sm px-1 text-xs text-muted hover:text-ink control-focus [&::-webkit-details-marker]:hidden">
                        <Glyph
                          name="chevronRight"
                          size={12}
                          className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
                        />
                        工作内容
                      </summary>
                      <p className="pt-2 pb-1 leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {schedule.task}
                      </p>
                    </details>
                    {confirming !== schedule.id && (
                      <Button
                        variant="text"
                        className="m-0 -mr-1 col-span-2 col-start-5 row-start-1 justify-self-end self-start px-1 text-xs font-normal text-muted enabled:hover:text-error @max-[560px]/settings:col-span-3 @max-[560px]/settings:col-start-4"
                        disabled={!available || busy}
                        onClick={() => setConfirming(schedule.id)}
                      >
                        取消安排
                      </Button>
                    )}
                  </div>
                  {failure?.id === schedule.id && (
                    <p
                      role="alert"
                      className="mt-3 text-sm leading-relaxed text-error"
                    >
                      {failure.problem.message}
                    </p>
                  )}
                  {confirming === schedule.id ? (
                    <div className="mt-4">
                      <p className="text-sm">
                        取消这项安排？{running && "已经开始的工作仍会交付。"}
                      </p>
                      <div className="mt-4 flex justify-end gap-4">
                        <Button
                          variant="text"
                          disabled={busy || !available}
                          onClick={() => setConfirming(null)}
                        >
                          保留
                        </Button>
                        <Button
                          variant="text"
                          className="text-error"
                          disabled={busy || !available}
                          onClick={() =>
                            void change(schedule, {
                              type: "cancelSchedule",
                              scheduleId: schedule.id,
                              revision: schedule.revision,
                            })
                          }
                        >
                          取消安排
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      )}
      <aside className="settings-note mt-6">
        <p>
          Mac
          开着、这位伙伴在值班时才会执行。睡眠或离线后可能晚到；周期工作只补最近一期。
        </p>
        {available && !snapshot.eventStreamReady && (
          <p className="mt-2">这位伙伴当前不在线，安排会等恢复后再开始。</p>
        )}
      </aside>
    </section>
  );
}
