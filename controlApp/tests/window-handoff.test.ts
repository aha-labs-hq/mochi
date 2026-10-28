import { describe, expect, test } from "bun:test";
import {
  TransitionInterrupted,
  WindowHandoffOwner,
} from "../src/host/windowHandoff.ts";
import {
  anchoredFrame,
  localHandoff,
  parseHandoffReceipt,
  planWindow,
  type WindowHandoff,
} from "../src/shared/windowHandoff.ts";

const source = { x: -400, y: 50, width: 360, height: 380 };
const target = { x: -1920, y: 0, width: 1920, height: 1080 };
const plan = { ...planWindow(source, target), visible: true };

describe("single-window spatial handoff", () => {
  test("translates negative desktop coordinates into local top-left geometry", () => {
    expect(plan.stage).toEqual(target);
    const frame = localHandoff(plan, 1, "stage");
    expect(frame.source).toEqual({ x: 1520, y: 650, width: 360, height: 380 });
    expect(frame.target).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(anchoredFrame(frame, false)).toEqual({
      width: 360,
      height: 380,
      left: "calc((100vw - 360px) * 0.9743589743589743)",
      top: "calc((100vh - 380px) * 0.9285714285714286)",
    });
    expect(anchoredFrame(frame, true).left).toBe("calc((100vw - 1920px) * 0)");
    expect(() => planWindow({ ...source, width: 0 }, target)).toThrow();
    expect(() => planWindow({ ...source, x: Number.NaN }, target)).toThrow();
  });

  test("every native resize follows its corresponding paint receipt", async () => {
    const events: string[] = [];
    const owner = new WindowHandoffOwner({
      plan: async () => plan,
      place: async (_, surface) => {
        events.push(`native:${surface ?? "stage"}`);
      },
    });
    const move = owner.move("encounter", "intro", (surface, frame) => {
      events.push(`${surface}:${frame?.step ?? "done"}`);
      if (frame) queueMicrotask(() => owner.acknowledge(frame));
    });
    await move;
    expect(events).toEqual([
      "encounter:stage",
      "native:stage",
      "intro:animate",
      "intro:land",
      "native:intro",
      "intro:done",
    ]);
    expect(() => owner.acknowledge({ id: 1, step: "land" })).toThrow("Stale");
  });

  test("a hidden window commits its final layout without awaiting suspended paint", async () => {
    const events: unknown[] = [];
    const owner = new WindowHandoffOwner(
      {
        plan: async () => ({ ...plan, visible: false }),
        place: async (rect, surface) => {
          events.push({ rect, surface });
        },
      },
      10,
    );
    await owner.move("companion", "setup", (surface, handoff) => {
      events.push({ surface, handoff });
      // A hidden WebKit never supplies a paint receipt.
    });
    expect(events).toEqual([
      { rect: target, surface: "setup" },
      { surface: "setup", handoff: null },
    ]);
  });

  test("a failed hidden placement restores the source and never reports the target", async () => {
    const events: unknown[] = [];
    const owner = new WindowHandoffOwner({
      plan: async () => ({ ...plan, visible: false }),
      place: async (rect, surface) => {
        events.push({ rect, surface });
        if (surface === "setup") throw Error("placement failed");
      },
    });
    await expect(
      owner.move("companion", "setup", (surface, handoff) => {
        events.push({ surface, handoff });
      }),
    ).rejects.toThrow("placement failed");
    expect(events).toEqual([
      { rect: target, surface: "setup" },
      { rect: source, surface: "companion" },
      { surface: "companion", handoff: null },
    ]);
  });

  test("a missing renderer restores the exact original frame and never publishes completion", async () => {
    const placed: unknown[] = [],
      frames: (WindowHandoff | null)[] = [];
    const owner = new WindowHandoffOwner(
      {
        plan: async () => plan,
        place: async (rect, surface) => {
          placed.push({ rect, surface });
        },
      },
      10,
    );
    await expect(
      owner.move("encounter", "intro", (_, frame) => frames.push(frame)),
    ).rejects.toThrow("paint timed out");
    expect(placed).toEqual([{ rect: source, surface: "encounter" }]);
    expect(frames.map((f) => f?.step ?? null)).toEqual(["stage", null]);
  });

  test("close cancels both in-flight planning and waiting for animation", async () => {
    const planning = Promise.withResolvers<typeof plan>();
    const owner = new WindowHandoffOwner({
      plan: () => planning.promise,
      place: async () => {},
    });
    const frames: unknown[] = [];
    const moving = owner.move("encounter", "intro", (_, frame) =>
      frames.push(frame),
    );
    void moving.catch(() => {});
    owner.cancel();
    planning.resolve(plan);
    await expect(moving).rejects.toThrow("cancelled");
    expect(frames).toEqual([null]);

    const another = owner.move("encounter", "intro", (_, frame) => {
      if (frame?.step === "stage")
        queueMicrotask(() => owner.acknowledge(frame));
      if (frame?.step === "animate") queueMicrotask(() => owner.cancel());
    });
    await expect(another).rejects.toThrow("closed during handoff");
    expect(() => owner.acknowledge({ id: 1, step: "stage" })).toThrow();
  });

  test("an unpainted or closed handoff is an interruption the App survives", async () => {
    const owner = new WindowHandoffOwner(
      { plan: async () => plan, place: async () => {} },
      10,
    );
    const unpainted = await owner
      .move("encounter", "intro", () => {})
      .catch((error: unknown) => error);
    expect(unpainted).toBeInstanceOf(TransitionInterrupted);
    expect((unpainted as TransitionInterrupted).reason).toBe("unpainted");
    const closed = await owner
      .move("encounter", "intro", (_, frame) => {
        if (frame) queueMicrotask(() => owner.cancel());
      })
      .catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(TransitionInterrupted);
    expect((closed as TransitionInterrupted).reason).toBe("closed");
  });

  test("receipts are a closed acknowledgement, never a renderer-selected frame", () => {
    expect(parseHandoffReceipt({ id: 2, step: "animate" })).toEqual({
      id: 2,
      step: "animate",
    });
    for (const input of [
      { id: 0, step: "stage" },
      { id: 1, step: "done" },
      { id: 1, step: "land", x: 10 },
    ])
      expect(() => parseHandoffReceipt(input)).toThrow();
  });
});
