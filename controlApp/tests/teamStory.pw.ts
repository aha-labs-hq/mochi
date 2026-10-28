import { expect, test } from "@playwright/test";
import { localHandoff, planWindow } from "../src/shared/windowHandoff.ts";
import content from "../src/ui/introductionStories.json" with { type: "json" };

test("welcome holds for reading, then keyboard navigation preserves the same scene", async ({
  page,
}) => {
  await page.goto("/main/index.html?surface=intro");
  const welcome = page.locator('[data-intro-view="welcome"]');
  const frame = await page.getByTestId("felt-frame").elementHandle();
  await expect(welcome).toBeVisible();
  await page.waitForTimeout(1600);
  await expect(welcome).toBeVisible();
  // The illustration settles once; it must not become another looping player.
  const illustration = page.getByTestId("project-illustration");
  const stillFrame = await illustration.screenshot();
  await page.waitForTimeout(300);
  expect(await illustration.screenshot()).toEqual(stillFrame);
  await expect(
    page.getByRole("button", { name: "产品", exact: true }),
  ).toBeHidden();
  // macOS WebKit uses Option-Tab to include buttons without changing the
  // user's system-wide full keyboard access preference.
  await page.keyboard.press("Alt+Tab");
  await expect(
    page.getByRole("button", { name: content.explore }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: content.question }),
  ).toBeFocused();
  await page.getByRole("button", { name: "认识麻薯", exact: true }).click();
  await expect(welcome).toBeVisible();
  await expect(welcome.locator(":scope > div").first()).toHaveCSS(
    "opacity",
    "1",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: content.explore }).click();
  await expect(
    page.getByRole("button", { name: "产品", exact: true }),
  ).toBeVisible();
  expect(
    await frame!.evaluate(
      (node) => node === document.querySelector('[data-testid="felt-frame"]'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("native expansion into welcome reports no renderer errors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/main/index.html?surface=companion");
  const stage = localHandoff(
    planWindow(
      { x: 960, y: 200, width: 400, height: 560 },
      { x: 0, y: 0, width: 1440, height: 900 },
    ),
    7,
    "stage",
  );
  await page.evaluate(
    (handoff) => window.mochiTest.handoff(handoff, "companion"),
    stage,
  );
  const errors = await page.evaluate(async (handoff) => {
    const errors: string[] = [];
    const error = (event: ErrorEvent) => errors.push(event.message);
    window.addEventListener("error", error);
    window.mochiTest.handoff({ ...handoff, step: "animate" }, "intro");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    window.removeEventListener("error", error);
    return errors;
  }, stage);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.mochiTest.painted)).toContainEqual({
    id: 7,
    step: "animate",
  });
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 360, height: 509 },
  { width: 520, height: 700 },
  { width: 804, height: 877 },
  { width: 1440, height: 900 },
]) {
  test(`five roles at ${viewport.width}: continuous identity, local evidence and real setup handoff`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/main/index.html?surface=intro");
    const character = await page.locator("canvas").elementHandle();
    const frame = await page.getByTestId("felt-frame").elementHandle();
    const welcome = page.locator('[data-intro-view="welcome"]');
    await expect(welcome.getByRole("button")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "产品", exact: true }),
    ).toBeHidden();
    await expect(welcome).toContainText(content.heading.join(""));
    // Before the promise, one line says who Mochi is.
    await expect(welcome.locator("p").first()).toHaveText(content.who);
    await expect(welcome.locator("p").first()).toBeInViewport({ ratio: 1 });
    await expect(welcome).toContainText(content.intro);
    await expect(welcome).toContainText(content.context);
    await expect(welcome).toContainText(content.caption);
    await expect(welcome.getByRole("button")).toBeInViewport({ ratio: 1 });
    const promise = welcome.locator("p").nth(1);
    await expect(promise).toHaveText(
      content.intro + content.context + content.caption,
    );
    await expect(promise).toBeInViewport({ ratio: 1 });
    await expect(welcome.getByRole("heading")).toBeInViewport({ ratio: 1 });
    const illustration = page.getByTestId("project-illustration");
    await expect(illustration).toBeInViewport({ ratio: 1 });
    for (const asset of await illustration.locator("img").all())
      await expect
        .poll(() =>
          asset.evaluate(
            (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
          ),
        )
        .toBe(true);
    const illustrationBox = (await illustration.boundingBox())!;
    const promiseBox = (await promise.boundingBox())!;
    expect(illustrationBox.y + illustrationBox.height).toBeLessThan(
      promiseBox.y,
    );
    await page.screenshot({
      path: `controlApp/.build/intro-welcome-${viewport.width}.png`,
    });
    await page
      .getByRole("button", { name: content.explore, exact: true })
      .click();
    const choice = page.locator('[data-intro-view="choice"]');
    await expect(choice.locator("[data-role]")).toHaveCount(5);
    await expect(choice.getByRole("heading")).toHaveText(content.question);
    await expect(choice.getByRole("heading")).toBeFocused();
    await page.getByRole("button", { name: "认识麻薯", exact: true }).click();
    await expect(welcome).toBeVisible();
    await page
      .getByRole("button", { name: content.explore, exact: true })
      .click();
    await expect(choice).toContainText("你平时在团队里做什么？");
    await expect(page.getByRole("button", { name: "开始设置" })).toHaveCount(0);
    await expect(choice).not.toContainText(/Jules|Nora|Theo|Evan|Riley/);
    for (const button of await choice.locator("[data-role]").all())
      await expect(button).toBeInViewport({ ratio: 0.99 });
    await page.mouse.move(0, 0);
    const composition = await choice.evaluate((node) => {
      const frame = node.getBoundingClientRect();
      const textEdges = [
        node.querySelector("h1")!,
        ...[...node.querySelectorAll("p")].filter(
          (p) => p.getClientRects().length > 0,
        ),
      ].flatMap((text) => {
        const range = document.createRange();
        range.selectNodeContents(text);
        return [...range.getClientRects()]
          .filter((box) => box.width > 0)
          .map((box) => box.x);
      });
      const rows = new Map<number, DOMRect[]>();
      for (const avatar of node.querySelectorAll("[data-portrait]")) {
        const box = avatar.getBoundingClientRect();
        const key = Math.round(box.y);
        rows.set(key, [...(rows.get(key) ?? []), box]);
      }
      return {
        left: frame.x + Number.parseFloat(getComputedStyle(node).paddingLeft),
        right:
          frame.right - Number.parseFloat(getComputedStyle(node).paddingRight),
        textEdges,
        rows: [...rows.values()].map((boxes) =>
          boxes.map((box) => ({
            left: box.x,
            right: box.right,
          })),
        ),
      };
    });
    for (const left of composition.textEdges)
      expect(Math.abs(left - composition.left)).toBeLessThan(1);
    expect(composition.rows[0]!.at(-1)!.right).toBeCloseTo(
      composition.right,
      0,
    );
    for (const row of composition.rows) {
      expect(row[0]!.left).toBeCloseTo(composition.left, 0);
      row.forEach((box, index) => {
        expect(box.left).toBeCloseTo(composition.rows[0]![index]!.left, 0);
        if (index > 0)
          expect(box.left - row[index - 1]!.right).toBeGreaterThanOrEqual(16);
      });
    }
    await page.screenshot({
      path: `controlApp/.build/intro-choice-${viewport.width}.png`,
    });
    const firstChoice = choice.locator("[data-role]").first();
    const beforeHover = await firstChoice.locator("img").boundingBox();
    await firstChoice.hover();
    expect(await firstChoice.locator("img").boundingBox()).toEqual(beforeHover);
    await page.mouse.move(0, 0);
    for (const story of content.stories) {
      const button = page.getByRole("button", {
        name: story.role,
        exact: true,
      });
      await expect(button).toBeInViewport({ ratio: 0.99 });
      const portrait = await button.locator("img").elementHandle();
      await button.click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        story.title,
      );
      const thread = page.getByTestId("story-thread");
      await expect(thread).toHaveAttribute("data-conversation", "complete");
      await expect(thread.locator("[data-message]")).toHaveCount(
        story.messages.length,
      );
      const first = page.getByTestId("story-message-0");
      await expect(first).toHaveAttribute("data-perspective", "true");
      expect(
        await portrait!.evaluate(
          (node) => node === document.querySelector('[data-message="0"] img'),
        ),
      ).toBe(true);
      const firstBox = await first.boundingBox();
      const avatarBox = await first.locator("img").boundingBox();
      const bubbleBox = await first.locator("[data-chat-bubble]").boundingBox();
      expect(avatarBox!.x).toBeGreaterThan(bubbleBox!.x + bubbleBox!.width);
      expect(Math.abs(avatarBox!.y - bubbleBox!.y)).toBeLessThan(1);
      expect(firstBox!.width).toBeGreaterThan(bubbleBox!.width);
      await expect(page.getByText("对话示例", { exact: true })).toBeVisible();
      for (const image of await thread.locator("img").all())
        expect(
          await image.evaluate(
            (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
          ),
        ).toBe(true);
      const link = thread.getByRole("link").first();
      await link.click();
      const source = page.getByRole("dialog");
      await expect(source).toContainText("GitHub · 示例资料");
      await expect(source).not.toContainText(/跨客户|API|授权原话/);
      await page.keyboard.press("Escape");
      await expect(source).not.toBeVisible();
      await expect(link).toBeFocused();
      await thread.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({
        path: `controlApp/.build/intro-${story.id}-${viewport.width}.png`,
      });
      const setup = page.getByRole("button", { name: "开始设置", exact: true });
      const back = page.getByRole("button", { name: "重选职能" });
      const latest = page.getByRole("button", { name: "回到最新消息" });
      await expect(latest).toBeInViewport({ ratio: 1 });
      const footer = [await back.boundingBox(), await setup.boundingBox()];
      const threadBox = (await thread.boundingBox())!;
      const latestBox = (await latest.boundingBox())!;
      const faceBox = (await latest.locator("span").boundingBox())!;
      expect(latestBox.width).toBeGreaterThanOrEqual(44);
      expect(latestBox.height).toBeGreaterThanOrEqual(44);
      expect(latestBox.x + latestBox.width / 2).toBeCloseTo(
        threadBox.x + threadBox.width / 2,
        0,
      );
      expect(faceBox.y).toBeGreaterThan(threadBox.y + threadBox.height);
      expect(latestBox.y + latestBox.height).toBeLessThanOrEqual(
        Math.min(...footer.map((box) => box!.y)),
      );
      // The outer hit area works too, and the reading action never moves navigation.
      await latest.click({ position: { x: 2, y: latestBox.height / 2 } });
      await expect(thread).toHaveAttribute("data-bottom", "false");
      await expect(thread).toBeFocused();
      await expect(latest).toHaveCount(0);
      await expect(thread.locator("[data-message]").last()).toBeInViewport({
        ratio: 0.99,
      });
      expect([await back.boundingBox(), await setup.boundingBox()]).toEqual(
        footer,
      );
      await expect(setup).toBeInViewport({ ratio: 1 });
      await back.click();
      await expect(button).toBeFocused();
      expect(
        await portrait!.evaluate((node) => node.closest("button") !== null),
      ).toBe(true);
    }
    expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
    await page.getByRole("button", { name: "产品", exact: true }).click();
    await page.getByRole("button", { name: "开始设置" }).click();
    await expect(page.getByTestId("setup-journey")).toBeVisible();
    expect(
      await character!.evaluate(
        (node) => node === document.querySelector("canvas"),
      ),
    ).toBe(true);
    expect(
      await frame!.evaluate(
        (node) => node === document.querySelector('[data-testid="felt-frame"]'),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("only Mochi types, every reply follows promptly, scrolling anticipates text and the ending holds", async ({
  page,
}) => {
  await page.goto("/main/index.html?surface=intro");
  await page
    .getByRole("button", { name: content.explore, exact: true })
    .click();
  const button = page.getByRole("button", { name: "负责人", exact: true });
  const portrait = await button.locator("img").elementHandle();
  const ledge = await page.getByTestId("felt-frame").boundingBox();
  await button.click();
  const thread = page.getByTestId("story-thread");
  await expect(page.locator('[data-avatar-transition="landed"]')).toBeVisible();
  expect(
    await portrait!.evaluate(
      (node) => node === document.querySelector('[data-message="0"] img'),
    ),
  ).toBe(true);
  expect((await page.getByTestId("felt-frame").boundingBox())!.y).toBeCloseTo(
    ledge!.y,
    0,
  );
  expect(
    (await page.getByTestId("felt-frame").boundingBox())!.height,
  ).toBeGreaterThan(ledge!.height);
  await expect(
    thread.locator('[data-speaker="riley"] [data-glyph]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("story-message-1")).toHaveAttribute(
    "data-state",
    "typing",
  );
  await expect(
    thread.locator('[data-speaker="mochi"] [data-glyph]').first(),
  ).toHaveCSS("opacity", "1");
  const gaps = await thread.evaluate(async (node) => {
    const rows = Array.from(
      node.querySelectorAll<HTMLElement>("[data-message]"),
    );
    const finished = new Map<number, number>();
    const entered = new Map<number, number>();
    return new Promise<number[]>((resolve) => {
      const observer = new MutationObserver(() => {
        rows.forEach((row, i) => {
          if (row.dataset.state === "complete" && !finished.has(i))
            finished.set(i, performance.now());
          if (row.dataset.state !== "pending" && !entered.has(i))
            entered.set(i, performance.now());
        });
        if (node.dataset.conversation === "complete") {
          observer.disconnect();
          resolve(
            rows
              .slice(2)
              .map((_, i) => entered.get(i + 2)! - finished.get(i + 1)!),
          );
        }
      });
      observer.observe(node, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-state", "data-conversation"],
      });
    });
  });
  for (const gap of gaps) {
    expect(gap).toBeGreaterThan(300);
    expect(gap).toBeLessThan(700);
  }
  await expect(page.getByTestId("story-message-5")).toBeInViewport({
    ratio: 0.99,
  });
  await expect(thread).toHaveAttribute("data-reading", "false");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("shell")).toHaveAttribute(
    "data-surface",
    "intro",
  );
  expect(await page.evaluate(() => window.mochiTest.actions)).toEqual([]);
});

test("source inspection pauses and resumes without rewriting early evidence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/main/index.html?surface=intro");
  await page
    .getByRole("button", { name: content.explore, exact: true })
    .click();
  await page.getByRole("button", { name: "产品", exact: true }).click();
  const thread = page.getByTestId("story-thread");
  const proposal = page.getByTestId("story-message-2");
  const link = proposal.getByRole("link", { name: "原需求 #86" });
  await link.click();
  await expect(thread).toHaveAttribute("data-conversation", "paused");
  await expect(page.getByRole("dialog")).toContainText("待办 · 尚未指派");
  const arrived = await thread.getAttribute("data-arrived");
  await page.waitForTimeout(1000);
  await expect(thread).toHaveAttribute("data-arrived", arrived!);
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await expect(link).toBeFocused();
  await expect(thread).toHaveAttribute("data-conversation", "complete");
  const receipt = page.getByTestId("story-message-4");
  await receipt.getByRole("link", { name: "#86", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("进行中 · Evan");
  await page.keyboard.press("Escape");
  await link.click();
  await expect(page.getByRole("dialog")).toContainText("待办 · 尚未指派");
});

test("height-only resize keeps playback; scrolling hands over all history and returning cancels it", async ({
  page,
}) => {
  await page.goto("/main/index.html?surface=intro");
  await page
    .getByRole("button", { name: content.explore, exact: true })
    .click();
  await page.getByRole("button", { name: "产品", exact: true }).click();
  const thread = page.getByTestId("story-thread");
  await expect(thread).toHaveAttribute("data-conversation", "playing");
  await page.setViewportSize({ width: 520, height: 720 });
  await expect(thread).toHaveAttribute("data-reading", "false");
  await thread.hover();
  await page.mouse.wheel(0, 100);
  await expect(thread).toHaveAttribute("data-reading", "true");
  await expect(thread.locator('[data-state="complete"]')).toHaveCount(6);
  await thread.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(600);
  expect(await thread.evaluate((node) => node.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "重选职能" }).click();
  await page.getByRole("button", { name: "运营", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(thread).toHaveAttribute("data-reading", "true");
  await expect(thread.locator('[data-state="complete"]')).toHaveCount(4);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(thread).toHaveAttribute("data-reading", "true");
});
