# Release production

**Unreleased ToC candidate path.** Customer-free assembly and connected development deployment are implemented. New-organization approval, installed-release and clean-Mac acceptance remain distinct evidence. This procedure keeps the candidate private until acceptance; it does not restrict the accepted product to private recipients. The source repository remains private. See [public release preparation](public-release.md) and [implementation boundaries](onboarding.md#implementation-boundary).

`script/build_product_package.ts` is the only release producer. A successful run publishes one coherent candidate set; it does not install Mochi, create customer grants, run clean-Mac acceptance, or create a GitHub Release. Where a candidate sits on the way to the first public release is the [critical path](public-release.md#critical-path-to-the-first-public-release).

## Inputs

Release mode fails before assembly unless all of these are explicit:

- one clean source revision;
- an explicit absolute `--verification-result` path to a completed passing `bun run verify` receipt and its unchanged sibling `verification.log`; source tree, build architecture, macOS platform, pinned Bun version and log digest must match before assembly;
- the pinned official native `lark-cli` (`OFFICIAL_LARK_CLI` in `src/product/larkBinary.ts`: version, Lark Team and the arm64 executable's SHA-256), from its original package `bin/lark-cli` with the sibling package `LICENSE`; any other bytes, version or architecture fail before assembly;
- a mode-600 native GitHub OAuth registration source (`--github-registration`), strictly validated and staged as read-only `Resources/github-oauth.json` by the same producer; no user grant or issuer RSA key belongs in this resource;
- the complete `Developer ID Application: Name (TEAMID)` and `Developer ID Installer: Name (TEAMID)` certificate names for the Team recorded as `developerIdTeamId` in [`release/distribution.json`](../release/distribution.json). That Team is `null` until the issuer's Apple Developer membership is active, and release packaging refuses to start while it is;
- one named `notarytool` profile and an explicit absolute `--notary-keychain` file path, used for both credential preflight and submission;
- a schema-1 release-notes JSON containing only reviewed, single-line material limitations and no credentials;
- an existing repository-external output directory with no group or world access.
- a logged-in graphical macOS release-engineering session with Finder available, which the producer checks before expensive assembly because Finder writes the deterministic disk-image presentation metadata.

The packager bakes the package trust into the App it builds: `developer-id:<Team>` for a release, `development` for an ad-hoc package. In-product setup then requires the App to satisfy Apple's Developer ID Application requirement for that Team (`codesign -R`), and the privileged step copies the embedded package into a root-owned 0700 directory and installs that copy only after `pkgutil --check-signature` reports a distribution signature whose leaf is the same Team's Developer ID Installer. The packaged lifecycle also rechecks the host App under root with the identical Team requirement, rendered by the same requirement function; a valid signature from another publisher is insufficient. A development App has no Team to check; it is an explicit mode, never the result of a failed release check. An App built without the packager cannot prepare an installed product.

The desktop build downloads its toolchain through Electrobun's Hutch; `controlApp/build/toolchain.ts` pins the Hutch archive digest and Hutch's recorded Electrobun core, Cottontail and Bun toolchain, and selects that exact Hutch so a failed download never falls back to a machine-wide one. The App, Bridge and worker all run the repository's pinned Bun (`package.json#packageManager`). Changing Electrobun means updating those pins in the same change.

The script never searches for or selects a signing identity. An explicit certificate name still resolves through Apple's signing tools and the issuer's keychain, but the resulting App, Bridge, worker, component package, and final packages are checked back against the exact requested identities. Before assembly, a live `notarytool history` request proves the named profile is usable in the selected file-backed Keychain, with a 60-second deadline. Store it using `notarytool store-credentials PROFILE --keychain /absolute/path/login.keychain-db --apple-id APPLE_ID --team-id TEAM_ID` and enter the App-specific password at Apple's hidden prompt. The producer never relies on ambient data-protection Keychain lookup or exports credentials. Successful authentication is separate from an Accepted notarization of the exact artifact.

Start from [`release/notes.example.json`](../release/notes.example.json), review the limitations for this exact candidate, and keep that input committed or otherwise attributable. Do not put a customer credential, token, certificate key, notary credential, email, or other secret in it.

## Produce one candidate

The producer sets its build umask to `022`, independently of the operator's shell. Its temporary and candidate roots remain private, and it explicitly protects final artifacts. Copied resources and the App's embedded package receive mode `0644` (directories `0755`) without changing their private inputs. Packaged directories must be searchable and resources readable by every recipient account; group/world writes and special permission bits are rejected before package signing and again after package expansion. A private build shell or a reused build file must not silently produce root-only runtime resources.

```bash
install -d -m 700 /absolute/private/mochi-releases
bun run product:package -- \
  --github-registration /absolute/private/github-oauth.json \
  --lark-cli /absolute/path/to/native/lark-cli \
  --release \
  --app-identity 'Developer ID Application: Exact Name (TEAMID1234)' \
  --installer-identity 'Developer ID Installer: Exact Name (TEAMID1234)' \
  --notary-profile mochi-notary \
  --notary-keychain /absolute/path/login.keychain-db \
  --release-notes "$PWD/release/notes.example.json" \
  --verification-result /absolute/git-common/mochi-verification/commit/run/result.json \
  --release-output /absolute/private/mochi-releases
```

Run the command once per supported architecture. The disk image always carries the one reviewed installation artwork; there is no appearance selector or parallel visual candidate. The output directory has one process lock and refuses a second build while an unfinished production run exists. On success it atomically renames its private staging directory to:

```text
Mochi-<product version>-<architecture>-<manifest SHA-256 prefix>/
  Mochi.dmg
  Mochi.pkg
  Mochi-Release.json
```

The directory suffix is the `Mochi-Release.json` digest prefix, so a later build cannot overwrite an earlier candidate. The builder calls the merged `script/release_acceptance.ts` writer directly; it does not define or validate a second candidate schema. [`release-acceptance.md`](release-acceptance.md) is the sole authority for the manifest fields, clean-Mac evidence, and publication gate. The manifest deliberately contains no customer identity or credential digest; the exact disk-image and embedded-package digests bind the protected payload bytes.

## Continue an Apple submission

The producer keeps a private `.Mochi-production-*/production.json` checkpoint beside the candidate directories. Its assembly, signed pre-embedding App, original archives, submission IDs, Apple logs and stapled copies remain separate. `script/product_release_run.ts` owns this schema-2 production checkpoint; it is neither another candidate schema nor an installation transaction. No credentials are stored there.

Uploads use `notarytool submit --no-wait`, bounded to 30 minutes. The checkpoint records submission intent before upload and the returned ID before querying Apple. Each invocation queries each known package once, with a 60-second request deadline; the internal package is accepted before it is embedded in the disk image. If anything is still `In Progress`, the producer exits **75**, prints the checkpoint path and publishes no candidate. It does not poll, rebuild, re-upload or delete the assembly. Continue from the same clean verified source using only:

```bash
bun run product:package -- --resume-release /absolute/private/mochi-releases/.Mochi-production-ID/production.json
```

Resume revalidates the exact source revision and verification receipt, original input metadata, private output root, assembly bytes/modes and original archive hashes. It queries the saved IDs and requires Apple's Accepted log to match both ID and original SHA-256 before stapling a separate copy. A completed staple has its own digest; changed bytes fail closed. Only after the internal package passes does the same producer build and submit the disk image. Its subsequent resume follows the same rule. Signature, payload, ticket, Gatekeeper and mounted-image checks still run before final publication.

An interrupted upload with no durably recorded ID has an **unknown outcome**, not permission to upload again. Preserve its checkpoint and inspect Apple history and the original bytes; this command refuses automatic recovery of an unknown external effect. Invalid/rejected submissions retain their log and fail. An assembly interrupted before sealing also remains for diagnosis and cannot be resumed as signed production. Move a deliberately abandoned run out of the output directory only after recording its disposition; do not delete its evidence or manufacture a checkpoint for an older producer. A source change requires a new verified candidate and cannot adopt old Accepted results. Completed run evidence remains private for acceptance and can be archived separately after the candidate has been verified.

## Verification performed before publication

The producer fails closed unless it proves all of the following on the final stapled bytes:

1. The final `Mochi.app`, compiled Bridge, and Pi worker carry timestamped hardened-runtime signatures from the requested Developer ID Application identity, with exactly Bun's `com.apple.security.cs.allow-jit` entitlement ([`script/bun.entitlements.plist`](../script/bun.entitlements.plist)); a fixed JIT probe run inside each exact signed executable (`BUN_BE_BUN=1`) confirms the optimizing JIT is available. Without the entitlement the hardened runtime silently drops Bun to its interpreter (about six times slower). Development packages sign the Bridge and worker with the same recipe ad hoc, so they already run and probe under the hardened runtime. `lark-cli` is the pinned official executable and retains its Lark identifier and Team signature.
2. Product version, minimum macOS, architecture, the current `mochiControlManifest()` and installation manifest, Bridge/runtime versions, notices, and exact native OAuth registration bytes match the assembly inputs. These versions come from code owners, not a second list in this document.
3. The component and final internal package carry the requested Developer ID Installer identity. After Finder layout and final UDZO conversion, the outer `Mochi.dmg` is signed with the requested Developer ID Application identity, a secure timestamp and its own `app.mochi.companion.disk-image` identifier. That signature is verified before submission and again on the stapled image; an Accepted ticket alone cannot replace it. Mounting `Mochi.dmg` exposes exactly `Mochi.app` and the canonical `Applications` link, and the App's embedded `Mochi-Setup.pkg` is byte-identical to the candidate package. This follows Apple's [container signing order](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).
4. Apple returns `Accepted` for each package and the final disk image, `stapler validate` succeeds, and Gatekeeper reports `Notarized Developer ID` for both package and user-facing disk-image boundaries. The producer extracts the strictly typed verdict and authority from Gatekeeper's plist; optional notarization dates remain valid plist metadata and are not converted to JSON.
5. Expanding the final product package yields the exact transaction-staged inventory, modes, bytes, preinstall, postinstall, lifecycle script, installation manifest, package identifier/version, and Distribution contract. The same embedded package includes the exact uninstall script; no standalone uninstall package is generated.

Compilation or local deterministic CI does not substitute for these live Apple checks. Without the intended certificates and notary profile, the code path can be tested but no production candidate can be claimed.

## Acceptance and publication boundary

Continue only through [`release-acceptance.md`](release-acceptance.md), then [`public-release.md`](public-release.md). Do not rebuild after acceptance begins: a rebuild is a different candidate, even at the same product version. Release creation remains outside this producer; no command here publishes or uploads an artifact.

## Update-capable payload

The schema-6 inventory adds the native `mochi-update` executable and socket-activated `app.mochi.update` LaunchDaemon. The package stages a verified host App into the same journal as all backend components, so restoration cannot leave mixed versions. `script/build_update_helper.ts` builds only for Apple silicon and macOS 14 or later, using a private temporary compiler module cache so concurrent worktrees cannot invalidate each other's imported Clang modules. The producer signs the helper with the same Application identity, hardened runtime and timestamp. The helper does not run Bun and receives no JIT entitlement. The launchd socket is only a transport: every request must pass kernel audit-token, exact code identity, Team, path and installation-account checks. Neither a writable socket nor membership in Aha Labs grants generic privileged execution.

First preparation authorizes the existing embedded package and registers this service. Normal updates reuse that registered authority; same-version repair continues to request standard authorization and shares idle/health checks. Permission revocation, Login Items, device policy and another login account remain explicit acceptance cases. The public update feed is a separate publication step after schema-8 acceptance; see [public release](public-release.md#publishing-and-withdrawing-the-update-feed).
