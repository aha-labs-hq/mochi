import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateServiceState } from "../src/host/updateService.ts";
import {
  DesktopUpdates,
  type UpdateDependencies,
} from "../src/host/updates.ts";

const roots: string[] = [],
  updates: DesktopUpdates[] = [];
afterEach(async () => {
  for (const u of updates.splice(0)) u.stop();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const keys = generateKeyPairSync("ed25519"),
  bytes = Buffer.from("signed candidate content");
async function fixture(
  handler?: (request: RequestInit) => Response | Promise<Response>,
) {
  const cache = await mkdtemp(join(tmpdir(), "mochi-update-test-"));
  roots.push(cache);
  await writeFile(
    join(cache, "preferences.json"),
    JSON.stringify({ check: false, download: false, install: false }),
  );
  let withdrawn = false,
    feedStatus = 200,
    time = Date.now();
  const calls: string[] = [];
  let state: UpdateServiceState = { version: 1, phase: "idle" };
  let release = {
    schemaVersion: 1,
    product: "app.mochi.companion",
    version: "0.4.0",
    minimumUpdateVersion: "0.3.0",
    minimumMacOS: "14.0",
    architecture: "arm64",
    candidateSha256: "a".repeat(64),
    artifact: {
      path: `Mochi-0.4.0-arm64-${"a".repeat(16)}/Mochi.dmg`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    },
    notes: "改进更新体验。",
  };
  const fetcher = (async (
    url: string | URL | Request,
    request?: RequestInit,
  ) => {
    if (String(url).endsWith("stable.json")) {
      if (feedStatus !== 200) return new Response("", { status: feedStatus });
      const payload = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          issuedAt: new Date(time).toISOString(),
          withdrawn,
          release,
        }),
      );
      return new Response(
        JSON.stringify({
          payload: payload.toString("base64"),
          signature: sign(null, payload, keys.privateKey).toString("base64"),
        }),
      );
    }
    return handler ? handler(request!) : new Response(bytes);
  }) as typeof fetch;
  const dependencies: UpdateDependencies = {
    cache,
    version: "0.3.0",
    macOS: "14.0",
    fetch: fetcher,
    trust: {
      origin: "https://downloads.mochi.host/",
      feedPath: "updates/stable.json",
      publicKey: keys.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
      teamId: "9P89G9N875",
    },
    service: async (command) => {
      calls.push(command);
      return state;
    },
    close: async () => false,
    changed: () => {},
  };
  const u = new DesktopUpdates(dependencies);
  updates.push(u);
  await u.start();
  await u.check();
  return {
    u,
    cache,
    calls,
    dependencies,
    async reopen() {
      u.stop();
      const next = new DesktopUpdates(dependencies);
      updates.push(next);
      await next.start();
      return next;
    },
    publishNext() {
      time += 1000;
      release = {
        ...release,
        version: "0.5.0",
        candidateSha256: "b".repeat(64),
        artifact: {
          ...release.artifact,
          path: `Mochi-0.5.0-arm64-${"b".repeat(16)}/Mochi.dmg`,
        },
      };
    },
    clock: (next: number) => {
      time = next;
    },
    withdraw: () => {
      withdrawn = true;
      time += 1000;
    },
    feedStatus: (status: number) => {
      feedStatus = status;
    },
    state: (next: UpdateServiceState) => {
      state = next;
    },
  };
}
test("download verifies full bytes before installation and persists only user update preferences", async () => {
  const f = await fixture();
  expect(f.u.view.phase).toBe("available");
  await f.u.download();
  expect(f.u.view.phase).toBe("ready");
  expect(await readFile(join(f.cache, "Mochi.dmg"))).toEqual(bytes);
  expect(f.calls).not.toContain("install");
  f.state({ version: 1, phase: "preparing" });
  await f.u.install();
  expect(f.calls.filter((x) => x === "install")).toHaveLength(1);
  expect(f.u.view.phase).toBe("preparing");
});
test("a truncated transfer resumes the same signed candidate with an exact Range", async () => {
  let attempt = 0;
  const f = await fixture((request) => {
    attempt++;
    if (attempt === 1) return new Response(bytes.subarray(0, 8));
    expect((request.headers as Record<string, string>).Range).toBe("bytes=8-");
    return new Response(bytes.subarray(8), {
      status: 206,
      headers: {
        "Content-Range": `bytes 8-${bytes.length - 1}/${bytes.length}`,
      },
    });
  });
  await f.u.download();
  expect(f.u.view.phase).toBe("failed");
  await f.u.download();
  expect(f.u.view.phase).toBe("ready");
  expect(await readFile(join(f.cache, "Mochi.dmg"))).toEqual(bytes);
});
test("withdrawal between download and install leaves the current application running", async () => {
  const f = await fixture();
  await f.u.download();
  f.withdraw();
  await f.u.install();
  expect(f.calls).not.toContain("install");
  expect(f.u.view.phase).toBe("withdrawn");
});
test("an unpublished official feed means no update, while other feed failures stay failures", async () => {
  const f = await fixture();
  f.feedStatus(404);
  await f.u.check();
  expect(f.u.view).toMatchObject({
    phase: "current",
    error: null,
    target: null,
  });
  f.feedStatus(503);
  await f.u.check();
  expect(f.u.view).toMatchObject({ phase: "failed", error: "network" });
});
test("same-size altered bytes never reach the installer", async () => {
  const f = await fixture(() => new Response(Buffer.alloc(bytes.length)));
  await f.u.download();
  expect(f.u.view.phase).toBe("failed");
  expect(f.u.view.error).toBe("verification");
  await f.u.install();
  expect(f.calls).not.toContain("install");
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
test("a paused download stays paused after reopening even when background download is enabled", async () => {
  let transfers = 0;
  const f = await fixture((request) => {
    transfers++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 8));
          request.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      }),
    );
  });
  await f.u.preferences({ check: false, download: true, install: false });
  const transfer = f.u.download();
  await until(() => f.u.view.received === 8);
  f.u.pause();
  await transfer;
  // Flush the serial preference write before simulating the next process.
  await f.u.preferences({ check: false, download: true, install: false });
  const next = await f.reopen();
  await next.check();
  expect(next.view.phase).toBe("paused");
  expect(transfers).toBe(1);
  expect(await readFile(join(f.cache, "Mochi.part"))).toEqual(
    bytes.subarray(0, 8),
  );
});
test("a new candidate never appends to the previous candidate's partial download", async () => {
  let transfers = 0;
  const f = await fixture((request) => {
    transfers++;
    if (transfers === 1) return new Response(bytes.subarray(0, 8));
    expect((request.headers as Record<string, string>).Range).toBeUndefined();
    return new Response(bytes);
  });
  await f.u.download();
  f.publishNext();
  await f.u.check();
  await f.u.download();
  expect(f.u.view.phase).toBe("ready");
  expect(f.u.view.target).toBe("0.5.0");
  expect(await readFile(join(f.cache, "Mochi.dmg"))).toEqual(bytes);
});
test("installing a downloaded candidate rechecks and refuses a changed release", async () => {
  const f = await fixture();
  await f.u.download();
  f.publishNext();
  await f.u.install();
  expect(f.calls).not.toContain("install");
  expect(f.u.view.phase).toBe("available");
  expect(f.u.view.target).toBe("0.5.0");
  expect(f.u.view.received).toBe(0);
});
test("persisted feed identity rejects replay after the App restarts", async () => {
  const f = await fixture();
  f.clock(Date.now() + 1000);
  await f.u.check();
  const next = await f.reopen();
  f.clock(Date.now() - 1000);
  await next.check();
  expect(next.view.phase).toBe("failed");
  expect(next.view.error).toBe("verification");
});
test("concurrent settings changes persist one coherent last preference value", async () => {
  const f = await fixture();
  const first = f.u.preferences({
    check: false,
    download: true,
    install: false,
  });
  const second = f.u.preferences({
    check: false,
    download: false,
    install: true,
  });
  await Promise.all([first, second]);
  const next = await f.reopen();
  expect(next.view.preferences).toEqual({
    check: false,
    download: false,
    install: true,
  });
});
test("an unfinished native transaction is presented as recovery without discarding it for a newer feed", async () => {
  const f = await fixture();
  f.state({
    version: 1,
    phase: "failed",
    error: "recoveryRequired",
    candidateSha256: "a".repeat(64),
    targetVersion: "0.4.0",
  });
  const next = await f.reopen();
  expect(next.view.error).toBe("recovery");
  f.publishNext();
  f.state({ version: 1, phase: "preparing", candidateSha256: "a".repeat(64) });
  await next.retry();
  expect(f.calls.filter((command) => command === "install")).toHaveLength(1);
  expect(next.view.phase).toBe("preparing");
});

test("a repair's outcome belongs to its preparation, except an unfinished transaction", async () => {
  const f = await fixture();
  // Enable the startup check for the next launch only; this instance stays idle.
  await writeFile(
    join(f.cache, "preferences.json"),
    JSON.stringify({ check: true, download: false, install: false }),
  );
  // The preparation that ran the repair already reported this failure. It is
  // not an update result and must not hold back the startup check.
  f.state({
    version: 1,
    phase: "failed",
    mode: "repair",
    error: "healthFailed",
    targetVersion: "0.3.0",
  });
  const next = await f.reopen();
  await until(() => next.view.phase === "available");
  expect(next.view.error).toBeNull();
  f.state({
    version: 1,
    phase: "failed",
    mode: "repair",
    error: "recoveryRequired",
    targetVersion: "0.3.0",
  });
  const pending = await f.reopen();
  expect(pending.view).toMatchObject({ phase: "failed", error: "recovery" });
  f.dependencies.repair = async () =>
    f.state({
      version: 1,
      phase: "completed",
      mode: "repair",
      targetVersion: "0.3.0",
    });
  await pending.retry();
  expect(pending.view).toMatchObject({ phase: "idle", error: null });
});

test("a manual check cannot call the product current while an unfinished native transaction is unresolved", async () => {
  const f = await fixture();
  f.state({
    version: 1,
    phase: "failed",
    error: "recoveryRequired",
    candidateSha256: "a".repeat(64),
    targetVersion: "0.4.0",
  });
  const next = await f.reopen();
  expect(next.view.error).toBe("recovery");
  await next.check();
  expect(next.view.phase).toBe("failed");
  expect(next.view.error).toBe("recovery");
  expect(f.calls).not.toContain("install");
  // Once the helper reports the transaction resolved, checking works again.
  f.state({ version: 1, phase: "completed", targetVersion: "0.3.0" });
  await next.check();
  expect(next.view.error).toBeNull();
  expect(next.view.phase).toBe("available");
});

test("a status response from before install admission cannot strand the UI in preparing", async () => {
  const f = await fixture();
  await f.u.download();
  const accepted = Promise.withResolvers<UpdateServiceState>();
  const stale = Promise.withResolvers<UpdateServiceState>();
  let submitting = true;
  f.dependencies.service = async (command) => {
    if (command === "install") return accepted.promise;
    if (submitting) return stale.promise;
    return { version: 1, phase: "failed", error: "preparationFailed" };
  };
  const install = f.u.install();
  // The periodic status request may still describe the previous idle attempt.
  await Bun.sleep(1200);
  submitting = false;
  accepted.resolve({ version: 1, phase: "preparing" });
  await install;
  stale.resolve({ version: 1, phase: "idle" });
  await until(() => f.u.view.phase === "failed");
  expect(f.u.view.error).toBe("installation");
});

for (const previous of ["idle", "failed", "unavailable"] as const) {
  test(`an in-flight ${previous} result cannot replace a newly admitted update`, async () => {
    const f = await fixture();
    f.u.stop();
    const stale = Promise.withResolvers<UpdateServiceState>();
    let queried = false,
      admitted = false,
      closed = false;
    f.dependencies.service = async (command) => {
      if (command === "install") {
        admitted = true;
        return { version: 1, phase: "preparing" };
      }
      queried = true;
      return admitted ? { version: 1, phase: "closing" } : stale.promise;
    };
    f.dependencies.close = async () => {
      closed = true;
      return true;
    };
    const starting = f.u.start();
    await until(() => queried);
    await f.u.check();
    await f.u.download();
    await f.u.install();
    if (previous === "unavailable")
      stale.reject(Error("old transport failure"));
    else stale.resolve({ version: 1, phase: previous });
    await starting;
    expect(f.u.view.phase).toBe("preparing");
    expect(f.u.view.error).toBeNull();
    await until(() => closed);
    expect(f.u.view.phase).toBe("closing");
  });
}
