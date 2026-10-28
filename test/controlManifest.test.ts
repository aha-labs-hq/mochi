import { describe, expect, test } from "bun:test";
import {
  CONTROL_MANIFEST_SCHEMA_VERSION,
  mochiControlManifest,
} from "../src/control/manifest.ts";

describe("App-to-Bridge control manifest", () => {
  test("publishes one complete compatibility contract for each explicit service mode", () => {
    expect(mochiControlManifest("development", "0.2.0")).toEqual({
      schemaVersion: CONTROL_MANIFEST_SCHEMA_VERSION,
      productVersion: "0.2.0",
      serviceMode: "development",
      bridgeVersion: 1,
      statusVersion: 30,
      controlProtocolVersion: 28,
      controlSocketName: "control.sock",
      statusSnapshotName: "status.json",
      installedApplicationPath: "/Applications/Mochi.app",
      embeddedSetupPackagePath: "Contents/Resources/Mochi-Setup.pkg",
    });
    expect(mochiControlManifest("installed", "0.2.0").serviceMode).toBe("installed");
  });

  test("rejects a product version that cannot participate in compatibility checks", () => {
    expect(() => mochiControlManifest("installed", "latest"))
      .toThrow("semantic versioning");
  });
});
