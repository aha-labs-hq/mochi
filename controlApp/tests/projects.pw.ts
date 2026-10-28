import { expect, test } from "@playwright/test";
import type {} from "./desktop.pw.ts";

/** Connection, grant and project selection belong to the selected Bot. */
const github = {
  status: "connected" as const,
  account: { id: 1, login: "customer" },
  problem: null,
};
const projects = [
  {
    id: 20,
    ownerId: 1,
    installationId: 30,
    fullName: "customer/mochi",
    private: true,
    canWriteIssues: true,
    selected: true,
  },
  {
    id: 21,
    ownerId: 1,
    installationId: 30,
    fullName: "customer/a-very-long-project-name-that-still-needs-to-fit",
    private: false,
    canWriteIssues: false,
    selected: false,
  },
];
for (const colorScheme of ["light", "dark"] as const)
  for (const width of [360, 520])
    test(`projects ${colorScheme} ${width}: explicit selection, draft retention and real save`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 360 ? 509 : 700 });
      await page.emulateMedia({ colorScheme });
      await page.goto("/main/settings.html?page=projects");
      await page.evaluate(
        (facts) =>
          window.mochiTest.update({
            github: facts.github,
            githubProjects: facts.projects,
          }),
        { github, projects },
      );
      const dialog = page.getByRole("main", { name: "设置内容" });
      await expect(dialog).toContainText("@customer");
      await expect(
        page.getByRole("list", { name: "已选择项目" }),
      ).toBeVisible();
      await expect(page.getByRole("checkbox")).toHaveCount(0);
      await page
        .getByRole("button", { name: "管理访问范围", exact: true })
        .click();
      const checkbox = page.getByRole("checkbox", {
        name: projects[1]!.fullName,
        exact: true,
      });
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await expect(dialog).toContainText("尚未保存");
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.getByRole("button", { name: "连接器", exact: true }).click();
      await page
        .getByRole("button", { name: "打开 GitHub", exact: true })
        .click();
      await expect(checkbox).toBeChecked();
      await page.getByLabel("查找 GitHub 项目").fill("mochi");
      await expect(dialog.getByRole("checkbox")).toHaveCount(1);
      await page.getByLabel("查找 GitHub 项目").fill("");
      await page.screenshot({
        path: `controlApp/.build/settings-projects-${colorScheme}-${width}.png`,
      });
      const save = dialog.getByRole("button", {
        name: "保存项目选择",
        exact: true,
      });
      await save.click();
      await expect(dialog).toContainText("已选择 2 个项目");
      await expect(save).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "管理访问范围", exact: true }),
      ).toBeFocused();
      expect(
        await page.evaluate(() =>
          window.mochiTest.actions.filter(
            (action) => action.type === "selectProjects",
          ),
        ),
      ).toEqual([
        {
          type: "selectProjects",
          resourceIds: ["repository:20", "repository:21"],
        },
      ]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(
        (await page.evaluate(() => window.mochiTest.closeState())).dirty,
      ).toBe(false);
    });

test("projects: missing issuer config is not a fake login; ongoing authorization is cancelable", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  // Start the transition after the initial connected page has mounted.
  await expect(
    page.getByRole("heading", { name: "GitHub", level: 1, exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.mochiTest.update({
      github: {
        status: "unavailable",
        account: null,
        problem: "issuer_not_configured",
      },
    }),
  );
  await expect(page.getByRole("main", { name: "设置内容" })).toContainText(
    "无需你填写密钥",
  );
  await expect(
    page.getByRole("button", { name: "连接 GitHub", exact: true }),
  ).toHaveCount(0);
  // Opening the page asks nothing of the Bot; it keeps the projects current.
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  await page.evaluate(() =>
    window.mochiTest.update({
      github: {
        status: "authorizing",
        account: null,
        problem: null,
      },
      canReopenGitHubLogin: true,
    }),
  );
  await page
    .getByRole("button", { name: "继续 GitHub 授权", exact: true })
    .click();
  await page.getByRole("button", { name: "取消授权", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "reopenGitHubLogin" },
    { type: "cancelGitHubLogin" },
  ]);
});

test("projects: a pending save is a neutral status, and there is nothing to refresh", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        github: facts.github,
        githubProjects: facts.projects,
      }),
    { github, projects },
  );
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  await expect(page.getByRole("button", { name: /刷新|重新检查/ })).toHaveCount(
    0,
  );
  await page
    .getByRole("checkbox", { name: projects[1]!.fullName, exact: true })
    .click();
  await page.evaluate(() => window.mochiTest.holdActions());
  await page.getByRole("button", { name: "保存项目选择", exact: true }).click();
  await expect(
    page.getByText("正在保存项目选择…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => window.mochiTest.releaseActions());
  await expect(
    page.getByText("正在保存项目选择…", { exact: true }),
  ).toHaveCount(0);
});

test("projects: failed save retains the draft; another account cannot inherit it", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        github: facts.github,
        githubProjects: facts.projects,
      }),
    { github, projects },
  );
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  const checkbox = page.getByRole("checkbox", {
    name: projects[1]!.fullName,
    exact: true,
  });
  await checkbox.click();
  await page.evaluate(() =>
    window.mochiTest.failAction("github_selection_failed"),
  );
  await page.getByRole("button", { name: "保存项目选择", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("可选项目会自动更新");
  await expect(checkbox).toBeChecked();
  await expect(page.getByRole("main", { name: "设置内容" })).toContainText(
    "尚未保存",
  );
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        github: { ...facts.github, account: { id: 2, login: "another" } },
        githubProjects: facts.projects.map((project) => ({
          ...project,
          selected: false,
        })),
      }),
    { github, projects },
  );
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByRole("main", { name: "设置内容" })).toContainText(
    "已选择 0 个项目",
  );
});

test("an accepted project save keeps native close busy until its result arrives", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        github: facts.github,
        githubProjects: facts.projects,
      }),
    { github, projects },
  );
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  await page
    .getByRole("checkbox", { name: projects[1]!.fullName, exact: true })
    .click();
  await page.evaluate(() => window.mochiTest.holdActions());
  await page.getByRole("button", { name: "保存项目选择", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.closeState())).toEqual({
    dirty: true,
    busy: true,
  });
  await page.evaluate(() => window.mochiTest.releaseActions());
  await expect(
    page.getByText("已选择 2 个项目", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.closeState())).toEqual({
    dirty: false,
    busy: false,
  });
});

test("setup at 960 by 680 exposes real selection and save without scrolling the whole page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 680 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/main/index.html");
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        setup: null,
        github: facts.github,
        githubProjects: Array.from({ length: 30 }, (_, index) => ({
          ...facts.projects[0]!,
          id: index + 100,
          fullName: `customer/project-${index}`,
          selected: false,
        })),
      }),
    { github, projects },
  );
  await page.evaluate(() => window.mochiTest.beginSetup());
  await expect(
    page.getByRole("heading", { name: "选择 GitHub 项目" }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("setup-journey")
      .locator('ol[aria-label="准备进度"] button'),
  ).toHaveCount(0);
  const save = page.getByRole("button", { name: "保存项目选择", exact: true });
  const box = await save.boundingBox();
  const reading = await page.locator("[data-journey-scroll]").boundingBox();
  expect(box!.y + box!.height).toBeLessThan(reading!.y + reading!.height);
  await expect(save).toBeInViewport({ ratio: 1 });
  const list = await page.getByRole("list", { name: "可选项目" }).boundingBox();
  expect(box!.y).toBeGreaterThan(list!.y + list!.height);
  const thirdChoice = await page.getByRole("checkbox").nth(2).boundingBox();
  expect(thirdChoice!.y + thirdChoice!.height).toBeLessThan(
    list!.y + list!.height,
  );
  const search = page.getByRole("textbox", { name: "查找 GitHub 项目" });
  await search.fill("no-such-project");
  await expect(page.getByText("没有匹配的项目。")).toBeInViewport({ ratio: 1 });
  await expect(save).toBeDisabled();
  await search.fill("");
  await page.getByRole("checkbox").first().click();
  await expect(save).toBeEnabled();
  await page.screenshot({ path: "controlApp/.build/setup-projects-960.png" });
  await save.click();
  await expect(
    page.getByRole("heading", { name: "去飞书，问第一个问题" }),
  ).toBeVisible();
});
