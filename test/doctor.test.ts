import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStatusProjection } from "../src/control/statusSnapshot.ts";
import { describePublishedRuntime, readPublishedBridgeStatus } from "../src/maintenance/doctor.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_BOT_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const POLICY = { model: "openai-codex/gpt-5.4", reasoningEffort: "high" as const };
const cleanup: (() => void)[] = [];

afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function liveFleet() {
  const directory = mkdtempSync(join(tmpdir(), "mochi-doctor-"));
  const product = {
    bridgeExecutablePath: join(directory, "bin/mochi-bridge"),
    statusSnapshotPath: join(directory, "status.json"),
  };
  const projection = new FleetStatusProjection(product.statusSnapshotPath);
  cleanup.push(() => { projection.stopping(); rmSync(directory, { recursive: true, force: true }); });
  projection.roster([BOT_ID, OTHER_BOT_ID].map((id) => ({ id, label: "Test", characterId: "mochi", enabled: true })));
  projection.accountChanged({
    status: "signedIn",
    account: { provider: "openai-codex", authType: "oauth", subscription: true },
    connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
  });
  projection.controlReady();
  for (const id of [BOT_ID, OTHER_BOT_ID]) {
    projection.bot(id).policy(POLICY);
    projection.bot(id).eventStreamReady();
  }
  const launch = `program = ${product.bridgeExecutablePath}\npid = ${process.pid}`;
  return { product, projection, launch };
}

describe("live doctor evidence", () => {
  test("reads the current Bridge's resumed Bot without changing its publication", () => {
    const f = liveFleet();
    const before = readFileSync(f.product.statusSnapshotPath, "utf8");
    const snapshot = readPublishedBridgeStatus(f.product, f.launch);
    expect(describePublishedRuntime(snapshot, BOT_ID, POLICY)).toContain(`Runtime ready for Bot ${BOT_ID}`);
    expect(readFileSync(f.product.statusSnapshotPath, "utf8")).toBe(before);
  });

  test("rejects a different LaunchAgent program or missing process identity", () => {
    const f = liveFleet();
    for (const launch of [
      `program = /another/mochi-bridge\npid = ${process.pid}`,
      `program = ${f.product.bridgeExecutablePath}`,
      `program = ${f.product.bridgeExecutablePath}\npid = 0`,
    ]) expect(() => readPublishedBridgeStatus(f.product, launch)).toThrow("status owner");
  });

  test("rejects status from an old process, expired status, and missing status", () => {
    const f = liveFleet();
    const snapshot = f.projection.snapshot();
    writeFileSync(f.product.statusSnapshotPath, JSON.stringify({ ...snapshot, processId: process.pid + 1 }));
    expect(() => readPublishedBridgeStatus(f.product, f.launch)).toThrow("wrong_process");
    writeFileSync(f.product.statusSnapshotPath, JSON.stringify({
      ...snapshot,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() - 45_000).toISOString(),
    }));
    expect(() => readPublishedBridgeStatus(f.product, f.launch)).toThrow("expired");
    unlinkSync(f.product.statusSnapshotPath);
    expect(() => readPublishedBridgeStatus(f.product, f.launch)).toThrow("missing");
  });

  test("does not accept a stopping or failed publisher", () => {
    const f = liveFleet();
    f.projection.failed("bridge_startup_failed");
    expect(() => readPublishedBridgeStatus(f.product, f.launch)).toThrow("Bridge is not ready");
    f.projection.stopping();
    expect(() => readPublishedBridgeStatus(f.product, f.launch)).toThrow("Bridge is not ready");
  });

  test("another healthy Bot does not prove the selected Bot is ready", () => {
    const f = liveFleet();
    const bot = f.projection.bot(BOT_ID);
    for (const change of [
      () => bot.starting(),
      () => bot.blocked("runtime_session_unavailable"),
      () => bot.eventStreamUnavailable(),
      () => bot.paused(),
    ]) {
      change();
      expect(() => describePublishedRuntime(f.projection.snapshot(), BOT_ID, POLICY)).toThrow("This Bot");
      expect(describePublishedRuntime(f.projection.snapshot(), OTHER_BOT_ID, POLICY)).toContain("Runtime ready");
    }
    expect(() => describePublishedRuntime(f.projection.snapshot(), "missing-bot", POLICY)).toThrow("This Bot");
  });

  test("an unavailable shared account cannot prove Runtime health", () => {
    const f = liveFleet();
    for (const status of ["unknown", "signedOut", "signingIn"] as const) {
      f.projection.accountChanged({ status });
      expect(() => describePublishedRuntime(f.projection.snapshot(), BOT_ID, POLICY)).toThrow("model connection");
    }
  });

  test("rejects a model or effort changed on disk but not adopted by the live Bot", () => {
    const f = liveFleet();
    for (const policy of [
      { ...POLICY, model: "another/model" },
      { ...POLICY, reasoningEffort: "low" as const },
    ]) expect(() => describePublishedRuntime(f.projection.snapshot(), BOT_ID, policy)).toThrow("model policy differs");
  });
});
