import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStableControlPlane } from "../src/control/readiness.ts";
import { FleetStatusProjection } from "../src/control/statusSnapshot.ts";
import { buildLaunchAgentPlist } from "../src/control/launchAgent.ts";
import { SERVICE_LABEL } from "../src/product/layout.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LaunchAgent service", () => {
  test("treats the explicit first-run setup lifecycle as a stable control plane", () => {
    // Readiness reads a published deployment, so the fixture publishes one.
    const directory = mkdtempSync(join(tmpdir(), "mochi-readiness-"));
    temporaryDirectories.push(directory);
    const projection = new FleetStatusProjection(join(directory, "status.json"));
    projection.roster([{ id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true }]);
    const bot = projection.bot(BOT_ID);
    const signedIn = { status: "signedIn", account: { provider: "openai-codex", authType: "oauth", subscription: true }, connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }] } as const;

    // A Bot that has published its setup stage is settled, whichever stage it holds.
    bot.starting();
    bot.setup("checking");
    projection.controlReady();
    expect(isStableControlPlane(projection.snapshot())).toBe(true);

    bot.setup("signIn");
    expect(isStableControlPlane(projection.snapshot())).toBe(true);

    // A Bot still starting is not settled, and neither is one holding work.
    bot.starting();
    expect(isStableControlPlane(projection.snapshot())).toBe(false);

    // Listening is settled only once its event stream is actually healthy.
    projection.accountChanged(signedIn);
    bot.eventStreamReady();
    expect(isStableControlPlane(projection.snapshot())).toBe(true);
    bot.eventStreamUnavailable();
    expect(isStableControlPlane(projection.snapshot())).toBe(false);

    // A disabled Bot is not a precondition for a settled deployment.
    bot.starting();
    projection.roster([{ id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: false }]);
    expect(isStableControlPlane(projection.snapshot())).toBe(true);

    // An unavailable control plane is never ready.
    projection.controlReady();
    projection.failed("bridge_startup_failed");
    expect(isStableControlPlane(projection.snapshot())).toBe(false);
    projection.stopping();
  });

  test("starts exactly one fixed entrypoint without embedding credentials", () => {
    const plist = buildLaunchAgentPlist({
      mode: "development",
      command: ["/Users/test/Studio & Space/bin/mochi-bridge"],
      workingDirectory: "/var/empty",
      immutableRoot: "/Users/test/Studio & Space",
      mutableRoot: "/Users/test/Studio & Space",
      dataDirectory: "/Users/test/Studio & Space/data",
      plistPath: `/Users/test/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
      structuredLogPath: "/Users/test/Library/Logs/Mochi/service.jsonl",
      statusPath: "/Users/test/Library/Application Support/Mochi/status.json",
    });
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<key>AssociatedBundleIdentifiers</key>\n  <string>app.mochi.companion.development</string>");
    expect(plist).toContain("/Users/test/Studio &amp; Space/bin/mochi-bridge");
    expect(plist).toContain("<string>/var/empty</string>");
    expect(plist).not.toContain("<string>run</string>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).toContain("<key>MOCHI_STRUCTURED_LOG_PATH</key>");
    expect(plist).toContain("/Users/test/Library/Logs/Mochi/service.jsonl");
    expect(plist.match(/<string>\/dev\/null<\/string>/g)).toHaveLength(2);
    expect(plist).not.toContain("GITHUB_APP");
    expect(plist).not.toContain("LARK_");
  });
});
