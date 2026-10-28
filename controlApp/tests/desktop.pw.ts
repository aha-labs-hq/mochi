import { expect, test } from "@playwright/test";
import manifest from "../../motion/manifest.json" with { type: "json" };
import { MotionCatalog } from "../src/motion/catalog.ts";
import type { DesktopSurface } from "../src/shared/experience.ts";
import type { ExperiencePreviewCommand } from "../src/shared/experiencePreview.ts";
import type {
  DesktopAction,
  PreviewRequest,
  SettingsIntent,
} from "../src/shared/model.ts";
import type { ProblemCode } from "../src/shared/problem.ts";
import { problem } from "../src/shared/problem.ts";
import {
  NOT_RUNNING,
  PHASE_WORDS,
  START_APPLICATION,
  sharedMemoryNote,
} from "../src/shared/vocabulary.ts";
import type {
  HandoffReceipt,
  WindowHandoff,
} from "../src/shared/windowHandoff.ts";
import { connectedBotId, type DesktopFactPatch } from "./connectedFacts.ts";

declare global {
  interface Window {
    mochiTest: {
      painted: HandoffReceipt[];
      beginSetup(): Promise<void>;
      handoff(handoff: WindowHandoff | null, surface: DesktopSurface): void;
      motionEvidence(
        id: string,
      ): ReturnType<typeof import("./motionEvidence.ts").motionEvidence>;
      stickerEvidence(): ReturnType<
        typeof import("./stickerEvidence.ts").stickerEvidence
      >;
      problem(code: ProblemCode | null): void;
      update(patch: DesktopFactPatch): void;
      preview(value: PreviewRequest): void;
      previewExperience(command: ExperiencePreviewCommand): Promise<void>;
      sheet(value: SettingsIntent): void;
      settingsRequests: SettingsIntent[];
      navigate(route: import("../src/shared/settings.ts").SettingsRoute): void;
      closeState(): import("../src/shared/settings.ts").SettingsCloseState;
      companionRequests(): number;
      settingsRendered(): number;
      reopen(sheet?: SettingsIntent, preview?: PreviewRequest): void;
      actions: DesktopAction[];
      botWrites: { botId: string | null; kind: string; content?: string }[];
      modelRequests(): number;
      skillRequests(): number;
      scheduleRequests(): number;
      setSchedules(
        records: readonly import("../../src/schedules/view.ts").ScheduleView[],
        botId?: string,
      ): void;
      holdSchedules(): void;
      releaseSchedules(): void;
      skillContent(content: string): void;
      failAction(code: ProblemCode | null, type?: DesktopAction["type"]): void;
      holdActions(): void;
      releaseActions(): void;
    };
  }
}

for (const colorScheme of ["light", "dark"] as const)
  for (const viewport of [
    { width: 360, height: 509 },
    { width: 520, height: 700 },
  ]) {
    test(`${colorScheme} ${viewport.width}: companion keeps identity, switch and settings visible`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await page.goto("/main/index.html");
      await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
      await expect(page.getByText("gpt-test-balanced")).toHaveCount(0);
      await expect(
        page.getByRole("switch", { name: "麻薯：值班" }),
      ).toBeInViewport({ ratio: 1 });
      await expect(page.locator("canvas")).toHaveAttribute(
        "data-ready",
        "true",
      );
      const plaque = page.getByTestId("companion-sill");
      await expect(plaque).toBeInViewport({ ratio: 1 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(viewport.width);
      await page.screenshot({
        path: `controlApp/.build/home-${colorScheme}-${viewport.width}.png`,
      });
      await page.getByRole("button", { name: "设置", exact: true }).click();
      expect(
        await page.evaluate(() => window.mochiTest.settingsRequests),
      ).toEqual(["instructions"]);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          window.mochiTest.actions.map((action) => action.type),
        ),
      ).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

test("companion replaces a failed start with verified recovery from another window", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      phase: "stopped",
      loaded: false,
      controlReady: false,
      eventStreamReady: false,
    });
    window.mochiTest.failAction("service_readiness_timeout");
  });
  await page
    .getByRole("button", { name: START_APPLICATION, exact: true })
    .click();
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "Mochi 没有正常启动" });
  await expect(failure).toBeVisible();
  await page.evaluate(() =>
    window.mochiTest.update({
      phase: "attention",
      loaded: true,
      controlReady: true,
      eventStreamReady: false,
    }),
  );
  await expect(failure).toBeVisible();
  await page.evaluate(() =>
    window.mochiTest.update({
      phase: "listening",
      eventStreamReady: true,
      problem: null,
    }),
  );
  await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "麻薯：值班", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "service", operation: "start" },
  ]);
});

test("a late startup failure response cannot overwrite an already recovered frame", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      phase: "stopped",
      loaded: false,
      controlReady: false,
      eventStreamReady: false,
    });
    window.mochiTest.failAction("service_readiness_timeout");
    window.mochiTest.holdActions();
  });
  await page
    .getByRole("button", { name: START_APPLICATION, exact: true })
    .click();
  await page.evaluate(() => {
    window.mochiTest.update({
      phase: "working",
      loaded: true,
      controlReady: true,
      eventStreamReady: true,
      problem: null,
    });
    window.mochiTest.releaseActions();
  });
  await expect(page.getByText("正在回复", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("setup owns one explicit action and never initializes automatically", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  for (const stage of [
    "install",
    "signIn",
    "signingIn",
    "ready",
    "initializing",
  ] as const) {
    await page.evaluate(async (setup) => {
      window.mochiTest.update({ setup });
      await window.mochiTest.beginSetup();
    }, stage);
    await expect(page.locator('[data-setup="true"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: "ChatGPT", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('[data-setup="true"]')).not.toContainText(
      /Bun|Node|Pi|终端|上下文|Session/,
    );
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  }
  await page.evaluate(() => window.mochiTest.update({ setup: "ready" }));
  await page.getByRole("button", { name: "开始值班", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "setBotEnabled", botId: connectedBotId, enabled: true },
  ]);
});

for (const width of [360, 520])
  test(`group controls at ${width}: all groups, persistent facts, safe long names and keyboard`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/main/settings.html?page=groups");
    const longName = "Product Design 设计与工程协作群 😺 ".repeat(8).trim();
    await page.evaluate(
      (name) =>
        window.mochiTest.update({
          feishuGroups: [
            {
              id: "oc_test",
              name: "Mochi 测试群",
              avatarUrl: null,
              enabled: true,
            },
            { id: "oc_second", name, avatarUrl: null, enabled: false },
          ],
        }),
      longName,
    );
    const dialog = page.getByRole("main", { name: "设置内容" });
    await expect(dialog).toContainText(sharedMemoryNote("麻薯"));
    await expect(dialog.getByText(longName, { exact: true })).toBeVisible();
    const first = dialog.getByRole("switch", {
      name: "Mochi 测试群：回应消息",
    });
    await expect(first).toBeChecked();
    await first.focus();
    await page.keyboard.press("Space");
    await expect(first).not.toBeChecked();
    // Opening the page asks nothing of the Bot; it keeps the list current.
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
      { type: "updateGroupParticipation", chatId: "oc_test", enabled: false },
    ]);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.evaluate(() => window.mochiTest.update({ feishuGroups: [] }));
    await expect(dialog).toContainText("还没有加入群聊");
    await page.evaluate(() => window.mochiTest.update({ feishuGroups: null }));
    await expect(dialog).toContainText(
      "还在确认所在群，确认后会自动显示在这里。",
    );
    await expect(dialog.getByRole("button", { name: /刷新/ })).toHaveCount(0);
  });

test("group avatar CSP permits Feishu images; image failure falls back without disabling participation", async ({
  page,
}) => {
  await page.route("https://s1-imfile.feishucdn.com/**", (route) =>
    route.request().url().endsWith("/good")
      ? route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="blue"/></svg>',
        })
      : route.abort(),
  );
  await page.goto("/main/settings.html?page=groups");
  await page.evaluate(() =>
    window.mochiTest.update({
      feishuGroups: [
        {
          id: "oc_good",
          name: "Good",
          avatarUrl: "https://s1-imfile.feishucdn.com/good",
          enabled: true,
        },
        {
          id: "oc_bad",
          name: "Missing",
          avatarUrl: "https://s1-imfile.feishucdn.com/missing",
          enabled: true,
        },
      ],
    }),
  );
  const dialog = page.getByRole("region", { name: "所在群", exact: true });
  await expect
    .poll(() =>
      dialog
        .locator('img[src$="/good"]')
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(24);
  await expect(dialog.locator('img[src$="/missing"]')).toHaveCount(0);
  await expect(
    dialog.getByRole("switch", { name: "Missing：回应消息" }),
  ).toBeChecked();
  await page.evaluate(() =>
    window.mochiTest.update({ busy: "updateGroupParticipation" }),
  );
  await expect(
    dialog.getByRole("switch", { name: "Good：回应消息" }),
  ).toBeDisabled();
});

test("a lost backend never presents stale Bot status as online", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() =>
    window.mochiTest.update({ controlReady: false, eventStreamReady: false }),
  );
  await expect(page.getByTestId("companion-sill")).toContainText(
    "正在确认状态",
  );
  await expect(page.getByText("1 位正在值班")).toHaveCount(0);
  await expect(page.getByRole("switch")).toBeDisabled();
  await expect(page.getByText("正在值班", { exact: true })).toHaveCount(0);
});
test("a Bot's own worker or event failure reconnects only that Bot", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  for (const problemCode of [
    "runtime_session_unavailable",
    "event_stream_unavailable",
  ]) {
    await page.evaluate(
      ({ problemCode, botId }) =>
        window.mochiTest.update({
          phase: "attention",
          eventStreamReady: false,
          bots: [
            {
              botId,
              label: "麻薯",
              characterId: "mochi",
              groupCount: 1,
              projectCount: 1,
              phase: "attention",
              lifecycle: "blocked",
              enabled: true,
              problemCode,
            },
          ],
        }),
      { problemCode, botId: connectedBotId },
    );
    await expect(page.getByRole("alert")).toHaveCount(1);
    await page.getByRole("button", { name: "重新连接", exact: true }).click();
  }
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "recoverBot" },
    { type: "recoverBot" },
  ]);
});
for (const width of [360, 520, 768])
  test(`backend recovery at ${width} remains visible and actionable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 560 });
    await page.goto("/main/index.html");
    await page.evaluate(() => {
      window.mochiTest.update({
        controlReady: false,
        account: { status: "unknown" },
      });
      window.mochiTest.problem("status_unavailable");
    });
    await expect(page.getByRole("alert")).toHaveCount(1);
    const recover = page.getByRole("button", { name: "重新连接", exact: true });
    await expect(recover).toBeInViewport({ ratio: 1 });
    await recover.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
      { type: "service", operation: "restart" },
    ]);
    await page.evaluate(() =>
      window.mochiTest.problem("service_readiness_timeout"),
    );
    await expect(
      page.getByRole("button", { name: "重新连接", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "查看诊断", exact: true }).click();
    expect(
      await page.evaluate(() => window.mochiTest.settingsRequests.at(-1)),
    ).toBe("diagnostics");
    await page.screenshot({
      path: `controlApp/.build/backend-failure-${width}.png`,
    });
  });

test("diagnostics uses the same account evidence vocabulary", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=diagnostics");
  for (const [status, summary] of [
    ["signedOut", "未连接"],
    ["signingIn", "等待授权"],
    ["unknown", "暂时无法确认"],
  ] as const) {
    await page.evaluate(
      (status) => window.mochiTest.update({ account: { status } }),
      status,
    );
    await expect(
      page
        .locator("dt")
        .filter({ hasText: /^模型连接$/ })
        .locator("+ dd"),
    ).toHaveText(summary);
  }
  await expect(page.getByText("Mochi 0.2.0 · Development")).toBeVisible();
  await expect(page.getByText("最近动态", { exact: true })).toBeVisible();
});

test("preparation recovery has one real action and browser recovery does not create a new login", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      setup: "install",
      development: false,
      installed: false,
      loaded: false,
      controlReady: false,
      eventStreamReady: false,
    });
    window.mochiTest.problem("product_preparation_failed");
    void window.mochiTest.beginSetup();
  });
  await expect(page.getByRole("alert")).toContainText(
    "已有设置和工作记录不会被清除",
  );
  await expect(
    page.getByRole("button", { name: "准备 Mochi", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "准备 Mochi", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "prepare" },
  ]);
  await page.screenshot({ path: "controlApp/.build/setup-recovery.png" });
  await page.evaluate(() => {
    window.mochiTest.update({
      setup: "signingIn",
      canReopenLogin: true,
      account: { status: "signingIn" },
    });
    window.mochiTest.problem("login_browser_unavailable");
  });
  await page.getByRole("button", { name: "打开浏览器", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "prepare" },
    { type: "reopenLogin" },
  ]);
});

test("narrow setup keeps its single recovery action fully visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 509 });
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      setup: "install",
      development: false,
      installed: false,
      loaded: false,
      controlReady: false,
      eventStreamReady: false,
    });
    window.mochiTest.problem("product_preparation_failed");
    void window.mochiTest.beginSetup();
  });
  const button = page.getByRole("button", { name: "准备 Mochi", exact: true });
  await expect(button).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("alert")).toBeInViewport({ ratio: 1 });
  await button.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "prepare" },
  ]);
  await page.screenshot({
    path: "controlApp/.build/setup-recovery-narrow.png",
  });
});

test("a 伙伴's own failure names its cause and leads to the reason, not to its groups", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() =>
    window.mochiTest.update({
      eventStreamReady: false,
      phase: "attention",
      bots: [
        {
          botId: "11111111-2222-4333-8444-555555555555",
          label: "麻薯",
          characterId: "mochi",
          groupCount: 1,
          projectCount: 1,
          phase: "attention",
          lifecycle: "listening",
          enabled: true,
          problemCode: "event_stream_unavailable",
        },
      ],
    }),
  );
  const cause = problem("event_stream_unavailable");
  const sill = page.getByTestId("companion-sill");
  await expect(sill).toContainText(cause.title);
  await expect(sill).not.toContainText(PHASE_WORDS.listening.label);
  await expect(page.getByRole("button", { name: /个群/ })).toHaveCount(0);
  await page.getByRole("button", { name: /查看原因/ }).click();
  const reason = page.getByRole("dialog");
  await expect(reason).toContainText(cause.message);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.settingsRequests)).toEqual(
    [],
  );
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "recoverBot" },
  ]);
});

test("a stopped Mochi never shows a 伙伴 as on duty", async ({ page }) => {
  await page.goto("/main/index.html");
  await expect(page.getByRole("switch")).toBeChecked();
  await page.evaluate(() =>
    window.mochiTest.update({ loaded: false, controlReady: false }),
  );
  await expect(page.getByRole("switch")).not.toBeChecked();
  await expect(page.getByTestId("companion-sill")).toContainText(
    NOT_RUNNING.label,
  );
  await expect(
    page.getByRole("button", { name: START_APPLICATION, exact: true }),
  ).toBeVisible();
});

test("each Bot status communicates its own lifecycle without exposing model policy", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  for (const [phase, lifecycle, enabled, label] of [
    ["listening", "listening", true, "正在值班"],
    ["working", "listening", true, "正在回复"],
    ["organizingContext", "listening", true, "正在整理记忆"],
    ["attention", "listening", true, problem("event_stream_unavailable").title],
    ["stopped", "paused", false, PHASE_WORDS.stopped.label],
    // Never started is not paused.
    ["stopped", "setup", false, "还没设置好"],
    ["starting", "setup", true, "正在启动"],
    ["attention", "failed", true, "没能启动"],
  ] as const) {
    await page.evaluate(
      ({ phase, lifecycle, enabled }) =>
        window.mochiTest.update({
          bots: [
            {
              botId: "11111111-2222-4333-8444-555555555555",
              label: "麻薯",
              characterId: "mochi",
              groupCount: 1,
              projectCount: 1,
              phase,
              lifecycle,
              enabled,
              problemCode: null,
            },
          ],
        }),
      { phase, lifecycle, enabled },
    );
    await expect(page.getByTestId("companion-sill")).toContainText(label);
    await expect(page.getByRole("switch")).toHaveAttribute(
      "aria-checked",
      String(enabled),
    );
  }
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("changing character waits for its stable assets before waking the frame clock", async ({
  page,
}) => {
  const character = new MotionCatalog(manifest).character("awawa");
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    `**/assets/${character.assets[0]!.resource}.png`,
    async (route) => {
      requested.resolve();
      await release.promise;
      await route.continue();
    },
  );
  try {
    await page.goto("/main/index.html");
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
    await page.evaluate(() =>
      window.mochiTest.preview({
        character: "awawa",
        preview: "working",
        nonce: "pending-assets",
      }),
    );
    await requested.promise;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByRole("alert")).not.toBeVisible();
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "false");
    release.resolve();
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  } finally {
    release.resolve();
  }
});

for (const character of new MotionCatalog(manifest).characters)
  for (const preview of character.previews)
    test(`manifest preview ${character.id}/${preview.id}: renders, plays and returns without a backend action`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/main/index.html");
      await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
      await page.evaluate((request) => window.mochiTest.preview(request), {
        character: character.id,
        preview: preview.id,
        nonce: preview.id,
      });
      await expect(page.getByRole("heading")).toHaveText(preview.title);
      const motion =
        preview.type === "state"
          ? character.states.find((state) => state.id === preview.target)
              ?.motion
          : undefined;
      const staticPreview = motion?.type === "static";
      await expect(
        page.getByText(
          `${staticPreview ? "形象预览" : "动效预览"} · 不改变实际运行状态`,
        ),
      ).toBeVisible();
      await expect(page.locator("canvas")).toHaveAttribute(
        "data-ready",
        "true",
      );
      const frame = await page.locator("canvas").screenshot();
      await expect
        .poll(
          async () => (await page.locator("canvas").screenshot()).equals(frame),
          {
            timeout:
              motion?.type === "intermittent"
                ? motion.maximumDelaySeconds * 1000 + 5000
                : 5000,
          },
        )
        .toBe(staticPreview);
      await page.getByRole("button", { name: "结束预览" }).click();
      await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
      await expect(page.getByRole("alert")).not.toBeVisible();
      expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
      expect(errors).toEqual([]);
    });

test("companion close/reopen preserves preview without a settings modal", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() =>
    window.mochiTest.reopen(undefined, {
      character: "mochi",
      preview: "working-continuous",
      nonce: "reopen",
    }),
  );
  await expect(
    page.getByRole("heading", { name: "工作 · 连续循环" }),
  ).toBeVisible();
  await page.evaluate(() => window.mochiTest.reopen());
  await expect(
    page.getByRole("heading", { name: "工作 · 连续循环" }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

for (const viewport of [
  { width: 360, height: 509 },
  { width: 520, height: 700 },
])
  test(`preview replaces the live heading without overlapping at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/main/index.html");
    await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
    await page.evaluate(() =>
      window.mochiTest.preview({
        character: "mochi",
        preview: "working-continuous",
        nonce: "layout-test",
      }),
    );
    await expect(
      page.getByRole("heading", { name: "工作 · 连续循环" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "麻薯" })).not.toBeVisible();
    const header = await page.locator("main > header").boundingBox();
    const status = await page.getByTestId("companion-sill").boundingBox();
    const canvas = await page.locator("canvas").boundingBox();
    expect(status!.y).toBeGreaterThan(header!.y + header!.height);
    expect(canvas!.y).toBeLessThan(status!.y);
    expect(canvas!.y + canvas!.height).toBeGreaterThan(status!.y);
    await page.getByRole("button", { name: "结束预览" }).click();
    await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });

test("opening the selected Bot's settings retains its character stage", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  expect(await page.evaluate(() => window.mochiTest.settingsRequests)).toEqual([
    "instructions",
  ]);
  await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a stopped host with no readable roster never invites replacing existing companions", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() =>
    window.mochiTest.update({
      loaded: false,
      controlReady: false,
      bots: [],
      selectedBotId: null,
    }),
  );
  await expect(
    page.getByText(NOT_RUNNING.label, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("从一位伙伴开始")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: START_APPLICATION, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /新增|新建/ })).toHaveCount(0);
  await expect(page.getByTestId("host-availability")).toBeVisible();
  await expect(page.getByTestId("bot-home")).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  await page
    .getByRole("button", { name: START_APPLICATION, exact: true })
    .click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "service", operation: "start" },
  ]);
});

test("a confirmed empty roster leaves the daily companion for first setup", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() =>
    window.mochiTest.update({
      bots: [],
      selectedBotId: null,
      controlReady: true,
      setup: "signIn",
      account: { status: "signedOut" },
    }),
  );
  await expect(page.getByTestId("bot-home")).toHaveCount(0);
  await expect(page.getByTestId("shell")).toHaveAttribute("data-setup", "true");
  await expect(
    page.getByRole("heading", { name: "连接模型", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("disabled macOS background item offers one system recovery and no duty control", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(() => {
    window.mochiTest.update({
      phase: "attention",
      loaded: false,
      controlReady: false,
      eventStreamReady: false,
      bots: [],
      selectedBotId: null,
      account: { status: "unknown" },
    });
    window.mochiTest.problem("background_permission_required");
  });
  await expect(page.getByRole("alert")).toHaveCount(1);
  const recovery = page.getByRole("button", {
    name: "打开系统设置",
    exact: true,
  });
  await expect(recovery).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "启动 Mochi", exact: true }),
  ).toHaveCount(0);
  await recovery.click();
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
    { type: "openLoginItems" },
  ]);
});
