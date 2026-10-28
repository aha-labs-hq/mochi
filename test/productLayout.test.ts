import { describe, expect, test } from "bun:test";
import {
  INSTALLED_PRODUCT_ROOT,
  isBotId,
  resolveProductLayout,
  userLayout,
} from "../src/product/layout.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";

describe("installed product layout", () => {
  test("keeps immutable code separate from one user-owned mutable root", () => {
    const layout = resolveProductLayout({
      environment: { MOCHI_PRODUCT_ROOT: INSTALLED_PRODUCT_ROOT },
      homeDirectory: "/Users/test",
    });
    expect(layout).toMatchObject({
      mode: "installed",
      immutableRoot: "/Library/Application Support/Mochi",
      mutableRoot: "/Users/test/Library/Application Support/Mochi",
      bridgeExecutablePath: "/Library/Application Support/Mochi/bin/mochi-bridge",
      larkCliPath: "/Library/Application Support/Mochi/bin/lark-cli",
      workingDirectory: "/var/empty",
    });
    // Every Bot-owned path derives from the roster directory, never from the root.
    expect(layout.bot(BOT_ID)).toMatchObject({
      botId: BOT_ID,
      configurationDirectory: `/Users/test/Library/Application Support/Mochi/Bots/${BOT_ID}/Configuration`,
      botConfigPath: `/Users/test/Library/Application Support/Mochi/Bots/${BOT_ID}/Configuration/bot.toml`,
      stateDirectory: `/Users/test/Library/Application Support/Mochi/Bots/${BOT_ID}/State`,
      stateDatabasePath: `/Users/test/Library/Application Support/Mochi/Bots/${BOT_ID}/State/bot.sqlite`,
      stateLockPath: `/Users/test/Library/Application Support/Mochi/Bots/${BOT_ID}/State/bot.lock`,
      feishuConnectionDirectory: `/Users/test/Library/Application Support/Mochi/Bots/${BOT_ID}/Connections/feishu`,
      materialStagingRoot: `/Users/test/Library/Application Support/Mochi/Bots/${BOT_ID}/State/materialStaging`,
    });
    expect(layout.botsDirectory).toBe("/Users/test/Library/Application Support/Mochi/Bots");
    expect(layout.fleetRecordPath).toBe("/Users/test/Library/Application Support/Mochi/fleet.json");
    expect(JSON.stringify(layout)).not.toContain("checkout/must-not-be-used");
  });

  test("admits a Bot identity only as a lowercase UUID", () => {
    const layout = resolveProductLayout({ environment: {}, homeDirectory: "/Users/test" });
    expect(isBotId(BOT_ID)).toBe(true);
    for (const invalid of ["Engineering", "", "../escape", "ABCDEF01-2222-4333-8444-555555555555"]) {
      expect(isBotId(invalid)).toBe(false);
      expect(() => layout.bot(invalid)).toThrow("lowercase UUID");
    }
  });

  test("rejects redirectable installed roots", () => {
    expect(() => resolveProductLayout({
      environment: { MOCHI_PRODUCT_ROOT: "/tmp/other" },
      homeDirectory: "/Users/test",
    })).toThrow("must be /Library/Application Support/Mochi");
    expect(() => resolveProductLayout({
      environment: {
        MOCHI_PRODUCT_ROOT: INSTALLED_PRODUCT_ROOT,
        MOCHI_DATA_ROOT: "/tmp/data",
      },
      homeDirectory: "/Users/test",
    })).toThrow("MOCHI_DATA_ROOT");
  });
});

describe("development deployment layout", () => {
  test("does not depend on the checkout, interpreter, or current working directory", () => {
    const layout = resolveProductLayout({ environment: {}, homeDirectory: "/Users/test" });
    expect(layout).toMatchObject({
      mode: "development",
      immutableRoot: "/Users/test/Library/Application Support/Mochi/Development/Runtime",
      mutableRoot: "/Users/test/Library/Application Support/Mochi/Development",
      workingDirectory: "/var/empty",
      bridgeExecutablePath: "/Users/test/Library/Application Support/Mochi/Development/Runtime/bin/mochi-bridge",
    });
    expect(layout.bot(BOT_ID).stateDatabasePath)
      .toBe(`/Users/test/Library/Application Support/Mochi/Development/Bots/${BOT_ID}/State/bot.sqlite`);
    expect(JSON.stringify(layout)).not.toContain("Documents");
    expect(() => resolveProductLayout({ environment: { MOCHI_DATA_ROOT: "/tmp/state" } })).toThrow("cannot redirect");
  });
});

describe("console user paths", () => {
  test("are the same in both modes, so the App and either Bridge meet at one place", () => {
    const user = userLayout("/Users/test");
    expect(user).toEqual({
      dataDirectory: "/Users/test/Library/Application Support/Mochi",
      deploymentLockPath: "/Users/test/Library/Application Support/Mochi/bot.lock",
      statusSnapshotPath: "/Users/test/Library/Application Support/Mochi/status.json",
      controlSocketPath: "/Users/test/Library/Application Support/Mochi/control.sock",
      launchAgentPath: "/Users/test/Library/LaunchAgents/app.mochi.bridge.plist",
      logDirectory: "/Users/test/Library/Logs/Mochi",
      structuredLogPath: "/Users/test/Library/Logs/Mochi/service.jsonl",
      companionLogPath: "/Users/test/Library/Logs/Mochi/companion.jsonl",
    });
    for (const environment of [{}, { MOCHI_PRODUCT_ROOT: INSTALLED_PRODUCT_ROOT }]) {
      expect(resolveProductLayout({ environment, homeDirectory: "/Users/test" })).toMatchObject(user);
    }
    expect(() => userLayout("relative/home")).toThrow("absolute");
  });
});
