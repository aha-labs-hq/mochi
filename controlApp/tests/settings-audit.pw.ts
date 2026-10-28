import { expect, test } from "@playwright/test";

for (const [width, height] of [
  [640, 540],
  [1040, 716],
  [1440, 900],
])
  test(`Settings visual review ${width} x ${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    for (const route of [
      "instructions",
      "connectors",
      "model",
      "groups",
      "schedules",
      "account",
      "feishu",
      "feishuServices",
      "feishuMail",
      "projects",
      "help",
      "document:github-investigation",
      "diagnostics",
    ]) {
      await page.goto(`/main/settings.html?page=${route}`);
      const content = page.getByRole("main", { name: "设置内容" });
      await expect(content.getByRole("heading", { level: 1 })).toBeVisible();
      if (route === "instructions")
        await expect(
          page.getByRole("textbox", { name: "给麻薯的嘱咐", exact: true }),
        ).toContainText("先讲结论");
      if (route === "model")
        await expect(page.getByLabel("模型", { exact: true })).toBeVisible();
      if (route === "groups")
        await expect(
          page.getByRole("region", { name: "所在群" }).getByRole("switch"),
        ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(
        await content.evaluate((el) => el.scrollWidth),
      ).toBeLessThanOrEqual(Math.ceil((await content.boundingBox())!.width));
      await page
        .locator('img[aria-hidden="true"]:visible')
        .evaluateAll(async (images) => {
          await Promise.all(
            images.map((image) => (image as HTMLImageElement).decode()),
          );
        });
      await page.screenshot({
        path: `controlApp/.build/setup-audit/${route}-${width}.png`,
      });
      if (route === "feishu") {
        const back = await page
          .getByRole("button", { name: /^返回/ })
          .boundingBox();
        const heading = await content
          .getByRole("heading", { level: 1 })
          .boundingBox();
        if (width! >= 900) {
          // The way back is part of the title line: it hangs in the margin
          // just left of the title and shares its vertical centre.
          const gap = heading!.x - (back!.x + back!.width);
          expect(gap).toBeGreaterThanOrEqual(0);
          expect(gap).toBeLessThanOrEqual(8);
          expect(
            Math.abs(
              back!.y + back!.height / 2 - (heading!.y + heading!.height / 2),
            ),
          ).toBeLessThanOrEqual(4);
        } else {
          // Without a margin to hang in, it sits on the title's axis above it.
          expect(Math.abs(back!.x - heading!.x)).toBeLessThanOrEqual(8);
          expect(back!.y + back!.height).toBeLessThanOrEqual(heading!.y);
        }
        expect(back!.height).toBeGreaterThanOrEqual(32);
      }
      const scroll =
        route === "instructions"
          ? content.locator("[data-settings-scroll]")
          : content;
      const panelBox = (await page
        .getByTestId("settings-reading-surface")
        .boundingBox())!;
      const scrollBox = (await scroll.boundingBox())!;
      expect(
        panelBox.x + panelBox.width - scrollBox.x - scrollBox.width,
      ).toBeLessThanOrEqual(2);
      await scroll.evaluate((el) => (el.scrollTop = 24));
      await page.screenshot({
        path: `controlApp/.build/setup-audit/${route}-${width}-edge.png`,
      });
      await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
      if (route !== "instructions")
        await page.screenshot({
          path: `controlApp/.build/setup-audit/${route}-${width}-bottom.png`,
        });
      else {
        await expect(
          page.getByRole("textbox", { name: "给麻薯的嘱咐" }).locator(".."),
        ).toBeInViewport({ ratio: 1 });
        await expect(
          page.getByRole("button", { name: "保存嘱咐" }),
        ).toBeInViewport({ ratio: 1 });
        await expect(content.locator("footer:visible")).toBeInViewport({
          ratio: 1,
        });
      }
    }
  });
