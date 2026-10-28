import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 360, height: 509 },
  { width: 520, height: 700 },
  { width: 960, height: 680 },
]) {
  test(`installation ${viewport.width}: one readable surface contains its close control and action`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/main/index.html");
    await page.evaluate(() => {
      window.mochiTest.update({
        locationReady: true,
        installed: false,
        controlReady: false,
        phase: "notInstalled",
        setup: "install",
        busy: null,
        problem: null,
        bots: [],
        selectedBotId: null,
        account: { status: "signedOut" },
        feishu: { active: null, candidate: null },
        github: { status: "disconnected", account: null, problem: null },
      });
      window.mochiTest.beginSetup();
    });
    const panel = page.getByTestId("setup-journey");
    await expect(panel.getByRole("heading", { level: 1 })).toBeInViewport({
      ratio: 1,
    });
    await expect(
      panel.getByRole("button", { name: "安装并继续", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const close = panel.getByRole("button", { name: "关闭窗口", exact: true });
    await expect(close).toBeInViewport({ ratio: 1 });
    const bounds = await panel.boundingBox();
    const control = await close.boundingBox();
    expect(control!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(control!.x + control!.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width,
    );
    expect(control!.y).toBeGreaterThanOrEqual(bounds!.y);
    await page.screenshot({
      path: `controlApp/.build/clarity-installation-${viewport.width}.png`,
    });
    await close.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#root")).toHaveAttribute(
      "data-window-closed",
      "true",
    );
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });
  test(`first glance ${viewport.width}: purpose, quota and primary action are visible before any scroll`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.goto("/main/index.html");
    await page.evaluate(() => window.mochiTest.beginSetup());
    await page.evaluate(() =>
      window.mochiTest.update({
        setup: "signIn",
        account: { status: "signedOut" },
        feishu: { active: null, candidate: null },
        github: { status: "disconnected", account: null, problem: null },
        githubProjects: null,
      }),
    );
    const title = page.getByRole("heading", {
      name: "连接模型",
      exact: true,
    });
    await expect(title).toBeFocused();
    const quota = page.getByText(
      "使用 ChatGPT 订阅，或添加一个或多个模型 API 连接。",
    );
    const action = page.getByRole("button", {
      name: "连接 ChatGPT",
      exact: true,
    });
    await expect(title).toBeInViewport({ ratio: 1 });
    // WebKit rounds fractional widths at 520 px; no actual text is clipped.
    await expect(quota).toBeInViewport({ ratio: 0.999 });
    await expect(action).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByText("已完成的连接会保留，可以随时回来继续。"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "准备进度" }),
    ).not.toContainText("已完成");
    // Main reading text must remain legible in either OS appearance; no translucent texture behind it.
    await expect(quota).toHaveCSS("font-size", "14px");
    await page.screenshot({
      path: `controlApp/.build/clarity-chatgpt-${viewport.width}.png`,
    });
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });
  test(`introduction ${viewport.width}: role choice precedes the labelled conversation`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/main/index.html?surface=intro");
    await expect(page.getByRole("button", { name: "开始设置" })).toHaveCount(0);
    await page
      .getByRole("button", { name: "看看麻薯怎么协作", exact: true })
      .click();
    await page.getByRole("button", { name: "产品", exact: true }).click();
    await expect(page.getByTestId("story-message-0")).toBeInViewport({
      ratio: 0.99,
    });
    await expect(page.getByRole("button", { name: "开始设置" })).toBeInViewport(
      { ratio: 1 },
    );
    await expect(page.getByText("对话示例", { exact: true })).toBeVisible();
    const source = page
      .getByTestId("story-message-2")
      .getByRole("link")
      .first();
    await expect(page.getByTestId("story-message-0")).toHaveCSS("opacity", "1");
    await source.scrollIntoViewIfNeeded();
    // WebKit rounds the intersection of fractional container coordinates.
    await expect(source).toBeInViewport({ ratio: 0.99 });
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
    await page.locator("[data-journey-scroll]").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.getByRole("heading", { level: 1 }).focus();
    await page.screenshot({
      path: `controlApp/.build/clarity-intro-${viewport.width}.png`,
    });
  });
}

test("a new task resets its reading position after an interrupted long step", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 509 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/main/index.html");
  await page.evaluate(() => window.mochiTest.beginSetup());
  await page.evaluate(() =>
    window.mochiTest.update({
      setup: null,
      feishu: {
        active: null,
        candidate: {
          brand: "feishu" as const,
          state: "needsAction",
          bot: null,
          problem: "permissions_required",
        },
      },
    }),
  );
  const scroll = page.locator("[data-journey-scroll]");
  expect(await scroll.evaluate((node) => node.scrollHeight)).toBeGreaterThan(
    await scroll.evaluate((node) => node.clientHeight),
  );
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(await scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(() =>
    window.mochiTest.update({
      setup: "signIn",
      account: { status: "signedOut" },
    }),
  );
  const heading = page.getByRole("heading", {
    name: "连接模型",
    exact: true,
  });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport({ ratio: 1 });
  expect(await scroll.evaluate((node) => node.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});
