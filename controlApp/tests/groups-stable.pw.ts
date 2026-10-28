import { expect, test } from "@playwright/test";
import type {} from "./desktop.pw.ts";

for (const width of [640, 1040]) {
  test(`groups keep their place while one switches and need no refresh at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 716 });
    await page.goto("/main/settings.html?page=groups");
    const groups = page.getByRole("region", { name: "所在群" });
    const toggle = groups.getByRole("switch").first();
    await expect(toggle).toBeEnabled();
    // The Bot keeps the list current, so there is no refresh control at all.
    await expect(groups.getByRole("button")).toHaveCount(0);
    const geometry = () =>
      groups.evaluate((node) =>
        ["#group-participation-help", "ul", "li"].map((selector) => {
          const box = node.querySelector(selector)!.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }),
      );
    const before = await geometry();
    await page.evaluate(() => window.mochiTest.holdActions());
    await toggle.click();
    await expect(groups.getByText("正在更新…", { exact: true })).toBeVisible();
    expect(await geometry()).toEqual(before);
    await page.screenshot({
      path: `controlApp/.build/groups-switching-${width}.png`,
    });
    await page.evaluate(() => window.mochiTest.releaseActions());
    await expect(groups.getByText("正在更新…", { exact: true })).toHaveCount(0);
    expect(await geometry()).toEqual(before);
  });
}
