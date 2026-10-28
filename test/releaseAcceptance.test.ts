import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createReleaseCandidateManifest,
  createReleaseAcceptanceTemplate,
  RELEASE_ACCEPTANCE_SCENARIOS,
  verifyReleaseAcceptance,
} from "../script/release_acceptance.ts";

const artifactFiles = [
  ["applicationDiskImage", "Mochi.dmg"],
  ["privilegedPackage", "Mochi.pkg"],
] as const;

describe("exact release acceptance", () => {
  test("rejects the retired acceptance schema and keeps missing current-product observations blocked", async () => {
    const fixture = createFixture();
    try {
      const recordPath = join(fixture.directory, "Mochi-Acceptance-clean-arm.json");
      await createReleaseAcceptanceTemplate({ candidateManifestPath: fixture.manifestPath, outputPath: recordPath,
        targetId: "clean-arm", macOSVersion: "14.7.8" });
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      expect(record.schemaVersion).toBe(8);
      const scenarios = record.scenarios.map((item: { id: string }) => item.id);
      for (const scenario of ["schedules", "independent-bots", "installed-permissions", "release-signature-runtime",
        "fake-ip-proxy", "login-items", "multi-user-mac", "in-app-update"]) expect(scenarios).toContain(scenario);
      for (const checkpoint of record.scenarios.flatMap((item: { checkpoints: unknown[] }) => item.checkpoints))
        expect(checkpoint).toMatchObject({ result: "blocked", evidence: [] });
      const permissions = record.scenarios.find((item: { id: string }) => item.id === "installed-permissions");
      expect(permissions.checkpoints.map((item: { id: string }) => item.id)).toEqual([
        "installed-paths-match-declared-owner-and-mode",
        "system-ancestors-deny-unprivileged-replacement",
        "material-acls-match-exact-runtime-access",
        "sudo-rules-limited-to-pinned-worker",
      ]);
      record.schemaVersion = 6;
      writeFileSync(recordPath, JSON.stringify(record));
      await expect(verifyReleaseAcceptance({ candidateManifestPath: fixture.manifestPath, acceptanceRecordPath: recordPath }))
        .rejects.toThrow("finite schema 8 suite");
    } finally { fixture.dispose(); }
  });

  test("creates the exact candidate manifest from immutable package bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-release-candidate-"));
    try {
      const expectedArtifacts = artifactFiles.map(([role, filename], index) => {
        const source = `candidate-package-${index}\n`;
        writeFileSync(join(directory, filename), source, { mode: 0o600 });
        return {
          role,
          filename,
          sha256: hash(source),
          sizeBytes: Buffer.byteLength(source),
        };
      });
      const result = await createReleaseCandidateManifest({
        candidateDirectory: directory,
        sourceRevision: "c".repeat(40),
        productVersion: "0.2.0",
        architecture: "arm64",
        minimumMacOS: "14.0",
        limitations: ["The Mac must be running for scheduled work"],
      });
      expect(result.manifestPath).toBe(join(directory, "Mochi-Release.json"));
      expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8"))).toEqual({
        schemaVersion: 4,
        sourceRevision: "c".repeat(40),
        productVersion: "0.2.0",
        architecture: "arm64",
        minimumMacOS: "14.0",
        limitations: ["The Mac must be running for scheduled work"],
        artifacts: expectedArtifacts,
      });
      await expect(createReleaseCandidateManifest({
        candidateDirectory: directory,
        sourceRevision: "c".repeat(40),
        productVersion: "0.2.0",
        architecture: "arm64",
        minimumMacOS: "14.0",
        limitations: [],
      })).rejects.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds every passing clean-Mac checkpoint to exact candidate and evidence bytes", async () => {
    const fixture = createFixture();
    try {
      const recordPath = join(fixture.directory, "Mochi-Acceptance-clean-arm.json");
      await createReleaseAcceptanceTemplate({
        candidateManifestPath: fixture.manifestPath,
        outputPath: recordPath,
        targetId: "clean-arm",
        macOSVersion: "15.6.1",
      });
      const evidencePath = join(fixture.directory, "evidence.txt");
      const evidence = "redacted clean-Mac observation\n";
      writeFileSync(evidencePath, evidence, { mode: 0o600 });
      const reference = {
        kind: "operatorRecord",
        path: "evidence.txt",
        sha256: hash(evidence),
        sizeBytes: Buffer.byteLength(evidence),
      };
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
        target: { baseline: Record<string, boolean>; evidence: unknown[] };
        scenarios: Array<{ checkpoints: Array<{ result: string; evidence: unknown[] }> }>;
      };
      for (const fact of Object.keys(record.target.baseline)) record.target.baseline[fact] = true;
      record.target.evidence = [reference];
      for (const scenario of record.scenarios) {
        for (const checkpoint of scenario.checkpoints) {
          checkpoint.result = "pass";
          checkpoint.evidence = [reference];
        }
      }
      writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

      const report = await verifyReleaseAcceptance({
        candidateManifestPath: fixture.manifestPath,
        acceptanceRecordPath: recordPath,
      });
      const checkpointCount = RELEASE_ACCEPTANCE_SCENARIOS.reduce(
        (total, scenario) => total + scenario.checkpoints.length,
        0,
      );
      expect(report).toMatchObject({
        accepted: true,
        sourceRevision: "a".repeat(40),
        productVersion: "0.2.0",
        architecture: "arm64",
        targetId: "clean-arm",
        artifactCount: 2,
        schemaVersion: 8,
        scenarioCount: RELEASE_ACCEPTANCE_SCENARIOS.length,
        passedScenarioCount: RELEASE_ACCEPTANCE_SCENARIOS.length,
        checkpointCount,
        passedCheckpointCount: checkpointCount,
        failures: [],
      });
      expect(report.candidateManifestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(report.acceptanceRecordSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fixture.dispose();
    }
  });

  test("creates one finite incomplete suite without inventing live proof", async () => {
    const fixture = createFixture();
    try {
      const recordPath = join(fixture.directory, "Mochi-Acceptance-clean-arm.json");
      await createReleaseAcceptanceTemplate({
        candidateManifestPath: fixture.manifestPath,
        outputPath: recordPath,
        targetId: "clean-arm",
        macOSVersion: "14.0",
      });
      const report = await verifyReleaseAcceptance({
        candidateManifestPath: fixture.manifestPath,
        acceptanceRecordPath: recordPath,
      });
      expect(report.accepted).toBeFalse();
      expect(report.passedScenarioCount).toBe(0);
      expect(report.passedCheckpointCount).toBe(0);
      expect(report.failures).toContain("target baseline has no evidence");
      expect(report.failures).toContain("fresh-install/clean-supported-target is blocked");
    } finally {
      fixture.dispose();
    }
  });

  test("rejects changed package bytes instead of accepting a matching filename", async () => {
    const fixture = createFixture();
    try {
      writeFileSync(join(fixture.directory, "Mochi.pkg"), "package-X\n");
      await expect(createReleaseAcceptanceTemplate({
        candidateManifestPath: fixture.manifestPath,
        outputPath: join(fixture.directory, "Mochi-Acceptance-clean-arm.json"),
        targetId: "clean-arm",
        macOSVersion: "14.0",
      })).rejects.toThrow("SHA-256 does not match the record");
    } finally {
      fixture.dispose();
    }
  });

  test("rejects scenario drift and evidence that escapes the private record directory", async () => {
    const fixture = createFixture();
    try {
      const recordPath = join(fixture.directory, "Mochi-Acceptance-clean-arm.json");
      await createReleaseAcceptanceTemplate({
        candidateManifestPath: fixture.manifestPath,
        outputPath: recordPath,
        targetId: "clean-arm",
        macOSVersion: "14.0",
      });
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
        target: { evidence: unknown[] };
        scenarios: unknown[];
      };
      record.scenarios.pop();
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await expect(verifyReleaseAcceptance({
        candidateManifestPath: fixture.manifestPath,
        acceptanceRecordPath: recordPath,
      })).rejects.toThrow("finite schema 8 suite");

      await createReleaseAcceptanceTemplate({
        candidateManifestPath: fixture.manifestPath,
        outputPath: join(fixture.directory, "second.json"),
        targetId: "clean-arm",
        macOSVersion: "14.0",
      });
      const second = JSON.parse(readFileSync(join(fixture.directory, "second.json"), "utf8")) as {
        target: { evidence: unknown[] };
      };
      second.target.evidence = [{
        kind: "operatorRecord",
        path: "../outside.txt",
        sha256: "b".repeat(64),
        sizeBytes: 1,
      }];
      writeFileSync(join(fixture.directory, "second.json"), `${JSON.stringify(second)}\n`, { mode: 0o600 });
      await expect(verifyReleaseAcceptance({
        candidateManifestPath: fixture.manifestPath,
        acceptanceRecordPath: join(fixture.directory, "second.json"),
      })).rejects.toThrow("normalized relative file path");
    } finally {
      fixture.dispose();
    }
  });
});

function createFixture(): {
  directory: string;
  manifestPath: string;
  dispose(): void;
} {
  const directory = mkdtempSync(join(tmpdir(), "mochi-release-acceptance-"));
  const artifacts = artifactFiles.map(([role, filename], index) => {
    const source = `package-${index}\n`;
    writeFileSync(join(directory, filename), source);
    return {
      role,
      filename,
      sha256: hash(source),
      sizeBytes: Buffer.byteLength(source),
    };
  });
  const manifestPath = join(directory, "Mochi-Release.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 4,
    sourceRevision: "a".repeat(40),
    productVersion: "0.2.0",
    architecture: "arm64",
    minimumMacOS: "14.0",
    limitations: ["The Mac must be running for scheduled work"],
    artifacts,
  }, null, 2)}\n`);
  return {
    directory,
    manifestPath,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
