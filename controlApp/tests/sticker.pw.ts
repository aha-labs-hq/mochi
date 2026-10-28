import { expect, test } from "@playwright/test";

test("GPU material preserves compiled colour and alpha at daily, paper and reduced-motion boundaries", async ({
  page,
}) => {
  await page.goto("/main/index.html");
  await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
  // The companion is a transparent desktop object. A decorative felt ellipse
  // behind the character reads as a halo and competes with the actual silhouette.
  await expect(page.getByTestId("felt-landing-pad")).toHaveCount(0);
  const result = await page.evaluate(() => window.mochiTest.stickerEvidence());
  await test.info().attach("pixel-fidelity.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.failed).toBe(false);
  expect(result.maximumAlphaError).toBeLessThanOrEqual(1);
  expect(result.maximumColorError).toBeLessThanOrEqual(2);
  expect(result.contaminatedBefore).toBe(0);
  expect(result.contaminatedAfter).toBe(0);
  expect(
    result.staticAssetContamination.every(
      (asset) => asset.before === 0 && asset.after === 0,
    ),
  ).toBe(true);
  expect(result.addedPaperPixels).toBeGreaterThan(500);
  expect(result.addedPaperPixels).toBeLessThan(12_000);
  expect(result.cornerAlpha).toBe(0);
  expect(result.movedPixels).toBeGreaterThan(1_000);
  expect(result.reducedMismatch).toBe(0);
  expect(result.resizeContinuity).toEqual([255, 255, 255]);
  for (const change of result.resolutionChanges) {
    expect(change).toMatchObject({
      width: change.size,
      height: change.size,
      alpha: 255,
      sameContext: true,
      error: 0,
    });
  }
  for (const sample of result.minification)
    expect(sample.maximumError).toBeLessThanOrEqual(1);
});

for (const density of [1, 2]) {
  test(`character draws at ${density}x display density after window resize`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ deviceScaleFactor: density });
    const page = await context.newPage();
    try {
      await page.goto(`${process.env.MOCHI_UI_TEST_URL}/main/index.html`);
      const canvas = page.locator("canvas");
      await expect(canvas).toHaveAttribute("data-ready", "true");
      for (const size of [
        { width: 400, height: 560 },
        { width: 520, height: 700 },
      ]) {
        await page.setViewportSize(size);
        await expect
          .poll(() =>
            canvas.evaluate((node: HTMLCanvasElement) => {
              const bounds = node.getBoundingClientRect();
              return Math.max(
                Math.abs(
                  node.width - Math.round(bounds.width * devicePixelRatio),
                ),
                Math.abs(
                  node.height - Math.round(bounds.height * devicePixelRatio),
                ),
              );
            }),
          )
          .toBeLessThanOrEqual(1);
      }
    } finally {
      await context.close();
    }
  });
}

test("desktop arrival dims the real desktop and restores transparency when skipped without provider actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/main/index.html?surface=encounter");
  const canvas = await page.locator("canvas").elementHandle();
  await expect(page.getByTestId("encounter")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "麻薯来到你的桌面" }),
  ).toBeFocused();
  await expect(page.getByTestId("shell")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
  const bounds = await page.locator("canvas").boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(450);
  await expect(page.getByRole("button", { name: "认识一下" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const captureCornerAlpha = async () => {
    const screenshot = await page.screenshot({
      omitBackground: true,
    });
    // Computed background-color alone cannot prove that the document canvas or
    // an ancestor has not painted over the native transparent stage.
    return page.evaluate(
      async (bytes) => {
        const image = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        );
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        image.close();
        return context.getImageData(100, 100, 1, 1).data[3];
      },
      [...screenshot],
    );
  };
  await expect(page.getByTestId("fullscreen-backdrop")).toHaveCSS(
    "opacity",
    "1",
  );
  // 38% coverage leaves the actual desktop visible rather than an opaque fill.
  expect(Math.abs((await captureCornerAlpha())! - 97)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("setup-journey")).toBeVisible();
  await expect(page.getByTestId("fullscreen-backdrop")).toHaveCSS(
    "opacity",
    "0",
  );
  expect(await captureCornerAlpha()).toBe(0);
  expect(
    await canvas!.evaluate((node) => node === document.querySelector("canvas")),
  ).toBe(true);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});
