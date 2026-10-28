import { expect, test } from "@playwright/test";
import sharp from "./sharp.ts";

test("the real generated entrance reveals one felt frame, lands and becomes the introduction without replacing its canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/main/index.html?surface=encounter");
  const actor = page.locator("canvas[aria-label='Mochi']");
  await expect(actor).toHaveAttribute("data-ready", "true");
  const canvas = await actor.elementHandle();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-surface",
    "encounter",
  );
  await page.screenshot({
    path: "controlApp/.build/arrival-start.png",
    omitBackground: true,
  });
  await page.waitForFunction(() => {
    const stage = document.querySelector<HTMLElement>("[data-testid=shell]")!;
    return (
      Number(stage.style.getPropertyValue("--arrival-below")) <= 0.221 &&
      Number(stage.style.getPropertyValue("--arrival-travel")) === 0
    );
  });
  const peekBounds = await actor.boundingBox();
  // The event canvas includes transparent jumping headroom above the actor.
  expect(peekBounds!.y).toBeGreaterThan(900 - peekBounds!.height);
  expect(peekBounds!.y).toBeLessThan(900);
  expect(peekBounds!.y + peekBounds!.height).toBeGreaterThan(900);
  expect(
    await page
      .getByTestId("shell")
      .evaluate((node) => node.style.getPropertyValue("--frame-reveal")),
  ).toBe("0");
  const peek = await page.screenshot({
    path: "controlApp/.build/arrival-peek.png",
    omitBackground: true,
  });
  // A canvas intersecting the viewport is not enough: it previously exposed
  // only ear tips. Assert real eye pixels, before flight or panel reveal.
  const pixels = await sharp(peek)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let green = 0;
  for (
    let y = Math.floor(pixels.info.height * 0.75);
    y < pixels.info.height;
    y++
  ) {
    for (
      let x = Math.floor(pixels.info.width * 0.7);
      x < pixels.info.width;
      x++
    ) {
      const i = (y * pixels.info.width + x) * 4;
      const [r, g, b, a] = pixels.data.subarray(i, i + 4);
      if (a! > 180 && g! > 1.3 * r! && g! > 1.3 * b!) green++;
    }
  }
  expect(green).toBeGreaterThan(150);
  await page.waitForFunction(() => {
    const stage = document.querySelector<HTMLElement>("[data-testid=shell]")!;
    const travel = Number(stage.style.getPropertyValue("--arrival-travel"));
    return travel > 0.35 && travel < 0.9;
  });
  await page.screenshot({
    path: "controlApp/.build/arrival-flight.png",
    omitBackground: true,
  });
  const landing = await page.evaluate(async () => {
    const samples: Array<{ surface: string; baseline: number; size: number }> =
      [];
    const shell = document.querySelector<HTMLElement>("[data-testid=shell]")!;
    const actor = document.querySelector("canvas")!;
    let settledAt: number | null = null;
    while (settledAt === null || performance.now() - settledAt < 500) {
      await new Promise(requestAnimationFrame);
      if (shell.dataset.surface === "intro") settledAt ??= performance.now();
      if (
        shell.style.getPropertyValue("--arrival-rise") !== "1" ||
        shell.style.getPropertyValue("--arrival-travel") !== "1"
      )
        continue;
      const rect = actor.getBoundingClientRect();
      const overhang =
        parseFloat(actor.style.getPropertyValue("--pose-overhang")) / 100;
      const scale = Number(actor.style.getPropertyValue("--pose-scale"));
      const panel = document
        .querySelector("[data-testid=felt-frame]")!
        .getBoundingClientRect();
      samples.push({
        surface: shell.dataset.surface!,
        baseline: rect.y + rect.height * (1 - overhang) - panel.y,
        size: rect.height / scale,
      });
    }
    return samples;
  });
  expect(landing.some((sample) => sample.surface === "encounter")).toBe(true);
  expect(landing.some((sample) => sample.surface === "intro")).toBe(true);
  for (const sample of landing) {
    expect(Math.abs(sample.baseline)).toBeLessThan(1 / 32);
    expect(Math.abs(sample.size - landing[0]!.size)).toBeLessThan(1 / 32);
  }
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-surface",
    "intro",
    { timeout: 15_000 },
  );
  await page.screenshot({
    path: "controlApp/.build/arrival-landed.png",
    omitBackground: true,
  });
  await expect(page.getByTestId("encounter")).toHaveCount(0);
  expect(
    await canvas!.evaluate(
      (node) => node === document.querySelector("canvas[aria-label='Mochi']"),
    ),
  ).toBe(true);
  await expect(page.locator('[data-intro-view="welcome"]')).toBeVisible();
  await page
    .getByRole("button", { name: "看看麻薯怎么协作", exact: true })
    .click();
  await page.getByRole("button", { name: "产品", exact: true }).click();
  await expect(page.getByTestId("story-message-0")).toBeVisible();
  await page.getByRole("button", { name: "开始设置", exact: true }).click();
  await expect(page.getByTestId("setup-journey")).toBeVisible();
  expect(
    await canvas!.evaluate(
      (node) => node === document.querySelector("canvas[aria-label='Mochi']"),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("reduced motion enters the settled scene without an offscreen wait or provider call", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/main/index.html?surface=encounter");
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-surface",
    "intro",
  );
  await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});
