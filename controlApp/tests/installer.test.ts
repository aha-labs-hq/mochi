import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MochiControlManifest,
  mochiControlManifest,
} from "../../src/control/manifest.ts";
import type { PackageTrust } from "../build/packageTrust.ts";
import { environmentFor } from "../src/host/contract.ts";
import {
  INSTALLER_SIGNATURE_CHECK,
  installerScript,
  PRIVILEGED_SETUP_SCRIPT,
  prepareProduct,
} from "../src/host/installer.ts";

const TEAM = "ABCDE12345";
const release: PackageTrust = { mode: "developer-id", teamId: TEAM };
const development: PackageTrust = { mode: "development" };
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

/** An installed-mode App whose fixed location is this fixture. */
function installedApp() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-setup-")));
  directories.push(directory);
  const application = join(directory, "Mochi.app");
  mkdirSync(join(application, "Contents/Resources"), { recursive: true });
  writeFileSync(
    join(application, "Contents/Resources/Mochi-Setup.pkg"),
    "fixture",
  );
  const manifest = {
    ...mochiControlManifest("installed", "0.2.0"),
    installedApplicationPath: application,
  } as unknown as MochiControlManifest;
  return { env: environmentFor(manifest, application, directory), directory };
}

function recorder(status = 0) {
  const calls: string[][] = [],
    scripts: string[] = [];
  return {
    calls,
    scripts,
    command: async (args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    },
    authorize: async (script: string) => {
      scripts.push(script);
      return status;
    },
  };
}

test("a release App requires its own Developer ID Team before root sees the package", async () => {
  const { env } = installedApp();
  const { calls, command, scripts, authorize } = recorder();
  expect(await prepareProduct(env, command, release, authorize)).toBe(
    "completed",
  );
  expect(calls[0]).toEqual([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    `-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM}"`,
    env.application,
  ]);
  expect(calls).toHaveLength(1);
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain(
    `" developer-id ${TEAM}" with administrator privileges`,
  );
});

test("development packages are an explicit trust mode, not a failed release check", async () => {
  const { env } = installedApp();
  const { calls, command, scripts, authorize } = recorder();
  expect(await prepareProduct(env, command, development, authorize)).toBe(
    "completed",
  );
  expect(calls[0]).toEqual([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    env.application,
  ]);
  expect(scripts[0]).toContain('" development" with administrator privileges');
  const failing = recorder();
  await expect(
    prepareProduct(
      env,
      async (args) => {
        failing.calls.push(args);
        return { code: 1, stdout: "", stderr: "invalid signature" };
      },
      release,
      failing.authorize,
    ),
  ).rejects.toThrow("component_contract_mismatch");
  expect(failing.calls).toHaveLength(1);
  expect(failing.scripts).toEqual([]);
});

test("an installed App built without package trust never reaches authorization", async () => {
  const { env } = installedApp();
  const { calls, command, scripts, authorize } = recorder();
  await expect(prepareProduct(env, command, null, authorize)).rejects.toThrow(
    "component_contract_unavailable",
  );
  expect(calls).toEqual([]);
  expect(scripts).toEqual([]);
});

test("native authorization preserves cancellation and fails closed on all other errors", async () => {
  const { env } = installedApp();
  const outcome = async (status: number) => {
    const { command, authorize } = recorder(status);
    return prepareProduct(env, command, release, authorize);
  };
  await expect(outcome(65)).rejects.toThrow("component_contract_mismatch");
  expect(await outcome(-128)).toBe("cancelled");
  for (const status of [1, -1, -1712])
    await expect(outcome(status)).rejects.toThrow("product_preparation_failed");
  await expect(
    prepareProduct(env, recorder().command, release),
  ).rejects.toThrow("component_contract_unavailable");
});

const signature = (status: string, leaf: string) => `Package "Mochi-Setup.pkg":
   Status: ${status}
   Notarization: trusted by the Apple notary service
   Signed with a trusted timestamp on: 2026-10-15 00:00:00 +0000
   Certificate Chain:
    1. ${leaf}
       Expires: 2031-10-15 00:00:00 +0000
       SHA256 Fingerprint:
           00 11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00 11 22 33 44 55
       ------------------------------------------------------------------------
    2. Developer ID Certification Authority
       Expires: 2031-10-15 00:00:00 +0000
       ------------------------------------------------------------------------
    3. Apple Root CA
`;
const distribution =
  "signed by a developer certificate issued by Apple for distribution";

test("root accepts only the expected Team's Developer ID Installer distribution signature", () => {
  const matches = (report: string, team = TEAM) =>
    Bun.spawnSync(
      [
        "/bin/bash",
        "-c",
        `${INSTALLER_SIGNATURE_CHECK}\nmochi_installer_signature_matches "$1"`,
        "check",
        team,
      ],
      { stdin: new Blob([report]) },
    ).exitCode === 0;
  expect(
    matches(
      signature(
        distribution,
        `Developer ID Installer: Mochi Example (${TEAM})`,
      ),
    ),
  ).toBe(true);
  expect(
    matches(
      signature(
        distribution,
        `Developer ID Installer: Mochi Example (${TEAM})`,
      ),
      "ZZZZZ99999",
    ),
  ).toBe(false);
  expect(
    matches(
      signature(distribution, `Developer ID Installer: Other (ZZZZZ99999)`),
    ),
  ).toBe(false);
  expect(
    matches(
      signature(
        distribution,
        `Developer ID Application: Mochi Example (${TEAM})`,
      ),
    ),
  ).toBe(false);
  expect(
    matches(
      signature(
        "signed by a certificate trusted by macOS",
        `Developer ID Installer: Mochi Example (${TEAM})`,
      ),
    ),
  ).toBe(false);
  expect(matches('Package "Mochi-Setup.pkg":\n   Status: no signature\n')).toBe(
    false,
  );
});

test.skipIf(process.platform !== "darwin")(
  "root proves its private copy before installing it",
  () => {
    const { directory } = installedApp();
    const unsigned = join(directory, "Mochi-Setup.pkg");
    writeFileSync(unsigned, "not a signed package");
    const setup = (...args: string[]) =>
      Bun.spawnSync(
        ["/bin/bash", "-c", PRIVILEGED_SETUP_SCRIPT, "mochi-setup", ...args],
        {
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        },
      );
    const mismatch = setup(unsigned, "developer-id", TEAM);
    expect(mismatch.exitCode).toBe(65);
    expect(mismatch.stderr.toString()).toContain(`team ${TEAM}`);
    for (const invalid of [
      [unsigned, "developer-id", "lowercase1"],
      [unsigned, "developer-id"],
      [unsigned, "development", TEAM],
      [unsigned, "release", TEAM],
    ])
      expect(setup(...invalid).exitCode).toBe(64);
  },
);

test.skipIf(process.platform !== "darwin")(
  "the authorization script is valid AppleScript for both trust modes",
  () => {
    const { directory } = installedApp();
    for (const trust of [release, development]) {
      const compiled = Bun.spawnSync([
        "/usr/bin/osacompile",
        "-o",
        join(directory, `${trust.mode}.scpt`),
        "-e",
        installerScript(
          '/Applications/Mochi.app/Contents/Resources/Mochi "Setup".pkg',
          trust,
        ),
      ]);
      expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
    }
    expect(() =>
      installerScript("/Applications/Mochi\n.pkg", development),
    ).toThrow();
  },
);
