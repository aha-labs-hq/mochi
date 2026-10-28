import { expect, test } from "bun:test";
import { DesktopQuit } from "../src/host/quit.ts";
import { problem } from "../src/shared/problem.ts";

test("quit joins concurrent requests, waits for shutdown proof and only then permits native termination", async () => {
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let approvals = 0,
    shutdowns = 0,
    exits = 0;
  const quitting = new DesktopQuit({
    approve: async () => {
      approvals++;
      return true;
    },
    shutdown: async () => {
      shutdowns++;
      await stopped;
      return { ok: true, value: null };
    },
    revealFailure: () => {
      throw new Error("unexpected failure");
    },
    quit: () => {
      expect(quitting.allowed).toBe(true);
      exits++;
    },
  });
  const first = quitting.request();
  expect(quitting.request()).toBe(first);
  await Bun.sleep(0);
  expect([approvals, shutdowns, exits]).toEqual([1, 1, 0]);
  expect(quitting.allowed).toBe(false);
  finish();
  await first;
  expect(exits).toBe(1);
});

test("a cancelled draft decision never stops the service; failed shutdown reveals the App and can be retried", async () => {
  let approve = false,
    stopped = false,
    shutdowns = 0,
    failures = 0,
    exits = 0;
  const quitting = new DesktopQuit({
    approve: async () => approve,
    shutdown: async () => {
      shutdowns++;
      return stopped
        ? { ok: true, value: null }
        : { ok: false, problem: problem("service_shutdown_failed") };
    },
    revealFailure: () => {
      failures++;
    },
    quit: () => {
      exits++;
    },
  });
  await quitting.request();
  expect(shutdowns).toBe(0);
  approve = true;
  await quitting.request();
  expect(quitting.allowed).toBe(false);
  expect([shutdowns, failures, exits]).toEqual([1, 1, 0]);
  stopped = true;
  await quitting.request();
  expect([shutdowns, failures, exits]).toEqual([2, 1, 1]);
});
