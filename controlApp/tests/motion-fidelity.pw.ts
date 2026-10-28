import { expect, test } from "@playwright/test";
import manifest from "../../motion/manifest.json" with { type: "json" };

for (const sequence of manifest.sequences.filter(
  (s) =>
    s.acceptance.startsWith("approved") ||
    (s.acceptance === "candidate" &&
      "bundledForPreview" in s &&
      s.bundledForPreview === true),
)) {
  test(`${sequence.id}: every atlas frame retains colour, alpha and exact static handoffs`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/main/index.html");
    const result = await page.evaluate(
      (id) => window.mochiTest.motionEvidence(id),
      sequence.id,
    );
    await test.info().attach("pixel-fidelity.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    expect(result.rootMismatch).toBe(0);
    expect(result.terminalMismatch).toBe(0);
    expect(result.fractionalRedraws).toBe(0);
    expect(result.maximumAlphaError).toBeLessThanOrEqual(1);
    expect(result.maximumColorError).toBeLessThanOrEqual(2);
  });
}
