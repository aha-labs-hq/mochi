import { expect, test } from "@playwright/test";
import { problem } from "../src/shared/problem.ts";
import { START_APPLICATION } from "../src/shared/vocabulary.ts";
import { connectedFacts } from "./connectedFacts.ts";
import { expectFocusRing } from "./focus.ts";

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme}: introduction, setup and Settings share typography and semantic colors`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 960, height: 680 });
    const themes: unknown[] = [];
    for (const [path, selector, headingSize] of [
      ["/main/index.html?surface=intro", ".product-theme", "32px"],
      ["/main/index.html", ".setup-theme", "32px"],
      ["/main/settings.html?page=model", ".settings-theme", "28px"],
    ]) {
      await page.goto(path!);
      if (selector === ".setup-theme")
        await page.evaluate(async () => {
          window.mochiTest.update({
            setup: "signIn",
            account: { status: "signedOut" },
          });
          await window.mochiTest.beginSetup();
        });
      await expect(page.locator(selector!)).toBeVisible();
      themes.push(
        await page.locator(selector!).evaluate((node) => {
          const style = getComputedStyle(node);
          return Object.fromEntries(
            [
              "font-family",
              "font-size",
              "--text-title",
              "--radius-md",
              "--color-ink",
              "--color-muted",
              "--color-surface",
              "--color-card",
              "--color-control",
              "--color-primary",
              "--color-on-primary",
              "--color-hairline",
              "--color-scrim",
              "--shadow-surface",
              "--shadow-control",
            ].map((key) => [key, style.getPropertyValue(key)]),
          );
        }),
      );
      await expect(page.locator(selector!)).toHaveCSS(
        "color",
        "rgb(41, 41, 41)",
      );
      const neutral = await page.locator(selector!).evaluate((node) => {
        const sample = document.createElement("span");
        node.append(sample);
        const colors = ["muted", "hairline", "status-idle", "scrim"].map(
          (role) => {
            sample.style.color = `var(--color-${role})`;
            return getComputedStyle(sample).color;
          },
        );
        sample.remove();
        return colors;
      });
      for (const color of neutral) {
        const [r, g, b] = color.match(/[\d.]+/g)!.map(Number);
        expect(r).toBe(g);
        expect(g).toBe(b);
      }
      await expect(page.getByRole("heading", { level: 1 }).first()).toHaveCSS(
        "font-size",
        headingSize!,
      );
      await page.screenshot({
        path: `controlApp/.build/theme-${colorScheme}-${selector!.slice(1)}.png`,
      });
    }
    expect(themes[1]).toEqual(themes[0]);
    expect(themes[2]).toEqual(themes[0]);
  });
}

test("reading, action and status text retain contrast on their actual theme surfaces", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=instructions");
  const contrasts = await page.locator(".settings-theme").evaluate((node) => {
    const sample = document.createElement("span");
    node.append(sample);
    const luminance = (color: string) => {
      const values = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((v) => {
          const channel = v / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
    };
    const resolve = (role: string) => {
      sample.style.color = `var(--color-${role})`;
      return luminance(getComputedStyle(sample).color);
    };
    const ratio = (foreground: number, background: number) =>
      (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05);
    const pairs = [
      ...["surface", "card"].flatMap((background) =>
        [
          "ink",
          "muted",
          "primary",
          "status-good",
          "status-attention",
          "error",
        ].map((foreground) => [foreground, background] as const),
      ),
      ...["control", "field", "field-active", "note", "action-soft"].flatMap(
        (background) =>
          ["ink", "muted", "primary"].map(
            (foreground) => [foreground, background] as const,
          ),
      ),
      ["on-primary", "primary"] as const,
    ];
    const result = pairs.map(([foreground, background]) => ({
      foreground,
      background,
      contrast: ratio(resolve(foreground), resolve(background)),
    }));
    sample.remove();
    return result;
  });
  for (const { foreground, background, contrast } of contrasts)
    expect(contrast, `${foreground} on ${background}`).toBeGreaterThanOrEqual(
      4.5,
    );
});

test("navigation stays neutral while form selections share checked, focus and disabled feedback", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.goto("/main/settings.html?page=instructions");
  const selected = page
    .getByRole("navigation", { name: "设置分类" })
    .locator('[aria-current="page"]');
  const neutral = await selected.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.backgroundColor, style.color];
  });
  for (const color of neutral) {
    const [r, g, b] = color.match(/[\d.]+/g)!.map(Number);
    expect(r).toBe(g);
    expect(g).toBe(b);
  }
  const duty = page.getByRole("switch", { name: "麻薯：值班", exact: true });
  await expect(duty).toBeChecked();
  const dutyColor = await duty
    .locator("span[aria-hidden]")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  const group = page
    .getByRole("region", { name: "所在群" })
    .getByRole("switch");
  await expect(group).toBeChecked();
  await expect(group.locator("span[aria-hidden]")).toHaveCSS(
    "background-color",
    dutyColor,
  );
  await page.keyboard.press("Tab");
  // Focus is a ring, never the selection wash the navigation uses.
  await expectFocusRing(group);
  await expect(selected).toHaveCSS("outline-style", "none");
  await page.evaluate(() => window.mochiTest.holdActions());
  await page.keyboard.press("Space");
  await expect(group).toBeDisabled();
  await expect(group).toBeChecked();
  await expect(group.locator("span[aria-hidden]")).toHaveCSS(
    "background-color",
    dutyColor,
  );
  await page.evaluate(() => window.mochiTest.releaseActions());
  await expect(group).not.toBeChecked();
  await expect(group).toBeEnabled();
  await expect(group.locator("span[aria-hidden]")).not.toHaveCSS(
    "background-color",
    dutyColor,
  );
  expect(
    (await page.evaluate(() => window.mochiTest.actions)).filter(
      (action) => action.type === "updateGroupParticipation",
    ),
  ).toEqual([
    { type: "updateGroupParticipation", chatId: "oc_test", enabled: false },
  ]);
  await page.getByRole("button", { name: "连接器", exact: true }).click();
  await page.getByRole("button", { name: "打开 GitHub", exact: true }).click();
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  const project = page.getByRole("checkbox", {
    name: "customer/mochi",
    exact: true,
  });
  await expect(project).toBeChecked();
  await page.keyboard.press("Tab");
  await expectFocusRing(project);
});

test("only a confirmed connection lists models; other account states stay neutral", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=account");
  const content = page.getByRole("main", { name: "设置内容" });
  const connected = content.getByRole("region", { name: "已连接模型" });
  await expect(connected).toBeVisible();
  const goodColor = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.className = "text-status-good";
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  for (const [status, label] of [
    ["signedOut", "未连接"],
    ["signingIn", "等待授权"],
    ["unknown", "暂时无法确认"],
  ] as const) {
    await page.evaluate(
      (status) => window.mochiTest.update({ account: { status } }),
      status,
    );
    await expect(connected).toHaveCount(0);
    await expect(
      content.getByText(label, { exact: true }).filter({ visible: true }),
    ).not.toHaveCSS("color", goodColor);
  }
});

test("daily panel keeps Bot actions compact and keyboard accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 560 });
  await page.goto("/main/index.html");
  await expect(page.getByRole("heading", { name: "麻薯" })).toBeVisible();
  await expect(page.getByRole("switch")).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: /新增|新建/ })).toHaveCount(0);
  const plaque = await page.getByTestId("companion-sill").boundingBox();
  expect(plaque!.height).toBeLessThan(140);
  const name = await page.getByRole("heading", { name: "麻薯" }).boundingBox();
  const groups = await page
    .getByRole("button", { name: "1 个群" })
    .boundingBox();
  const status = await page.getByTestId("companion-status").boundingBox();
  expect(status!.x).toBeCloseTo(name!.x, 1);
  expect(groups!.y + groups!.height / 2).toBeCloseTo(
    status!.y + status!.height / 2,
    1,
  );
  expect(plaque!.x).toBe(0);
  expect(plaque!.width).toBe(400);
  expect(plaque!.y + plaque!.height).toBe(560);
  await expect(page.getByRole("button", { name: /^切换伙伴/ })).toHaveCount(0);
  const duty = await page.getByRole("switch").boundingBox();
  expect(duty!.y + duty!.height / 2).toBeCloseTo(
    status!.y + status!.height / 2,
    1,
  );
  await expect(page.getByText(/个项目/)).toHaveCount(0);
  const canvas = await page.locator("canvas").boundingBox();
  expect(canvas!.height).toBeGreaterThan(250);
  await page.getByRole("switch").focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("switch")).not.toBeChecked();
});

for (const viewport of [
  { width: 400, height: 560 },
  { width: 360, height: 509 },
  { width: 520, height: 700 },
])
  test(`character stage ${viewport.width}: state changes preserve size, canvas and complete contact area`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/main/index.html");
    const canvas = page.locator("canvas");
    await expect(canvas).toHaveAttribute("data-ready", "true");
    const original = await canvas.elementHandle();
    const baseline = await canvas.boundingBox();
    expect(baseline!.height).toBeGreaterThan(
      viewport.width === 400 ? 265 : 210,
    );
    for (const phase of [
      "working",
      "contextFull",
      "organizingContext",
      "stopped",
      "listening",
    ] as const) {
      await page.evaluate(
        (phase) =>
          window.mochiTest.update({
            phase,
            canOrganize: phase === "contextFull",
          }),
        phase,
      );
      await expect(canvas).toHaveCount(1);
      const current = await canvas.boundingBox();
      const plaque = await page.getByTestId("companion-sill").boundingBox();
      const name = await page
        .getByRole("heading", { name: "麻薯" })
        .boundingBox();
      expect(current!.height).toBeCloseTo(baseline!.height, 1);
      expect(current!.y).toBeCloseTo(baseline!.y, 1);
      expect(current!.y).toBeGreaterThanOrEqual(0);
      expect(current!.y + current!.height).toBeGreaterThan(plaque!.y);
      expect(current!.y + current!.height).toBeLessThan(name!.y);
      expect(
        await original!.evaluate(
          (node) => node === document.querySelector("canvas"),
        ),
      ).toBe(true);
      await expect(page.getByRole("switch")).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: `controlApp/.build/character-${viewport.width}-${phase}.png`,
      });
    }
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });

for (const viewport of [
  { width: 360, height: 509 },
  { width: 400, height: 560 },
  { width: 520, height: 700 },
])
  test(`companion ${viewport.width}: setup, paused, recovery and preview retain the same sill and character bounds`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/main/index.html");
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
    const bounds = async () => {
      // Selecting a different Bot mounts its own player. Measure its first
      // painted pose, after the manifest has supplied the canvas placement.
      await expect(page.locator("canvas")).toHaveAttribute(
        "data-ready",
        "true",
      );
      return page.evaluate(() => {
        const box = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return {
          sill: box('[data-testid="companion-sill"]'),
          canvas: box("canvas"),
          name: { y: box("h1").y, height: box("h1").height },
        };
      });
    };
    const baseline = await bounds();
    const otherId = "22222222-2222-4222-8222-222222222222";
    await page.evaluate(
      ({ original, otherId }) =>
        window.mochiTest.update({
          bots: [
            original,
            {
              ...original,
              botId: otherId,
              label: "星野",
              enabled: false,
              lifecycle: "setup",
              phase: "stopped",
            },
          ],
        }),
      { original: connectedFacts.bots[0]!, otherId },
    );
    await page.getByRole("button", { name: /^切换伙伴，当前/ }).click();
    await page
      .getByRole("menuitemradio", { name: "切换到星野", exact: true })
      .click();
    await page.evaluate(() => window.mochiTest.update({ setup: "ready" }));
    await expect(
      page.getByRole("button", { name: "开始值班", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("switch")).not.toBeChecked();
    expect(await bounds()).toEqual(baseline);
    await page.getByRole("button", { name: /^切换伙伴，当前/ }).click();
    await page
      .getByRole("menuitemradio", { name: "切换到麻薯", exact: true })
      .click();
    expect(await bounds()).toEqual(baseline);
    for (const lifecycle of [
      "setup",
      "awaitingLogin",
      "awaitingConnection",
      "paused",
      "listening",
    ] as const) {
      await page.evaluate(
        ({ original, lifecycle }) =>
          window.mochiTest.update({
            bots: [
              {
                ...original,
                enabled: lifecycle !== "paused" && lifecycle !== "setup",
                lifecycle,
                phase: lifecycle === "listening" ? "listening" : "stopped",
              },
            ],
          }),
        { original: connectedFacts.bots[0]!, lifecycle },
      );
      expect(await bounds()).toEqual(baseline);
      await expect(page.getByRole("switch")).toBeInViewport({ ratio: 1 });
    }
    await page.evaluate(() =>
      window.mochiTest.update({ loaded: false, controlReady: false }),
    );
    expect(await bounds()).toEqual(baseline);
    await expect(
      page.getByRole("button", { name: START_APPLICATION, exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.evaluate(() =>
      window.mochiTest.problem("service_readiness_timeout"),
    );
    expect(await bounds()).toEqual(baseline);
    await expect(page.getByRole("alert")).toContainText("Mochi 没有正常启动");
    await expect(
      page.getByRole("button", { name: "查看诊断", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const reason = page.getByRole("button", {
      name: "Mochi 没有正常启动：查看原因",
      exact: true,
    });
    await reason.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText(
      problem("service_readiness_timeout").message,
    );
    await expect(page.getByRole("dialog")).toBeInViewport({ ratio: 1 });
    expect(await bounds()).toEqual(baseline);
    await page.keyboard.press("Escape");
    await expect(reason).toBeFocused();
    await reason.click();
    await page.evaluate(() => window.mochiTest.problem(null));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.evaluate(() => {
      window.mochiTest.problem(null);
      window.mochiTest.update({ loaded: true, controlReady: true });
      window.mochiTest.preview({
        character: "mochi",
        preview: "working-continuous",
        nonce: "stable-layout",
      });
    });
    expect(await bounds()).toEqual(baseline);
    await page.getByRole("button", { name: "结束预览", exact: true }).click();
    expect(await bounds()).toEqual(baseline);
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([
      { type: "selectBot", botId: otherId },
      { type: "selectBot", botId: connectedFacts.bots[0]!.botId },
    ]);
  });

test("companion focus draws a visible neutral ring without moving a control", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await page.evaluate(
    (original) =>
      window.mochiTest.update({
        bots: [
          original,
          {
            ...original,
            botId: "22222222-2222-4222-8222-222222222222",
            label: "星野",
          },
        ],
      }),
    connectedFacts.bots[0]!,
  );
  const picker = page.getByRole("button", { name: /^切换伙伴，当前/ });
  const controls = [
    picker,
    page.getByRole("switch"),
    page.getByRole("button", { name: "1 个群", exact: true }),
    page.getByRole("button", { name: "设置", exact: true }),
  ];
  for (const control of controls) {
    await page.locator("h1").click();
    await expectFocusRing(control);
  }
  await picker.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
  await expect(picker).toHaveCSS("outline-style", "solid");
  await page.screenshot({ path: "controlApp/.build/companion-focus.png" });
});
