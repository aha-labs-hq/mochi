/** Calendar policy belongs here; timers never define a recurrence. */
export type ScheduleRule =
  | { kind: "once"; at: string; timeZone: string }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; time: string; timeZone: string; weekdays: number[] };

// Bun 1.4.2 implements Temporal, but its declaration package does not publish
// its types. Describe only the native methods this boundary uses, without a
// second implementation or a polyfill fallback.
interface CalendarDate {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  add(duration: { days: number }): CalendarDate;
}
interface ZonedDate {
  epochMilliseconds: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  toPlainDate(): CalendarDate;
}
const temporal = (
  globalThis as unknown as {
    Temporal: {
      Instant: {
        from(value: string): { epochMilliseconds: number };
        fromEpochMilliseconds(value: number): {
          toZonedDateTimeISO(zone: string): ZonedDate;
        };
      };
      ZonedDateTime: {
        from(
          value: {
            timeZone: string;
            year: number;
            month: number;
            day: number;
            hour: number;
            minute: number;
          },
          options: { disambiguation: "earlier"; overflow: "reject" },
        ): ZonedDate;
      };
    };
  }
).Temporal;

export function parseScheduleRule(value: unknown): ScheduleRule {
  if (!record(value) || !isTimeZone(value.timeZone))
    throw new Error("安排需要有效的 IANA 时区。");
  if (value.kind === "once" && keys(value) === "at,kind,timeZone") {
    if (
      typeof value.at !== "string" ||
      value.at.length > 64 ||
      !/(?:Z|[+-]\d\d:\d\d)$/.test(value.at)
    ) {
      throw new Error("一次性安排需要带时区的完整时间。");
    }
    instant(value.at);
    return { kind: "once", at: value.at, timeZone: value.timeZone };
  }
  if (
    (value.kind !== "daily" && value.kind !== "weekly") ||
    typeof value.time !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)
  )
    throw new Error("周期安排需要准确的当地时间 HH:mm。");
  if (value.kind === "daily" && keys(value) === "kind,time,timeZone") {
    return { kind: "daily", time: value.time, timeZone: value.timeZone };
  }
  if (
    value.kind === "weekly" &&
    keys(value) === "kind,time,timeZone,weekdays" &&
    Array.isArray(value.weekdays) &&
    value.weekdays.length > 0 &&
    value.weekdays.length <= 7 &&
    value.weekdays.every(
      (day) => Number.isInteger(day) && day >= 1 && day <= 7,
    ) &&
    new Set(value.weekdays).size === value.weekdays.length
  ) {
    return {
      kind: "weekly",
      time: value.time,
      timeZone: value.timeZone,
      weekdays: [...value.weekdays].sort(),
    };
  }
  throw new Error("安排的时间规则无效。");
}

/** The next future occurrence, strictly after the supplied wall-clock instant. */
export function nextOccurrence(
  rule: ScheduleRule,
  after: number,
): number | null {
  assertTimestamp(after);
  if (rule.kind === "once") {
    const at = instant(rule.at);
    return at > after ? at : null;
  }
  const date = temporal.Instant.fromEpochMilliseconds(after)
    .toZonedDateTimeISO(rule.timeZone)
    .toPlainDate();
  for (let offset = 0; offset < 15; offset++) {
    const candidate = occurrenceOn(rule, date.add({ days: offset }));
    if (candidate !== null && candidate > after) return candidate;
  }
  throw new Error("无法确定安排的下一次时间。");
}

/** Coalesce an offline/busy interval into its newest due occurrence. */
export function latestDueOccurrence(
  rule: ScheduleRule,
  firstDue: number,
  now: number,
): number | null {
  assertTimestamp(firstDue);
  assertTimestamp(now);
  if (now < firstDue) return null;
  if (rule.kind === "once")
    return instant(rule.at) === firstDue ? firstDue : null;
  const date = temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(rule.timeZone)
    .toPlainDate();
  for (let offset = 0; offset > -15; offset--) {
    const candidate = occurrenceOn(rule, date.add({ days: offset }));
    if (candidate !== null && candidate <= now)
      return candidate >= firstDue ? candidate : null;
  }
  throw new Error("无法确定安排已到的时间。");
}

function occurrenceOn(
  rule: Exclude<ScheduleRule, { kind: "once" }>,
  date: CalendarDate,
): number | null {
  if (rule.kind === "weekly" && !rule.weekdays.includes(date.dayOfWeek))
    return null;
  const [hour, minute] = rule.time.split(":").map(Number) as [number, number];
  const value = temporal.ZonedDateTime.from(
    {
      timeZone: rule.timeZone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute,
    },
    { disambiguation: "earlier", overflow: "reject" },
  );
  // A spring-forward gap moves the clock. Skip that date rather than silently
  // running at a different local hour. A repeated hour uses its earlier instant.
  return value.year === date.year &&
    value.month === date.month &&
    value.day === date.day &&
    value.hour === hour &&
    value.minute === minute
    ? value.epochMilliseconds
    : null;
}

export function isTimeZone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)
  )
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function instant(value: string): number {
  requireTemporal();
  const result = temporal.Instant.from(value).epochMilliseconds;
  assertTimestamp(result);
  return result;
}
function assertTimestamp(value: number): void {
  requireTemporal();
  if (!Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799_999)
    throw new Error("安排时间超出可支持范围。");
}
function requireTemporal(): void {
  if (!temporal)
    throw new Error("Mochi schedules require the pinned Bun Temporal runtime");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(",");
}
