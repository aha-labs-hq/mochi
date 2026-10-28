import { expect, test } from "@playwright/test";

for (const provider of ["ChatGPT", "GitHub"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1378, height: 660 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    test(`${provider} callback presentation at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const requests: string[] = [];
      page.on("request", (request) =>
        requests.push(new URL(request.url()).pathname),
      );
      for (const outcome of provider === "GitHub"
        ? ["received", "rejected", "installation"]
        : ["received", "rejected"]) {
        const route = `/oauth/${provider === "GitHub" ? "github/" : ""}${outcome}`;
        await page.goto(`${route}?code=fixture-only&state=fixture-only`);
        await expect(page).toHaveURL(new RegExp(`${route}$`));
        await expect(page.locator("h1")).toHaveText(
          outcome === "installation"
            ? "可以回到 Mochi，查看可用项目了"
            : outcome === "received"
              ? `${provider} 授权已收到，可以回到 Mochi 了`
              : "这次没能完成授权",
        );
        expect(
          await page
            .locator(".portrait img")
            .evaluate(
              (image: HTMLImageElement) =>
                image.complete && image.naturalWidth === 512,
            ),
        ).toBe(true);
        const geometry = await page.evaluate(() => {
          const elements = [".portrait", "h1", ".detail", "button"].map(
            (selector) =>
              document.querySelector(selector)!.getBoundingClientRect(),
          );
          return {
            width: document.documentElement.scrollWidth,
            fitting: elements.every(
              (rect) => rect.left >= 0 && rect.right <= innerWidth,
            ),
            ordered: elements.every(
              (rect, index) =>
                index === 0 || rect.top >= elements[index - 1]!.bottom,
            ),
            actionVisible: elements.at(-1)!.bottom <= innerHeight,
          };
        });
        expect(geometry).toEqual({
          width: viewport.width,
          fitting: true,
          ordered: true,
          actionVisible: true,
        });
        await page.getByRole("button", { name: "关闭页面" }).focus();
        await expect(
          page.getByRole("button", { name: "关闭页面" }),
        ).toBeFocused();
        await page.screenshot({
          path: test.info().outputPath(`${outcome}.png`),
          fullPage: true,
        });
      }
      expect(errors).toEqual([]);
      expect(requests.every((path) => path.startsWith("/oauth/"))).toBe(true);
    });
  }
}

test("a browser that refuses closing retains a clear next action", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.close = () => {};
  });
  await page.goto("/oauth/received");
  await page.getByRole("button", { name: "关闭页面" }).click();
  await expect(page.getByRole("status")).toContainText("再切回 Mochi");
});

test("closing a script-opened callback tab works", async ({ page }) => {
  await page.goto("/oauth/received");
  const opened = page.waitForEvent("popup");
  await page.evaluate(() => window.open(location.pathname));
  const callback = await opened;
  await callback.waitForLoadState();
  const closed = callback.waitForEvent("close");
  await callback.getByRole("button", { name: "关闭页面" }).click();
  await closed;
});
