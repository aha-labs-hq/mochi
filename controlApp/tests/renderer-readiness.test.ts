import { expect, test } from "bun:test";
import { RendererReadiness } from "../src/host/rendererReadiness.ts";

for (const paintFirst of [true, false]) {
  test(`native visibility joins subscriber and first frame, paintFirst=${paintFirst}`, () => {
    let shown = 0;
    const failures: string[] = [];
    const ready = new RendererReadiness(
      () => shown++,
      (reason) => failures.push(reason),
    );
    if (paintFirst) ready.firstFrame();
    else ready.subscribed();
    expect(shown).toBe(0);
    if (paintFirst) ready.subscribed();
    else ready.firstFrame();
    ready.firstFrame();
    ready.subscribed();
    expect(shown).toBe(1);
    expect(failures).toEqual([]);
  });
}

test("missing renderer fails visibly once, even when it never subscribes", async () => {
  let shown = 0;
  const failures: string[] = [];
  const ready = new RendererReadiness(
    () => shown++,
    (reason) => failures.push(reason),
    1,
  );
  await Bun.sleep(10);
  ready.firstFrame();
  ready.subscribed();
  expect(shown).toBe(0);
  expect(failures).toEqual(["first-frame-timeout"]);
});

test("early script failure and close revoke late paint callbacks", async () => {
  for (const close of [true, false]) {
    let shown = 0;
    const failures: string[] = [];
    const ready = new RendererReadiness(
      () => shown++,
      (reason) => failures.push(reason),
      1,
    );
    if (close) ready.close();
    else ready.fail("script-error");
    ready.firstFrame();
    ready.subscribed();
    await Bun.sleep(10);
    expect(shown).toBe(0);
    expect(failures).toEqual(close ? [] : ["script-error"]);
  }
});
