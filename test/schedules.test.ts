import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleDispatcher } from "../src/schedules/dispatcher.ts";
import {
  MAXIMUM_SCHEDULES,
  SCHEDULE_SCHEMA,
  type ScheduleDefinition,
  ScheduleStore,
} from "../src/schedules/store.ts";
import {
  latestDueOccurrence,
  nextOccurrence,
  parseScheduleRule,
} from "../src/schedules/time.ts";

const instant = (value: string) => Date.parse(value);
const id = (digit = "a") => `schedule:${digit.repeat(64)}`;
const daily = {
  kind: "daily",
  time: "09:00",
  timeZone: "Asia/Shanghai",
} as const;
const definition = (
  rule: ScheduleDefinition["rule"] = daily,
): ScheduleDefinition => ({
  title: "核对本周进展",
  task: "核对这个事项还有什么阻塞，给出原始依据。",
  rule,
  appId: "cli_example",
  chatId: "oc_example",
  threadKey: "omt_example",
  replyMessageId: "om_example",
  requesterId: "ou_example",
  delivery: "group",
  sourceMessageLink: null,
  threadTarget: null,
  resources: [
    {
      connectionId: "github:1",
      resourceId: "repository:2",
      selectionId: "a".repeat(32),
    },
  ],
});

describe("schedule dispatch admission", () => {
  test("busy admission preserves the due time; parallel ticks execute once", async () => {
    const { store } = fixture();
    store.create(id(), definition(), instant("2026-10-01T00:00Z"));
    let allowed = false;
    let finish!: () => void;
    let executions = 0;
    const dispatcher = new ScheduleDispatcher({
      store,
      now: () => instant("2026-10-03T02:00Z"),
      canStart: () => allowed,
      executionFailed: () => {
        throw new Error("Unexpected execution failure");
      },
      failed: () => {
        throw new Error("Unexpected infrastructure failure");
      },
      execute: async () => {
        executions++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { status: "delivered", problem: null };
      },
    });
    expect(await dispatcher.tick()).toBeNull();
    expect(store.get(id()).nextDueAt).toBe(instant("2026-10-01T01:00Z"));
    allowed = true;
    const first = dispatcher.tick();
    const second = dispatcher.tick();
    await Promise.resolve();
    expect(second).toBe(first);
    expect(executions).toBe(1);
    finish();
    await first;
    expect(await dispatcher.tick()).toBeNull();
    expect(store.get(id()).lastRun?.status).toBe("delivered");
    await dispatcher.close();
    expect(await dispatcher.tick()).toBeNull();
  });
  test("delivery ambiguity is failed, never replayed, while a later cycle can run", async () => {
    const { store } = fixture();
    let now = instant("2026-10-01T01:00Z");
    store.create(id(), definition(), now - 60_000);
    let executions = 0;
    const errors: unknown[] = [];
    const dispatcher = new ScheduleDispatcher({
      store,
      now: () => now,
      canStart: () => true,
      executionFailed: (_occurrence, error) => {
        errors.push(error);
      },
      failed: () => {},
      execute: async () => {
        executions++;
        if (executions === 1) throw new Error("Delivery uncertain");
        return { status: "delivered", problem: null };
      },
    });
    await dispatcher.tick();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("Delivery uncertain");
    expect(store.get(id()).lastRun?.status).toBe("failed");
    expect(await dispatcher.tick()).toBeNull();
    expect(executions).toBe(1);
    now += 86_400_000;
    await dispatcher.tick();
    expect(executions).toBe(2);
    expect(store.get(id()).lastRun?.status).toBe("delivered");
    await dispatcher.close();
  });
  test("closing waits for accepted work without accepting another occurrence", async () => {
    const { store } = fixture();
    store.create(id(), definition(), instant("2026-10-01T00:00Z"));
    let finish!: () => void;
    const dispatcher = new ScheduleDispatcher({
      store,
      now: () => instant("2026-10-01T01:00Z"),
      canStart: () => true,
      executionFailed: () => {},
      failed: () => {},
      execute: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { status: "delivered", problem: null };
      },
    });
    const running = dispatcher.tick();
    await Promise.resolve();
    let closed = false;
    const closing = dispatcher.close().then(() => {
      closed = true;
    });
    await Bun.sleep(1);
    expect(closed).toBe(false);
    finish();
    await closing;
    await running;
    expect(store.get(id()).lastRun?.status).toBe("delivered");
    expect(await dispatcher.tick()).toBeNull();
  });
});
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dispose.splice(0).reverse()) cleanup();
});
function fixture(path = ":memory:") {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEDULE_SCHEMA);
  dispose.push(() => db.close());
  return { db, store: new ScheduleStore(db) };
}

describe("schedule calendar", () => {
  test("strict future, daily, weekly and offset-bearing one-time instants", () => {
    const now = instant("2026-10-03T01:00:00Z");
    expect(nextOccurrence(daily, now)).toBe(instant("2026-10-04T01:00:00Z"));
    expect(
      nextOccurrence(
        {
          kind: "weekly",
          time: "15:00",
          timeZone: "Asia/Shanghai",
          weekdays: [5],
        },
        now,
      ),
    ).toBe(instant("2026-10-09T07:00:00Z"));
    const once = parseScheduleRule({
      kind: "once",
      at: "2026-10-03T15:00:00+08:00",
      timeZone: "Asia/Shanghai",
    });
    expect(nextOccurrence(once, now)).toBe(instant("2026-10-03T07:00:00Z"));
    expect(nextOccurrence(once, instant("2026-10-03T07:00:00Z"))).toBeNull();
  });
  test("rejects invalid zones, offsets as zones, implicit zones and impossible rules", () => {
    for (const value of [
      { kind: "daily", time: "25:00", timeZone: "Asia/Shanghai" },
      { kind: "daily", time: "09:00", timeZone: "Mars/Base" },
      { kind: "daily", time: "09:00", timeZone: "+08:00" },
      { kind: "weekly", time: "09:00", timeZone: "UTC", weekdays: [] },
      { kind: "weekly", time: "09:00", timeZone: "UTC", weekdays: [1, 1] },
      { kind: "once", at: "2026-10-03T09:00", timeZone: "UTC" },
      { kind: "once", at: "2026-02-30T09:00Z", timeZone: "UTC" },
      { kind: "daily", time: "09:00", timeZone: "UTC", cron: "* * * * *" },
    ])
      expect(() => parseScheduleRule(value)).toThrow();
  });
  test("skips nonexistent DST time and executes only the first repeated time", () => {
    const spring = {
      kind: "daily",
      time: "02:30",
      timeZone: "America/Los_Angeles",
    } as const;
    expect(nextOccurrence(spring, instant("2026-03-08T00:00Z"))).toBe(
      instant("2026-03-09T09:30Z"),
    );
    const autumn = {
      kind: "daily",
      time: "01:30",
      timeZone: "America/Los_Angeles",
    } as const;
    expect(nextOccurrence(autumn, instant("2026-11-01T00:00Z"))).toBe(
      instant("2026-11-01T08:30Z"),
    );
    expect(nextOccurrence(autumn, instant("2026-11-01T08:30Z"))).toBe(
      instant("2026-11-02T09:30Z"),
    );
    expect(
      latestDueOccurrence(
        autumn,
        instant("2026-11-01T08:30Z"),
        instant("2026-11-01T09:45Z"),
      ),
    ).toBe(instant("2026-11-01T08:30Z"));
  });
  test("handles a skipped calendar day and half-hour DST", () => {
    expect(
      nextOccurrence(
        { kind: "daily", time: "09:00", timeZone: "Pacific/Apia" },
        instant("2011-12-29T20:00Z"),
      ),
    ).toBe(instant("2011-12-30T19:00Z"));
    expect(
      nextOccurrence(
        { kind: "daily", time: "02:15", timeZone: "Australia/Lord_Howe" },
        instant("2026-10-03T12:00Z"),
      ),
    ).toBe(instant("2026-10-04T15:15Z"));
  });
  test("offline recurrence retains the newest occurrence without changing the fixed zone", () => {
    expect(
      latestDueOccurrence(
        daily,
        instant("2026-10-01T01:00Z"),
        instant("2026-10-09T05:00Z"),
      ),
    ).toBe(instant("2026-10-09T01:00Z"));
    expect(
      latestDueOccurrence(
        daily,
        instant("2026-10-10T01:00Z"),
        instant("2026-10-09T05:00Z"),
      ),
    ).toBeNull();
  });
});

describe("schedule persistence", () => {
  test("claims and advances atomically, coalesces a week of missed work", () => {
    const { store } = fixture();
    store.create(id(), definition(), instant("2026-10-01T00:00Z"));
    const due = store.due(instant("2026-10-09T05:00Z"))!;
    const claimed = store.claim(
      due.id,
      due.revision,
      instant("2026-10-09T05:00Z"),
    )!;
    expect(claimed.dueAt).toBe(instant("2026-10-09T01:00Z"));
    expect(claimed.coalesced).toBe(true);
    expect(store.due(instant("2026-10-09T05:00Z"))).toBeNull();
    expect(store.get(id()).nextDueAt).toBe(instant("2026-10-10T01:00Z"));
    expect(
      store.claim(due.id, due.revision, instant("2026-10-09T05:00Z")),
    ).toBeNull();
    store.finish(
      due.id,
      claimed.dueAt,
      "delivered",
      instant("2026-10-09T05:01Z"),
    );
    expect(store.get(id()).lastRun?.status).toBe("delivered");
  });
  test("restart marks ambiguous execution interrupted and never replays it", () => {
    const root = mkdtempSync(join(tmpdir(), "mochi-schedule-"));
    dispose.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "state.sqlite");
    const first = fixture(path);
    first.store.create(
      id(),
      definition({
        kind: "once",
        at: "2026-10-03T01:00Z",
        timeZone: "Asia/Shanghai",
      }),
      instant("2026-10-03T00:00Z"),
    );
    first.store.claim(id(), 1, instant("2026-10-03T01:00Z"));
    first.db.close();
    dispose.pop();
    const restored = fixture(path).store;
    expect(restored.recoverInterrupted(instant("2026-10-03T01:10Z"))).toBe(1);
    expect(restored.recoverInterrupted(instant("2026-10-03T01:11Z"))).toBe(0);
    expect(restored.due(instant("2026-10-03T01:10Z"))).toBeNull();
    expect(restored.get(id()).lastRun?.status).toBe("interrupted");
    expect(
      restored.create(
        id(),
        definition({
          kind: "once",
          at: "2026-10-03T01:00Z",
          timeZone: "Asia/Shanghai",
        }),
        instant("2026-10-03T01:10Z"),
      ).id,
    ).toBe(id());
  });
  test("paused work is not claimed; resuming skips elapsed cycles and rejects expired once", () => {
    const { store } = fixture();
    store.create(id(), definition(), instant("2026-10-01T00:00Z"));
    store.setEnabled(id(), 1, false, instant("2026-10-01T00:30Z"));
    expect(store.due(instant("2026-10-03T02:00Z"))).toBeNull();
    const resumed = store.setEnabled(
      id(),
      2,
      true,
      instant("2026-10-03T02:00Z"),
    );
    expect(resumed.nextDueAt).toBe(instant("2026-10-04T01:00Z"));
    store.create(
      id("b"),
      definition({ kind: "once", at: "2026-10-03T01:00Z", timeZone: "UTC" }),
      instant("2026-10-01T00:00Z"),
    );
    store.setEnabled(id("b"), 1, false, instant("2026-10-01T00:30Z"));
    expect(() =>
      store.setEnabled(id("b"), 2, true, instant("2026-10-03T02:00Z")),
    ).toThrow("过期");
  });
  test("repeating the current switch state preserves an overdue occurrence; cancellation does not replay accepted work", () => {
    const { store, db } = fixture();
    const saved = store.create(
      id(),
      definition(),
      instant("2026-10-01T00:00Z"),
    );
    const now = instant("2026-10-03T02:00Z");
    expect(store.setEnabled(saved.id, saved.revision, true, now)).toEqual(
      saved,
    );
    const claim = store.claim(saved.id, saved.revision, now)!;
    store.setEnabled(saved.id, saved.revision + 1, false, now);
    store.finish(saved.id, claim.dueAt, "delivered", now + 1);
    expect(store.get(saved.id).lastRun?.status).toBe("delivered");
    expect(store.due(now + 86_400_000)).toBeNull();
    store.cancel(saved.id, saved.revision + 2);
    expect(store.list()).toEqual([]);
    expect(db.query("SELECT * FROM schedule_runs").all()).toEqual([]);
    store.finish(saved.id, claim.dueAt, "delivered", now + 2);
    expect(store.list()).toEqual([]);
  });
  test("revision conflicts, damaged definitions and crossed Bot storage fail closed", () => {
    const a = fixture();
    const b = fixture();
    a.store.create(id(), definition(), instant("2026-10-01T00:00Z"));
    expect(b.store.list()).toEqual([]);
    expect(() => b.store.get(id())).toThrow("没有找到");
    expect(() => a.store.cancel(id(), 2)).toThrow("变化");
    expect(() =>
      a.store.create(
        id("b"),
        {
          ...definition(),
          resources: [{ ...definition().resources[0]!, selectionId: "bad" }],
        },
        instant("2026-10-01T00:00Z"),
      ),
    ).toThrow("资源");
    a.db
      .query("UPDATE schedules SET definition_json = ?")
      .run('{"title":"broken"}');
    expect(() => a.store.list()).toThrow("定义");
  });
  test("invalid persisted occurrence times stop at the read boundary", () => {
    const { store, db } = fixture();
    store.create(id(), definition(), instant("2026-10-01T00:00Z"));
    db.query("UPDATE schedules SET next_due_at = ?").run(
      instant("2026-10-01T02:00Z"),
    );
    expect(() => store.list()).toThrow("持久记录");
    expect(() => store.due(instant("2026-10-02T02:00Z"))).toThrow("持久记录");
  });
  test("bounds both definitions and retained run metadata", () => {
    const { store, db } = fixture();
    const start = instant("2026-10-01T00:00Z");
    for (let index = 0; index < MAXIMUM_SCHEDULES; index++)
      store.create(
        `schedule:${index.toString(16).padStart(64, "0")}`,
        definition(),
        start,
      );
    expect(() => store.create(id(), definition(), start)).toThrow("最多");
    for (let index = 0; index < 30; index++) {
      const current = store.get(`schedule:${"0".repeat(64)}`);
      const now = start + (index + 1) * 86_400_000;
      const claim = store.claim(current.id, current.revision, now)!;
      store.finish(current.id, claim.dueAt, "delivered", now);
    }
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id = ?",
        )
        .get(`schedule:${"0".repeat(64)}`)?.count,
    ).toBe(20);
  });
});
