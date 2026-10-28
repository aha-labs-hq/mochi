import { expect, test } from "@playwright/test";
import {
  EXPERIENCE_SCENES,
  experienceSceneIds,
} from "../src/shared/experiencePreview.ts";

test("menu-style entrance navigation owns keyboard focus and Escape reaches setup", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => window.mochiTest.previewExperience("encounter"));
  await expect(
    page.getByRole("heading", { name: "麻薯来到你的桌面" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("setup-journey")).toBeVisible();
  await expect(page.getByRole("button", { name: /跳过开场/ })).toHaveCount(0);
  await expect(page.locator("canvas[aria-label='Mochi']")).toHaveCount(1);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("repeated entrance replay never retains orphaned invitations or skip controls", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  for (let replay = 0; replay < 4; replay++) {
    await page.evaluate(() => window.mochiTest.previewExperience("encounter"));
    await expect(page.getByTestId("encounter")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /跳过开场/ })).toHaveCount(1);
    await page.getByRole("button", { name: "重播", exact: true }).click();
    await expect(page.getByTestId("encounter")).toHaveCount(1);
    await page.evaluate(() => window.mochiTest.previewExperience("intro"));
    await expect(page.getByTestId("encounter")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /跳过开场/ })).toHaveCount(0);
    await expect(page.getByTestId("introduction")).toHaveCount(1);
    await expect(page.locator("canvas[aria-label='Mochi']")).toHaveCount(1);
  }
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("all review scenes are reachable offline, labelled and free of provider calls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 680 });
  await page.goto("/main/index.html");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() =>
    window.mochiTest.update({
      controlReady: false,
      problem: {
        code: "control_unavailable",
        title: "真实后台离线",
        message: "离线",
        recoveryAction: "restartService",
      },
    }),
  );
  for (const scene of experienceSceneIds) {
    await page.evaluate(
      (scene) => window.mochiTest.previewExperience(scene),
      scene,
    );
    if (EXPERIENCE_SCENES[scene].surface === "companion") {
      await expect(page.getByTestId("bot-home")).toHaveAttribute(
        "data-preview",
        "true",
      );
      await expect(page.getByRole("switch")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("shell")).toHaveAttribute(
        "data-experience-preview",
        scene,
      );
      await expect(page.getByTestId("shell")).toHaveAttribute(
        "data-surface",
        EXPERIENCE_SCENES[scene].surface,
      );
    }
    await expect(
      page.getByRole("complementary", { name: "体验预览控制" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "真实后台离线" }),
    ).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  await page.getByRole("button", { name: "退出预览", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("真实后台离线");
});

test("demo authorization and selection buttons cannot reach the live connection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 680 });
  await page.goto("/main/index.html");
  await page.evaluate(() => window.mochiTest.previewExperience("signIn"));
  await page.getByRole("button", { name: "连接 ChatGPT", exact: true }).click();
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-experience-preview",
    "signingIn",
  );
  await page.evaluate(() => window.mochiTest.previewExperience("feishuScan"));
  await expect(page.getByText("不生成有效二维码")).toBeVisible();
  await page.getByRole("button", { name: "在浏览器中打开" }).click();
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-experience-preview",
    "feishuChecking",
  );
  await page.evaluate(() => window.mochiTest.previewExperience("projects"));
  await page.getByRole("checkbox", { name: "example/our-project" }).click();
  await page.getByRole("button", { name: "保存项目选择" }).click();
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-experience-preview",
    "emptyGroups",
  );
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  expect(await page.evaluate(() => window.mochiTest.modelRequests())).toBe(0);
});

test("replay restarts the narrative without replacing its character canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/main/index.html");
  await page.evaluate(() => window.mochiTest.previewExperience("intro"));
  await page
    .getByRole("button", { name: "看看麻薯怎么协作", exact: true })
    .click();
  await page.getByRole("button", { name: "产品", exact: true }).click();
  await expect(page.getByTestId("story-message-0")).toBeVisible();
  const canvas = await page
    .locator("canvas[aria-label='Mochi']")
    .elementHandle();
  await expect(page.getByTestId("story-message-2")).toBeVisible();
  await page.getByRole("button", { name: "重播", exact: true }).click();
  await expect(page.getByTestId("story-thread")).toHaveCount(0);
  await expect(page.locator('[data-intro-view="welcome"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "产品", exact: true }),
  ).toBeHidden();
  await page
    .getByRole("button", { name: "看看麻薯怎么协作", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "产品", exact: true }),
  ).toBeVisible();
  expect(
    await canvas!.evaluate(
      (node) => node === document.querySelector("canvas[aria-label='Mochi']"),
    ),
  ).toBe(true);
});
