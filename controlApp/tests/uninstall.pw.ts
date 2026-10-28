import { expect, test } from "@playwright/test";
import { problem } from "../src/shared/problem.ts";
import type {} from "./desktop.pw.ts";

test("uninstall has one entry and keeps keyboard focus on cancellation while work drains", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await page.goto("/main/settings.html?page=about");
  await page.evaluate(() => window.mochiTest.update({ development: false }));
  const action = page.getByRole("button", { name: "卸载 Mochi…", exact: true });
  await action.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.actions.at(-1)))
    .toEqual({ type: "uninstall" });
  await page.evaluate(() => window.mochiTest.update({ busy: "uninstall" }));
  const cancel = page.getByRole("button", { name: "取消卸载", exact: true });
  await expect(cancel).toBeEnabled();
  await expect(cancel).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "等待已接工作" }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.actions.at(-1)))
    .toEqual({ type: "cancelUninstall" });
  await page.screenshot({ path: "controlApp/.build/uninstall-waiting.png" });
});

test("development cannot uninstall the installed product and an update cannot overlap uninstall", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=about");
  await page.evaluate(() => window.mochiTest.update({ development: true }));
  await expect(
    page.getByRole("button", { name: "卸载 Mochi…", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.mochiTest.update({ development: false, busy: "prepare" }),
  );
  await expect(
    page.getByRole("button", { name: "卸载 Mochi…", exact: true }),
  ).toBeDisabled();
});

test("uninstall failure is visible after reopening a short settings window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await page.goto("/main/settings.html?page=about");
  await page.evaluate(
    (failure) =>
      window.mochiTest.update({
        development: false,
        problem: failure,
        update: {
          phase: "idle",
          target: null,
          notes: "",
          received: 0,
          total: 0,
          checkedAt: null,
          error: null,
          preferences: { check: true, download: true, install: false },
        },
      }),
    problem("product_uninstall_failed"),
  );
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("修复后台组件");
  await expect(alert).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "controlApp/.build/uninstall-failure.png" });
});
