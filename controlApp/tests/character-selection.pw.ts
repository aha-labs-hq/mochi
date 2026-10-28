import { expect, test } from "@playwright/test";
import { connectedBotId } from "./connectedFacts.ts";

const characters = [
  { id: "mochi", name: "Mochi" },
  { id: "awawa", name: "Awawa" },
  { id: "kiwi", name: "Kiwi" },
] as const;

for (const width of [360, 640, 1040]) {
  test(`角色选择在 ${width}px 下保持清晰且不横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 640 ? 640 : 716 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/main/settings.html?page=instructions");

    const choices = page.getByRole("group", { name: "角色形象" });
    const radios = choices.getByRole("radio");
    await expect(radios).toHaveCount(characters.length);
    await expect(radios.nth(0)).toBeChecked();
    await expect(
      choices.getByRole("radio", { name: /^Awawa：岩蹄兔/ }),
    ).toBeVisible();
    await expect(
      choices.getByRole("radio", { name: /^Kiwi：Kiwi 鸟/ }),
    ).toBeVisible();
    await expect(choices.locator("label").nth(1)).toHaveAttribute(
      "title",
      /岩蹄兔的短耳、浅腹与胡须轮廓/,
    );
    await expect(choices.locator("label").nth(2)).toHaveAttribute(
      "title",
      /Kiwi 鸟的长喙、圆身与宽脚趾/,
    );

    const images = choices.locator("img");
    await expect(images).toHaveCount(characters.length);
    await expect
      .poll(() =>
        images.evaluateAll((nodes) =>
          nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);

    const boxes = await Promise.all(
      characters.map(async ({ name }) => {
        const box = await choices
          .getByRole("radio", { name: new RegExp(`^${name}：`) })
          .boundingBox();
        if (!box) throw new Error(`${name} card is not measurable`);
        return box;
      }),
    );
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await expect(radios.nth(2)).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);

    const awawa = choices.getByRole("radio", { name: /^Awawa：/ });
    await awawa.check();
    await expect(awawa).toBeChecked();
    await expect(radios.nth(0)).not.toBeChecked();
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.actions))
      .toEqual([
        {
          type: "setBotCharacter",
          botId: connectedBotId,
          characterId: "awawa",
        },
      ]);

    const kiwi = choices.getByRole("radio", { name: /^Kiwi：/ });
    await kiwi.check();
    await expect(kiwi).toBeChecked();
    await expect(awawa).not.toBeChecked();
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.actions))
      .toHaveLength(2);

    await page.screenshot({
      path: `controlApp/.build/character-selection-${width}.png`,
    });
  });
}

test("角色选择在后台不可用时保持只读且不发出写入", async ({ page }) => {
  await page.goto("/main/settings.html?page=instructions");
  await page.evaluate(() => window.mochiTest.update({ controlReady: false }));
  const choices = page.getByRole("group", { name: "角色形象" });
  const awawa = choices.getByRole("radio", { name: /^Awawa：/ });
  await expect(awawa).toBeDisabled();
  await expect(awawa).toBeChecked({ checked: false });
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("更换形象只在后台确认后显示选中，失败不清除嘱咐草稿", async ({ page }) => {
  await page.goto("/main/settings.html?page=instructions");
  const editor = page.locator("#mochi-instructions");
  await editor.fill("这是尚未保存的嘱咐");
  await page.evaluate(() => {
    window.mochiTest.holdActions();
    window.mochiTest.failAction("control_unavailable", "setBotCharacter");
  });
  const choices = page.getByRole("group", { name: "角色形象" });
  const awawa = choices.getByRole("radio", { name: /^Awawa：/ });
  await awawa.click();
  await expect(awawa).not.toBeChecked();
  await expect(choices.getByRole("radio", { name: /^Mochi：/ })).toBeChecked();
  await page.evaluate(() => window.mochiTest.releaseActions());
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(awawa).not.toBeChecked();
  await expect(editor).toHaveValue("这是尚未保存的嘱咐");
  expect(
    await page.evaluate(() => window.mochiTest.closeState()),
  ).toMatchObject({
    dirty: true,
  });
});

for (const [width, height] of [
  [1040, 716],
  [1152, 828],
] as const) {
  test(`设定在 ${width}×${height} 嘱咐占用可用视口，正文滚动不移动页面`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/main/settings.html?page=instructions");
    const editor = page.locator("#mochi-instructions");
    await expect(editor).toContainText("先讲结论");
    const surface = page.locator("[data-settings-scroll]");
    const frame = editor.locator("..");
    const save = page.getByRole("button", { name: "保存嘱咐", exact: true });
    await expect(
      page.getByRole("heading", { name: "设定", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(save).toBeInViewport({ ratio: 1 });
    await frame.scrollIntoViewIfNeeded();
    await expect(frame).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole("heading", { name: "嘱咐", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#instructions-help")).toBeInViewport({
      ratio: 1,
    });
    await expect(save).toHaveText("保存嘱咐");
    await expect(save).toBeInViewport({ ratio: 1 });
    expect(await page.locator("form form").count()).toBe(0);
    await editor.fill("先讲结论，保留必要来源。\n".repeat(120));
    const before = await surface.evaluate((node) => node.scrollTop);
    const box = (await editor.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => editor.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    expect(await surface.evaluate((node) => node.scrollTop)).toBe(before);
    await expect(frame).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#instructions-help")).toBeInViewport({
      ratio: 1,
    });
    await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: `controlApp/.build/settings-layout-${width}-${height}.png`,
    });
  });
}

test("短窗口通过同一页面滚动访问设定，保存栏和编辑框均可完整到达", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 540 });
  await page.goto("/main/settings.html?page=instructions");
  const editor = page.locator("#mochi-instructions");
  await expect(editor).toContainText("先讲结论");
  const frame = editor.locator("..");
  const save = page.getByRole("button", { name: "保存嘱咐", exact: true });
  await expect(
    page.getByRole("heading", { name: "设定", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
  await frame.scrollIntoViewIfNeeded();
  await expect(frame).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
  const before = await page
    .locator("[data-settings-scroll]")
    .evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(0);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "设定", exact: true }).click();
  expect(
    await page
      .locator("[data-settings-scroll]")
      .evaluate((node) => node.scrollTop),
  ).toBe(before);
  await expect(frame).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
});
