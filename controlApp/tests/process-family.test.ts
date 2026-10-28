import { expect, test } from "bun:test";
import { ProcessFamily, processTable } from "../src/host/processFamily.ts";

const record = (
  pid: number,
  parent: number,
  started = "Wed Sep 9 12:00:00 2026",
) => ({ pid, parent, started });

test("shutdown follows descendants across reparenting without claiming unrelated or reused PIDs", () => {
  const family = new ProcessFamily(10, [
    record(30, 20),
    record(20, 10),
    record(10, 1),
    record(99, 1),
  ]);
  expect(family.remaining([record(30, 1), record(40, 30), record(99, 1)])).toBe(
    2,
  );
  expect(family.remaining([record(40, 1), record(99, 1)])).toBe(1);
  expect(
    family.remaining([
      record(40, 1, "Wed Sep 9 12:01:00 2026"),
      record(50, 40),
      record(99, 1),
    ]),
  ).toBe(0);
});

test("process inspection reads only identity and fails closed when it cannot prove termination", async () => {
  expect(
    await processTable(async (command) => {
      expect(command).toEqual(["/bin/ps", "-axo", "pid=,ppid=,lstart="]);
      return {
        code: 0,
        stdout: " 10  1 Wed Sep  9 12:00:00 2026\n",
        stderr: "",
      };
    }),
  ).toEqual([record(10, 1)]);
  await expect(
    processTable(async () => ({ code: 1, stdout: "", stderr: "" })),
  ).rejects.toThrow("service_shutdown_failed");
  await expect(
    processTable(async () => ({ code: 0, stdout: "invalid", stderr: "" })),
  ).rejects.toThrow("service_shutdown_failed");
});
