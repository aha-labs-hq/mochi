import { expect, type Page, test } from "@playwright/test";
import { connectedFacts, feishuMailConnection } from "./connectedFacts.ts";
import type {} from "./desktop.pw.ts";

/** Publishes a ready mail connection whose one selected mailbox is `address`. */
async function selectMailbox(page: Page, address: string) {
  const ready = feishuMailConnection("selected");
  const connection = {
    ...ready,
    resourceScope: { status: "ready" as const, selectedCount: 1 },
    resources: [
      {
        ...ready.resources.find((resource) => resource.selected)!,
        displayName: address,
      },
    ],
  };
  await page.evaluate(
    ({ facts, connection }) => {
      window.mochiTest.update({
        connectorCatalog: {
          ...facts.connectorCatalog!,
          connections: [
            ...facts.connectorCatalog!.connections.filter(
              (candidate) => candidate.providerId !== "feishu-mail",
            ),
            connection,
          ],
        },
      });
    },
    { facts: connectedFacts, connection },
  );
}

test("a selected mailbox loads its domain icon without disclosing the mailbox name", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  const requests: string[] = [];
  const referrers: (string | undefined)[] = [];
  await page.route("https://icons.duckduckgo.com/ip3/**", async (route) => {
    requests.push(route.request().url());
    referrers.push(route.request().headers().referer);
    await route.fulfill({
      path: "controlApp/Resources/MochiCompanion.png",
      contentType: "image/png",
    });
  });
  await page.goto("/main/settings.html?page=feishuMail");
  await selectMailbox(page, "team@example.com");
  const list = page.getByRole("list", { name: "共享邮箱" });
  const icon = list.locator("img");
  await expect(icon).toHaveAttribute(
    "src",
    "https://icons.duckduckgo.com/ip3/example.com.ico",
  );
  await expect(icon).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect
    .poll(() =>
      icon.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  expect(requests).toEqual([
    "https://icons.duckduckgo.com/ip3/example.com.ico",
  ]);
  expect(referrers).toEqual([undefined]);
  await expect(
    list.getByText("读取邮件 · 只读", { exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("switch", { name: "team@example.com：读取邮件" }),
  ).toBeEnabled();
  await page.screenshot({ path: "controlApp/.build/mailbox-domain-icon.png" });
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("a failed icon retains the mailbox row and a new domain can load normally", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.route("https://icons.duckduckgo.com/ip3/**", async (route) => {
    if (route.request().url().endsWith("example.com.ico")) await route.abort();
    else
      await route.fulfill({
        path: "controlApp/Resources/MochiCompanion.png",
        contentType: "image/png",
      });
  });
  await page.goto("/main/settings.html?page=feishuMail");
  await selectMailbox(page, "team@example.com");
  const list = page.getByRole("list", { name: "共享邮箱" });
  const frame = list.locator('span[aria-hidden="true"]').first();
  await expect(frame.locator("svg")).toBeVisible();
  await expect(list.locator("img")).toHaveCount(0);
  await expect(
    list.getByText("team@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("switch", { name: "team@example.com：读取邮件" }),
  ).toBeEnabled();
  const before = (await frame.boundingBox())!;
  expect(before.width).toBe(40);
  expect(before.height).toBe(40);
  await selectMailbox(page, "team@other.com");
  await expect
    .poll(() =>
      list
        .locator("img")
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  expect(await frame.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});
