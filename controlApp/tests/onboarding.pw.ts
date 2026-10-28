import { expect, test } from "@playwright/test";
import type { DesktopSnapshot } from "../src/shared/model.ts";
import {
  connectedBotId,
  connectedFacts,
  withNoSelectedProjects,
} from "./connectedFacts.ts";

const signedIn = {
  status: "signedIn",
  account: { provider: "openai-codex", authType: "oauth", subscription: true },
  connections: [
    { provider: "openai-codex", authType: "oauth", subscription: true },
  ],
} as const;

test("first installation does not claim account progress or installation before authorization", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      locationReady: true,
      installed: false,
      controlReady: false,
      phase: "notInstalled",
      setup: "install",
      busy: null,
      problem: null,
      bots: [],
      selectedBotId: null,
      account: { status: "signedOut" },
      feishu: { active: null, candidate: null },
      github: { status: "disconnected", account: null, problem: null },
    });
    window.mochiTest.beginSetup();
  });
  await expect(page.getByRole("list", { name: "准备进度" })).toHaveCount(0);
  await expect(
    page.getByText("已完成的连接会保留，可以随时回来继续。"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "安装并继续", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "prepare" },
  ]);
  await page.evaluate(() => window.mochiTest.update({ busy: "prepare" }));
  await expect(
    page.getByRole("button", { name: "正在准备…", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("正在安装…", { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.mochiTest.update({ busy: null }));
  await expect(
    page.getByRole("button", { name: "安装并继续", exact: true }),
  ).toBeEnabled();
});

test("opening outside Applications gives neutral Finder guidance before preparation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      locationReady: false,
      installed: false,
      controlReady: false,
      phase: "notInstalled",
      setup: "install",
      problem: null,
      bots: [],
      selectedBotId: null,
    });
    window.mochiTest.beginSetup();
  });
  await expect(
    page.getByRole("heading", { name: "先移到“应用程序”", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("现在还不会请求管理员授权。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "安装并继续", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("需要你看一下", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("已完成的连接会保留，可以随时回来继续。", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "打开“应用程序”", exact: true })
    .click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "openApplications" },
  ]);
});

test("first duty follows connections without exposing a record-preparation task", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        setup: "ready",
        eventStreamReady: false,
        bots: facts.bots.map((bot) => ({
          ...bot,
          enabled: false,
          lifecycle: "setup",
          phase: "stopped",
        })),
        feishu: { active: null, candidate: null },
      }),
    connectedFacts,
  );
  await page.evaluate(() => window.mochiTest.beginSetup());
  await expect(
    page.getByRole("heading", { name: "连接团队群聊", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "准备进度" })).toContainText(
    "模型，已完成",
  );
  await expect(page.getByText(/准备工作记录|准备它的工作记录/)).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        feishu: facts.feishu,
        connectorCatalog: facts.connectorCatalog,
      }),
    {
      feishu: connectedFacts.feishu,
      connectorCatalog: withNoSelectedProjects(connectedFacts.connectorCatalog),
    },
  );
  await expect(
    page.getByRole("heading", { name: "选择 GitHub 项目", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (catalog) => window.mochiTest.update({ connectorCatalog: catalog }),
    connectedFacts.connectorCatalog,
  );
  await expect(
    page.getByRole("heading", { name: "可以开始值班了", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始值班", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "setBotEnabled", botId: connectedBotId, enabled: true },
  ]);
  await expect(
    page.getByRole("heading", { name: "去飞书，问第一个问题", exact: true }),
  ).toBeVisible();
});

test("setup keeps step labels and alternative model actions on one alignment line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      setup: "signIn",
      account: { status: "signedOut" },
    });
    window.mochiTest.beginSetup();
  });
  await expect(page.getByRole("heading", { name: "连接模型" })).toBeVisible();

  const modelLabelBefore = await page
    .getByRole("list", { name: "准备进度" })
    .locator("[data-step-label]")
    .first()
    .boundingBox();
  const primaryText = await page
    .getByRole("button", { name: "连接 ChatGPT" })
    .locator("span")
    .first()
    .boundingBox();
  const byokText = await page
    .getByRole("button", { name: "添加模型 API" })
    .boundingBox();
  expect(primaryText).not.toBeNull();
  expect(byokText).not.toBeNull();
  expect(Math.abs(primaryText!.x - byokText!.x)).toBeLessThan(1);

  await page.evaluate((facts) => {
    window.mochiTest.update({
      ...facts,
      setup: "ready",
      account: {
        status: "signedIn",
        account: {
          provider: "openai-codex",
          authType: "oauth",
          subscription: true,
        },
        connections: [
          { provider: "openai-codex", authType: "oauth", subscription: true },
        ],
      },
    });
  }, connectedFacts);
  const modelLabelAfter = await page
    .getByRole("list", { name: "准备进度" })
    .locator("[data-step-label]")
    .first()
    .boundingBox();
  expect(modelLabelBefore).not.toBeNull();
  expect(modelLabelAfter).not.toBeNull();
  expect(Math.abs(modelLabelBefore!.x - modelLabelAfter!.x)).toBeLessThan(1);

  await page.evaluate(() => window.mochiTest.update({ setup: null }));
  await expect(
    page.getByRole("heading", { name: "去飞书，问第一个问题" }),
  ).toBeVisible();
  const manageGroups = await page
    .getByRole("button", { name: "管理群聊" })
    .boundingBox();
  const finishSetup = await page
    .getByRole("button", { name: "完成设置" })
    .boundingBox();
  expect(manageGroups).not.toBeNull();
  expect(finishSetup).not.toBeNull();
  expect(manageGroups!.height).toBe(finishSetup!.height);
  expect(
    Math.abs(
      manageGroups!.y +
        manageGroups!.height / 2 -
        (finishSetup!.y + finishSetup!.height / 2),
    ),
  ).toBeLessThan(1);
});

test("a failed BYOK connection offers the same input flow again", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      setup: "signIn",
      account: { status: "signedOut" },
    });
    window.mochiTest.failAction("byok_connection_failed", "configureModelApi");
    window.mochiTest.beginSetup();
  });
  await page.getByRole("button", { name: "添加模型 API" }).click();
  await expect(
    page.getByRole("heading", { name: "连接没有完成" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "检查 API 地址和模型名称",
  );
  await expect(page.getByRole("button", { name: "检查连接" })).toBeVisible();
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page.getByRole("button", { name: "检查连接" }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "configureModelApi" },
    { type: "configureByok" },
  ]);
});

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`continuous first encounter: ${reducedMotion}, no synthetic provider actions`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion });
    await page.goto("/main/index.html?surface=intro");
    await expect(page.getByTestId("introduction")).toBeVisible();
    const felt = await page.getByTestId("felt-frame").elementHandle();
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
    await expect(page.locator('[aria-label="角色"]')).toHaveCSS(
      "transform",
      "none",
    );
    await page
      .getByRole("button", { name: "看看麻薯怎么协作", exact: true })
      .click();
    await page.getByRole("button", { name: "产品", exact: true }).click();
    await expect(page.getByTestId("story-message-0")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: `controlApp/.build/intro-${reducedMotion}.png`,
    });
    const question = page.getByTestId("story-message-0");
    const questionBefore = await question.evaluate(
      (node: HTMLElement) => node.offsetTop,
    );
    await expect(page.getByTestId("story-message-2")).toBeVisible();
    await expect(page.getByTestId("story-message-0")).toHaveCSS("opacity", "1");
    // Transcript scrolling can move viewport coordinates without relaying out a row.
    expect(await question.evaluate((node: HTMLElement) => node.offsetTop)).toBe(
      questionBefore,
    );
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
    await page.screenshot({
      path: `controlApp/.build/intro-story-${reducedMotion}.png`,
    });
    await page.getByRole("button", { name: "开始设置" }).click();
    await expect(page.getByTestId("setup-journey")).toBeVisible();
    expect(
      await felt!.evaluate(
        (node) => node === document.querySelector('[data-testid="felt-frame"]'),
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 960, height: 680 });
    await page.getByRole("button", { name: "完成设置" }).click();
    await expect(page.getByTestId("bot-home")).toBeVisible();
    await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });
}

test("the landing is one transparent felt composition, with the body baseline aligned and complete paws above it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/main/index.html?surface=intro");
  const canvas = page.locator("canvas[aria-label='Mochi']");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  const panel = await page.getByTestId("felt-frame").boundingBox();
  const cat = await canvas.boundingBox();
  expect(panel).not.toBeNull();
  expect(cat).not.toBeNull();
  expect(Math.abs(cat!.y + (cat!.height * 475) / 512 - panel!.y)).toBeLessThan(
    1,
  );
  expect(cat!.y + (cat!.height * 501) / 512).toBeGreaterThan(panel!.y);
  await expect(page.getByTestId("shell")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator("header")).toHaveCount(0);
  await expect(page.getByTestId("story-evidence")).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: /跑得快的团队，\s*都共享同一份项目全貌/,
    }),
  ).toBeFocused();
});

test("setup is an explicit chat action; Escape never starts setup or dismisses a provider step", async ({
  page,
}) => {
  await page.goto("/main/index.html?surface=intro");
  await expect(page.getByTestId("introduction")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-surface",
    "intro",
  );
  await page
    .getByRole("button", { name: "看看麻薯怎么协作", exact: true })
    .click();
  await page.getByRole("button", { name: "产品", exact: true }).click();
  await page.getByRole("button", { name: "开始设置" }).click();
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-surface",
    "setup",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-surface",
    "setup",
  );
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

for (const viewport of [
  { width: 360, height: 509 },
  { width: 520, height: 700 },
  { width: 960, height: 680 },
]) {
  test(`first meeting ${viewport.width}: readable, bounded, keyboard accessible, no phantom work`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/main/index.html");
    await page.evaluate(() => window.mochiTest.beginSetup());
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
    const stages: DesktopSnapshot["setup"][] = [
      "install",
      "checking",
      "signIn",
      "signingIn",
      "ready",
      "initializing",
      null,
    ];
    for (const setup of stages) {
      await page.evaluate(
        ({ setup, signedIn }) =>
          window.mochiTest.update({
            setup,
            phase:
              setup === "install"
                ? "notInstalled"
                : setup === null
                  ? "listening"
                  : "checking",
            account:
              setup === "ready" || setup === "initializing" || setup === null
                ? signedIn
                : setup === "signingIn"
                  ? { status: "signingIn" }
                  : setup === "checking"
                    ? { status: "unknown" }
                    : { status: "signedOut" },
            eventStreamReady: setup === null,
            canReopenLogin: setup === "signingIn",
          }),
        { setup, signedIn },
      );
      const scene = page.locator('[data-setup="true"]');
      await expect(scene).toBeVisible();
      const id = setup === "install" ? "welcome" : (setup ?? "groups");
      const chapter = scene.locator(`[data-chapter="${id}"]`);
      await expect(chapter).toHaveCSS("opacity", "1");
      await expect(scene).not.toContainText(
        /Bun|Node|Pi|Terminal|终端|Session|一切准备就绪/,
      );
      await expect(scene.getByRole("heading", { level: 1 })).toBeFocused();
      const dock = await page.getByTestId("setup-journey").boundingBox();
      expect(dock!.y + dock!.height).toBeLessThanOrEqual(viewport.height);
      const resume = page.locator("[data-journey-resume]");
      if (await resume.count()) {
        const note = await resume.boundingBox();
        const reading = await page
          .locator("[data-journey-scroll]")
          .boundingBox();
        expect(note!.y).toBeGreaterThanOrEqual(
          reading!.y + reading!.height - 1,
        );
        expect(note!.y + note!.height).toBeLessThanOrEqual(
          dock!.y + dock!.height,
        );
      }
      const canvas = await page.locator("canvas").boundingBox();
      expect(canvas!.y).toBeGreaterThanOrEqual(0);
      expect(canvas!.y + canvas!.height).toBeLessThanOrEqual(viewport.height);
      const felt = await page.getByTestId("felt-frame").boundingBox();
      // The resting pose always belongs to the same physical ledge; setup
      // must not leave a body with a floating, straight-cut lower silhouette.
      expect(
        Math.abs(canvas!.y + (canvas!.height * 475) / 512 - felt!.y),
      ).toBeLessThan(1);
      expect(canvas!.y + (canvas!.height * 501) / 512).toBeGreaterThan(felt!.y);
      for (const button of await page
        .getByTestId("setup-journey")
        .getByRole("button")
        .all()) {
        await button.focus();
        const box = await button.boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(dock!.y);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(viewport.width);
      // Screenshots represent pointer use, not the final keyboard tab stop.
      await scene.getByRole("heading", { level: 1 }).focus();
      await page.screenshot({
        path: `controlApp/.build/onboarding-${setup ?? "groups"}-${viewport.width}.png`,
      });
    }
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("failed reads stay unknown; cancel, retry and browser recovery perform exactly the named operation", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => window.mochiTest.beginSetup());
  await page.evaluate(() => {
    window.mochiTest.update({
      setup: "checking",
      account: { status: "unknown" },
      eventStreamReady: false,
    });
    window.mochiTest.problem("account_status_unavailable");
  });
  await expect(
    page.getByRole("button", { name: "连接 ChatGPT", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.evaluate(() => {
    window.mochiTest.problem(null);
    window.mochiTest.update({
      setup: "signingIn",
      account: { status: "signingIn" },
      canReopenLogin: true,
    });
  });
  await page.getByRole("button", { name: "重新打开浏览器" }).click();
  await page.getByRole("button", { name: "稍后再连接" }).click();
  await page.evaluate((account) => {
    window.mochiTest.update({ setup: "ready", account });
    window.mochiTest.problem("setup_failed");
  }, signedIn);
  await page.getByRole("button", { name: "开始值班", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "service", operation: "restart" },
    { type: "reopenLogin" },
    { type: "cancelLogin" },
    { type: "setBotEnabled", botId: connectedBotId, enabled: true },
  ]);
});

test("the handoff manages real group facts without an automatic test or lost keyboard focus", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => window.mochiTest.beginSetup());
  await page.evaluate(() => window.mochiTest.update({ setup: "ready" }));
  await page.evaluate(() => window.mochiTest.update({ setup: null }));
  await expect(
    page.getByRole("heading", { name: "去飞书，问第一个问题" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "管理群聊" }).click();
  expect(await page.evaluate(() => window.mochiTest.settingsRequests)).toEqual([
    "groups",
  ]);
  // The independent Settings window publishes its result through the shared controller.
  await page.evaluate(() =>
    window.mochiTest.update({
      feishuGroups: [
        {
          id: "oc_test",
          name: "Mochi 测试群",
          avatarUrl: null,
          enabled: false,
        },
      ],
    }),
  );
  await expect(
    page.getByRole("heading", { name: "选择一个群，开启回应" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "管理群聊" })).toBeFocused();
  await page.getByRole("button", { name: "完成设置" }).click();
  await expect(page.locator('[data-setup="true"]')).toHaveCount(0);
  await expect(page.getByTestId("bot-home")).toBeVisible();
  await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("setup names what to bring, marks a failure and keeps one form of primary action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      setup: "install",
      development: false,
      installed: false,
      loaded: false,
      controlReady: false,
      eventStreamReady: false,
      bots: [],
      selectedBotId: null,
    });
    void window.mochiTest.beginSetup();
  });
  const checklist = page.getByRole("list", { name: "开始前准备" });
  await expect(checklist.getByRole("listitem")).toHaveCount(4);
  await expect(checklist).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: "安装并继续" })).toBeInViewport(
    { ratio: 1 },
  );
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText(
    "麻薯",
  );
  // A failure is visibly different from an ordinary step.
  await page.evaluate(() =>
    window.mochiTest.problem("product_preparation_failed"),
  );
  await expect(page.getByText("需要你看一下", { exact: true })).toBeVisible();
  await page.evaluate(() => window.mochiTest.problem(null));
  // GitHub uses the same full-row action as every other step.
  await page.evaluate(
    (account) =>
      window.mochiTest.update({
        setup: "ready",
        installed: true,
        loaded: true,
        controlReady: true,
        account,
        github: { status: "disconnected", account: null, problem: null },
        githubProjects: [],
      }),
    signedIn,
  );
  const connect = page.getByRole("button", { name: "连接 GitHub" });
  await expect(connect).toBeVisible();
  await expect(connect).toHaveAttribute("data-variant", "text");
  await expect(page.getByRole("list", { name: "准备进度" })).toContainText(
    "开始值班",
  );
});
