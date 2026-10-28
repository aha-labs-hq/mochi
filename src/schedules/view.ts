import { isGroupName } from "../lark/group.ts";
import {
  isScheduleId,
  isScheduleText,
  MAXIMUM_SCHEDULES,
  SCHEDULE_PROBLEMS,
  type ScheduleProblem,
  type ScheduleRecord,
  type ScheduleRun,
} from "./store.ts";
import { parseScheduleRule, type ScheduleRule } from "./time.ts";

/** On-demand private control data, never status, diagnostics or a transcript. */
export interface ScheduleView {
  id: string;
  title: string;
  task: string;
  rule: ScheduleRule;
  enabled: boolean;
  delivery: "group" | "thread";
  groupName: string | null;
  revision: number;
  nextDueAt: number | null;
  lastRun: ScheduleRun | null;
  problem: ScheduleProblem | null;
}
export function projectSchedule(
  schedule: ScheduleRecord,
  groupName: string | null,
  problem: ScheduleProblem | null,
): ScheduleView {
  return {
    id: schedule.id,
    title: schedule.title,
    task: schedule.task,
    rule: schedule.rule,
    enabled: schedule.enabled,
    delivery: schedule.delivery,
    groupName,
    revision: schedule.revision,
    nextDueAt: schedule.nextDueAt,
    lastRun: schedule.lastRun,
    problem,
  };
}
export function parseScheduleViews(value: unknown): ScheduleView[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_SCHEDULES)
    throw new Error("Invalid schedules response");
  const result = value.map((item: unknown): ScheduleView => {
    if (
      !record(item) ||
      Object.keys(item).sort().join(",") !==
        "delivery,enabled,groupName,id,lastRun,nextDueAt,problem,revision,rule,task,title" ||
      !isScheduleId(item.id) ||
      !isScheduleText(item.title, 120) ||
      !isScheduleText(item.task, 4_000, true) ||
      typeof item.enabled !== "boolean" ||
      (item.delivery !== "group" && item.delivery !== "thread") ||
      !isGroupName(item.groupName) ||
      !Number.isSafeInteger(item.revision) ||
      (item.revision as number) < 1 ||
      (item.nextDueAt !== null && !timestamp(item.nextDueAt)) ||
      !problem(item.problem)
    )
      throw new Error("Invalid schedule projection");
    const last = item.lastRun;
    if (
      last !== null &&
      (!record(last) ||
        Object.keys(last).sort().join(",") !==
          "dueAt,finishedAt,problem,startedAt,status" ||
        !timestamp(last.dueAt) ||
        !timestamp(last.startedAt) ||
        !["running", "delivered", "blocked", "failed", "interrupted"].includes(
          last.status as string,
        ) ||
        (last.status === "running"
          ? last.finishedAt !== null
          : !timestamp(last.finishedAt)) ||
        !problem(last.problem))
    )
      throw new Error("Invalid schedule run projection");
    return {
      ...item,
      rule: parseScheduleRule(item.rule),
    } as unknown as ScheduleView;
  });
  if (new Set(result.map((item) => item.id)).size !== result.length)
    throw new Error("Duplicate schedule projection");
  return result;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function timestamp(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 253_402_300_799_999
  );
}
function problem(value: unknown): boolean {
  return value === null || SCHEDULE_PROBLEMS.includes(value as ScheduleProblem);
}
