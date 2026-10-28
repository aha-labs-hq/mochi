import { expect, test } from "@playwright/test";
import QRCode from "qrcode";
import type { DesktopSnapshot } from "../src/shared/model.ts";
import { connectedFacts } from "./connectedFacts.ts";

const bot = { name: "Mochi — 我的飞书机器人", avatarUrl: null };

test("Lark uses the same connection page and names the verified platform", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => window.mochiTest.beginSetup());
  await page.evaluate(() =>
    window.mochiTest.update({
      setup: null,
      feishu: {
        active: null,
        candidate: {
          state: "needsAction",
          brand: "lark",
          bot: { name: "Riley’s team", avatarUrl: null },
          problem: "permissions_required",
        },
      },
      feishuGroups: null,
      eventStreamReady: false,
    }),
  );
  await expect(
    page.getByRole("heading", { name: "需要补充 Lark 权限" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "去 Lark 确认授权" }),
  ).toBeVisible();
  await expect(page.getByText("Riley’s team", { exact: true })).toBeVisible();
  await expect(page.locator('[data-chapter="feishu"]')).toHaveCSS(
    "opacity",
    "1",
  );
  await page.screenshot({ path: "controlApp/.build/lark-connection.png" });
  await page.getByRole("button", { name: "去 Lark 确认授权" }).click();
  expect(await page.evaluate(() => window.mochiTest.actions.at(-1)?.type)).toBe(
    "feishuSettings",
  );
});

test("a pending approval check never carries its page or reply to another partner", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/main/settings.html?page=groups");
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
      feishu: {
        active: null,
        candidate: {
          brand: "feishu" as const,
          state: "needsAction",
          bot: { name: "第一位的机器人", avatarUrl: null },
          problem: "permissions_approval_required",
        },
      },
      feishuGroups: null,
    });
    window.mochiTest.holdActions();
  }, connectedFacts.bots[0]!);
  await page.clock.fastForward(30_000);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mochiTest.actions.filter(
            (action) => action.type === "checkFeishuCandidate",
          ).length,
      ),
    )
    .toBe(1);
  // A new host frame selects B before A's check finishes.
  await page.evaluate(() =>
    window.mochiTest.update({
      selectedBotId: "22222222-2222-4222-8222-222222222222",
      feishu: { active: null, candidate: null },
    }),
  );
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开始连接", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("飞书权限尚未获批", { exact: true })).toHaveCount(
    0,
  );
  await page.evaluate(() => window.mochiTest.releaseActions());
  await page.clock.fastForward(120_000);
  await expect(
    page.getByRole("button", { name: "开始连接", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.mochiTest.actions.filter(
          (action) => action.type === "checkFeishuCandidate",
        ).length,
    ),
  ).toBe(1);
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [360, 520]) {
    test(`Feishu ${colorScheme} ${width}: one real step, recoverable QR and bounded layout`, async ({
      page,
    }) => {
      const height = width === 360 ? 509 : 700;
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.goto("/main/index.html");
      await page.evaluate(() => window.mochiTest.beginSetup());
      await page.evaluate(() =>
        window.mochiTest.update({
          setup: null,
          feishu: { active: null, candidate: null },
          feishuGroups: null,
          eventStreamReady: false,
        }),
      );
      await expect(
        page.getByRole("heading", { name: "连接团队群聊" }),
      ).toBeVisible();
      expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
      await page.getByRole("button", { name: "开始连接", exact: true }).click();

      const qr = await QRCode.toDataURL(
        "https://accounts.feishu.cn/fixture-only",
        { margin: 4, scale: 6 },
      );
      await page.evaluate(
        (qr) =>
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
            feishuVerificationQr: qr,
            canReopenFeishuConnection: true,
          }),
        qr,
      );
      const image = page.getByRole("img", {
        name: "用飞书或 Lark 扫码，确认连接机器人",
      });
      await expect(image).toBeVisible();
      await expect(image).toHaveJSProperty("complete", true);
      expect(
        await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
      ).toBeGreaterThan(0);
      await image.scrollIntoViewIfNeeded();
      const bounds = await image.boundingBox();
      expect(bounds!.width).toBe(176);
      expect(bounds!.y).toBeGreaterThan(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
      const visibleArea = await page
        .getByTestId("setup-journey")
        .locator("[data-journey-scroll]")
        .boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(visibleArea!.y);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
        visibleArea!.y + visibleArea!.height,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: `controlApp/.build/feishu-qr-${colorScheme}-${width}.png`,
      });
      await page.getByRole("button", { name: "取消扫码" }).click();
      expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
        { type: "connectFeishu" },
        { type: "cancelFeishuConnection" },
      ]);
      await page.evaluate(
        (bot) =>
          window.mochiTest.update({
            feishu: {
              active: null,
              candidate: {
                brand: "feishu" as const,
                state: "needsAction",
                bot,
                problem: "permissions_required",
              },
            },
            feishuVerificationQr: null,
            canReopenFeishuConnection: false,
          }),
        bot,
      );
      await expect(
        page.getByText("飞书还没有授予完整权限。", { exact: false }),
      ).toBeVisible();
      await page.getByRole("button", { name: "去飞书确认授权" }).click();
      await page.getByRole("button", { name: "已处理，检查并继续" }).click();
      // A long recovery page may be scrolled; the next task must start at its heading.
      await page.locator("[data-journey-scroll]").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await page.evaluate(
        (bot) =>
          window.mochiTest.update({
            feishu: {
              active: null,
              candidate: {
                brand: "feishu" as const,
                state: "ready",
                bot,
                problem: null,
              },
            },
          }),
        bot,
      );
      await expect(
        page.getByRole("heading", { name: "确认你的飞书机器人" }),
      ).toBeFocused();
      expect(
        await page
          .locator("[data-journey-scroll]")
          .evaluate((node) => node.scrollTop),
      ).toBe(0);
      await page
        .getByRole("button", { name: "使用这个机器人", exact: true })
        .click();
      expect(
        (await page.evaluate(() => window.mochiTest.actions)).slice(2),
      ).toEqual([
        { type: "feishuSettings" },
        { type: "checkFeishuCandidate" },
        { type: "activateFeishuConnection" },
      ]);
    });
  }
}

test("Settings retains the current Bot while a replacement is pending; reopening resumes the same attempt", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=feishu");
  const active: DesktopSnapshot["feishu"]["active"] = {
    state: "ready",
    brand: "feishu",
    bot,
  };
  await page.evaluate(
    (active) =>
      window.mochiTest.update({ feishu: { active, candidate: null } }),
    active,
  );
  await page.getByRole("button", { name: "连接另一个机器人" }).click();
  await page.evaluate(
    (active) =>
      window.mochiTest.update({
        feishu: {
          active,
          candidate: {
            brand: null,
            state: "registering",
            bot: null,
            problem: null,
          },
        },
        feishuVerificationQr: null,
        canReopenFeishuConnection: false,
      }),
    active,
  );
  await page.getByRole("button", { name: "继续这次扫码" }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续这次扫码" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^返回/ }).click();
  await expect(
    page.getByRole("switch", { name: "Mochi 测试群：回应消息" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.mochiTest.actions.filter(
        (action) => action.type === "connectFeishu",
      ),
    ),
  ).toHaveLength(2);
  expect(
    await page.evaluate(() =>
      window.mochiTest.actions.some(
        (action) => action.type === "disconnectFeishu",
      ),
    ),
  ).toBe(false);
});

test("an administrator approval hands over a link and watches for the answer", async ({
  page,
}) => {
  await page.clock.install();
  await page.setViewportSize({ width: 520, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/main/index.html");
  await page.evaluate(() => window.mochiTest.beginSetup());
  const waiting = {
    brand: "feishu" as const,
    state: "needsAction",
    bot,
    problem: "permissions_approval_required",
  } as const;
  await page.evaluate(
    (candidate) =>
      window.mochiTest.update({
        setup: null,
        feishu: { active: null, candidate },
        feishuGroups: null,
        eventStreamReady: false,
      }),
    waiting,
  );
  const heading = page.getByRole("heading", { level: 1 });
  const title = await heading.textContent();
  await expect(page.getByText("权限申请已提交", { exact: false })).toHaveCount(
    0,
  );
  const copy = page.getByRole("button", { name: "复制权限链接" });
  await copy.click();
  await expect(copy).toContainText("已复制");
  // The manual "done, check" step is replaced by watching for the answer.
  await expect(
    page.getByRole("button", { name: "已处理，检查并继续" }),
  ).toHaveCount(0);
  const abandon = page.getByRole("button", { name: "放弃这次连接" });
  await expect(abandon).toBeVisible();
  expect((await abandon.boundingBox())!.height).toBeLessThan(
    (await copy.boundingBox())!.height,
  );
  const checks = () =>
    page.evaluate(
      () =>
        window.mochiTest.actions.filter(
          (action) => action.type === "checkFeishuCandidate",
        ).length,
    );
  expect(await checks()).toBe(0);
  // A check in flight never replaces the waiting page or moves focus.
  await page.evaluate(() => window.mochiTest.holdActions());
  await page.clock.fastForward(30_000);
  await expect.poll(checks).toBe(1);
  await page.evaluate(() =>
    window.mochiTest.update({
      feishu: {
        active: null,
        candidate: {
          brand: "feishu" as const,
          state: "checking",
          bot: null,
          problem: null,
        },
      },
    }),
  );
  await expect(heading).toHaveText(title!);
  await expect(
    page.getByRole("status").filter({ hasText: "正在检查" }),
  ).toBeVisible();
  await page.evaluate(
    (candidate) =>
      window.mochiTest.update({ feishu: { active: null, candidate } }),
    waiting,
  );
  await page.evaluate(() => window.mochiTest.releaseActions());
  // Bounded: automatic checks stop and offer one more by hand.
  const again = page.getByRole("button", { name: "再检查一次", exact: true });
  await expect
    .poll(
      async () => {
        await page.clock.fastForward(30_000);
        return again.count();
      },
      { timeout: 20_000 },
    )
    .toBe(1);
  expect(await checks()).toBeGreaterThan(2);
  expect(await checks()).toBeLessThanOrEqual(20);
  const stopped = await checks();
  await page.clock.fastForward(120_000);
  expect(await checks()).toBe(stopped);
  // Approval arrives: the page moves on by itself and stops watching.
  await page.evaluate(
    (bot) =>
      window.mochiTest.update({
        feishu: {
          active: null,
          candidate: {
            brand: "feishu" as const,
            state: "ready",
            bot,
            problem: null,
          },
        },
      }),
    bot,
  );
  await expect(
    page.getByRole("heading", { name: "确认你的飞书机器人" }),
  ).toBeVisible();
  const settled = await checks();
  await page.clock.fastForward(120_000);
  expect(await checks()).toBe(settled);
  expect(
    await page.evaluate(() =>
      window.mochiTest.actions.some(
        (action) => action.type === "copyFeishuApprovalLink",
      ),
    ),
  ).toBe(true);
});
