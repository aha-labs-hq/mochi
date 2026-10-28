import { expect, test } from "bun:test";
import { DesktopUninstall } from "../src/host/uninstall.ts";
import type { UpdateServiceState } from "../src/host/updateService.ts";

function fixture(
  options: {
    choice?: "keepData" | "deleteAll" | null;
    approve?: boolean;
    states?: UpdateServiceState[];
  } = {},
) {
  const calls: string[] = [];
  const states = [
    ...(options.states ?? [
      { version: 1, mode: "uninstall", phase: "waiting" },
      { version: 1, mode: "uninstall", phase: "closing" },
    ]),
  ];
  let onWait = async () => {};
  const removal = new DesktopUninstall({
    approveClose: async () => options.approve ?? true,
    choose: async () =>
      options.choice === undefined ? "keepData" : options.choice,
    service: async (command, _candidate, policy) => {
      calls.push([command, policy].filter(Boolean).join(":"));
      if (command === "uninstall")
        return { version: 1, mode: "uninstall", phase: "preparing" };
      if (command === "cancel") return { version: 1, phase: "cancelling" };
      const next = states.shift();
      if (!next) throw Error("unexpected poll");
      return next;
    },
    pauseUpdates: () => {
      calls.push("pause");
    },
    resumeUpdates: () => {
      calls.push("resume");
    },
    close: () => {
      calls.push("close");
    },
    wait: async () => {
      await onWait();
    },
  });
  return {
    removal,
    calls,
    onWait: (callback: () => Promise<void>) => {
      onWait = callback;
    },
  };
}

test("cancelling either the unsaved-draft decision or native data choice never admits uninstall", async () => {
  for (const options of [{ approve: false }, { choice: null }]) {
    const f = fixture(options);
    await f.removal.start();
    expect(f.calls).toEqual([]);
  }
});

test("both native policies wait for the authenticated closing phase before quitting", async () => {
  for (const choice of ["keepData", "deleteAll"] as const) {
    const f = fixture({ choice });
    await f.removal.start();
    expect(f.calls).toEqual([
      "pause",
      `uninstall:${choice}`,
      "status",
      "status",
      "close",
    ]);
  }
});

test("cancellation while work drains keeps the App alive and resumes updates", async () => {
  const f = fixture({
    states: [
      { version: 1, mode: "uninstall", phase: "failed", error: "cancelled" },
    ],
  });
  f.onWait(() => f.removal.cancel());
  await f.removal.start();
  expect(f.calls).toEqual([
    "pause",
    "uninstall:keepData",
    "cancel",
    "status",
    "resume",
  ]);
});

test("a stale update close, failed removal or lost service never closes the App", async () => {
  for (const states of [
    [{ version: 1, phase: "closing" }],
    [
      {
        version: 1,
        mode: "uninstall",
        phase: "failed",
        error: "preparationFailed",
      },
    ],
    [],
  ] as UpdateServiceState[][]) {
    const f = fixture({ states });
    await expect(f.removal.start()).rejects.toThrow();
    expect(f.calls).not.toContain("close");
    expect(f.calls.at(-1)).toBe("resume");
  }
});
