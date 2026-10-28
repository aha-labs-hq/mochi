import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildLaunchAgentPlist } from "../src/control/launchAgent.ts";
import { mochiControlManifest } from "../src/control/manifest.ts";
import { FleetStatusProjection } from "../src/control/statusSnapshot.ts";
import { installationManifest } from "../src/product/installation.ts";
import { INSTALLED_PRODUCT_ROOT, resolveProductLayout } from "../src/product/layout.ts";
import {
  developerIdentityTeam,
  distributionXml,
  finderDiskImageLayoutScript,
  parseArguments,
  renderProductPostinstall,
  renderProductLifecycle,
  parseCodeSignature,
  parseReleaseNotes,
  verifyExpandedDistribution,
  verifyPackageInfo,
  verifyNotarizedAssessment,
  verifyDiskImageSigningProof,
  payloadEntries,
  copyProductResource,
} from "../script/build_product_package.ts";

function plistValue(source: string): unknown {
  const parsed = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"], { stdin: Buffer.from(source) });
  if (parsed.exitCode !== 0) throw new Error(parsed.stderr.toString());
  return JSON.parse(parsed.stdout.toString());
}

const appIdentity = "Developer ID Application: Mochi Example (ABC123DEF4)";
const installerIdentity = "Developer ID Installer: Mochi Example (ABC123DEF4)";

describe("product release contract", () => {
  test("private build resources and packages become readable only in their staged copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "mochi-resource-copy-"));
    const source = join(root, "private");
    const destination = join(root, "Resources");
    const previous = process.umask(0o077);
    try {
      await mkdir(join(source, "protocol"), { recursive: true });
      await writeFile(join(source, "Mochi-Setup.pkg"), "signed package bytes");
      await writeFile(join(source, "protocol", "instructions.md"), "protocol bytes");
      await copyProductResource(source, destination);
      for (const file of ["Mochi-Setup.pkg", "protocol/instructions.md"]) {
        expect((await stat(join(source, file))).mode & 0o777).toBe(0o600);
        expect((await stat(join(destination, file))).mode & 0o777).toBe(0o644);
        expect(await readFile(join(destination, file))).toEqual(await readFile(join(source, file)));
      }
      expect((await stat(source)).mode & 0o777).toBe(0o700);
      expect((await stat(join(destination, "protocol"))).mode & 0o777).toBe(0o755);
      await payloadEntries(destination);
      await symlink(join(source, "Mochi-Setup.pkg"), join(root, "linked-package"));
      await expect(copyProductResource(join(root, "linked-package"), join(destination, "link")))
        .rejects.toThrow("regular files or directories");
    } finally {
      process.umask(previous);
      await rm(root, { recursive: true, force: true });
    }
  });
  test("packaged resources are readable to recipient accounts and never writable by them", async () => {
    const root = await mkdtemp(join(tmpdir(), "mochi-payload-permissions-"));
    const directory = join(root, "Resources");
    const file = join(directory, "product.json");
    try {
      await mkdir(directory);
      await writeFile(file, "{}");
      await chmod(directory, 0o755);
      for (const mode of [0o444, 0o644, 0o755]) {
        await chmod(file, mode);
        expect(await payloadEntries(root)).toEqual(new Set(["Resources", "Resources/product.json"]));
      }
      for (const mode of [0o400, 0o600, 0o664, 0o666, 0o4755]) {
        await chmod(file, mode);
        await expect(payloadEntries(root)).rejects.toThrow("permissions are unsafe or inaccessible");
      }
      await chmod(file, 0o644);
      for (const mode of [0o700, 0o750, 0o775, 0o777]) {
        await chmod(directory, mode);
        await expect(payloadEntries(root)).rejects.toThrow("permissions are unsafe or inaccessible");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("Gatekeeper uses the structured notarization verdict, independently of optional origin text", () => {
    const assessment = (verdict: string, source: string) => `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>assessment:authority</key><dict><key>assessment:authority:source</key><string>${source}</string></dict>
      <key>assessment:remote</key><true/><key>assessment:verdict</key>${verdict}
      </dict></plist>`;
    expect(() => verifyNotarizedAssessment(assessment("<true/>", "Notarized Developer ID"))).not.toThrow();
    const dated = assessment("<true/>", "Notarized Developer ID").replace(
      "<key>assessment:remote</key>",
      "<key>assessment:notarization-date</key><date>2026-10-19T13:48:01Z</date><key>assessment:remote</key>",
    );
    expect(() => verifyNotarizedAssessment(dated)).not.toThrow();
    for (const invalid of [
      assessment("<false/>", "Notarized Developer ID"),
      assessment("<true/>", "Unnotarized Developer ID"),
      assessment("<true/>", "Mac App Store"),
      assessment("<string>true</string>", "Notarized Developer ID"),
      dated.replace("<key>assessment:verdict</key><true/>", "<key>assessment:verdict</key><false/>"),
      dated.replace("<key>assessment:verdict</key><true/>", ""),
      dated.replace("<string>Notarized Developer ID</string>", "<true/>"),
      "accepted source=Notarized Developer ID",
    ]) expect(() => verifyNotarizedAssessment(invalid)).toThrow();
  });
  test("installation readiness accepts the real empty-fleet host status, but rejects unavailable control and version drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mochi-install-status-"));
    const statusPath = join(directory, "status.json");
    const projection = new FleetStatusProjection(statusPath);
    try {
      projection.controlReady();
      projection.close();
      const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
      expect(snapshot.bots).toEqual([]);
      expect(snapshot).not.toHaveProperty("lifecycle");
      const source = await readFile(new URL("../installer/postinstall.sh", import.meta.url), "utf8");
      const start = source.indexOf("status_matches() {");
      const end = source.indexOf("\nrollback_on_error()", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const functions = source.slice(start, end);
      const invoke = (action: "status_matches" | "wait_for_status") => Bun.spawnSync([
        "/bin/bash", "-c", `${functions}\n${action} "$@"`, "installer-readiness-test",
        snapshot.productVersion, String(snapshot.bridgeVersion), String(snapshot.version), String(snapshot.controlProtocolVersion),
      ], { env: { STATUS: statusPath } });
      expect(invoke("wait_for_status").exitCode).toBe(0);
      for (const changed of [{ ...snapshot, controlAvailable: false }, { ...snapshot, version: snapshot.version + 1 }]) {
        await writeFile(statusPath, JSON.stringify(changed));
        expect(invoke("status_matches").exitCode).not.toBe(0);
      }
    } finally {
      projection.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("runtime-account verification accepts native dscl labels and still refuses unsafe values", async () => {
    const source = await readFile(new URL("../installer/postinstall.sh", import.meta.url), "utf8");
    const start = source.indexOf("for ATTRIBUTE_EXPECTED in ");
    const end = source.indexOf("\ndone", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const verification = source.slice(start, end + "\ndone".length).replaceAll("/usr/bin/dscl", "fixture_dscl");
    const fixture = `set -euo pipefail
RUNTIME_USER=_mochi
RUNTIME_HOME=/Users/_mochi
RUNTIME_GID=401
fixture_dscl() {
  case "$4" in
    NFSHomeDirectory) printf 'NFSHomeDirectory: %s\\n' "/Users/_mochi" ;;
    UserShell) printf 'UserShell: /usr/bin/false\\n' ;;
    PrimaryGroupID) printf 'PrimaryGroupID: 401\\n' ;;
    IsHidden) printf '%s\\n' "$HIDDEN_ATTRIBUTE" ;;
  esac
}
${verification}`;
    for (const [attribute, expectedCode] of [
      ["dsAttrTypeNative:IsHidden: 1", 0], ["IsHidden: 1", 0],
      ["dsAttrTypeNative:IsHidden: 0", 1], ["dsAttrTypeNative:IsHidden: 1 0", 1],
    ] as const) {
      const result = Bun.spawnSync(["/bin/bash", "-c", fixture], { env: { HIDDEN_ATTRIBUTE: attribute } });
      expect({ attribute, code: result.exitCode }).toEqual({ attribute, code: expectedCode });
    }
  });
  test("delete-all asks macOS to remove the service account before anything is removed; a refusal says why and removes nothing", async () => {
    const source = await readFile(new URL("../installer/uninstall.sh", import.meta.url), "utf8");
    const start = source.indexOf("remove_runtime_account() {");
    const end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const removal = source.slice(start, end + "\n}\n".length)
      .replaceAll("/usr/bin/dscl", "fixture_dscl").replaceAll("/usr/bin/id", "fixture_id");
    const gateStart = source.indexOf('if [[ "$UNINSTALL_POLICY" == deleteAll ]]; then');
    const gateEnd = source.indexOf('\n/bin/mkdir -p "$WORK_ROOT"', gateStart);
    const gate = source.slice(gateStart, gateEnd);
    const directory = await mkdtemp(join(tmpdir(), "mochi-account-removal-"));
    try {
      const run = async (dscl: string, present: boolean) => {
        const account = join(directory, "account");
        const calls = join(directory, "calls");
        await rm(account, { force: true });
        await rm(calls, { force: true });
        await rm(join(directory, "remaining"), { force: true });
        if (present) await writeFile(account, "");
        const result = Bun.spawnSync(["/bin/bash", "-c", `set -u
RUNTIME_USER=_mochi
UNINSTALL_POLICY=deleteAll
REMAINING_FILE="$WORK_ROOT/remaining"
fixture_id() { [[ -e "$ACCOUNT" ]]; }
fixture_dscl() { echo called >> "$CALLS"; ${dscl}; }
${removal}
${gate}`], { env: { ACCOUNT: account, CALLS: calls, WORK_ROOT: directory } });
        return {
          code: result.exitCode, stderr: result.stderr.toString(),
          remains: await Bun.file(account).exists(), asked: await Bun.file(calls).exists(),
        };
      };
      expect(await run('rm "$ACCOUNT"', true)).toMatchObject({ code: 0, remains: false, asked: true });
      expect(await run("true", false)).toMatchObject({ code: 0, asked: false });
      const refused = await run('echo "<dscl_cmd> DS Error: -14120 (eDSPermissionError)" >&2; exit 40', true);
      expect(refused).toMatchObject({ code: 1, remains: true });
      expect(await readFile(join(directory, "remaining"), "utf8")).toBe("runtime-account-permission: _mochi\n");
      expect((await stat(join(directory, "remaining"))).mode & 0o777).toBe(0o600);
      expect(refused.stderr).toContain("eDSPermissionError");
      expect(refused.stderr).toContain("Nothing has been removed");
      expect(refused.stderr).toContain("Reopen Mochi and retry uninstalling.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    // The request comes after the App has quit and an interrupted installation is restored, but before the
    // uninstall policy is bound or any component, root or directory is removed.
    const ask = source.indexOf("if ! remove_runtime_account; then");
    expect(ask).toBeGreaterThan(source.indexOf('mochi_stop_host_application "$INSTALLATION_MANIFEST"'));
    expect(ask).toBeGreaterThan(source.indexOf('mochi_recover_transaction "$INSTALLATION_MANIFEST"'));
    expect(ask).toBeLessThan(source.indexOf('mochi_atomic_text "$UNINSTALL_POLICY_FILE"'));
    expect(ask).toBeLessThan(source.indexOf('remove_path "$id" "$destination"'));
    // No later step deletes the user record, and no call discards what dscl says.
    expect(source.match(/dscl \. -delete "\/Users\//g)?.length).toBe(1);
    expect(source).not.toMatch(/dscl \. -delete "\/Users\/[^\n]*\/dev\/null/);
    expect(Bun.spawnSync(["/bin/bash", "-n", new URL("../installer/uninstall.sh", import.meta.url).pathname]).exitCode).toBe(0);
  });
  test("a keep-data uninstall leaves a record, not a live installation: reinstalling does not take the repair or in-app-update path", async () => {
    const source = await readFile(new URL("../installer/postinstall.sh", import.meta.url), "utf8");
    const start = source.indexOf("previous_installation_is_live() {");
    const end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const decision = source.slice(start, end + "\n}\n".length);
    const live = (installedFor: string, serviceLoaded: string) => Bun.spawnSync(
      ["/bin/bash", "-c", `${decision}\nprevious_installation_is_live`],
      { env: { INSTALLED_FOR: installedFor, SERVICE_WAS_LOADED: serviceLoaded } },
    ).exitCode === 0;
    // Keep-data removes the sudoers rule and the LaunchAgent: nothing names an account and nothing is loaded.
    expect(live("", "false")).toBe(false);
    // Any sign of a live installation keeps the repair and update handoffs: the rule, or a loaded service.
    expect(live("alice", "false")).toBe(true);
    expect(live("", "true")).toBe(true);
    expect(live("alice", "true")).toBe(true);
    // Both decisions that read the retained record consult it.
    expect(source).toMatch(/elif \[\[ -f "\$OLD_INSTALLATION_RECORD" \]\] && previous_installation_is_live; then\n\s+# A repair may restore an offline service/);
    expect(source).toMatch(/"\$installed_version" != "\$PRODUCT_VERSION" \]\] \\\n\s+&& previous_installation_is_live; then\n\s+echo 'Use Mochi’s in-app update/);
    expect(Bun.spawnSync(["/bin/bash", "-n", new URL("../installer/postinstall.sh", import.meta.url).pathname]).exitCode).toBe(0);
  });
  test("root's host verification pins the release Team, while ad-hoc packages remain explicit", async () => {
    const template = await readFile(new URL("../installer/lifecycle.sh", import.meta.url), "utf8");
    const release = renderProductLifecycle(template, "ABC123DEF4");
    expect(release).toContain('certificate leaf[subject.OU] = "ABC123DEF4"');
    expect(release).toContain('signature_arguments+=("-R=$host_requirement")');
    expect(renderProductLifecycle(template)).toContain("local host_requirement=''");
    expect(() => renderProductLifecycle(template, "invalid")).toThrow("Team");
    expect(() => renderProductLifecycle("missing")).toThrow("exactly one");
    expect(Bun.spawnSync(["/bin/bash", "-n"], { stdin: Buffer.from(release) }).exitCode).toBe(0);
  });
  test("repair after refused uninstall uses the installed App, never its retained retry copy", async () => {
    const source = await readFile(new URL("../installer/lifecycle.sh", import.meta.url), "utf8");
    const start = source.indexOf("mochi_application_source() {");
    const end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // Exercise the production selector with real request files. Only root
    // ownership is simulated, so the suite never needs elevated privileges.
    const selector = source.slice(start, end + 3).replaceAll("/usr/bin/stat", "fixture_stat");
    const root = await mkdtemp(join(tmpdir(), "mochi-repair-source-"));
    try {
      const update = join(root, "Update");
      await mkdir(update, { mode: 0o700 });
      await mkdir(join(update, "Mochi.app"));
      const request = join(update, "request.json");
      const run = () => Bun.spawnSync(["/bin/bash", "-c", `
        mochi_work_root() { printf '%s\\n' "$FIXTURE_ROOT"; }
        mochi_host_application_destination() { printf '%s\\n' /Applications/Mochi.app; }
        fixture_stat() { if [[ -d "$3" ]]; then printf root:700; else printf root:600; fi; }
        mochi_manifest_value() {
          if [[ "$1" == manifest ]]; then printf 0.3.0;
          else /usr/bin/plutil -extract "$2" raw -o - "$1"; fi
        }
        ${selector}
        mochi_application_source manifest
      `], { env: { ...process.env, FIXTURE_ROOT: root } });
      for (const mode of ["uninstall", "repair", undefined]) {
        await writeFile(request, JSON.stringify({ version: "0.3.0", mode }), { mode: 0o600 });
        const result = run();
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim()).toBe(mode === undefined
          ? join(update, "Mochi.app") : "/Applications/Mochi.app");
      }
      await writeFile(request, JSON.stringify({ version: "0.3.0", mode: "unknown" }));
      expect(run().exitCode).not.toBe(0);
      await writeFile(request, JSON.stringify({ version: "0.4.0", mode: "uninstall" }));
      expect(run().exitCode).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("the packaged installer writes exactly the LaunchAgent the App verifies", async () => {
    const template = await readFile(new URL("../installer/postinstall.sh", import.meta.url), "utf8");
    const rendered = renderProductPostinstall(template);
    expect(rendered).not.toContain("@MOCHI_BRIDGE_PROCESS_TYPE@");
    expect(() => renderProductPostinstall("no marker")).toThrow("exactly one");
    expect(() => renderProductPostinstall(`${template} @MOCHI_BRIDGE_PROCESS_TYPE@`)).toThrow("exactly one");

    // The App rejects any installed plist that differs from buildLaunchAgentPlist.
    const heredoc = /<<PLIST\n([\s\S]*?)\nPLIST\n/.exec(rendered)?.[1];
    expect(heredoc).toBeString();
    const layout = resolveProductLayout({
      homeDirectory: "/Users/test",
      environment: { MOCHI_PRODUCT_ROOT: INSTALLED_PRODUCT_ROOT },
    });
    const installed = Bun.spawnSync(["/bin/bash", "-c", `/bin/cat <<PLIST\n${heredoc}\nPLIST\n`], {
      env: {
        PRODUCT_ROOT: layout.immutableRoot,
        DATA_ROOT: layout.mutableRoot,
        LOG_ROOT: dirname(layout.structuredLogPath),
        HOST_BUNDLE_IDENTIFIER: installationManifest("0.2.0", mochiControlManifest("installed", "0.2.0"))
          .hostApplication.bundleIdentifier,
      },
    });
    expect(installed.exitCode).toBe(0);
    const expected = buildLaunchAgentPlist({
      mode: "installed",
      command: [layout.bridgeExecutablePath],
      workingDirectory: layout.workingDirectory,
      immutableRoot: layout.immutableRoot,
      mutableRoot: layout.mutableRoot,
      dataDirectory: layout.mutableRoot,
      plistPath: layout.launchAgentPath,
      structuredLogPath: layout.structuredLogPath,
      statusPath: layout.statusSnapshotPath,
    });
    expect(plistValue(installed.stdout.toString())).toEqual(plistValue(expected));
    expect(plistValue(expected)).toMatchObject({
      AssociatedBundleIdentifiers: "app.mochi.companion",
      ProcessType: "Interactive",
    });
  });
  test("targets the exact mounted volume when Finder writes the disk-image layout", () => {
    const source = finderDiskImageLayoutScript();
    expect(source).toContain("set volumeName to item 2 of argv");
    expect(source).toContain("set targetDisk to disk volumeName");
    expect(source).toContain('set position of item "Mochi.app" to {220, 275}');
    expect(source).toContain('set position of item "Applications" to {548, 275}');
    expect(source).toContain("set icon size of viewOptions to 128");
    expect(source).toContain('/.background/MochiDiskImageBackground.png');
    expect(source).toContain("set background picture of viewOptions to backgroundImage");
    expect(source).not.toContain("MochiBlueTexture.png");
    expect(source).not.toContain("set arrangement of viewOptions");
  });

  test("ships one canonical exact-canvas Finder background", async () => {
    const resourceDirectory = join(
      import.meta.dir,
      "..",
      "installer",
      "Resources",
    );
    const backgrounds = (await readdir(resourceDirectory))
      .filter((filename) => filename.startsWith("MochiDiskImageBackground"));
    expect(backgrounds).toEqual(["MochiDiskImageBackground.png"]);

    const png = await readFile(join(resourceDirectory, backgrounds[0]!));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1536);
    expect(png.readUInt32BE(20)).toBe(1024);
    expect(png[25]).toBe(2);
    const physicalPixelDimensions = png.indexOf(Buffer.from("pHYs"));
    expect(physicalPixelDimensions).toBeGreaterThan(0);
    expect(png.readUInt32BE(physicalPixelDimensions + 4)).toBe(5669);
    expect(png.readUInt32BE(physicalPixelDimensions + 8)).toBe(5669);
    expect(png[physicalPixelDimensions + 12]).toBe(1);
  });

  test("requires every explicit release authority and private-output input", () => {
    expect(() => parseArguments([
      "--lark-cli", "/private/lark-cli",
      "--github-registration", "/private/github-oauth.json",
      "--release",
    ])).toThrow("--app-identity, --installer-identity, --notary-profile, --notary-keychain, --release-notes, --release-output, --verification-result");

    expect(parseArguments([
      "--lark-cli", "/private/lark-cli",
      "--github-registration", "/private/github-oauth.json",
      "--release",
      "--app-identity", appIdentity,
      "--installer-identity", installerIdentity,
      "--notary-profile", "mochi-notary",
      "--notary-keychain", "/private/login.keychain-db",
      "--release-notes", "/private/release-notes.json",
      "--release-output", "/private/releases",
      "--verification-result", "/private/verification/result.json",
    ])).toEqual({
      larkCliPath: "/private/lark-cli",
      githubRegistrationPath: "/private/github-oauth.json",
      release: true,
      appIdentity,
      installerIdentity,
      notaryProfile: "mochi-notary",
      notaryKeychainPath: "/private/login.keychain-db",
      releaseNotesPath: "/private/release-notes.json",
      releaseOutputDirectory: "/private/releases",
      verificationResultPath: "/private/verification/result.json",
    });

    expect(parseArguments([
      "--lark-cli", "/private/lark-cli",
      "--github-registration", "/private/github-oauth.json",
    ])).toEqual({
      larkCliPath: "/private/lark-cli",
      githubRegistrationPath: "/private/github-oauth.json",
      release: false,
    });
  });

  test("does not infer release authority from partial or duplicate arguments", () => {
    expect(() => parseArguments([
      "--lark-cli", "/private/lark-cli",
      "--github-registration", "/private/github-oauth.json",
      "--notary-keychain", "/private/login.keychain-db",
    ])).toThrow("Release-only inputs require --release");
    expect(() => parseArguments([
      "--lark-cli", "/private/lark-cli",
      "--github-registration", "/private/github-oauth.json",
      "--release", "--notary-keychain", "login.keychain-db",
    ])).toThrow("--notary-keychain must be an absolute path");
    expect(() => parseArguments([
      "--lark-cli", "/private/lark-cli",
      "--github-registration", "/private/github-oauth.json",
      "--app-identity", appIdentity,
    ])).toThrow("Release-only inputs require --release");
    expect(() => parseArguments([
      "--lark-cli", "/private/one",
      "--lark-cli", "/private/two",
      "--lark-cli", "/private/lark-cli",
    ])).toThrow("Duplicate product packaging argument: --lark-cli");
    expect(() => parseArguments([
      "--lark-cli", "/private/lark-cli",
      "--appearance", "night",
    ])).toThrow("Unknown product packaging argument: --appearance");
  });

  test("accepts only explicit matching Developer ID certificate names", () => {
    expect(developerIdentityTeam(appIdentity, "Application")).toBe("ABC123DEF4");
    expect(developerIdentityTeam(installerIdentity, "Installer")).toBe("ABC123DEF4");
    expect(() => developerIdentityTeam("Mochi Example", "Application")).toThrow(
      "one explicit certificate name with team ID",
    );
  });

  test("keeps material limitations bounded, strict, and single-line", () => {
    expect(parseReleaseNotes({
      schemaVersion: 1,
      limitations: ["Clean-Mac acceptance remains pending."],
    })).toEqual({
      schemaVersion: 1,
      limitations: ["Clean-Mac acceptance remains pending."],
    });
    expect(() => parseReleaseNotes({ schemaVersion: 1, limitations: ["duplicate", "duplicate"] })).toThrow(
      "must not contain duplicates",
    );
    expect(() => parseReleaseNotes({ schemaVersion: 1, limitations: ["line one\nline two"] })).toThrow(
      "single-line string",
    );
    expect(() => parseReleaseNotes({ schemaVersion: 1, limitations: [], extra: true })).toThrow(
      "invalid shape",
    );
  });

  test("extracts the exact timestamped hardened Developer ID proof", () => {
    expect(parseCodeSignature(`Executable=/tmp/Mochi
Identifier=app.mochi.companion
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+7 location=embedded
Authority=${appIdentity}
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Sep 2, 2026 at 10:00:00
TeamIdentifier=ABC123DEF4
`)).toEqual({
      identifier: "app.mochi.companion",
      teamId: "ABC123DEF4",
      authorities: [appIdentity, "Developer ID Certification Authority", "Apple Root CA"],
      hardenedRuntime: true,
      timestamped: true,
    });
  });

  test("requires the outer disk image's own timestamped Developer ID signature", () => {
    const proof = `Identifier=app.mochi.companion.disk-image
CodeDirectory v=20200 size=400 flags=0x0(none) hashes=1+7 location=embedded
Authority=${appIdentity}
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Oct 19, 2026 at 12:00:00
TeamIdentifier=ABC123DEF4
`;
    // A container has no executable runtime; its signature must still pin its own identity.
    expect(() => verifyDiskImageSigningProof(proof, appIdentity)).not.toThrow();
    for (const invalid of [
      "code object is not signed at all",
      proof.replace("app.mochi.companion.disk-image", "app.mochi.companion"),
      proof.replace("TeamIdentifier=ABC123DEF4", "TeamIdentifier=OTHERTEAM1"),
      proof.replace(`Authority=${appIdentity}`, `Authority=${installerIdentity}`),
      proof.replace(`Authority=${appIdentity}`, "Authority=Developer ID Application: Other (ABC123DEF4)"),
      proof.replace("Timestamp=Oct 19, 2026 at 12:00:00", "Timestamp=none"),
      proof.replace("Timestamp=Oct 19, 2026 at 12:00:00", "Signed Time=Oct 19, 2026 at 12:00:00"),
    ]) {
      expect(() => verifyDiskImageSigningProof(invalid, appIdentity)).toThrow();
    }
  });

  test("verifies productbuild's normalized Distribution as the exact install contract", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "mochi-release-distribution-test-"));
    try {
      const payload = join(fixture, "payload");
      await mkdir(join(payload, "Library/Application Support/Mochi"), { recursive: true });
      await writeFile(join(payload, "Library/Application Support/Mochi/product"), "fixture");
      const component = join(fixture, "Mochi-component.pkg");
      const productVersion = (JSON.parse(
        await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
      ) as { version: string }).version;
      await run([
        "/usr/bin/pkgbuild",
        "--root", payload,
        "--identifier", "app.mochi.product",
        "--version", productVersion,
        component,
      ]);
      const distribution = join(fixture, "Distribution.xml");
      await writeFile(distribution, distributionXml());
      const product = join(fixture, "Mochi.pkg");
      await run([
        "/usr/bin/productbuild",
        "--distribution", distribution,
        "--package-path", fixture,
        product,
      ]);
      const expanded = join(fixture, "expanded");
      await run(["/usr/sbin/pkgutil", "--expand-full", product, expanded]);
      await verifyExpandedDistribution(join(expanded, "Distribution"));
      await verifyPackageInfo(join(expanded, "Mochi-component.pkg", "PackageInfo"), "app.mochi.product");
      expect((await readFile(join(expanded, "Distribution"), "utf8"))).toContain("#Mochi-component.pkg");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

async function run(command: readonly string[]): Promise<void> {
  const result = Bun.spawnSync({ cmd: [...command], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr.toString()}`);
  }
}
