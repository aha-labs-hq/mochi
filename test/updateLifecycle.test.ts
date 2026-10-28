import { expect, test } from "bun:test";
import {
  UpdateLifecycle,
  parseUpdateLifecycleRequest,
  compareProductVersions,
} from "../src/control/updateLifecycle.ts";

const acquire = {
  lifecycle: "update",
  version: 1,
  command: "acquire",
  targetVersion: "0.3.0",
  sha256: "a".repeat(64),
} as const;
test("an update lease waits for every participant and operation without closing admission while busy", () => {
  let idle = false,
    now = 0;
  const gate = new UpdateLifecycle(
    "0.2.0",
    () => idle,
    () => now,
  );
  expect(gate.handle(acquire)).toMatchObject({ ok: false, reason: "busy" });
  expect(gate.acceptingWork).toBe(true);
  idle = true;
  const finish = gate.enterOperation()!;
  expect(gate.handle(acquire)).toMatchObject({ ok: false, reason: "busy" });
  finish();
  finish();
  const held = gate.handle(acquire);
  expect(held.ok).toBe(true);
  if (!held.ok) throw new Error("lease missing");
  expect(gate.acceptingWork).toBe(false);
  expect(gate.enterOperation()).toBeNull();
  expect(gate.handle(acquire)).toMatchObject({ ok: false, reason: "busy" });
  expect(
    gate.handle({
      lifecycle: "update",
      version: 1,
      command: "stop",
      lease: "b".repeat(36),
    }),
  ).toMatchObject({ ok: false, reason: "expired" });
  now = 120_001;
  expect(gate.acceptingWork).toBe(true);
  expect(
    gate.handle({
      lifecycle: "update",
      version: 1,
      command: "stop",
      lease: held.lease!,
    }),
  ).toMatchObject({ ok: false, reason: "expired" });
});

test("cancel restores admission; shutdown cannot expire into accepting work again", () => {
  let now = 0;
  const gate = new UpdateLifecycle(
    "0.2.0",
    () => true,
    () => now,
  );
  const get = () => {
    const r = gate.handle(acquire);
    if (!r.ok) throw Error("not granted");
    return r.lease!;
  };
  expect(
    gate.handle({
      lifecycle: "update",
      version: 1,
      command: "release",
      lease: get(),
    }).ok,
  ).toBe(true);
  expect(gate.acceptingWork).toBe(true);
  expect(
    gate.handle({
      lifecycle: "update",
      version: 1,
      command: "stop",
      lease: get(),
    }).ok,
  ).toBe(true);
  now = 100_000;
  expect(gate.acceptingWork).toBe(false);
});

test("wire accepts one closed lifecycle contract and never downgrades; same-version repair shares admission", () => {
  expect(parseUpdateLifecycleRequest(acquire)).toEqual(acquire);
  for (const input of [
    { ...acquire, path: "/tmp/pkg" },
    { ...acquire, version: 28 },
    { ...acquire, targetVersion: "0.3.0-beta" },
    { ...acquire, sha256: "invalid" },
    { lifecycle: "update", version: 1, command: "stop", lease: "no" },
  ])
    expect(() => parseUpdateLifecycleRequest(input)).toThrow();
  const gate = new UpdateLifecycle("0.2.0", () => true);
  expect(gate.handle({ ...acquire, targetVersion: "0.1.999" })).toMatchObject({
    ok: false,
    reason: "invalid",
  });
  expect(gate.handle({ ...acquire, targetVersion: "0.2.0" })).toMatchObject({
    ok: true,
  });
  expect(compareProductVersions("0.10.0", "0.9.99")).toBe(1);
});
