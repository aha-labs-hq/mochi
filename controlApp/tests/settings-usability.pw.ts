import { expect, test } from "@playwright/test";
import { connectedFacts } from "./connectedFacts.ts";
import type {} from "./desktop.pw.ts";

test("an initial Feishu failure stays visible in the connection page", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=groups");
  await page.evaluate(() => {
    window.mochiTest.update({
      feishu: { active: null, candidate: null },
      feishuGroups: null,
    });
    window.mochiTest.failAction("feishu_connection_failed");
  });
  await page.getByRole("button", { name: "开始连接", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始连接", exact: true }),
  ).toBeEnabled();
});

test("an unsigned Bot goes directly to the shared connection and returns to its model settings", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  await page.evaluate(() =>
    window.mochiTest.update({
      account: { status: "signedOut" },
      setup: "signIn",
    }),
  );
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: /模型连接.*管理模型连接/ }).click();
  await expect(
    page.getByRole("button", { name: "连接 ChatGPT", exact: true }),
  ).toBeVisible();
  // One 伙伴: the shared categories sit in the same column as its own.
  await expect(
    page
      .getByRole("navigation", { name: "通用设置" })
      .getByRole("button", { name: "模型连接", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: /^返回/ }).click();
  await expect(
    page.getByRole("heading", { name: "模型", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

const second = {
  ...connectedFacts.bots[0]!,
  botId: "22222222-2222-4222-8222-222222222222",
  label: "星野",
};

test("reading help keeps application scope through document links and navigation", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=help");
  await page.evaluate(
    (bots) => window.mochiTest.update({ bots }),
    [...connectedFacts.bots, second],
  );
  await page.getByRole("button", { name: /群聊协作 参与群聊/ }).click();
  const app = page.getByRole("button", { name: "通用", exact: true });
  await expect(app).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByRole("button", { name: "使用帮助", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "原文", exact: true }).click();
  await page
    .getByRole("article")
    .getByRole("button", { name: "Issue 写作协议", exact: true })
    .click();
  await expect(app).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "设置麻薯", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设定", exact: true }),
  ).toBeVisible();
  await app.click();
  await expect(
    page.getByRole("article", { name: "Issue 协作", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^返回/ }).click();
  await expect(
    page.getByRole("article", { name: "群聊协作", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^返回/ }).click();
  await expect(
    page.getByRole("heading", { name: "Mochi 使用帮助", exact: true }),
  ).toBeVisible();
});

test("switching Bots does not carry another Bot's group search", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=groups");
  await page.evaluate(
    (first) =>
      window.mochiTest.update({
        bots: [
          first,
          {
            ...first,
            botId: "22222222-2222-4222-8222-222222222222",
            label: "星野",
          },
        ],
        feishuGroups: Array.from({ length: 7 }, (_, i) => ({
          id: String(i),
          name: `群聊 ${i}`,
          enabled: true,
          avatarUrl: null,
        })),
      }),
    connectedFacts.bots[0]!,
  );
  await page
    .getByRole("searchbox", { name: "查找群聊", exact: true })
    .fill("不存在的群");
  await expect(
    page.getByText("没有匹配的群聊。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置星野", exact: true }).click();
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "查找群聊", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("region", { name: "所在群" }).getByRole("switch"),
  ).toHaveCount(7);
});

test("renaming normalizes the saved draft and keyboard save respects disabled state", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  const name = page.getByRole("textbox", { name: "伙伴的名字", exact: true });
  await name.fill("  星野  ");
  await page.getByRole("button", { name: "保存名字", exact: true }).click();
  await page.evaluate(
    (first) => window.mochiTest.update({ bots: [{ ...first, label: "星野" }] }),
    connectedFacts.bots[0]!,
  );
  await expect(name).toHaveValue("星野");
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    false,
  );
  await name.fill("改名草稿");
  await page.evaluate(() => window.mochiTest.update({ controlReady: false }));
  await name.press("Control+s");
  expect(
    (await page.evaluate(() => window.mochiTest.actions)).filter(
      (action) => action.type === "renameBot",
    ),
  ).toHaveLength(1);
});

test("a delayed failure from another Bot cannot appear on the current Bot", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  await page.evaluate((first) => {
    window.mochiTest.update({
      bots: [
        first,
        {
          ...first,
          botId: "22222222-2222-4222-8222-222222222222",
          label: "星野",
        },
      ],
      feishu: { active: null, candidate: null },
      feishuGroups: null,
    });
  }, connectedFacts.bots[0]!);
  // Read B's own document before injecting a failure into A's pending operation.
  await page.getByRole("button", { name: "设置星野", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "给星野的嘱咐" }),
  ).toContainText("先讲结论");
  await page.getByRole("button", { name: "设置麻薯", exact: true }).click();
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await page.evaluate(() => {
    window.mochiTest.holdActions();
    window.mochiTest.failAction("feishu_connection_failed");
  });
  await page.getByRole("button", { name: "开始连接", exact: true }).click();
  await page.evaluate(() => {
    window.mochiTest.update({
      selectedBotId: "22222222-2222-4222-8222-222222222222",
    });
    window.mochiTest.releaseActions();
  });
  await expect(
    page.getByRole("heading", { name: "设定", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a failed model read retries in place without changing the policy", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  await page.evaluate(() =>
    window.mochiTest.failAction("model_catalog_unavailable"),
  );
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(1);
  await page.evaluate(() =>
    window.mochiTest.update({ busy: "updateGroupParticipation" }),
  );
  await expect(
    page.getByRole("button", { name: "重新读取模型", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.mochiTest.update({ busy: null }));
  await expect(
    page.getByRole("button", { name: "重新读取模型", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(1);
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page.getByRole("button", { name: "重新读取模型", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "模型", exact: true }),
  ).toHaveValue("gpt-test-balanced");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(2);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("a Bot switch keeps the model page neutral until the host is idle", async ({
  page,
}) => {
  const otherBotId = "22222222-2222-4222-8222-222222222222";
  const firstBotId = connectedFacts.bots[0]!.botId;
  await page.goto("/main/settings.html?page=instructions");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.evaluate(
    (first) =>
      window.mochiTest.update({
        bots: [
          first,
          {
            ...first,
            botId: "22222222-2222-4222-8222-222222222222",
            label: "星野",
          },
        ],
      }),
    connectedFacts.bots[0]!,
  );
  await page.evaluate(
    (botId) => window.mochiTest.update({ selectedBotId: botId }),
    otherBotId,
  );
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "模型", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (botId) => window.mochiTest.update({ selectedBotId: botId }),
    firstBotId,
  );
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "模型", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(3);

  await page.evaluate(
    (botId) =>
      window.mochiTest.update({ busy: "selectBot", selectedBotId: botId }),
    otherBotId,
  );
  await expect(page.getByText("正在切换伙伴…", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(3);

  await page.evaluate(() => window.mochiTest.update({ busy: null }));
  await expect(
    page.getByRole("combobox", { name: "模型", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(4);
});

test("model reads settle once and retain the form through later host operations", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  const model = page.getByRole("combobox", { name: "模型", exact: true });
  await expect(model).toBeEnabled();
  await model.selectOption("gpt-test-fast");
  await page.evaluate(() =>
    window.mochiTest.update({ busy: "updateGroupParticipation" }),
  );
  await expect(model).toBeVisible();
  await expect(model).toBeDisabled();
  await page.evaluate(() => window.mochiTest.update({ busy: null }));
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue("gpt-test-fast");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(1);
});

test("repeated model read contention stays neutral and needs an explicit reload after one deferred read", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  await page.evaluate(() => window.mochiTest.failAction("action_in_progress"));
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.modelRequests()))
    .toBe(2);
  const reload = page.getByRole("button", {
    name: "重新读取模型",
    exact: true,
  });
  await expect(reload).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("当前操作完成后，可重新读取模型。", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.mochiTest.update({ busy: "updateGroupParticipation" }),
  );
  await expect(reload).toBeDisabled();
  await page.evaluate(() => window.mochiTest.update({ busy: null }));
  await expect(reload).toBeEnabled();
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(2);
  await page.evaluate(() => window.mochiTest.failAction(null));
  await reload.click();
  await expect(
    page.getByRole("combobox", { name: "模型", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(3);
});

test("native navigation remembers application destinations and preserves a reopened return path", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=help");
  await page.evaluate(
    (bots) => window.mochiTest.update({ bots }),
    [...connectedFacts.bots, second],
  );
  await page.getByRole("button", { name: "设置麻薯", exact: true }).click();
  await page.getByRole("button", { name: "通用", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Mochi 使用帮助", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /群聊协作 参与群聊/ }).click();
  await page.evaluate(() =>
    window.mochiTest.navigate({
      page: "document",
      id: "feishu-collaboration",
      section: "help",
    }),
  );
  await page.getByRole("button", { name: /^返回/ }).click();
  await expect(
    page.getByRole("heading", { name: "Mochi 使用帮助", exact: true }),
  ).toBeVisible();
});

for (const width of [320, 640, 1040]) {
  test(`maximum names stay inside Settings at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 640 ? 540 : 716 });
    await page.goto("/main/settings.html?page=instructions");
    await page.evaluate(
      (first) =>
        window.mochiTest.update({
          bots: [{ ...first, label: "W".repeat(60) }],
          github: {
            status: "connected",
            problem: null,
            account: { id: 42, login: "W".repeat(39) },
          },
          feishu: {
            active: {
              brand: "feishu" as const,
              state: "ready",
              bot: { name: "W".repeat(60), avatarUrl: null },
            },
            candidate: null,
          },
          feishuGroups: [],
        }),
      connectedFacts.bots[0]!,
    );
    for (const route of [
      "instructions",
      "connectors",
      "groups",
      "projects",
      "diagnostics",
    ] as const) {
      await page.evaluate((page) => window.mochiTest.navigate({ page }), route);
      const content = page.getByRole("main", { name: "设置内容" });
      await expect(content.getByRole("heading", { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(
        await content.evaluate((el) => el.scrollWidth),
      ).toBeLessThanOrEqual(Math.ceil((await content.boundingBox())!.width));
      if (route === "instructions")
        await expect(
          page.getByRole("button", { name: "保存嘱咐", exact: true }),
        ).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: `controlApp/.build/usability-${route}-${width}.png`,
      });
    }
  });
}
