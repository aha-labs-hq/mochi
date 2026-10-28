import { expect, test } from "@playwright/test";

for (const surface of ["intro", "setup", "companion", "encounter"]) {
  for (const viewport of [
    { width: 360, height: 509 },
    { width: 960, height: 680 },
  ]) {
    test(`missing character ${surface} ${viewport.width}: recovery stays readable and clear of product controls`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.route("**/assets/MochiCompanion.png", (route) =>
        route.abort(),
      );
      await page.goto(`/main/index.html?surface=${surface}`);
      if (surface === "setup") {
        await page.evaluate(() => {
          window.mochiTest.update({
            setup: "signIn",
            account: { status: "signedOut" },
          });
          window.mochiTest.beginSetup();
        });
      }
      const failure = page.getByRole("alert");
      await expect(failure).toContainText("角色");
      await expect(failure).toBeInViewport({ ratio: 1 });
      const bounds = (await failure.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(160);
      expect(bounds.height).toBeLessThanOrEqual(88);
      expect(
        await failure.evaluate((node) => node.scrollWidth),
      ).toBeLessThanOrEqual(bounds.width);
      if (surface === "intro" || surface === "setup") {
        const panel = (await page.getByTestId("felt-frame").boundingBox())!;
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(panel.y);
      }
      await expect(failure).toContainText("重新打开 Mochi");
      await expect(failure).not.toContainText("更新");
      if (surface === "intro") {
        await page.getByRole("button", { name: "看看麻薯怎么协作" }).click();
        await page.getByRole("button", { name: "产品", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "开始设置" }),
        ).toBeVisible();
      }
      if (surface === "encounter") {
        await page.getByRole("button", { name: /跳过开场/ }).click();
        await expect(page.getByTestId("setup-journey")).toBeVisible();
      }
      expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
      await page.screenshot({
        path: `controlApp/.build/recovery-${surface}-${viewport.width}.png`,
      });
    });
  }
}

for (const viewport of [
  { width: 360, height: 509 },
  { width: 960, height: 680 },
]) {
  test(`introduction ${viewport.width}: scrollbar compatibility and the entire primary action`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/main/index.html?surface=intro");
    const scroll = page
      .locator("[data-intro-view=welcome] [class*=overflow-y-auto]")
      .first();
    const action = page.getByRole("button", { name: "看看麻薯怎么协作" });
    // Sonoma's original WebKit ignores scrollbar-width. Exercise the supported
    // pseudo-element independently of the newer engine's standard property.
    await scroll.evaluate((node) =>
      (node as HTMLElement).style.setProperty(
        "scrollbar-width",
        "auto",
        "important",
      ),
    );
    expect(
      await scroll.evaluate(
        (node) => getComputedStyle(node, "::-webkit-scrollbar").display,
      ),
    ).toBe("none");
    await expect(action).toBeInViewport({ ratio: 1 });
    for (const paragraph of await scroll.locator("p").all())
      await expect(paragraph).toBeInViewport({ ratio: 1 });
    const bounds = (await action.boundingBox())!;
    const panel = (await page.getByTestId("felt-frame").boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      panel.y + panel.height - 8,
    );
    await action.click();
    await page.getByRole("button", { name: "产品", exact: true }).click();
    const transcript = page.getByTestId("story-thread");
    await transcript.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    expect(await transcript.evaluate((node) => node.scrollTop)).toBeGreaterThan(
      0,
    );
  });
}
