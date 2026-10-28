import { expect, test } from "@playwright/test";
import { connectedBotId, connectedFacts } from "./connectedFacts.ts";
import type {} from "./desktop.pw.ts";

test("one Bot profile owns name and instructions without duplicating resource pages", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  await expect(
    page.getByRole("navigation", { name: "设置分类" }).getByRole("button"),
  ).toHaveText(["设定", "连接器", "模型", "群聊", "安排"]);
  await expect(
    page.getByRole("heading", { name: "设定", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "伙伴的名字" })).toBeVisible();
  await expect(page.getByRole("group", { name: "角色形象" })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(3);
  await expect(page.getByRole("textbox", { name: "伙伴的名字" })).toHaveValue(
    "麻薯",
  );
  await expect(
    page.getByRole("textbox", { name: "给麻薯的嘱咐" }),
  ).toContainText("先讲结论");
  await expect(
    page.getByRole("region", { name: "这个 Bot 的配置" }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(0);
});

test("saving a name leaves instruction edits intact and keyboard saving follows the focused form", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  const editor = page.locator("#mochi-instructions");
  const name = page.getByRole("textbox", { name: "伙伴的名字" });
  await editor.fill("保留这份尚未保存的嘱咐");
  await name.fill("小满");
  await expect(page.getByRole("region", { name: "伙伴身份" })).toContainText(
    "名字未保存",
  );
  await expect(editor).toHaveValue("保留这份尚未保存的嘱咐");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "设定", exact: true }).click();
  await expect(name).toHaveValue("小满");
  await expect(editor).toHaveValue("保留这份尚未保存的嘱咐");
  await name.press("Meta+s");
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "renameBot", botId: connectedBotId, label: "小满" },
  ]);
  expect(
    await page.evaluate(() =>
      window.mochiTest.botWrites.filter(
        (write) => write.kind === "instructions",
      ),
    ),
  ).toEqual([]);
  await expect(editor).toHaveValue("保留这份尚未保存的嘱咐");
  await editor.press("Meta+s");
  await expect(page.getByRole("status")).toContainText("已保存");
  expect(
    await page.evaluate(() =>
      window.mochiTest.botWrites.filter(
        (write) => write.kind === "instructions",
      ),
    ),
  ).toEqual([
    {
      botId: connectedBotId,
      kind: "instructions",
      content: "保留这份尚未保存的嘱咐",
    },
  ]);
});

test("the shared Bot duty control remains available across all four categories", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  const control = page.getByRole("switch", { name: "麻薯：值班", exact: true });
  for (const label of ["设定", "连接器", "模型", "群聊"]) {
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: label, exact: true })
      .click();
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  await control.click();
  await expect(control).not.toBeChecked();
  expect(
    (await page.evaluate(() => window.mochiTest.actions)).filter(
      (action) => action.type === "setBotEnabled",
    ),
  ).toEqual([{ type: "setBotEnabled", botId: connectedBotId, enabled: false }]);
});

for (const width of [360, 900, 1040]) {
  test(`a long saved name and a new draft stay readable in the ${width}px profile grid`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 716 });
    await page.goto("/main/settings.html?page=instructions");
    const identity = page.getByRole("region", { name: "伙伴身份" });
    const savedName = "一起把每件正在推进的事情讲清楚".repeat(3);
    await page.evaluate(
      (bots) => window.mochiTest.update({ bots }),
      connectedFacts.bots.map((bot) => ({ ...bot, label: savedName })),
    );
    const name = page.getByRole("textbox", { name: "伙伴的名字" });
    await expect(name).toHaveValue(savedName);
    const help = page.locator("#instructions-help");
    expect(
      Math.abs((await name.boundingBox())!.x - (await help.boundingBox())!.x),
    ).toBeLessThan(1);
    await name.fill("新的名字草稿");
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.getByRole("button", { name: "设定", exact: true }).click();
    await expect(name).toHaveValue("新的名字草稿");
    await expect(
      page.getByRole("region", { name: "当前伙伴", exact: true }),
    ).toContainText(savedName);
    await expect(identity.getByText("名字未保存")).toBeInViewport({ ratio: 1 });
    const duty = page
      .getByRole("region", { name: "当前伙伴", exact: true })
      .getByText("正在值班", { exact: true });
    expect(
      await duty.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length;
      }),
    ).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    const bounds = (await identity.boundingBox())!;
    for (const item of [
      identity.getByText("名字未保存"),
      name,
      identity.getByRole("button", { name: "保存名字", exact: true }),
    ]) {
      const box = (await item.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(
        bounds.x + bounds.width + 1,
      );
    }
    await page.screenshot({
      path: `controlApp/.build/settings-profile-name-${width}.png`,
    });
  });
}
