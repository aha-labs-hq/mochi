import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DevelopmentDeployment } from "../src/product/developmentDeployment.ts";
import { resolveProductLayout } from "../src/product/layout.ts";
import { waitUntilStopped } from "../src/maintenance/service.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const BOT_ID = "11111111-2222-4333-8444-555555555555";

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mochi-development-test-")));
  roots.push(home);
  const layout = resolveProductLayout({ environment: {}, homeDirectory: home });
  // State is per Bot now, so the deployment fixture owns one Bot's own paths.
  const bot = layout.bot(BOT_ID);
  mkdirSync(layout.immutableRoot, { recursive: true, mode: 0o700 });
  mkdirSync(bot.stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(bot.configurationDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(layout.launchAgentPath), { recursive: true });
  writeFileSync(join(layout.immutableRoot, "code"), "old");
  writeFileSync(bot.stateDatabasePath, "same-session-state");
  writeFileSync(layout.launchAgentPath, "old-plist", { mode: 0o600 });
  const events: string[] = [];
  const service = {
    async stop() { events.push("stop"); },
    async start() { events.push("start"); writeFileSync(layout.launchAgentPath, "new-plist"); },
    async verify() { events.push("verify"); },
    async restore() { events.push("restore"); },
  };
  return { layout, bot, events, service, transaction: new DevelopmentDeployment(layout, service) };
}

describe("development runtime publication", () => {
  test("stages before stopping and changes code without touching persistent state", async () => {
    const f = fixture();
    f.transaction.begin();
    writeFileSync(join(f.transaction.stagedRuntime, "code"), "new");
    expect(f.events).toEqual([]);
    expect(readFileSync(join(f.layout.immutableRoot, "code"), "utf8")).toBe("old");
    await f.transaction.publish();
    expect(f.events).toEqual(["stop", "start"]);
    expect(readFileSync(join(f.layout.immutableRoot, "code"), "utf8")).toBe("new");
    expect(readFileSync(f.bot.stateDatabasePath, "utf8")).toBe("same-session-state");
    expect(existsSync(f.transaction.directory)).toBe(false);
  });

  test("failed activation retains a journal; explicit recovery restores code/plist, never stale state", async () => {
    const f = fixture();
    f.service.start = async () => {
      writeFileSync(f.bot.stateDatabasePath, "new-idempotency-record");
      writeFileSync(f.layout.launchAgentPath, "new-plist");
      throw new Error("not ready");
    };
    f.transaction.begin();
    writeFileSync(join(f.transaction.stagedRuntime, "code"), "new");
    await expect(f.transaction.publish()).rejects.toThrow("not ready");
    expect(() => f.transaction.begin()).toThrow("interrupted deployment");
    await new DevelopmentDeployment(f.layout, f.service).rollback();
    expect(readFileSync(join(f.layout.immutableRoot, "code"), "utf8")).toBe("old");
    expect(readFileSync(f.layout.launchAgentPath, "utf8")).toBe("old-plist");
    expect(readFileSync(f.bot.stateDatabasePath, "utf8")).toBe("new-idempotency-record");
    expect(f.events).toEqual(["stop", "stop", "restore"]);
  });

  test("accepts a timed-out publication only after the live service verifies ready", async () => {
    const f = fixture();
    f.service.start = async () => {
      f.events.push("start");
      writeFileSync(f.layout.launchAgentPath, "new-plist");
      throw new Error("not ready yet");
    };
    f.transaction.begin();
    writeFileSync(join(f.transaction.stagedRuntime, "code"), "new");
    await expect(f.transaction.publish()).rejects.toThrow("not ready yet");
    await new DevelopmentDeployment(f.layout, f.service).accept();
    expect(f.events).toEqual(["stop", "start", "verify"]);
    expect(readFileSync(join(f.layout.immutableRoot, "code"), "utf8")).toBe("new");
    expect(existsSync(f.transaction.directory)).toBe(false);
  });

  test("recovers an interruption between the two directory renames", async () => {
    const f = fixture();
    f.transaction.begin();
    f.service.stop = async () => { throw new Error("interrupted"); };
    await expect(f.transaction.publish()).rejects.toThrow("interrupted");
    renameSync(f.layout.immutableRoot, join(f.transaction.directory, "previous"));
    f.service.stop = async () => {};
    await new DevelopmentDeployment(f.layout, f.service).rollback();
    expect(readFileSync(join(f.layout.immutableRoot, "code"), "utf8")).toBe("old");
  });

  test("preparation failure does not stop the live service", async () => {
    const f = fixture();
    f.transaction.begin();
    await f.transaction.rollback();
    expect(f.events).toEqual([]);
    mkdirSync(f.transaction.directory, { mode: 0o700 });
    mkdirSync(f.transaction.stagedRuntime, { mode: 0o700 });
    await f.transaction.rollback();
    expect(f.events).toEqual([]);
  });
  test("invalid recovery metadata cannot stop a service or remove its runtime", async () => {
    const f = fixture();
    f.transaction.begin();
    writeFileSync(join(f.transaction.directory, "journal.json"), JSON.stringify({version: 1, phase: "publishing", hadRuntime: true, hadPlist: true, path: "/arbitrary"}));
    await expect(f.transaction.rollback()).rejects.toThrow("Invalid development deployment journal");
    expect(f.events).toEqual([]);
    expect(readFileSync(join(f.layout.immutableRoot, "code"), "utf8")).toBe("old");
  });
  test("a removed launch job is not stopped until its prior process exits", async () => {
    const child = Bun.spawn(["/bin/sleep", "0.4"], {stdout:"ignore", stderr:"ignore"});
    await waitUntilStopped(`gui/${process.getuid!()}/app.mochi.test-absent-${process.pid}`, child.pid);
    expect(await child.exited).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow();
  });
});
