import { expect, test } from "@playwright/test";
import type {} from "./desktop.pw.ts";

for (const colorScheme of ["light", "dark"] as const)
  for (const width of [360, 1040])
    test(`methods ${colorScheme} ${width}: three plain points, the full protocol and return focus`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 716 });
      await page.emulateMedia({ colorScheme });
      await page.goto("/main/settings.html?page=help");
      const method = page.getByRole("button", { name: /GitHub 调查 从线索/ });
      await method.focus();
      await page.keyboard.press("Enter");
      const reader = page.getByRole("article", { name: "GitHub 调查" });
      // People read what the method means for them; the protocol is one tab away.
      await expect(reader.getByRole("listitem")).toHaveCount(3);
      await expect(
        reader.getByRole("heading", { name: "GitHub 调查协议", exact: true }),
      ).toHaveCount(0);
      await expect(reader.getByRole("textbox")).toHaveCount(0);
      await page.screenshot({
        path: `controlApp/.build/settings-method-${colorScheme}-${width}.png`,
      });
      await page.getByRole("button", { name: "原文", exact: true }).click();
      await expect(
        reader.getByRole("heading", { name: "GitHub 调查协议", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: /^返回/ }).click();
      await expect(method).toBeFocused();
      await page
        .getByRole("navigation", { name: "设置分类" })
        .getByRole("button", { name: "群聊", exact: true })
        .click();
      await page.getByRole("button", { name: /群聊协作 参与群聊/ }).click();
      await page.getByRole("button", { name: "原文", exact: true }).click();
      await page
        .getByRole("article")
        .getByRole("button", { name: "Issue 写作协议", exact: true })
        .click();
      await expect(
        page.getByRole("article", { name: "Issue 协作" }),
      ).toBeVisible();
      expect(await page.evaluate(() => window.mochiTest.skillRequests())).toBe(
        1,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    });

test("arbitrary Markdown retains headings, tables, code and literal HTML without loading remote content", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.org/"))
      remote.push(request.url());
  });
  await page.goto("/main/settings.html?page=help");
  await page.evaluate(() => {
    window.mochiTest.skillContent(
      "# 自己的标题\n\n一个**任意结构**的文档。\n\n## 不是固定栏目\n\n| 项目 | 状态 |\n| --- | --- |\n| 原文 | 保留 |\n\n```js\nconst value = '<tag>';\n```\n\n- [x] 已完成\n- [ ] 待完成\n\n> 一段引用\n\n<script>window.skillExecuted = true</script>\n\n![材料](https://example.org/private.png)\n\n[参考](https://example.org/reference)\n",
    );
    window.mochiTest.navigate({ page: "document", id: "github-investigation" });
  });
  const reader = page.getByRole("article", { name: "GitHub 调查" });
  await page.getByRole("button", { name: "原文", exact: true }).click();
  await expect(
    reader.getByRole("heading", { name: "自己的标题" }),
  ).toBeVisible();
  await expect(reader.getByRole("table")).toContainText("原文保留");
  await expect(reader.locator("pre code")).toHaveText(
    "const value = '<tag>';\n",
  );
  await expect(reader.getByRole("checkbox")).toHaveCount(2);
  await expect(reader.getByRole("checkbox").first()).toBeDisabled();
  await expect(reader.locator("script, iframe, img")).toHaveCount(0);
  await expect(reader).toContainText("https://example.org/private.png");
  await expect(reader).toContainText("https://example.org/reference");
  expect(remote).toEqual([]);
});

test("skills report read failure without retries or stale fallback and reload after reconnect", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=help");
  await page.evaluate(() => {
    window.mochiTest.failAction("skills_unavailable");
    window.mochiTest.navigate({ page: "document", id: "github-investigation" });
  });
  await expect(page.getByRole("alert")).toContainText("暂时无法读取技能");
  expect(await page.evaluate(() => window.mochiTest.skillRequests())).toBe(1);
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.getByRole("button", { name: "原文", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "GitHub 调查协议", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.mochiTest.update({ controlReady: false }));
  await expect(page.getByText("后台连接后，就能查看工作方法。")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "GitHub 调查协议", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.mochiTest.skillContent("# 更新后的技能\n\n新的原文。");
    window.mochiTest.update({ controlReady: true });
  });
  await expect(
    page.getByRole("heading", { name: "更新后的技能" }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.skillRequests())).toBe(3);
});
