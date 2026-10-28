import { expect, test } from "bun:test";
import { join } from "node:path";

test("pinned Pi serves Mochi pages without changing OAuth validation or claiming login success", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/oauthCallback.ts")], {
    env: { PATH: process.env.PATH!, HOME: process.env.HOME! },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("SDK validation and failed exchange preserved");
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}, 15_000);
