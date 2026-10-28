import { expect, type Page, test } from "@playwright/test";
import { NOT_RUNNING } from "../src/shared/vocabulary.ts";
import { connectedBotId as A, connectedFacts } from "./connectedFacts.ts";

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

async function selectCompanion(page: Page, label: string) {
  await page.getByRole("button", { name: /^切换伙伴，当前/ }).click();
  await page
    .getByRole("menuitemradio", { name: `切换到${label}`, exact: true })
    .click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test("the two Bot switches and settings entry address exactly the chosen Bot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 560 });
  await page.goto("/main/index.html");
  await page.evaluate((bots) => window.mochiTest.update({ bots }), bots);
  const a = page.getByRole("switch", { name: "麻薯：值班" });
  await expect(a).toBeChecked();
  await expect(page.locator("canvas")).toHaveCount(1);
  await a.click();
  await expect(a).not.toBeChecked();
  await selectCompanion(page, "星野");
  const b = page.getByRole("switch", { name: "星野：值班" });
  await expect(b).not.toBeChecked();
  await b.focus();
  await page.keyboard.press("Space");
  await expect(b).toBeChecked();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "setBotEnabled", botId: A, enabled: false },
    { type: "selectBot", botId: B },
    { type: "setBotEnabled", botId: B, enabled: true },
  ]);
  expect(await page.evaluate(() => window.mochiTest.settingsRequests)).toEqual([
    "instructions",
  ]);
  await selectCompanion(page, "麻薯");
  await expect(a).not.toBeChecked();
  await page.screenshot({ path: "controlApp/.build/bots-main.png" });
});

test("instruction drafts stay with their Bot across selector and main-window changes", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  await page.evaluate((bots) => window.mochiTest.update({ bots }), bots);
  await page
    .getByRole("textbox", { name: "给麻薯的嘱咐" })
    .fill("A 的独立嘱咐");
  await page.getByRole("button", { name: "设置星野", exact: true }).click();
  await page.getByRole("button", { name: "设定", exact: true }).click();
  const b = page.getByRole("textbox", { name: "给星野的嘱咐" });
  await expect(b).not.toHaveValue("A 的独立嘱咐");
  await b.fill("B 的独立嘱咐");
  await b.press("Meta+s");
  await expect(page.getByRole("status")).toContainText("已保存");
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    true,
  );
  await page.evaluate(
    (id) => window.mochiTest.update({ selectedBotId: id }),
    A,
  );
  await page.getByRole("button", { name: "设定", exact: true }).click();
  const a = page.getByRole("textbox", { name: "给麻薯的嘱咐" });
  await expect(a).toHaveValue("A 的独立嘱咐");
  await a.press("Meta+s");
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.closeState().dirty))
    .toBe(false);
  expect(
    await page.evaluate(() =>
      window.mochiTest.botWrites.filter(
        (write) => write.kind === "instructions",
      ),
    ),
  ).toEqual([
    { botId: B, kind: "instructions", content: "B 的独立嘱咐" },
    { botId: A, kind: "instructions", content: "A 的独立嘱咐" },
  ]);
});

test("model and project drafts are separate and do not leak into a second Bot", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  await page.evaluate((bots) => window.mochiTest.update({ bots }), bots);
  await page
    .getByRole("combobox", { name: "模型", exact: true })
    .selectOption("gpt-test-fast");
  await page.getByRole("button", { name: "连接器", exact: true }).click();
  await page.getByRole("button", { name: "打开 GitHub", exact: true }).click();
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "customer/mochi", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "设置星野", exact: true }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "模型", exact: true }),
  ).toHaveValue("gpt-test-balanced");
  await page.getByRole("button", { name: "连接器", exact: true }).click();
  await page.getByRole("button", { name: "打开 GitHub", exact: true }).click();
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "customer/mochi", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "设置麻薯", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "customer/mochi", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "模型", exact: true }),
  ).toHaveValue("gpt-test-fast");
  await page.screenshot({ path: "controlApp/.build/bots-settings.png" });
});

test("an unconnected Bot shows required actions and repeated names stay distinguishable", async ({
  page,
}) => {
  const repeated = bots.map((bot) => ({ ...bot, label: "麻薯" }));
  await page.goto("/main/index.html");
  await page.evaluate((bots) => window.mochiTest.update({ bots }), repeated);
  await expect(
    page.getByRole("switch", { name: "麻薯（1）：值班" }),
  ).toBeChecked();
  await selectCompanion(page, "麻薯（2）");
  await expect(
    page.getByRole("switch", { name: "麻薯（2）：值班" }),
  ).not.toBeChecked();
  await page.goto("/main/settings.html?page=instructions");
  await page.evaluate(
    ({ bots, id }) =>
      window.mochiTest.update({
        bots,
        selectedBotId: id,
        phase: "starting",
        eventStreamReady: false,
        account: { status: "signedOut" },
        setup: "signIn",
        feishu: { active: null, candidate: null },
        github: {
          status: "unavailable",
          account: null,
          problem: "sign_in_required",
        },
      }),
    { bots: repeated, id: B },
  );
  await expect(
    page.getByRole("heading", { name: "设定", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "设置范围" })
      .getByRole("button", { name: /^设置麻薯/ }),
  ).toHaveText(["麻薯（1）", "麻薯（2）"]);
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开始连接", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "连接器", exact: true }).click();
  await page.getByRole("button", { name: "打开 GitHub", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "连接 GitHub", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("a full roster keeps one performance and offers keyboard selection without changing duty", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 509 });
  await page.goto("/main/index.html");
  const many = Array.from({ length: 64 }, (_, i) => ({
    ...bots[0]!,
    botId: `${String(i).padStart(8, "0")}-2222-4222-8222-222222222222`,
    label: `伙伴 ${i + 1}`,
  }));
  await page.evaluate(
    (bots) => window.mochiTest.update({ bots, selectedBotId: bots[63]!.botId }),
    many,
  );
  const picker = page.getByRole("button", { name: /^切换伙伴，当前/ });
  await expect(picker).toContainText("伙伴 64");
  await expect(page.locator("canvas")).toHaveCount(1);
  await picker.focus();
  await page.keyboard.press("ArrowUp");
  const selected = page.getByRole("menuitemradio", {
    name: "切换到伙伴 64",
    exact: true,
  });
  await expect(selected).toBeChecked();
  await expect(selected).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  const first = page.getByRole("menuitemradio", {
    name: "切换到伙伴 1",
    exact: true,
  });
  await expect(first).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(picker).toHaveAccessibleName("切换伙伴，当前伙伴 1");
  await expect(picker).toBeFocused();
  await expect(page.getByRole("switch")).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "selectBot", botId: many[0]!.botId },
  ]);
});

test("the window sill opens group settings and leaves projects in Settings", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.getByRole("button", { name: "1 个群", exact: true }).click();
  await expect(page.getByRole("button", { name: /个项目/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.settingsRequests)).toEqual([
    "groups",
  ]);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("new Bots are created in Settings while the previous Bot keeps its draft", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  await page
    .getByRole("textbox", { name: "给麻薯的嘱咐" })
    .fill("保留麻薯的草稿");
  await page.evaluate(() => window.mochiTest.failAction("bot_creation_failed"));
  await page.getByRole("button", { name: "新增伙伴", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("没有新增伙伴");
  // One 伙伴 has no roster: its scope and categories share one column.
  await expect(
    page
      .getByRole("complementary", { name: "设置范围" })
      .getByRole("button", { name: /^设置/ }),
  ).toHaveCount(0);
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page.getByRole("button", { name: "新增伙伴", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设定", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "新伙伴：值班", exact: true }),
  ).not.toBeChecked();
  await expect(
    page
      .getByRole("complementary", { name: "设置范围" })
      .getByRole("button", { name: /^设置/ }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "设置麻薯", exact: true }).click();
  await page.getByRole("button", { name: "设定", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "给麻薯的嘱咐" })).toHaveValue(
    "保留麻薯的草稿",
  );
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    true,
  );
  await page.evaluate(() => window.mochiTest.update({ controlReady: false }));
  await expect(
    page.getByRole("button", { name: "新增伙伴", exact: true }),
  ).toBeDisabled();
});

test("the main group shortcut shows selected Bot avatars and excludes disabled groups", async ({
  page,
}) => {
  await page.route("https://s1-imfile.feishucdn.com/**", (route) =>
    route.request().url().endsWith("/missing")
      ? route.abort()
      : route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#6f8068"/></svg>',
        }),
  );
  await page.goto("/main/index.html");
  await page.evaluate(
    (bots) =>
      window.mochiTest.update({
        bots,
        feishuGroups: [
          {
            id: "a",
            name: "Design",
            avatarUrl: "https://s1-imfile.feishucdn.com/design",
            enabled: true,
          },
          {
            id: "b",
            name: "Product",
            avatarUrl: "https://s1-imfile.feishucdn.com/product",
            enabled: true,
          },
          {
            id: "c",
            name: "Disabled",
            avatarUrl: "https://s1-imfile.feishucdn.com/disabled",
            enabled: false,
          },
        ],
      }),
    bots,
  );
  const shortcut = page.getByRole("button", { name: "2 个群", exact: true });
  await expect(shortcut.locator("img")).toHaveCount(2);
  await expect
    .poll(() =>
      shortcut
        .locator("img")
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  await expect(page.locator('img[src$="/disabled"]')).toHaveCount(0);
  await shortcut.click();
  expect(await page.evaluate(() => window.mochiTest.settingsRequests)).toEqual([
    "groups",
  ]);
  await selectCompanion(page, "星野");
  await page.evaluate(() =>
    window.mochiTest.update({
      feishuGroups: [
        {
          id: "b",
          name: "Missing",
          avatarUrl: "https://s1-imfile.feishucdn.com/missing",
          enabled: true,
        },
      ],
    }),
  );
  const second = page.getByRole("button", { name: "1 个群", exact: true });
  await expect(second.locator("img")).toHaveCount(0);
  await expect(second).toBeEnabled();
  await selectCompanion(page, "麻薯");
  await expect(shortcut.locator("img")).toHaveCount(2);
  await page.evaluate(() => window.mochiTest.update({ feishuGroups: null }));
  await expect(
    page.getByRole("button", { name: "所在群", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.mochiTest.update({ feishuGroups: [] }));
  await expect(
    page.getByRole("button", { name: "选择回应的群", exact: true }),
  ).toHaveText("选择回应的群");
});

test("the name picker uses the available line without crowding duty or group identities", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 509 });
  await page.goto("/main/index.html");
  await page.evaluate(
    (bots) =>
      window.mochiTest.update({
        bots: bots.map((bot) => ({ ...bot, label: "麻薯" })),
      }),
    bots,
  );
  const picker = page.getByRole("button", { name: /^切换伙伴，当前/ });
  const text = page.getByRole("heading").locator("span");
  expect(
    await text.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.evaluate(
    (bots) =>
      window.mochiTest.update({
        bots: bots.map((bot) => ({
          ...bot,
          label: "一位有很长名字的伙伴正在等你来命名",
        })),
        feishuGroups: [1, 2, 3].map((i) => ({
          id: String(i),
          name: `Group ${i}`,
          avatarUrl: null,
          enabled: true,
        })),
      }),
    bots,
  );
  await expect(page.getByRole("switch")).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByRole("button", { name: "3 个群", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    360,
  );
  await picker.click();
  await expect(page.getByRole("menu")).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
});

for (const width of [360, 400, 520]) {
  test(`companion book ${width}: portraits reveal the roster and selection preserves the sill`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 360 ? 509 : 560 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/main/index.html");
    const roster = [
      ...bots,
      {
        ...bots[1]!,
        botId: "33333333-3333-4333-8333-333333333333",
        label: "小满",
        lifecycle: "setup" as const,
      },
    ];
    await page.evaluate((bots) => window.mochiTest.update({ bots }), roster);
    const picker = page.getByRole("button", { name: /^切换伙伴，当前/ });
    await expect(picker).toContainText("伙伴 3");
    const sill = await page.getByTestId("companion-sill").boundingBox();
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
    await page.screenshot({
      path: `controlApp/.build/companion-book-${width}-closed.png`,
    });
    await picker.click();
    const book = page.getByRole("menu", { name: "切换伙伴" });
    await expect(book).toBeInViewport({ ratio: 1 });
    await expect(book.getByRole("menuitemradio")).toHaveCount(3);
    await expect(book.getByRole("switch")).toHaveCount(0);
    await expect(book.locator("img")).toHaveCount(3);
    await expect
      .poll(() =>
        book
          .locator("img")
          .evaluateAll((images) =>
            images.every(
              (image) => (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    await expect(page.locator("canvas")).toHaveCount(1);
    await expect(
      book.getByRole("menuitemradio", { name: "切换到麻薯", exact: true }),
    ).toBeChecked();
    expect(await page.getByTestId("companion-sill").boundingBox()).toEqual(
      sill,
    );
    await page.screenshot({
      path: `controlApp/.build/companion-book-${width}-open.png`,
    });
    await book
      .getByRole("menuitemradio", { name: "切换到小满", exact: true })
      .click();
    await page.evaluate(() => window.mochiTest.update({ setup: "ready" }));
    await expect(
      page.getByRole("heading", { name: "小满", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "开始值班", exact: true }),
    ).toBeVisible();
    await expect(picker).toBeFocused();
    expect(await page.getByTestId("companion-sill").boundingBox()).toEqual(
      sill,
    );
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
      { type: "selectBot", botId: roster[2]!.botId },
    ]);
    await picker.click();
    await page.evaluate(() =>
      window.mochiTest.update({ loaded: false, controlReady: false }),
    );
    await expect(
      book.getByText(NOT_RUNNING.label, { exact: true }),
    ).toHaveCount(3);
    await expect(book.getByText("正在值班", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
}
