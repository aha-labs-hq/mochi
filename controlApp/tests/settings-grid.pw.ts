import { expect, test } from "@playwright/test";
import { BYOK_MAXIMUM_LABEL_LENGTH } from "../../src/runtime/byok.ts";
import type { ScheduleView } from "../../src/schedules/view.ts";
import type {} from "./desktop.pw.ts";

const schedule: ScheduleView = {
  id: `schedule:${"a".repeat(64)}`,
  title: "核对发布事项的进展并整理还需要团队决定的问题",
  task: "查看原事项和关联 PR，说明已完成的部分、阻塞以及需要谁决定什么。",
  rule: {
    kind: "weekly",
    time: "15:00",
    timeZone: "Asia/Shanghai",
    weekdays: [5],
  },
  enabled: true,
  delivery: "group",
  groupName: "一起推进产品的团队讨论群",
  revision: 1,
  nextDueAt: Date.parse("2026-10-16T07:00:00Z"),
  lastRun: null,
  problem: null,
};

for (const width of [360, 640, 1040, 1440]) {
  test(`settings share reading axes and keep their actions inside at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 640 ? 540 : 716 });
    await page.clock.install();
    let titleAxis: { x: number; y: number } | undefined;
    let valueAxis: number | undefined;
    let saveEdge: number | undefined;
    for (const route of [
      "instructions",
      "account",
      "connectors",
      "model",
      "groups",
      "schedules",
      "diagnostics",
      "about",
      "help",
    ]) {
      await page.goto(`/main/settings.html?page=${route}`);
      const main = page.getByRole("main", { name: "设置内容" });
      const heading = main.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      await expect(heading).toHaveCount(1);
      const box = (await heading.boundingBox())!;
      const panel = (await page
        .getByTestId("settings-reading-surface")
        .boundingBox())!;
      // Compact application scope has no Bot identity row. Compare the inset
      // within the reading panel, independently of that navigation height.
      const titleInset = box.y - panel.y;
      if (titleAxis) {
        expect(Math.abs(box.x - titleAxis.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(titleInset - titleAxis.y)).toBeLessThanOrEqual(1);
      } else titleAxis = { x: box.x, y: titleInset };

      if (route === "instructions") {
        valueAxis = (await main
          .getByRole("textbox", { name: "伙伴的名字" })
          .boundingBox())!.x;
        const save = (await main
          .getByRole("button", { name: "保存嘱咐", exact: true })
          .boundingBox())!;
        saveEdge = save.x + save.width;
      }
      if (route === "model") {
        const model = main.getByLabel("模型", { exact: true });
        await expect(model).toBeVisible();
        expect(
          Math.abs((await model.boundingBox())!.x - valueAxis!),
        ).toBeLessThanOrEqual(1);
        const explanation = main.getByText(
          "深度越高，越适合需要仔细推敲的问题，也可能需要更多等待。",
          { exact: true },
        );
        expect(
          Math.abs((await explanation.boundingBox())!.x - valueAxis!),
        ).toBeLessThanOrEqual(1);
        const save = (await main
          .getByRole("button", { name: "保存设置", exact: true })
          .boundingBox())!;
        expect(Math.abs(save.x + save.width - saveEdge!)).toBeLessThanOrEqual(
          1,
        );
      }
      if (route === "connectors") {
        const cards = main.locator("article[data-provider-id]");
        const first = (await cards
          .first()
          .locator("dt")
          .first()
          .boundingBox())!;
        for (const card of await cards.all()) {
          const label = (await card.locator("dt").first().boundingBox())!;
          expect(Math.abs(label.x - first.x)).toBeLessThanOrEqual(1);
          const action = (await card
            .getByRole("button", { name: /^(打开|连接) / })
            .boundingBox())!;
          const frame = (await card.boundingBox())!;
          expect(action.x + action.width).toBeLessThanOrEqual(
            frame.x + frame.width,
          );
        }
      }
      if (route === "schedules") {
        await expect(
          main.getByText("还没有安排", { exact: true }),
        ).toBeVisible();
        await page.evaluate(
          (record) => window.mochiTest.setSchedules([record]),
          schedule,
        );
        // The open list rereads itself; there is no refresh control.
        await page.clock.fastForward(16_000);
        const card = main.getByRole("article", { name: schedule.title });
        await expect(card).toBeVisible();
        const frame = (await card.boundingBox())!;
        const toggle = (await card.getByRole("switch").boundingBox())!;
        const cancel = (await card
          .getByRole("button", { name: "取消安排", exact: true })
          .boundingBox())!;
        for (const action of [toggle, cancel])
          expect(action.x + action.width).toBeLessThanOrEqual(
            frame.x + frame.width,
          );
        const values = await card.locator("dd").all();
        expect(
          Math.abs(
            (await values[0]!.boundingBox())!.x -
              (await values[1]!.boundingBox())!.x,
          ),
        ).toBeLessThanOrEqual(1);
      }
      expect(await main.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
        Math.ceil((await main.boundingBox())!.width),
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: `controlApp/.build/settings-grid/${route}-${width}.png`,
      });
    }
  });
}

for (const width of [360, 640, 1040]) {
  test(`a maximum API connection name stays readable in the model and shared pages at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 716 });
    await page.goto("/main/settings.html?page=model");
    const label = "W".repeat(BYOK_MAXIMUM_LABEL_LENGTH);
    await page.evaluate(
      (label) =>
        window.mochiTest.update({
          account: {
            status: "signedIn",
            account: {
              provider: "openai-codex",
              authType: "oauth",
              subscription: true,
            },
            connections: [
              {
                provider: "openai-codex",
                authType: "oauth",
                subscription: true,
              },
              {
                provider: "mochi-byok",
                authType: "api_key",
                subscription: false,
                label,
                model: "mochi-byok/gpt-5",
              },
            ],
          },
          policy: { model: "mochi-byok/gpt-5", reasoningEffort: "high" },
        }),
      label,
    );
    const main = page.getByRole("main", { name: "设置内容" });
    const source = main.getByRole("button", { name: new RegExp(label) });
    await expect(source.getByText(label, { exact: true })).toBeVisible();
    expect(await main.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
      Math.ceil((await main.boundingBox())!.width),
    );
    await source.click();
    await expect(
      main.getByRole("heading", { name: "模型连接", level: 1, exact: true }),
    ).toBeVisible();
    await expect(main.getByTitle(label, { exact: true })).toBeVisible();
    expect(await main.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
      Math.ceil((await main.boundingBox())!.width),
    );
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });
}
