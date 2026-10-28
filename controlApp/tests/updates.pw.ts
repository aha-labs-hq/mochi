import { expect, test } from "@playwright/test";
import type {} from "./desktop.pw.ts";

for (const width of [360, 640, 1040]) {
  test(`update progress, waiting and recovery keep one clear action at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 716 });
    await page.goto("/main/settings.html?page=about");
    const main = page.getByRole("main", { name: "设置内容" });
    const update = {
      phase: "downloading" as const,
      target: "0.4.0",
      notes: "保留原来的伙伴与记忆，改善更新后的恢复。",
      received: 2 * 1024 ** 2,
      total: 8 * 1024 ** 2,
      checkedAt: null,
      error: null,
      preferences: { check: true, download: true, install: false },
    };
    await page.evaluate(
      (update) => window.mochiTest.update({ update }),
      update,
    );
    await expect(main.getByRole("progressbar")).toHaveAttribute(
      "value",
      String(update.received),
    );
    await main.getByRole("button", { name: "暂停下载" }).click();
    expect(await page.evaluate(() => window.mochiTest.actions.at(-1))).toEqual({
      type: "pauseUpdate",
    });
    await page.evaluate(
      (update) =>
        window.mochiTest.update({ update: { ...update, phase: "ready" } }),
      update,
    );
    const install = main.getByRole("button", {
      name: "空闲时更新",
      exact: true,
    });
    await install.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.mochiTest.actions.at(-1))).toEqual({
      type: "installUpdate",
    });
    await page.evaluate(
      (update) =>
        window.mochiTest.update({ update: { ...update, phase: "waiting" } }),
      update,
    );
    await expect(main.getByRole("progressbar")).toHaveCount(0);
    await main.getByRole("button", { name: "取消本次更新" }).click();
    expect(await page.evaluate(() => window.mochiTest.actions.at(-1))).toEqual({
      type: "cancelUpdate",
    });
    const automatic = main.getByRole("switch", { name: "空闲时自动安装" });
    await expect(automatic).not.toBeChecked();
    await automatic.focus();
    await page.keyboard.press("Space");
    expect(await page.evaluate(() => window.mochiTest.actions.at(-1))).toEqual({
      type: "setUpdatePreferences",
      preferences: { check: true, download: true, install: true },
    });
    await page.screenshot({
      path: `controlApp/.build/update-review/waiting-${width}.png`,
    });
    await page.evaluate(
      (update) =>
        window.mochiTest.update({
          update: { ...update, phase: "failed", error: "installation" },
        }),
      update,
    );
    await expect(
      main.getByText("这次更新没有完成，当前版本已保留。可以重试。"),
    ).toBeVisible();
    await expect(main.getByText(/登录项与扩展/)).toHaveCount(0);
    await expect(
      main.getByRole("button", { name: "重试", exact: true }),
    ).toBeVisible();
    await page.evaluate(
      (update) =>
        window.mochiTest.update({
          update: { ...update, phase: "failed", error: "recovery" },
        }),
      update,
    );
    await main.getByRole("button", { name: "继续恢复" }).click();
    expect(await page.evaluate(() => window.mochiTest.actions.at(-1))).toEqual({
      type: "retryUpdate",
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({
      path: `controlApp/.build/update-review/recovery-${width}.png`,
    });
  });
}
