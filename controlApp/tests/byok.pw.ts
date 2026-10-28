import { expect, test } from "@playwright/test";

test("onboarding offers a model API without asking the renderer for a credential", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      setup: "signIn",
      account: { status: "signedOut" },
    });
    window.mochiTest.beginSetup();
  });
  await expect(
    page.getByRole("heading", { name: "连接模型", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "添加模型 API", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "configureModelApi" },
  ]);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test("a connected ChatGPT account exposes the API connection entry", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=account");
  await page.evaluate(() =>
    window.mochiTest.update({
      account: {
        status: "signedIn",
        account: {
          provider: "openai-codex",
          authType: "oauth",
          subscription: true,
        },
        connections: [
          {
            provider: "openai-codex",
            authType: "oauth",
            subscription: true,
          },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "ChatGPT 连接选项" }).click();
  await expect(
    page.getByRole("menuitem", { name: "添加模型 API…", exact: true }),
  ).toBeVisible();
});

test("ChatGPT and named model APIs stay visible in the shared connection directory", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=account");
  await page.evaluate(() =>
    window.mochiTest.update({
      account: {
        status: "signedIn",
        account: {
          provider: "openai-codex",
          authType: "oauth",
          subscription: true,
        },
        connections: [
          {
            provider: "openai-codex",
            authType: "oauth",
            subscription: true,
          },
          {
            provider: "mochi-byok",
            authType: "api_key",
            subscription: false,
            label: "Research service",
            model: "mochi-byok/gpt-5",
          },
        ],
      },
      bots: [
        {
          botId: "bot-chatgpt",
          label: "Chichi",
          characterId: "mochi",
          groupCount: 1,
          projectCount: 1,
          enabled: true,
          lifecycle: "listening",
          phase: "listening",
          problemCode: null,
          model: "gpt-5.6",
        },
        {
          botId: "bot-byok",
          label: "麻薯",
          characterId: "mochi",
          groupCount: 1,
          projectCount: 1,
          enabled: true,
          lifecycle: "listening",
          phase: "listening",
          problemCode: null,
          model: "mochi-byok/gpt-5",
        },
      ],
    }),
  );
  await expect(page.getByText("2 个模型连接", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "已连接模型" })
      .getByText("ChatGPT", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "已连接模型" })
      .getByText("Research service", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "各 Bot 的模型连接" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "ChatGPT 连接选项" }).click();
  await expect(
    page.getByRole("menuitem", { name: "添加模型 API…" }),
  ).toBeVisible();
});

for (const width of [360, 1040]) {
  test(`BYOK account at ${width} shows the connection and respects the shared idle gate`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 716 });
    await page.goto("/main/settings.html?page=account");
    await page.evaluate(() =>
      window.mochiTest.update({
        account: {
          status: "signedIn",
          account: {
            provider: "mochi-byok",
            authType: "api_key",
            subscription: false,
            label: "Research service",
            model: "mochi-byok/gpt-5",
          },
          connections: [
            {
              provider: "mochi-byok",
              authType: "api_key",
              subscription: false,
              label: "Research service",
              model: "mochi-byok/gpt-5",
            },
          ],
        },
        accountChangeReady: false,
      }),
    );
    await expect(
      page.getByRole("heading", { name: "模型连接", level: 1, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Research service", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Research service 连接选项" })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "断开模型 API…" }),
    ).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "切换账号…" })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({ path: `controlApp/.build/byok-${width}.png` });
  });
}
