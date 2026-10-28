import { expect, type Page, test } from "@playwright/test";
import type { ScheduleView } from "../../src/schedules/view.ts";
import type {} from "./desktop.pw.ts";

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4222-8222-222222222222";
const arrangement = (patch: Partial<ScheduleView> = {}): ScheduleView => ({
  id: `schedule:${"a".repeat(64)}`,
  title: "发布事项进展",
  task: "核对 Issue 20 的关联 PR 与阻塞，说明需要谁决定什么，并附上依据。",
  rule: {
    kind: "weekly",
    time: "15:00",
    timeZone: "Asia/Shanghai",
    weekdays: [5],
  },
  enabled: true,
  delivery: "group",
  groupName: "产品协作群",
  revision: 1,
  nextDueAt: Date.parse("2026-10-09T07:00:00Z"),
  lastRun: {
    status: "delivered",
    dueAt: Date.parse("2026-10-02T07:00Z"),
    startedAt: Date.parse("2026-10-02T07:00Z"),
    finishedAt: Date.parse("2026-10-02T07:02Z"),
    problem: null,
  },
  problem: null,
  ...patch,
});
/** The open list rereads itself on a timer; the test moves time instead of waiting. */
async function reread(page: Page) {
  await page.clock.fastForward(16_000);
}
async function show(page: Page, records: ScheduleView[] = [arrangement()]) {
  await page.clock.install();
  await page.goto("/main/settings.html?page=schedules");
  await expect(page.getByText("还没有安排", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /刷新/ })).toHaveCount(0);
  await page.evaluate((items) => window.mochiTest.setSchedules(items), records);
  await reread(page);
  await expect(
    page.getByRole("article", { name: records[0]!.title }),
  ).toBeVisible();
}

for (const colorScheme of ["light", "dark"] as const)
  for (const width of [360, 1040]) {
    test(`arrangements ${colorScheme} ${width}: coherent work, time and delivery without overflow`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: width === 360 ? 700 : 840 });
      await page.emulateMedia({ colorScheme });
      await show(page);
      // WebKit rounds horizontal scroll offsets; allow less than one pixel at
      // the button edge, well inside its padding rather than its label or icon.
      await expect(
        page
          .getByRole("navigation", { name: "设置分类" })
          .getByRole("button", { name: "安排", exact: true }),
      ).toBeInViewport({ ratio: 0.99 });
      const item = page.getByRole("article", { name: "发布事项进展" });
      await expect(item).toContainText("每周五 15:00");
      await expect(item).toContainText("10月9日");
      await expect(item).toContainText("产品协作群 · 群里的一条新消息");
      await expect(item).toContainText("已发出");
      await expect(
        page.getByText("Mac 开着、这位伙伴在值班时才会执行", { exact: false }),
      ).toBeVisible();
      await expect(item.getByRole("switch")).toBeInViewport({ ratio: 1 });
      await expect(
        item.getByRole("button", { name: "取消安排", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: `controlApp/.build/settings-schedules-${colorScheme}-${width}.png`,
      });
      await item.getByText("工作内容", { exact: true }).click();
      await expect(
        item.getByText(arrangement().task, { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: `controlApp/.build/settings-schedules-${colorScheme}-${width}-expanded.png`,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(errors).toEqual([]);
    });
  }

test("multiple arrangements share one readable list without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 840 });
  await page.emulateMedia({ colorScheme: "light" });
  await show(page, [
    arrangement(),
    arrangement({
      id: `schedule:${"b".repeat(64)}`,
      title: "每日发布检查",
      task: "查看今天的发布状态，整理仍需跟进的事项。",
      rule: {
        kind: "daily",
        time: "09:30",
        timeZone: "Asia/Shanghai",
      },
      groupName: "项目运营群",
      lastRun: null,
      nextDueAt: Date.parse("2026-10-04T01:30:00Z"),
    }),
  ]);
  const section = page.getByRole("region", { name: "安排列表" });
  await expect(section.getByRole("article")).toHaveCount(2);
  await expect(section.getByRole("article").nth(1)).toContainText(
    "每日发布检查",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1040,
  );
  await page.screenshot({
    path: "controlApp/.build/settings-schedules-light-1040-multiple.png",
  });
});

test("pause waits for authority readback, blocks closing, and cancel requires one local decision", async ({
  page,
}) => {
  await show(page);
  const item = page.getByRole("article", { name: "发布事项进展" });
  const toggle = item.getByRole("switch");
  await page.evaluate(() => window.mochiTest.holdActions());
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  expect((await page.evaluate(() => window.mochiTest.closeState())).busy).toBe(
    true,
  );
  await page.evaluate(() => window.mochiTest.releaseActions());
  await expect(toggle).not.toBeChecked();
  await expect(item).toContainText("已暂停");
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.closeState().busy))
    .toBe(false);
  await item.getByRole("button", { name: "取消安排", exact: true }).click();
  await expect(item).toContainText("取消这项安排？");
  expect(
    (await page.evaluate(() => window.mochiTest.actions)).map(
      (action) => action.type,
    ),
  ).toEqual(["setScheduleEnabled"]);
  await item.getByRole("button", { name: "保留", exact: true }).click();
  await item.getByRole("button", { name: "取消安排", exact: true }).click();
  await item.getByRole("button", { name: "取消安排", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText("还没有安排", { exact: true })).toBeVisible();
  expect(
    (await page.evaluate(() => window.mochiTest.botWrites)).map(
      (write) => write.kind,
    ),
  ).toEqual(["setScheduleEnabled", "cancelSchedule"]);
});

test("quiet delivery, running cancellation and ambiguous failures preserve honest copy", async ({
  page,
}) => {
  await show(page, [
    arrangement({
      delivery: "thread",
      lastRun: {
        status: "running",
        dueAt: 1000,
        startedAt: 1001,
        finishedAt: null,
        problem: null,
      },
    }),
  ]);
  const item = page.getByRole("article", { name: "发布事项进展" });
  await expect(item).toContainText("约定的话题内回复");
  await expect(item).toContainText("正在处理");
  await item.getByRole("button", { name: "取消安排", exact: true }).click();
  await expect(item).toContainText("已经开始的工作仍会交付");
  await item.getByRole("button", { name: "保留", exact: true }).click();
  await page.evaluate(
    (record) => window.mochiTest.setSchedules([record]),
    arrangement({
      lastRun: {
        status: "failed",
        dueAt: 1000,
        startedAt: 1001,
        finishedAt: 1002,
        problem: "delivery_failed",
      },
    }),
  );
  await reread(page);
  await expect(item).toContainText("无法确认这次结果已发出，没有自动重发");
  await expect(item).not.toContainText("最近交付");
});

test("expired once and revision conflicts keep the saved switch state and a concrete next action", async ({
  page,
}) => {
  await show(page, [
    arrangement({
      enabled: false,
      lastRun: null,
      rule: {
        kind: "once",
        at: "2020-10-03T07:00:00Z",
        timeZone: "Asia/Shanghai",
      },
    }),
  ]);
  const toggle = page.getByRole("switch", { name: "发布事项进展：开启安排" });
  await toggle.click();
  await expect(page.getByRole("alert")).toContainText(
    "请在群里告诉伙伴新的时间",
  );
  await expect(toggle).not.toBeChecked();
  await page.evaluate(() =>
    window.mochiTest.failAction("schedules_conflict", "setScheduleEnabled"),
  );
  await toggle.click();
  await expect(page.getByRole("alert")).toContainText("列表已按最新内容显示");
  await expect(toggle).not.toBeChecked();
});

test("disconnect removes cached work and reconnect reads the current Bot records", async ({
  page,
}) => {
  await show(page);
  await page.evaluate(() =>
    window.mochiTest.update({ controlReady: false, eventStreamReady: false }),
  );
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByText("后台连接后，可以查看这位伙伴的安排。"),
  ).toBeVisible();
  await page.evaluate(() => {
    window.mochiTest.setSchedules([]);
    window.mochiTest.update({ controlReady: true });
  });
  await expect(page.getByText("还没有安排", { exact: true })).toBeVisible();
  await expect(
    page.getByText("安排会等恢复后再开始", { exact: false }),
  ).toBeVisible();
});

test("a late read from another Bot stays in its original scope", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  expect(await page.evaluate(() => window.mochiTest.scheduleRequests())).toBe(
    0,
  );
  await page.evaluate(
    ({ a, b, first, second }) => {
      window.mochiTest.update({ selectedBotId: a });
      window.mochiTest.setSchedules([first], a);
      window.mochiTest.setSchedules([second], b);
      window.mochiTest.holdSchedules();
      window.mochiTest.navigate({ page: "schedules" });
    },
    {
      a: A,
      b: B,
      first: arrangement({ title: "A 的独立安排" }),
      second: arrangement({
        id: `schedule:${"b".repeat(64)}`,
        title: "B 的独立安排",
      }),
    },
  );
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.scheduleRequests()))
    .toBe(1);
  await page.evaluate(
    (id) => window.mochiTest.update({ selectedBotId: id }),
    B,
  );
  await page.getByRole("button", { name: "安排", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.scheduleRequests()))
    .toBe(2);
  await page.evaluate(() => window.mochiTest.releaseSchedules());
  await expect(
    page.getByRole("article", { name: "B 的独立安排" }),
  ).toBeVisible();
  await expect(page.getByText("A 的独立安排", { exact: true })).toHaveCount(0);
});
