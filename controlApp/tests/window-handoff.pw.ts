import { expect, type Locator, test } from "@playwright/test";
import { localHandoff, planWindow } from "../src/shared/windowHandoff.ts";
import sharp from "./sharp.ts";

async function expectRect(
  locator: Locator,
  expected: { x: number; y: number; width: number; height: number },
) {
  // WebKit layout is quantized to 1/64 point. Require less than 1/32 point,
  // rather than demanding impossible floating-point equality from CSS calc().
  await expect
    .poll(async () => {
      const rect = await locator.boundingBox();
      if (!rect) return Infinity;
      return Math.max(
        ...(["x", "y", "width", "height"] as const).map((key) =>
          Math.abs(rect[key] - expected[key]),
        ),
      );
    })
    .toBeLessThan(1 / 32);
}

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`native-frame handoff ${reducedMotion}: stable geometry from roster to encounter and continuous onboarding character`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 520, height: 700 });
    await page.goto("/main/index.html?surface=companion");
    const canvas = page.locator("canvas");
    await expect(canvas).toHaveAttribute("data-ready", "true");
    let original = await canvas.elementHandle();
    const plan = planWindow(
      { x: 900, y: 60, width: 520, height: 700 },
      { x: 0, y: 0, width: 1440, height: 900 },
    );
    const stage = localHandoff(plan, 1, "stage");
    const viewport = page.getByTestId("presentation-viewport");
    await page.evaluate(
      (handoff) => window.mochiTest.handoff(handoff, "companion"),
      stage,
    );
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.painted))
      .toContainEqual({ id: 1, step: "stage" });
    const before = await canvas.boundingBox();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectRect(viewport, stage.source);
    const after = await canvas.boundingBox();
    expect(after!.width).toBeCloseTo(before!.width, 2);
    expect(after!.height).toBeCloseTo(before!.height, 2);
    expect(after!.x - stage.source.x).toBeCloseTo(before!.x, 1);
    expect(after!.y - stage.source.y).toBeCloseTo(before!.y, 1);
    await page.evaluate(
      (handoff) => window.mochiTest.handoff(handoff, "encounter"),
      { ...stage, step: "animate" as const },
    );
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.painted))
      .toContainEqual({ id: 1, step: "animate" });
    await expectRect(viewport, stage.target);
    await page.evaluate(
      (handoff) => window.mochiTest.handoff(handoff, "encounter"),
      { ...stage, step: "land" as const },
    );
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.painted))
      .toContainEqual({ id: 1, step: "land" });
    await page.evaluate(() => window.mochiTest.handoff(null, "intro"));
    await expect(viewport).not.toHaveAttribute("data-handoff");
    await expect(page.locator("canvas")).toHaveCount(1);
    await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
    original = await page.locator("canvas").elementHandle();

    const contraction = localHandoff(
      planWindow(plan.target, { x: 240, y: 110, width: 960, height: 680 }),
      2,
      "stage",
    );
    await page.evaluate(
      (handoff) => window.mochiTest.handoff(handoff, "intro"),
      contraction,
    );
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.painted))
      .toContainEqual({ id: 2, step: "stage" });
    await page.evaluate(
      (handoff) => window.mochiTest.handoff(handoff, "setup"),
      { ...contraction, step: "animate" as const },
    );
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.painted))
      .toContainEqual({ id: 2, step: "animate" });
    await expectRect(viewport, contraction.target);
    await page.evaluate(
      (handoff) => window.mochiTest.handoff(handoff, "setup"),
      { ...contraction, step: "land" as const },
    );
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.painted))
      .toContainEqual({ id: 2, step: "land" });
    const dockBefore = await page.getByTestId("setup-journey").boundingBox();
    await page.setViewportSize({ width: 960, height: 680 });
    const dockAfter = await page.getByTestId("setup-journey").boundingBox();
    expect(dockAfter!.width).toBeCloseTo(dockBefore!.width, 2);
    expect(dockAfter!.height).toBeCloseTo(dockBefore!.height, 2);
    expect(dockAfter!.x).toBeCloseTo(dockBefore!.x - contraction.target.x, 1);
    expect(dockAfter!.y).toBeCloseTo(dockBefore!.y - contraction.target.y, 1);
    await page.evaluate(() => window.mochiTest.handoff(null, "setup"));
    expect(
      await original!.evaluate(
        (node) => node === document.querySelector("canvas"),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });
}

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`desktop dimmer ${reducedMotion}: fades outside content and clears before native landing`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/main/index.html?surface=intro");
    const backdrop = page.getByTestId("fullscreen-backdrop");
    await expect(backdrop).toHaveCSS("opacity", "1");
    await expect(backdrop).toHaveCSS("pointer-events", "none");
    const pixel = await sharp(await page.screenshot({ omitBackground: true }))
      .extract({ left: 8, top: 8, width: 1, height: 1 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect(pixel[3]).toBeGreaterThanOrEqual(96);
    expect(pixel[3]).toBeLessThanOrEqual(98);
    await expect(page.getByTestId("shell")).toHaveCSS("opacity", "1");
    const handoff = localHandoff(
      planWindow(
        { x: 0, y: 0, width: 1440, height: 900 },
        { x: 240, y: 110, width: 960, height: 680 },
      ),
      5,
      "stage",
    );
    await page.evaluate(
      (handoff) => window.mochiTest.handoff(handoff, "intro"),
      handoff,
    );
    await expect
      .poll(() => page.evaluate(() => window.mochiTest.painted))
      .toContainEqual({ id: 5, step: "stage" });
    const samples = await page.evaluate(async (handoff) => {
      const backdrop = document.querySelector<HTMLElement>(
        '[data-testid="fullscreen-backdrop"]',
      )!;
      window.mochiTest.handoff({ ...handoff, step: "animate" }, "setup");
      const samples: Array<{
        opacity: number;
        width: number;
        height: number;
        productOpacity: string;
      }> = [];
      while (
        !window.mochiTest.painted.some(
          (r) => r.id === 5 && r.step === "animate",
        )
      ) {
        await new Promise(requestAnimationFrame);
        const rect = backdrop.getBoundingClientRect();
        samples.push({
          opacity: Number(getComputedStyle(backdrop).opacity),
          width: rect.width,
          height: rect.height,
          productOpacity: getComputedStyle(
            document.querySelector('[data-testid="shell"]')!,
          ).opacity,
        });
      }
      return samples;
    }, handoff);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.width).toBe(1440);
      expect(sample.height).toBe(900);
      expect(sample.productOpacity).toBe("1");
    }
    if (reducedMotion === "no-preference")
      expect(samples.some((s) => s.opacity > 0 && s.opacity < 1)).toBe(true);
    expect(samples.at(-1)!.opacity).toBe(0);
    await expect(backdrop).toHaveCSS("opacity", "0");
    // Re-entering uses the same dimmer; replay must not stack or retain it.
    await page.evaluate(() => window.mochiTest.handoff(null, "intro"));
    await expect(backdrop).toHaveCSS("opacity", "1");
    await expect(backdrop).toHaveCount(1);
    await page.evaluate(() => window.mochiTest.handoff(null, "companion"));
    await expect(backdrop).toHaveCSS("opacity", "0");
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
  });
}
