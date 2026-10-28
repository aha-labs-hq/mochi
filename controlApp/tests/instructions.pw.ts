import { expect, test } from "@playwright/test";
import type {} from "./desktop.pw.ts";

test("default Settings gives the editor the viewport and keeps the page scrollbar at the panel edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.goto("/main/settings.html?page=instructions");
  const editor = page.locator("#mochi-instructions");
  await expect(editor).toContainText("先讲结论");
  const scroll = page.locator("[data-settings-scroll]");
  const panel = page.getByTestId("settings-reading-surface");
  const scrollBox = (await scroll.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(
    panelBox.x + panelBox.width - scrollBox.x - scrollBox.width,
  ).toBeLessThanOrEqual(2);
  expect(
    await scroll.evaluate((node) => node.scrollHeight - node.clientHeight),
  ).toBeLessThanOrEqual(1);
  await expect(editor.locator("..")).toBeInViewport({ ratio: 1 });
  expect((await editor.boundingBox())!.height).toBeGreaterThanOrEqual(320);

  const title = page.getByRole("heading", { name: "设定", exact: true });
  const identity = page.getByRole("region", { name: "伙伴身份" });
  const identityLabel = identity.locator('label[for="bot-name"]');
  const identityValue = identity.getByRole("textbox", { name: "伙伴的名字" });
  const label = page.locator('label[for="mochi-instructions"]');
  const help = page.locator("#instructions-help");
  const frame = editor.locator("..");
  const status = page.getByRole("status");
  const save = page.getByRole("button", { name: "保存嘱咐", exact: true });
  const titleBox = (await title.boundingBox())!;
  const frameBox = (await frame.boundingBox())!;
  for (const item of [identityLabel, label, frame, status]) {
    expect(Math.abs((await item.boundingBox())!.x - titleBox.x)).toBeLessThan(
      1,
    );
  }
  const saveBox = (await save.boundingBox())!;
  expect(
    Math.abs(frameBox.x + frameBox.width - saveBox.x - saveBox.width),
  ).toBeLessThan(1);
  expect(
    Math.abs(
      (await identityValue.boundingBox())!.x - (await help.boundingBox())!.x,
    ),
  ).toBeLessThan(1);
  const labelBox = (await label.boundingBox())!;
  const identityBox = (await identity.boundingBox())!;
  const withinGroup = frameBox.y - labelBox.y - labelBox.height;
  const betweenGroups = labelBox.y - identityBox.y - identityBox.height;
  expect(betweenGroups).toBeGreaterThan(withinGroup);
  expect((await status.boundingBox())!.y).toBe(saveBox.y);

  const name = page.getByRole("textbox", { name: "伙伴的名字" });
  expect(
    Math.abs((await name.boundingBox())!.x - (await help.boundingBox())!.x),
  ).toBeLessThan(1);
  expect(
    Math.abs(
      (await page.getByTestId("character-choice-list").boundingBox())!.x -
        (await help.boundingBox())!.x,
    ),
  ).toBeLessThan(1);
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [360, 640],
    [1040, 716],
    [1040, 840],
  ] as const) {
    test(`instructions ${colorScheme} ${width}x${height}: edit, retain, save, close`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      await page.goto("/main/settings.html?page=instructions");
      const editor = page.getByRole("textbox", { name: "给麻薯的嘱咐" });
      await expect(editor).toContainText("先讲结论");
      await expect(
        page.getByRole("button", { name: "保存嘱咐" }),
      ).toBeInViewport({ ratio: 1 });
      await expect(
        page.getByRole("button", { name: "完成", exact: true }),
      ).toHaveCount(0);
      const bounds = await editor.boundingBox();
      const lineHeight = await editor.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node).lineHeight),
      );
      // A spacious editor must fit real lines and its complete frame, not
      // satisfy a fixed height by overflowing underneath the save row.
      expect(bounds!.height).toBeGreaterThan(
        width === 360 ? 190 : 10 * lineHeight + 32,
      );
      expect(bounds!.width).toBeGreaterThan(width === 360 ? 270 : 550);
      await editor.locator("..").scrollIntoViewIfNeeded();
      await expect(editor.locator("..")).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: `controlApp/.build/settings-instructions-${colorScheme}-${width}x${height}.png`,
      });
      await editor.fill("先说结果，别给同事增加学习负担。\n保留必要来源。");
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.getByRole("button", { name: "设定", exact: true }).click();
      await expect(editor).toHaveValue(
        "先说结果，别给同事增加学习负担。\n保留必要来源。",
      );
      expect(await page.evaluate(() => window.mochiTest.closeState())).toEqual({
        dirty: true,
        busy: false,
      });
      await page.getByRole("button", { name: "保存嘱咐", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("已保存");
      await expect(
        page.getByRole("button", { name: "保存嘱咐" }),
      ).toBeDisabled();
      expect(await page.evaluate(() => window.mochiTest.closeState())).toEqual({
        dirty: false,
        busy: false,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
    });
  }
}

test("instructions keeps the draft on failure and explicitly reconciles another edit", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  const editor = page.getByRole("textbox", { name: "给麻薯的嘱咐" });
  await expect(editor).toBeVisible();
  await editor.fill("我写的版本");
  await page.evaluate(() =>
    window.mochiTest.failAction("instructions_conflict"),
  );
  await page.getByRole("button", { name: "保存嘱咐" }).click();
  await expect(page.getByRole("alert")).toContainText("草稿已保留");
  await expect(editor).toHaveValue("我写的版本");
  await expect(page.getByRole("button", { name: "保存嘱咐" })).toBeDisabled();
  await editor.press("Meta+s");
  await expect(page.getByRole("status")).toContainText("尚未保存");
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page.getByRole("button", { name: "查看最新内容" }).click();
  await expect(page.getByText("另一处保存的内容")).toBeVisible();
  await page.getByRole("button", { name: "已核对，继续编辑草稿" }).click();
  await expect(editor).toHaveValue("我写的版本");
  await page.getByRole("button", { name: "保存嘱咐" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await editor.fill(" ");
  await expect(page.getByRole("button", { name: "保存嘱咐" })).toBeDisabled();
  await editor.press("Meta+s");
  await expect(page.getByRole("status")).toContainText("未保存");
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    true,
  );
});

test("the writing surface keeps save visible for long documents and saves with the keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 509 });
  await page.goto("/main/settings.html?page=instructions");
  const editor = page.getByRole("textbox", { name: "给麻薯的嘱咐" });
  const save = page.getByRole("button", { name: "保存嘱咐" });
  await expect(editor).toBeVisible();
  const content = "先讲结论，照顾所有同事。\n\n".repeat(100);
  await editor.fill(content);
  await expect(page.getByRole("status")).toContainText("未保存");
  await expect(save).toBeInViewport({ ratio: 1 });
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(12, 12);
    element.scrollTop = 180;
  });
  const scrollBeforeSave = await editor.evaluate(
    (element) => element.scrollTop,
  );
  await editor.press("Meta+s");
  await expect(page.getByRole("status")).toContainText("已保存");
  await expect(save).toBeDisabled();
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate(
      (element: HTMLTextAreaElement) => element.selectionStart,
    ),
  ).toBe(12);
  expect(await editor.evaluate((element) => element.scrollTop)).toBe(
    scrollBeforeSave,
  );
  await editor.fill("断连后也要保留这次修改");
  await page.evaluate(() => window.mochiTest.update({ controlReady: false }));
  await expect(save).toBeDisabled();
  await editor.press("Meta+s");
  await expect(page.getByRole("status")).toContainText("未保存");
  await expect(editor).toHaveValue("断连后也要保留这次修改");
  await page.evaluate(() => window.mochiTest.update({ controlReady: true }));
  await editor.press("Control+s");
  await expect(page.getByRole("status")).toContainText("已保存");
  await expect(save).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    360,
  );
});

test("instructions preview their Markdown without a second editor", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  const editor = page.getByRole("textbox", { name: "给麻薯的嘱咐" });
  await expect(editor).toContainText("## 怎么说话");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  const preview = page.getByRole("document", { name: "给麻薯的嘱咐预览" });
  await expect(
    preview.getByRole("heading", { name: "怎么说话", exact: true }),
  ).toBeVisible();
  await expect(preview).not.toContainText("##");
  await expect(page.getByRole("textbox", { name: "给麻薯的嘱咐" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(editor).toBeVisible();
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    false,
  );
});
