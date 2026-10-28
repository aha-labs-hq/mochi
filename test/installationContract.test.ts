import { describe, expect, test } from "bun:test";
import { mochiControlManifest } from "../src/control/manifest.ts";
import { PI_RUNTIME_CWD, PI_RUNTIME_USER, PI_SUDO_PATH, PI_WORKER_PATH } from "../src/runtime/constants.ts";
import { buildRuntimeSudoersRule } from "../src/runtime/sudoers.ts";
import {
  INSTALLATION_CONTRACT_SCHEMA_VERSION,
  INSTALLATION_STATE_SCHEMA_VERSION,
  installationComponentSource,
  installationManifest,
  parseInstallationManifest,
} from "../src/product/installation.ts";

const control = mochiControlManifest("installed", "0.2.0");
const manifest = installationManifest("0.2.0", control);

describe("versioned installation authority", () => {
  test("classifies one transactional inventory and both removal policies", () => {
    expect(manifest.schemaVersion).toBe(INSTALLATION_CONTRACT_SCHEMA_VERSION);
    expect(manifest.compatibility).toEqual({
      schemaVersion: control.schemaVersion,
      bridgeVersion: control.bridgeVersion,
      statusVersion: control.statusVersion,
      controlProtocolVersion: control.controlProtocolVersion,
    });
    expect(manifest.installationState).toEqual({
      schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
      minimumReadableVersion: 0,
      migrations: [{ id: "adopt-pre-contract-installation", from: 0, to: 1 }],
    });
    expect(manifest.hostApplication).toEqual({
      id: "app",
      classification: "immutable",
      deliveredBy: "disk-image",
      destinationScope: "system",
      destination: "/Applications/Mochi.app",
      kind: "directory",
      bundleIdentifier: "app.mochi.companion",
      embeddedPackage: "Contents/Resources/Mochi-Setup.pkg",
      verification: "host-application",
      keepData: "remove",
      deleteAll: "remove",
    });
    expect(manifest.transactionalComponentCount).toBe(manifest.transactionalComponents.length);
    expect(manifest.retainedRootCount).toBe(manifest.retainedRoots.length);
    expect(manifest.externalArtifactCount).toBe(manifest.externalArtifacts.length);

    const components = new Map(manifest.transactionalComponents.map((entry) => [entry.id, entry]));
    expect(components.has("app")).toBeFalse();
    expect(components.get("runtime-sudoers")?.keepData).toBe("remove");
    expect(components.get("installation-record")?.keepData).toBe("retain");

    const roots = new Map(manifest.retainedRoots.map((entry) => [entry.id, entry]));
    expect(roots.get("user-data")).toMatchObject({ keepData: "retain", deleteAll: "remove" });
    expect(roots.get("runtime-home")).toMatchObject({ keepData: "retain", deleteAll: "remove" });
    expect(roots.get("shared-materials")).toMatchObject({ keepData: "retain", deleteAll: "remove" });
    expect(roots.get("user-data")?.cleanup).toEqual(["status.json", "control.sock", "bot.lock"]);

    const external = new Map(manifest.externalArtifacts.map((entry) => [entry.id, entry]));
    expect(external.get("runtime-account")).toMatchObject({ keepData: "retain", deleteAll: "remove" });
    expect([...external.keys()]).toEqual(["runtime-account"]);
    expect([...components.keys()]).not.toContain("deployment-environment");
    expect([...components.keys()]).not.toContain("github-private-key");
    expect(manifest).not.toHaveProperty("packageInputs");
  });

  test("has unique safe sources and destinations derived from the staging root", () => {
    const ids = manifest.transactionalComponents.map((entry) => entry.id);
    const sources = manifest.transactionalComponents.map((entry) =>
      installationComponentSource(manifest, entry)
    );
    const destinations = manifest.transactionalComponents.map((entry) =>
      `${entry.destinationScope}:${entry.destination}`
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(sources).size).toBe(sources.length);
    expect(new Set(destinations).size).toBe(destinations.length);
    expect(sources.every((path) => path.startsWith(`${manifest.payloadRoot}/`))).toBeTrue();
    expect([manifest.payloadRoot, manifest.transactionRoot]).toEqual([
      `${manifest.workRoot}/Payload`,
      `${manifest.workRoot}/Transaction`,
    ]);
    expect(sources.some((path) => path === "/Applications/Mochi.app")).toBeFalse();
  });

  test("carries the one runtime sudoers policy for the installer to fill", () => {
    const config = { sudoPath: PI_SUDO_PATH, runtimeUser: PI_RUNTIME_USER, workerPath: PI_WORKER_PATH, runtimeCwd: PI_RUNTIME_CWD };
    const digest = "b".repeat(64);
    const filled = manifest.runtimeSudoers.rule
      .replace("{bridgeUser}", "bridge-user")
      .replace("{workerSha256}", digest);
    expect(`${filled}\n`).toBe(buildRuntimeSudoersRule("bridge-user", config, digest));
    const accountPattern = new RegExp(manifest.runtimeSudoers.bridgeUserPattern);
    expect(["bridge-user", "first.last", "Bridge"].every((name) => accountPattern.test(name))).toBeTrue();
    expect(["Bridge User", "BRIDGE"].some((name) => accountPattern.test(name))).toBeFalse();
    expect(manifest.transactionalComponents.find((entry) => entry.id === "runtime-worker")?.destination)
      .toBe(PI_WORKER_PATH);
  });

  test("rejects drift instead of accepting an adjacent manifest shape", () => {
    expect(parseInstallationManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    const drifted = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    const hostApplication = drifted.hostApplication as Record<string, unknown>;
    hostApplication.destination = "/tmp/Mochi.app";
    expect(() => parseInstallationManifest(drifted)).toThrow(
      "does not match the versioned Mochi authority",
    );
  });
});
