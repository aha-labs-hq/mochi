import type { ScheduleProblem } from "../../../src/schedules/store.ts";
import type { ScheduleRule } from "../../../src/schedules/time.ts";

export function scheduleTime(
  value: number,
  timeZone: string,
  includeYear = false,
): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}
export function scheduleRuleLabel(rule: ScheduleRule): string {
  const zone = new Intl.DateTimeFormat("zh-CN", {
    timeZone: rule.timeZone,
    timeZoneName: "longGeneric",
  })
    .formatToParts(0)
    .find((part) => part.type === "timeZoneName")!.value;
  if (rule.kind === "once")
    return `${scheduleTime(Date.parse(rule.at), rule.timeZone, true)} · ${zone}`;
  const days = ["", "一", "二", "三", "四", "五", "六", "日"];
  return `${rule.kind === "daily" ? "每天" : `每周${rule.weekdays.map((day) => days[day]).join("、")}`} ${rule.time} · ${zone}`;
}
export const scheduleProblemCopy: Record<ScheduleProblem, string> = {
  channel_changed: "原来的群聊连接已改变。请在当前群重新交代这项安排。",
  group_unavailable: "原群没有开启回应，或暂时无法确认仍在群中。",
  source_unavailable: "约定的话题已无法回复。请在群里重新约定结果去向。",
  resources_changed:
    "原来指定的资源授权已改变。请在群里重新指定需要查看的资源。",
  execution_failed: "这次工作未完成，没有自动重跑。可在群里要求继续。",
  delivery_failed: "无法确认这次结果已发出，没有自动重发。可在群里要求继续。",
  interrupted: "上次工作被中断，没有自动重跑。可在群里要求继续。",
};
