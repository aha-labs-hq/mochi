import { expect, type Locator, test } from "@playwright/test";
import { effortLabel } from "../src/shared/vocabulary.ts";
import type {} from "./desktop.pw.ts";
import sharp from "./sharp.ts";

declare global {
  interface Window {
    /** Properties whose transitions started inside the effort slider. */
    effortTransitions: string[];
  }
}

/** Steps glide, so geometry is read only after the slider's motion settles. */
async function settled(control: Locator) {
  await control.evaluate(async (element) => {
    for (
      let running = element.getAnimations({ subtree: true });
      running.length > 0;
      running = element.getAnimations({ subtree: true })
    )
      await Promise.allSettled(running.map((animation) => animation.finished));
  });
}

for (const width of [320, 640, 1040]) {
  test(`${width}: seven catalog efforts are directly adjustable without a dropdown`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 716 });
    await page.goto("/main/settings.html?page=model");
    await page
      .getByRole("combobox", { name: "模型", exact: true })
      .selectOption("gpt-test-seven");
    const slider = page.getByRole("slider", { name: "思考深度", exact: true });
    await expect(slider).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^思考深度/ })).toHaveCount(
      0,
    );
    await expect(slider).toHaveAttribute("max", "6");
    await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("max"));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await slider.press("ArrowLeft");
    await slider.press("ArrowLeft");
    await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("high"));
    await page.getByRole("heading", { name: "模型", exact: true }).focus();
    const thumb = slider.locator("..");
    const control = slider.locator("../../..");
    await settled(control);
    await page.screenshot({
      path: `controlApp/.build/effort-picker-${width}.png`,
    });
    const bounds = (await control.boundingBox())!;
    for (const end of ["minimum", "maximum"] as const) {
      const current = (await thumb.boundingBox())!;
      await page.mouse.move(
        current.x + current.width / 2,
        current.y + current.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        end === "minimum" ? bounds.x - 10 : bounds.x + bounds.width + 10,
        bounds.y + bounds.height / 2,
        { steps: 8 },
      );
      await page.mouse.up();
      await expect(slider).toHaveAttribute(
        "aria-valuetext",
        effortLabel(end === "minimum" ? "none" : "max"),
      );
      await settled(control);
      const edge = (await thumb.boundingBox())!;
      expect(
        end === "minimum"
          ? edge.x - bounds.x
          : edge.x + edge.width - bounds.x - bounds.width,
      ).toBeCloseTo(0, 1);
      if (end === "minimum") {
        const pixels = await sharp(
          await control.screenshot({
            path: `controlApp/.build/effort-minimum-${width}.png`,
          }),
        )
          .removeAlpha()
          .raw()
          .toBuffer();
        let bluePixels = 0;
        for (let p = 0; p < pixels.length; p += 3)
          if (pixels[p + 2]! > pixels[p]! + 15) bluePixels++;
        expect(
          bluePixels,
          "No blue crescent may escape the minimum thumb",
        ).toBe(0);
      }
    }
    await page
      .getByRole("combobox", { name: "模型", exact: true })
      .selectOption("gpt-test-fast");
    await expect(
      page.getByText(effortLabel("low"), { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("slider")).toHaveCount(0);
  });
}

test("effort reveals a fixed gradient with visibly increasing color depth", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.goto("/main/settings.html?page=model");
  await page
    .getByRole("combobox", { name: "模型", exact: true })
    .selectOption("gpt-test-seven");
  const slider = page.getByRole("slider", { name: "思考深度", exact: true });
  const control = slider.locator("../../..");
  const colors: number[][] = [];
  for (const [step, id] of [
    [1, "minimal"],
    [3, "medium"],
    [6, "max"],
  ] as const) {
    await slider.press("Home");
    for (let i = 0; i < step; i++) await slider.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuetext", effortLabel(id));
    await page.getByRole("heading", { name: "模型", exact: true }).focus();
    await settled(control);
    const bounds = (await control.boundingBox())!;
    const thumb = (await slider.locator("..").boundingBox())!;
    const { data, info } = await sharp(
      await control.screenshot({
        path: `controlApp/.build/effort-gradient-${id}.png`,
      }),
    )
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const y = Math.floor(bounds.height / 2 + 8);
    const channel = (x: number) => data[(y * info.width + Math.floor(x)) * 3]!;
    // Sample the fill behind the thumb, away from the central tick marks.
    colors.push([channel(thumb.x - bounds.x - 8), channel(8)]);
  }
  expect(colors[0]![0]! - colors[1]![0]!).toBeGreaterThan(20);
  expect(colors[1]![0]! - colors[2]![0]!).toBeGreaterThan(20);
  // A point already revealed must keep its color as later steps are exposed.
  expect(Math.abs(colors[0]![1]! - colors[2]![1]!)).toBeLessThanOrEqual(2);
});

test("steps glide from the current position, never on first layout or with reduced motion", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.effortTransitions = [];
    document.addEventListener("transitionrun", (event) => {
      if ((event.target as Element).closest('[data-orientation="horizontal"]'))
        window.effortTransitions.push(event.propertyName);
    });
  });
  const runs = () => page.evaluate(() => window.effortTransitions);
  await page.goto("/main/settings.html?page=model");
  await page
    .getByRole("combobox", { name: "模型", exact: true })
    .selectOption("gpt-test-seven");
  const slider = page.getByRole("slider", { name: "思考深度", exact: true });
  const thumb = slider.locator("..");
  const control = slider.locator("../../..");
  await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("max"));
  await settled(control);
  expect(await runs(), "The first measured layout must not animate").toEqual(
    [],
  );

  const before = (await thumb.boundingBox())!;
  await slider.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("xhigh"));
  // WebKit reports Base UI's logical inset by its physical property.
  await expect.poll(runs).toEqual(expect.arrayContaining(["left", "width"]));
  await settled(control);
  expect((await thumb.boundingBox())!.x).toBeLessThan(before.x - 20);

  await page.evaluate(() => {
    window.effortTransitions = [];
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await slider.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("high"));
  await settled(control);
  expect(
    await runs(),
    "Reduced motion moves the thumb without gliding",
  ).toEqual([]);
});

test("keyboard stepping uses catalog IDs and only saves the draft on command", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  await page
    .getByRole("combobox", { name: "模型", exact: true })
    .selectOption("gpt-test-seven");
  const slider = page.getByRole("slider", { name: "思考深度", exact: true });
  await slider.press("Home");
  for (const id of [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    await expect(slider).toHaveAttribute("aria-valuetext", effortLabel(id));
    await slider.press("ArrowRight");
  }
  await slider.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("xhigh"));
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  await slider.press("Meta+s");
  await expect
    .poll(() => page.evaluate(() => window.mochiTest.actions))
    .toEqual([
      {
        type: "updatePolicy",
        policy: { model: "gpt-test-seven", reasoningEffort: "xhigh" },
      },
    ]);
  await expect(page.getByRole("status")).toContainText("已保存");
});

test("pointer selection snaps to a supported step and navigation preserves its draft", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  await page
    .getByRole("combobox", { name: "模型", exact: true })
    .selectOption("gpt-test-seven");
  const slider = page.getByRole("slider", { name: "思考深度", exact: true });
  const control = slider.locator("../../..");
  const bounds = (await control.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width - 1,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("medium"));
  await page.getByRole("button", { name: "设定", exact: true }).click();
  await expect(slider).not.toBeVisible();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("medium"));
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("account uncertainty disables adjustment and an unsupported saved effort requires an explicit choice", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=model");
  const slider = page.getByRole("slider", { name: "思考深度", exact: true });
  await expect(slider).toHaveAttribute("max", "1");
  await page.evaluate(() =>
    window.mochiTest.update({ account: { status: "unknown" } }),
  );
  await expect(slider).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存设置", exact: true }),
  ).toBeDisabled();
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
          { provider: "openai-codex", authType: "oauth", subscription: true },
        ],
      },
      policy: { model: "gpt-test-balanced", reasoningEffort: "none" },
    }),
  );
  const choices = page.getByRole("group", { name: "思考深度", exact: true });
  await expect(slider).toHaveCount(0);
  await expect(choices.getByRole("button")).toHaveText(
    ["high", "max"].map(effortLabel),
  );
  await choices
    .getByRole("button", { name: effortLabel("high"), exact: true })
    .click();
  await expect(slider).toHaveAttribute("aria-valuetext", effortLabel("high"));
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});
