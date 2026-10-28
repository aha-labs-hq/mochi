import { expect, test } from "@playwright/test";
import { effortLabel } from "../src/shared/vocabulary.ts";
import { connectedFacts } from "./connectedFacts.ts";
import type {} from "./desktop.pw.ts";
import { expectFocusRing } from "./focus.ts";
import sharp from "./sharp.ts";

for (const colorScheme of ["light", "dark"] as const)
  test(`settings ${colorScheme}: keyboard focus rings the slider thumb, unlike navigation selection`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/main/settings.html?page=model");
    const effort = page.getByRole("slider", { name: "思考深度", exact: true });
    const thumb = effort.locator("..");
    await page.getByLabel("模型", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expectFocusRing(effort, thumb);
    await expect(effort).toHaveAttribute("aria-valuetext", effortLabel("max"));
    await page.screenshot({
      path: `controlApp/.build/settings-field-focus-${colorScheme}.png`,
    });
    // Route restoration can focus navigation after keyboard interaction. Do not
    // assume the system's Tab preference includes non-field controls.
    const nav = page.getByRole("navigation", { name: "设置分类" });
    const thinking = nav.getByRole("button", {
      name: "模型",
      exact: true,
    });
    await expectFocusRing(thinking);
    await expect(thumb).toHaveCSS("outline-style", "none");
  });

for (const colorScheme of ["light", "dark"] as const)
  test(`settings ${colorScheme}: background changes affect chrome but never the reading panel`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1040, height: 716 });
    await page.emulateMedia({ colorScheme });
    await page.goto("/main/settings.html?page=model");
    await expect(page.getByLabel("模型", { exact: true })).toBeVisible();
    const content = page.getByRole("main", { name: "设置内容" });
    const sidebar = page.getByRole("complementary", { name: "设置范围" });
    const panel = page.getByTestId("settings-reading-surface");
    const panelBounds = (await panel.boundingBox())!;
    expect(panelBounds.y).toBe(8);
    expect(1040 - panelBounds.x - panelBounds.width).toBe(8);
    expect(716 - panelBounds.y - panelBounds.height).toBe(8);
    await expect(panel).toHaveCSS("border-radius", "16px");
    const categories = page.getByRole("navigation", { name: "设置分类" });
    const bounds = await content.boundingBox();
    if (!bounds) throw new Error("Reading panel unavailable");
    // The reading surface remains opaque above the native material.
    const reading = {
      x: bounds.x + 12,
      y: bounds.y,
      width: bounds.width - 24,
      height: bounds.height - 12,
    };
    await page.evaluate(() => {
      document.documentElement.style.backgroundColor = "#000000";
    });
    const darkContent = await page.screenshot({ clip: reading });
    const darkSidebar = await sidebar.screenshot();
    const darkCategories = await categories.screenshot();
    await page.evaluate(() => {
      document.documentElement.style.backgroundColor = "#ffffff";
    });
    expect((await page.screenshot({ clip: reading })).equals(darkContent)).toBe(
      true,
    );
    const lightSidebar = await sidebar.screenshot();
    expect((await categories.screenshot()).equals(darkCategories)).toBe(false);
    const darkChrome = await sharp(darkSidebar).stats();
    const lightChrome = await sharp(lightSidebar).stats();
    // A barely translucent fill can pass a simple inequality while hiding the
    // native material. Most backdrop contrast must survive the renderer tint.
    for (const channel of [0, 1, 2])
      expect(
        lightChrome.channels[channel]!.mean -
          darkChrome.channels[channel]!.mean,
      ).toBeGreaterThan(180);
  });

for (const colorScheme of ["light", "dark"] as const)
  for (const width of [360, 640, 1040])
    test(`settings ${colorScheme} ${width}: Bot categories, real state and retained drafts`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 360 ? 640 : 716 });
      await page.emulateMedia({ colorScheme });
      await page.goto("/main/settings.html?page=projects");
      const nav = page.getByRole("navigation", { name: "设置分类" });
      await expect(nav.getByRole("button")).toHaveText([
        "设定",
        "连接器",
        "模型",
        "群聊",
        "安排",
      ]);
      await expect(
        nav.getByRole("button", { name: "连接器", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        page.getByRole("heading", { name: "GitHub", level: 1, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("main").getByRole("switch")).toHaveCount(0);
      expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
      expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(
        0,
      );
      await page.screenshot({
        path: `controlApp/.build/settings-plugins-${colorScheme}-${width}.png`,
      });
      const thinking = nav.getByRole("button", {
        name: "模型",
        exact: true,
      });
      await thinking.focus();
      await page.keyboard.press("Enter");
      await page
        .getByLabel("模型", { exact: true })
        .selectOption("gpt-test-fast");
      expect(await page.evaluate(() => window.mochiTest.closeState())).toEqual({
        dirty: true,
        busy: false,
      });
      await nav.getByRole("button", { name: "群聊", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "所在群" }).getByRole("switch"),
      ).toHaveCount(1);
      await page.screenshot({
        path: `controlApp/.build/settings-groups-${colorScheme}-${width}.png`,
      });
      await thinking.click();
      await expect(page.getByLabel("模型", { exact: true })).toHaveValue(
        "gpt-test-fast",
      );
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await expect(
        page.getByText("已保存，从下一次任务开始使用。"),
      ).toBeVisible();
      expect(await page.evaluate(() => window.mochiTest.closeState())).toEqual({
        dirty: false,
        busy: false,
      });
      await page.screenshot({
        path: `controlApp/.build/settings-model-${colorScheme}-${width}.png`,
      });
      // Visiting pages asks nothing of the Bot; only the saved policy is an action.
      expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
        {
          type: "updatePolicy",
          policy: { model: "gpt-test-fast", reasoningEffort: "low" },
        },
      ]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    });

test("settings pages share one reading baseline and right edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.goto("/main/settings.html?page=model");
  const main = page.getByRole("main", { name: "设置内容" });
  const title = main.getByRole("heading", { name: "模型", exact: true });
  const chatGPT = main.getByRole("button", { name: /ChatGPT/ });
  const modelLabel = main.locator('label[for="model"]');
  const model = main.getByRole("combobox", { name: "模型", exact: true });
  const save = main.getByRole("button", { name: "保存设置", exact: true });
  const [titleBox, chatBox, labelBox, modelBox, saveBox] = await Promise.all([
    title.boundingBox(),
    chatGPT.boundingBox(),
    modelLabel.boundingBox(),
    model.boundingBox(),
    save.boundingBox(),
  ]);
  if (!titleBox || !chatBox || !labelBox || !modelBox || !saveBox)
    throw new Error("Settings alignment boxes unavailable");
  expect(labelBox.x).toBeCloseTo(titleBox.x, 1);
  expect(chatBox.x).toBeCloseTo(titleBox.x, 1);
  expect(modelBox.x + modelBox.width).toBeCloseTo(saveBox.x + saveBox.width, 1);
});

test("Settings clears its failed restart after verified recovery without losing the page", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=diagnostics");
  await page.evaluate(() => {
    window.mochiTest.update({ phase: "attention", eventStreamReady: false });
    window.mochiTest.failAction("service_readiness_timeout");
  });
  await page.getByRole("button", { name: "重新连接后台" }).click();
  await expect(page.getByRole("alert")).toContainText("Mochi 没有正常启动");
  await page.evaluate(() =>
    window.mochiTest.update({ phase: "listening", eventStreamReady: true }),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "运行诊断", exact: true }),
  ).toBeVisible();
});

test("model and group settings are usable before preparing a work record", async ({
  page,
}) => {
  await page.goto("/main/settings.html");
  await page.evaluate(() =>
    window.mochiTest.update({ setup: "ready", feishuGroups: null }),
  );
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const model = page.getByRole("combobox", { name: "模型", exact: true });
  await expect(model).toBeEnabled();
  await model.selectOption("gpt-test-fast");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByText("已保存，从下一次任务开始使用。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "完成准备", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "设定", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "麻薯：值班", exact: true }),
  ).not.toBeChecked();
  expect(await page.evaluate(() => window.mochiTest.companionRequests())).toBe(
    0,
  );
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await expect(
    page.getByText("还在确认所在群，确认后会自动显示在这里。"),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    {
      type: "updatePolicy",
      policy: { model: "gpt-test-fast", reasoningEffort: "low" },
    },
  ]);
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(1);
});

test("account actions remain provider-owned and unknown never means signed out", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=account");
  await page.getByRole("button", { name: "ChatGPT 连接选项" }).click();
  await page.getByRole("menuitem", { name: "切换账号…" }).click();
  await page.evaluate(() =>
    window.mochiTest.update({
      account: { status: "signingIn" },
      canReopenLogin: true,
    }),
  );
  await page.getByRole("button", { name: "打开浏览器", exact: true }).click();
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await page.evaluate(() =>
    window.mochiTest.update({ account: { status: "signedOut" } }),
  );
  await page.getByRole("button", { name: "连接 ChatGPT", exact: true }).click();
  await page.evaluate(() =>
    window.mochiTest.update({
      account: { status: "unknown" },
      controlReady: false,
    }),
  );
  await expect(
    page.getByText("暂时无法确认模型连接。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "连接 ChatGPT", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "switchAccount" },
    { type: "reopenLogin" },
    { type: "cancelLogin" },
    { type: "login" },
  ]);
});

test("failed saves retain the model draft without success or automatic retry", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  await page.getByLabel("模型", { exact: true }).selectOption("gpt-test-fast");
  await page.evaluate(() =>
    window.mochiTest.failAction("model_policy_out_of_sync"),
  );
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue(
    "gpt-test-fast",
  );
  await expect(page.getByText("已保存，从下一次任务开始使用。")).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.actions.length)).toBe(1);
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    true,
  );
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByText("已保存，从下一次任务开始使用。")).toBeVisible();
});

test("new account revalidates the retained model draft while retaining navigation", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  await page.getByLabel("模型", { exact: true }).selectOption("gpt-test-fast");
  await page.evaluate(() =>
    window.mochiTest.update({ account: { status: "signingIn" } }),
  );
  await expect(page.getByLabel("模型", { exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    window.mochiTest.update({
      account: {
        status: "signedIn",
        account: {
          provider: "openai-codex",
          authType: "oauth",
          subscription: true,
        },
        connections: [
          { provider: "openai-codex", authType: "oauth", subscription: true },
        ],
      },
    }),
  );
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue(
    "gpt-test-fast",
  );
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    true,
  );
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("hidden-window startup does not depend on a running animation clock", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
  });
  await page.goto("/main/settings.html?page=projects");
  await expect(
    page.getByRole("heading", { name: "GitHub", level: 1, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.settingsRendered()))
    .toBe(1);
  await page.evaluate(() => window.mochiTest.update({ contextPercent: 31 }));
  expect(await page.evaluate(() => window.mochiTest.settingsRendered())).toBe(
    1,
  );
});

test("temporary account uncertainty preserves the model draft and blocks saving", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  await page.getByLabel("模型", { exact: true }).selectOption("gpt-test-fast");
  await page.evaluate(() =>
    window.mochiTest.update({
      account: { status: "unknown" },
      controlReady: false,
    }),
  );
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue(
    "gpt-test-fast",
  );
  await expect(
    page.getByRole("button", { name: "保存设置", exact: true }),
  ).toBeDisabled();
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    true,
  );
  await page.evaluate(() =>
    window.mochiTest.update({
      controlReady: true,
      account: {
        status: "signedIn",
        account: {
          provider: "openai-codex",
          authType: "oauth",
          subscription: true,
        },
        connections: [
          { provider: "openai-codex", authType: "oauth", subscription: true },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "模型", exact: true }).focus();
  await page.keyboard.press("Meta+s");
  await expect(page.getByText("已保存，从下一次任务开始使用。")).toBeVisible();
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    false,
  );
});

test("switching sections restores the exact method and reading mode", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=help");
  await page.getByRole("button", { name: /GitHub 调查 从线索/ }).click();
  await page.getByRole("button", { name: "原文", exact: true }).click();
  const content = page.getByRole("main", { name: "设置内容" });
  await content.evaluate((element) => {
    element.scrollTop = 240;
  });
  await page.getByRole("button", { name: "运行诊断", exact: true }).click();
  await page.getByRole("button", { name: "使用帮助", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "GitHub 调查" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "原文", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBe(240);
  await page.getByRole("button", { name: /^返回/ }).click();
  await expect(
    page.getByRole("button", { name: /GitHub 调查 从线索/ }),
  ).toBeFocused();
});

test("group failure belongs to its row, retains authority and does not follow navigation", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=groups");
  await page.evaluate(() =>
    window.mochiTest.failAction("group_participation_update_failed"),
  );
  const toggle = page.getByRole("switch", { name: "Mochi 测试群：回应消息" });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(
    page.getByRole("listitem").filter({ has: toggle }).getByRole("alert"),
  ).toBeVisible();
  await page.getByRole("button", { name: "连接器", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.mochiTest.actions)).filter(
      (action) => action.type === "updateGroupParticipation",
    ),
  ).toHaveLength(1);
});

test("group search keeps the full membership count and makes hidden matches explicit", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=groups");
  await expect(page.getByRole("searchbox", { name: "查找群聊" })).toHaveCount(
    0,
  );
  await page.evaluate(() =>
    window.mochiTest.update({
      feishuGroups: Array.from({ length: 12 }, (_, index) => ({
        id: `group-${index}`,
        name: `协作群 ${index}`,
        enabled: index < 3,
        avatarUrl: null,
      })),
    }),
  );
  await page.getByRole("searchbox", { name: "查找群聊" }).fill("协作群 11");
  await expect(
    page.getByRole("region", { name: "所在群" }).getByRole("switch"),
  ).toHaveCount(1);
  await expect(page.getByText("12 个群 · 3 个开启回应")).toBeVisible();
  await page.getByRole("searchbox", { name: "查找群聊" }).fill("不存在");
  await expect(page.getByText("没有匹配的群聊。")).toBeVisible();
});

test("a late group failure cannot become an error on another page", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=groups");
  await page.evaluate(() => {
    window.mochiTest.failAction("group_participation_update_failed");
    window.mochiTest.holdActions();
  });
  await page
    .getByRole("region", { name: "所在群" })
    .getByRole("switch")
    .click();
  await page.getByRole("button", { name: "连接器", exact: true }).click();
  await page.evaluate(() => window.mochiTest.releaseActions());
  await page.getByRole("button", { name: "设定", exact: true }).click();
  await page.getByRole("button", { name: "连接器", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("each navigation selection and visible page update together", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  const nav = page.getByRole("navigation", { name: "设置分类" });
  for (const [label, heading] of [
    ["设定", "设定"],
    ["连接器", "连接器"],
    ["模型", "模型"],
    ["群聊", "在群里一起工作"],
  ]) {
    const button = nav.getByRole("button", { name: label!, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(button).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(
      page.getByRole("heading", { name: heading!, exact: true }),
    ).toBeVisible();
  }
  await nav.getByRole("button", { name: "连接器", exact: true }).click();
  await page.getByRole("button", { name: "打开 GitHub", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "GitHub", level: 1, exact: true }),
  ).toBeVisible();
});

test("one 伙伴 shares one column with the shared settings; several become a portrait strip when narrow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 540 });
  await page.goto("/main/settings.html?page=instructions");
  const scope = page.getByRole("complementary", { name: "设置范围" });
  await expect(
    scope.getByRole("navigation", { name: "设置分类" }).getByRole("button"),
  ).toHaveCount(5);
  await expect(
    scope.getByRole("navigation", { name: "通用设置" }).getByRole("button"),
  ).toHaveText(["模型连接", "运行诊断", "关于与更新", "使用帮助"]);
  await expect(scope.getByRole("button", { name: "通用" })).toHaveCount(0);
  await expect(
    scope.getByRole("region", { name: "当前伙伴" }).getByRole("switch"),
  ).toBeVisible();
  // The instructions stay usable at the native minimum size.
  const editor = page.locator("#mochi-instructions");
  await expect(editor).toContainText("先讲结论");
  await editor.scrollIntoViewIfNeeded();
  expect((await editor.boundingBox())!.height).toBeGreaterThanOrEqual(160);
  await expect(
    page.getByRole("button", { name: "保存嘱咐", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "controlApp/.build/settings-merged-640.png" });
  await scope
    .getByRole("navigation", { name: "通用设置" })
    .getByRole("button", { name: "模型连接", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "模型连接", level: 1 }),
  ).toBeVisible();
  await scope.getByRole("button", { name: "设定", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设定", level: 1 }),
  ).toBeVisible();

  await page.evaluate(
    (bots) => window.mochiTest.update({ bots }),
    [
      ...connectedFacts.bots,
      {
        ...connectedFacts.bots[0]!,
        botId: "22222222-2222-4222-8222-222222222222",
        label: "星野",
        enabled: false,
        lifecycle: "setup" as const,
        phase: "stopped" as const,
      },
    ],
  );
  const portraits = scope.getByRole("button", { name: /^设置/ });
  await expect(portraits).toHaveCount(2);
  expect((await scope.boundingBox())!.width).toBeLessThanOrEqual(64);
  // Each portrait says who and how it is; names stay off the narrow strip.
  await expect(portraits.nth(0)).toHaveAttribute("title", /麻薯 · 正在值班/);
  await expect(portraits.nth(1)).toHaveAttribute("title", /星野 · 还没设置好/);
  expect((await portraits.nth(1).boundingBox())!.width).toBeLessThanOrEqual(48);
  await page.screenshot({ path: "controlApp/.build/settings-strip-640.png" });
});
