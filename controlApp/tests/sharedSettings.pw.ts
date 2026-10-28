import { expect, test } from "@playwright/test";
import { connectedFacts } from "./connectedFacts.ts";

const B = "22222222-2222-4222-8222-222222222222";
const bots = [
  ...connectedFacts.bots,
  {
    ...connectedFacts.bots[0]!,
    botId: B,
    label: "星野",
    enabled: false,
    lifecycle: "paused" as const,
    phase: "stopped" as const,
  },
];

for (const width of [320, 360, 640, 1040]) {
  test(`shared connection at ${width}: scopes, icons and controls stay within the window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width < 640 ? 640 : 716 });
    await page.goto("/main/settings.html?page=account");
    await page.evaluate((bots) => window.mochiTest.update({ bots }), bots);
    const scope = page.getByRole("complementary", { name: "设置范围" });
    const categories = page.getByRole("navigation", { name: "设置分类" });
    await expect(
      scope.getByRole("button", { name: "通用", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await expect(categories.getByRole("button")).toHaveText([
      "模型连接",
      "运行诊断",
      "关于与更新",
      "使用帮助",
    ]);
    await expect(
      page
        .getByRole("main", { name: "设置内容" })
        .locator("h1")
        .filter({ hasText: /^模型连接$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "ChatGPT 连接选项" }),
    ).toBeInViewport({ ratio: 1 });
    const portraits = scope
      .getByRole("button", { name: /^设置/ })
      .locator("img");
    await expect(portraits).toHaveCount(2);
    await expect
      .poll(() =>
        portraits.evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);
    if (width >= 640) {
      const first = (await scope.boundingBox())!;
      const second = (await categories.boundingBox())!;
      const third = (await page
        .getByRole("main", { name: "设置内容" })
        .boundingBox())!;
      expect(second.x).toBeGreaterThanOrEqual(first.x + first.width);
      expect(third.x).toBeGreaterThanOrEqual(second.x + second.width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({
      path: `controlApp/.build/shared-settings-${width}.png`,
    });
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });
}

test("shared connection directory leaves Bot policies in each Bot's model settings", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=account");
  await page.evaluate((bots) => window.mochiTest.update({ bots }), bots);
  await expect(
    page.getByRole("region", { name: "各 Bot 的模型连接" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "设置星野", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "设置星野", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "模型", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("combobox", { name: "模型", exact: true })
    .selectOption("gpt-test-fast");
  await page.getByRole("button", { name: /ChatGPT/ }).click();
  await page.getByRole("button", { name: "运行诊断", exact: true }).click();
  await page.getByRole("button", { name: "设置星野", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "模型", exact: true }),
  ).toHaveValue("gpt-test-fast");
  await page.getByRole("button", { name: "通用", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "运行诊断", exact: true }),
  ).toBeVisible();
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    true,
  );
});

test("a busy Bot disables shared account mutation without hiding the connection", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=account");
  await page.evaluate(
    (bots) => window.mochiTest.update({ bots, accountChangeReady: false }),
    bots,
  );
  await page.getByRole("button", { name: "ChatGPT 连接选项" }).click();
  await expect(
    page.getByRole("menuitem", { name: "切换账号…" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "退出 ChatGPT…" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "ChatGPT 连接选项" }),
  ).toBeFocused();
  await expect(
    page.getByText("当前有进行中的任务，完成后即可切换或退出连接。"),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("an empty roster opens application settings and first creation uses the existing login", async ({
  page,
}) => {
  await page.goto("/main/settings.html");
  await page.evaluate(() =>
    window.mochiTest.update({ bots: [], selectedBotId: null }),
  );
  await expect(
    page
      .getByRole("main", { name: "设置内容" })
      .locator("h1")
      .filter({ hasText: /^模型连接$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新增伙伴", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设定", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "新伙伴：值班", exact: true }),
  ).not.toBeChecked();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "createBot" },
  ]);
});

test("Settings distinguishes an unreadable roster from confirmed absence", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=about");
  const identity = page.getByRole("region", { name: "当前伙伴", exact: true });
  await page.evaluate(() =>
    window.mochiTest.update({
      bots: [],
      selectedBotId: null,
      loaded: false,
      controlReady: false,
    }),
  );
  await expect(identity).toContainText("Mochi 没有运行");
  await expect(identity).not.toContainText("还没有伙伴");
  await expect(
    page.getByRole("button", { name: "新增伙伴", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.mochiTest.update({ loaded: true }));
  await expect(identity).toContainText("正在确认状态");
  await expect(identity).not.toContainText("还没有伙伴");
  await page.evaluate(() => window.mochiTest.update({ controlReady: true }));
  await expect(identity).toContainText("还没有伙伴");
  await expect(
    page.getByRole("button", { name: "新增伙伴", exact: true }),
  ).toBeEnabled();
});

for (const width of [640, 1040]) {
  test(`profile duty starts in place and preserves its layout at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 640 ? 540 : 716 });
    await page.goto("/main/settings.html?page=instructions");
    await page.evaluate(
      (bots) =>
        window.mochiTest.update({
          bots,
          selectedBotId: bots[1]!.botId,
          setup: "ready",
        }),
      bots,
    );
    const control = page.getByRole("switch", {
      name: "星野：值班",
      exact: true,
    });
    const identity = page.getByRole("region", {
      name: "当前伙伴",
      exact: true,
    });
    await expect(identity.getByRole("switch")).toHaveCount(1);
    await expect(
      page.getByTestId("settings-reading-surface").getByRole("switch"),
    ).toHaveCount(0);
    await expect(control).toBeInViewport({ ratio: 1 });
    const controlBounds = await control.boundingBox();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    expect(await control.boundingBox()).toEqual(controlBounds);
    await page.getByRole("button", { name: "设定", exact: true }).click();
    await expect(control).not.toBeChecked();
    await expect(page.getByText(/准备工作记录|准备它的工作记录/)).toHaveCount(
      0,
    );
    const panel = await page
      .getByTestId("settings-reading-surface")
      .boundingBox();
    await page.screenshot({
      path: `controlApp/.build/duty-profile-${width}.png`,
    });
    await page.evaluate(() => {
      window.mochiTest.holdActions();
      window.mochiTest.failAction("setup_failed");
    });
    await control.click();
    await page.evaluate(
      (bots) =>
        window.mochiTest.update({
          setup: "initializing",
          bots: bots.map((bot) =>
            bot.botId === bots[1]!.botId
              ? { ...bot, lifecycle: "setup", phase: "starting" }
              : bot,
          ),
        }),
      bots,
    );
    await expect(control.locator("..")).toContainText("正在启动");
    await expect(control).toBeDisabled();
    expect(
      await page.getByTestId("settings-reading-surface").boundingBox(),
    ).toEqual(panel);
    await page.evaluate((bots) => {
      window.mochiTest.update({ setup: "ready", bots });
      window.mochiTest.releaseActions();
    }, bots);
    await expect(identity.getByRole("alert")).toContainText("没能开始值班");
    await expect(control).not.toBeChecked();
    await expect(control).toBeEnabled();
    await page.evaluate(() => window.mochiTest.failAction(null));
    await control.click();
    await expect(control).toBeChecked();
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
      { type: "setBotEnabled", botId: B, enabled: true },
      { type: "setBotEnabled", botId: B, enabled: true },
    ]);
  });

  test(`an unprepared paused Bot keeps its model draft across the shared account at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 640 ? 540 : 716 });
    await page.goto("/main/settings.html?page=instructions");
    await page.evaluate((bots) => window.mochiTest.update({ bots }), bots);
    await page.getByRole("button", { name: "设置星野", exact: true }).click();
    await page.evaluate(() =>
      window.mochiTest.update({
        setup: "ready",
        phase: "stopped",
        eventStreamReady: false,
      }),
    );
    await page.getByRole("button", { name: "模型", exact: true }).click();
    const model = page.getByRole("combobox", { name: "模型", exact: true });
    await expect(model).toBeEnabled();
    await model.selectOption("gpt-test-fast");
    await page.getByRole("button", { name: /ChatGPT/ }).click();
    await expect(
      page
        .getByRole("main", { name: "设置内容" })
        .locator("h1")
        .filter({ hasText: /^模型连接$/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^返回/ }).click();
    await expect(model).toHaveValue("gpt-test-fast");
    await expect(
      page.getByRole("button", { name: "设置星野", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(
      page.getByText("已保存，从下一次任务开始使用。"),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.mochiTest.botWrites.filter(
          (write) => write.kind === "updatePolicy",
        ),
      ),
    ).toEqual([{ botId: B, kind: "updatePolicy" }]);
    expect(
      await page.evaluate(() =>
        window.mochiTest.actions.some(
          (action) => action.type === "setBotEnabled",
        ),
      ),
    ).toBe(false);
    await page.screenshot({
      path: `controlApp/.build/unprepared-model-${width}.png`,
    });
    await page.getByRole("button", { name: "设定", exact: true }).click();
    await expect(
      page.getByRole("switch", { name: "星野：值班", exact: true }),
    ).not.toBeChecked();
  });
}

test("first duty startup temporarily blocks model edits without losing the draft", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  const model = page.getByRole("combobox", { name: "模型", exact: true });
  await model.selectOption("gpt-test-fast");
  await page.evaluate(() => window.mochiTest.update({ setup: "initializing" }));
  await expect(model).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存设置", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.mochiTest.update({ setup: "ready" }));
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue("gpt-test-fast");
  await expect(
    page.getByRole("button", { name: "保存设置", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("an unconnected Bot starts and continues Feishu connection inside its group page", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  await page.evaluate(() =>
    window.mochiTest.update({
      setup: "ready",
      phase: "stopped",
      eventStreamReady: false,
      feishu: { active: null, candidate: null },
      feishuGroups: null,
    }),
  );
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "群聊", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "开始连接", exact: true }).click();
  await page.evaluate(() =>
    window.mochiTest.update({
      feishu: {
        active: null,
        candidate: {
          brand: null,
          state: "registering",
          bot: null,
          problem: null,
        },
      },
    }),
  );
  await expect(
    page.getByRole("button", { name: "继续这次扫码", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续这次扫码", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "connectFeishu" },
  ]);
  await page.evaluate(() =>
    window.mochiTest.update({
      feishu: {
        active: {
          brand: "feishu" as const,
          state: "ready",
          bot: { name: "星野", avatarUrl: null },
        },
        candidate: null,
      },
      feishuGroups: [],
    }),
  );
  await expect(
    page.getByRole("heading", { name: "还没有加入群聊", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /管理连接/ })).toBeVisible();
});

for (const route of ["groups", "projects"]) {
  test(`${route}: failed first duty stays visible beside the common control when initialization ends`, async ({
    page,
  }) => {
    await page.goto(`/main/settings.html?page=${route}`);
    await page.evaluate(
      (bots) =>
        window.mochiTest.update({
          bots,
          selectedBotId: bots[1]!.botId,
          setup: "ready",
        }),
      bots,
    );
    await page
      .getByRole("button", {
        name: route === "groups" ? "群聊" : "连接器",
        exact: true,
      })
      .click();
    if (route === "projects")
      await page
        .getByRole("button", { name: "打开 GitHub", exact: true })
        .click();
    const control = page.getByRole("switch", {
      name: "星野：值班",
      exact: true,
    });
    await expect(control).toBeEnabled();
    await page.evaluate(() => {
      window.mochiTest.holdActions();
      window.mochiTest.failAction("setup_failed", "setBotEnabled");
    });
    await control.click();
    await page.evaluate(() =>
      window.mochiTest.update({ setup: "initializing" }),
    );
    await expect(control).toBeDisabled();
    await page.evaluate(() => {
      window.mochiTest.update({ setup: "ready" });
      window.mochiTest.releaseActions();
    });
    await expect(control).toBeEnabled();
    // Nothing on the page refreshes itself through an action that could
    // replace the failure; the Bot keeps the directory current.
    expect(
      (await page.evaluate(() => window.mochiTest.actions)).map(
        (action) => action.type,
      ),
    ).toEqual(["setBotEnabled"]);
    await expect(page.getByRole("alert")).toContainText("没能开始值班");
    await expect(control).not.toBeChecked();
    await page.evaluate(() => window.mochiTest.failAction(null));
    await control.click();
    await expect(control).toBeChecked();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
