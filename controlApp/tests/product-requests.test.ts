import { expect, test } from "bun:test";
import type { DesktopController } from "../src/host/controller.ts";
import { productRequests } from "../src/host/productRequests.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const calls: unknown[] = [];
  const controller = {
    snapshot: { selectedBotId: A as string | null },
    async perform(input: unknown) {
      calls.push(input);
      return { ok: true as const, value: null };
    },
    async instructions(input: unknown) {
      calls.push(input);
      return { ok: true as const, value: null };
    },
    async models() {
      calls.push("models");
      return { ok: true as const, value: [] };
    },
    async skills() {
      calls.push("skills");
      return { ok: true as const, value: [] };
    },
    async schedules() {
      calls.push("schedules");
      return { ok: true as const, value: [] };
    },
  };
  return {
    controller,
    calls,
    rpc: productRequests(controller as unknown as DesktopController, (fn) =>
      fn(),
    ),
  };
}
test("all product RPCs reject a stale displayed Bot without calling the controller", async () => {
  const f = fixture();
  f.controller.snapshot.selectedBotId = B;
  const results = await Promise.all([
    f.rpc.perform({ botId: A, action: { type: "logout" } }),
    f.rpc.instructions({ botId: A, request: { type: "read" } }),
    f.rpc.models({ botId: A }),
    f.rpc.skills({ botId: A }),
    f.rpc.schedules({ botId: A }),
    f.rpc.perform({
      botId: A,
      action: {
        type: "setScheduleEnabled",
        scheduleId: `schedule:${"a".repeat(64)}`,
        revision: 1,
        enabled: false,
      },
    }),
  ]);
  for (const result of results) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe("bot_view_changed");
  }
  expect(f.calls).toEqual([]);
});
test("product RPCs return a closed failure for malformed or additional scope fields", async () => {
  const f = fixture();
  for (const input of [
    null,
    {},
    { botId: A, extra: true },
    { botId: "bad" },
    { botId: undefined },
  ]) {
    expect((await f.rpc.models(input)).ok).toBe(false);
    expect((await f.rpc.skills(input)).ok).toBe(false);
    expect((await f.rpc.schedules(input)).ok).toBe(false);
  }
  expect(
    (await f.rpc.perform({ botId: A, action: { type: "logout" }, extra: true }))
      .ok,
  ).toBe(false);
  expect(f.calls).toEqual([]);
});
test("matching scopes pass through and an empty roster may explicitly create its first Bot", async () => {
  const f = fixture();
  expect(
    (await f.rpc.instructions({ botId: A, request: { type: "read" } })).ok,
  ).toBe(true);
  expect((await f.rpc.models({ botId: A })).ok).toBe(true);
  f.controller.snapshot.selectedBotId = null;
  expect(
    (await f.rpc.perform({ botId: null, action: { type: "createBot" } })).ok,
  ).toBe(true);
  expect(f.calls).toEqual([{ type: "read" }, "models", { type: "createBot" }]);
});
