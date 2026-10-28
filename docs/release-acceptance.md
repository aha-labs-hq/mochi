# Exact release acceptance

Release acceptance accepts bytes, not a branch, build log, package name, or successful development install. The acceptance boundary remains incomplete until the release work supplies the signed and notarized candidate set.

`script/release_acceptance.ts` owns the finite executable suite. Candidate schema **4** binds the DMG and its internal privileged package; acceptance records and verdicts use schema **8**, including in-App uninstall cancellation, draining and both retention choices. Earlier records remain historical evidence and are rejected by the current gate; do not relabel their results. The product has no private recipient enrollment or fixed customer repository.

## Candidate contract

Each supported release architecture has one private candidate directory containing exactly these immutable files:

```text
Mochi-Release.json
Mochi.dmg
Mochi.pkg
```

`Mochi-Release.json` is the release record and candidate identity. Schema 4 contains only:

- `sourceRevision`: the 40-character Git commit used to build the candidate;
- `productVersion`: the semantic product version;
- `architecture`: `arm64` or `x86_64`;
- `minimumMacOS`: the declared minimum supported macOS version;
- `limitations`: bounded material release limitations;
- `artifacts`: the two fixed roles, filenames, byte sizes, and lowercase SHA-256 digests: application disk image and internal privileged package. Only the DMG is publicly downloadable.

The release workstream must emit that record beside the exact package bytes. Do not rebuild, rename, or re-sign a package after its record is created. The richer GitHub Release description may link to this record, but must not become a competing candidate identity.

## Evidence record

Generate one private evidence record per clean target and candidate architecture from a release-engineering checkout:

```bash
bun run script/release_acceptance.ts template \
  /absolute/candidate/Mochi-Release.json \
  /absolute/evidence/Mochi-Acceptance-clean-arm.json \
  clean-arm \
  14.7.8
```

The template deliberately marks every checkpoint `blocked` and every clean-baseline fact `false`; generating it is not evidence. The target ID is an opaque test label, never a user name, serial number, email, device identifier, or account identity.

Use the actual target macOS version, not the example. Public staging requires at least one accepted target per candidate on its declared minimum macOS **major** version. Success only on newer macOS cannot justify an older support claim. If only a narrower platform can be proven, change the actual product support declaration before producing a new candidate.

Evidence attachments stay outside Git in the same private directory as the acceptance record. Each reference contains a normalized relative path, byte size, SHA-256, and one fixed kind: `screenRecording`, `screenshot`, `redactedTranscript`, `diagnosticsReport`, or `operatorRecord`. A single attachment may support several checkpoints. Redact passwords, codes, tokens, credentials, Session/login IDs, messages, emails, avatars, personal paths, raw logs, and unnecessary personal data before hashing it. Never change an attachment after recording its digest.

The clean target must have no repository, Bun, Node, Swift toolchain, jq, global Pi/lark-cli, or prior Mochi state. A macOS virtual machine on Apple silicon (for example, a [tart](https://tart.run) VM) is an acceptable arm64 target. Start from a vanilla image of the declared minimum major version, then remove what a customer Mac would not have: the Command Line Tools (`/Library/Developer/CommandLineTools`; afterwards `swift` and `git` must offer to install developer tools) and any passwordless `sudo` rule. Keep that machine stopped as the clean snapshot and clone it for each target or earlier state. SSH and automatic login may stay on for operating the target; record them as harness differences in the target evidence. pkgutil keeps listing the removed tools' receipts, which live in a SIP-protected database; they are not a toolchain. The template and final validator run on the release-engineering machine; they are not installed on the recipient Mac. Use standard macOS UI and system facilities on the target. Before installation, independently compare both artifact digests with `/usr/bin/shasum -a 256`. Record Gatekeeper assessment for `Mochi.dmg`, then mount it and prove that the only visible entries are the signed `Mochi.app` and canonical `Applications` link, and that the App contains the byte-identical candidate `Mochi-Setup.pkg`; record `/usr/sbin/pkgutil --check-signature` for the embedded package. Stapling/notary submission evidence comes from the release production record; Gatekeeper acceptance is repeated on each clean target.

## Finite live suite

Run the seventeen scenarios in order on disposable supported targets. Use a separate clean target or restored clean snapshot wherever the scenario requires an earlier state. Account/resource authorization and system consent remain explicit checkpoints. Previously authorized operations on named disposable targets may be performed by the test operator; personal credentials and production resources remain outside that authorization.

1. **Release security.** Close the historical credential-exposure review: review the historical exposure inventory without recording values, prove every affected retired credential is revoked at its provider, and prove the current GitHub authority authenticates the actual App. The September 11 issuer rotation or a healthy current login alone does not establish every old credential's revocation. Review the public user/data notices, publisher/contact information and hosted-service/support retention; publish only claims the issuer can support. Issuer-owned redacted evidence may be referenced by each target record.
2. **Fresh install.** Launching from the DMG stops before authorization and offers only the Finder installation action. Drag to Applications, eject, launch, and prepare components as a standard user using one separate administrator authorization inside Mochi. The system authorization must identify Mochi as the requester, cancellation must leave the App usable, and preparation must keep the UI responsive. While authorization is pending, Mochi says it is preparing rather than claiming installation has started. Account progress appears after preparation; retained-connection reassurance requires an observed existing connection. No generic Installer wizard, second installer App, developer configuration or terminal is required. Prove Developer ID/Gatekeeper trust, official ChatGPT OAuth, real Feishu/GitHub readiness and toolchain independence. New Bots stay paused until explicit duty start initializes and verifies the one prepared record.
3. **Installed permissions.** Right after preparation, run the [audit](#installed-permissions-audit) as the administrator. Every installed path has its declared owner and mode. Resolve the ancestors of privileged components and prove an unprivileged account cannot replace their entries through ownership, group permissions or an allow ACL; system ancestors must be owned by root or an existing administrator, and group write is limited to the administrator group outside sticky shared-directory boundaries. Record administrator-owned directories such as `/usr/local/share` and the standard administrator-writable `/Applications` explicitly. An administrator is already trusted to install system software; ordinary account ownership, `staff` write access and additional write-granting ACLs are refused before any child directory is created. Only the immutable macOS `/etc`, `/var` and `/tmp` aliases may normalize; other redirected system ancestors are refused. Account-scoped ancestors belong to the installing account. Preserve stock macOS deny-delete ACLs, which grant no access, and do not change unrelated system directories to make the audit pass. Prove the two exact material ACLs owned by `src/attachments/materialWorkspace.ts`: `_mochi` may traverse the mode-700 parent and inherit read/search access under the mode-700 materials root, with no foreign grants. `sudo -l` for the installing standard user lists only the digest-pinned worker rule, and lists nothing for `_mochi`. Recheck these boundaries with the second-user scenario; permission text alone is not proof.
4. **Release-signature runtime.** On the installed release bytes, the JIT probe below prints a small positive number (not `1000000`) inside `/Applications/Mochi.app/Contents/MacOS/Mochi`, `/Library/Application Support/Mochi/bin/mochi-bridge` and `/usr/local/libexec/mochi-pi-runtime`. In the approved test group, one real turn that runs a shell command proves the per-turn sandbox starts under the release signature; inside it, reading outside the turn workspace (for example the user's `~/Library/Application Support/Mochi`) and connecting to a LAN or loopback address are refused, while public HTTPS research works.
5. **Customer connections.** With explicitly approved disposable customer accounts/resources, prove a genuinely new Feishu App's default scopes and organization-approval recovery. Prove group/project selection persistence, denied reads outside selection, one App-authored GitHub Issue mutation with current human authority and actual provider readback, and remote grant revocation invalidating old authority. In the approved group prove same-topic steering, cross-topic order, materials and unsupported-content gaps. Complete mailbox user authorization and one selected thread read, then prove deselection/disconnection blocks reads. Never send or modify mail.
6. **Independent Bots and models.** Keep ChatGPT and a named model API connected concurrently and select each through Bot policy. Enter the key only in the native form; inspect renderer/diagnostic boundaries without copying secrets. Prove separate memory, instructions, connections and resource selections; busy-account-change refusal; same-record pause/resume; instruction conflict and next-turn behavior. Settings and model changes cannot silently create or replace a record.
7. **Schedules.** In the approved test group use real model interpretation to create/change an arrangement and verify readback. Observe actual due delivery at the agreed group/topic, pause/cancel semantics and completion of accepted work. Sleep/wake through a due occurrence and prove latest-period recovery without duplicate replay. Revoke a bound resource and prove dispatch/delivery fails closed. Prove scheduled execution cannot write or inherit human authority; deterministic policy tests support this observation but do not replace actual dispatch evidence.
8. **Login continuity.** Cancel/resume official login and Feishu creation, quit/relaunch and reboot during setup. Prove unchanged prepared record, candidate/active separation, connections and selections without exposing stored identities. No implicit create, replacement or fork is accepted.
9. **Service unavailability.** Exercise offline, Feishu, GitHub, ChatGPT login/quota and default-browser failures separately. Each shows one truthful problem and safe recovery; no indefinite unknown state, prompt replay, lost memory, raw error or configuration command.
10. **Fake-IP proxy.** Install a fake-IP proxy on the target, for example Clash Verge in fake-IP mode with its DNS as the system resolver, and record that public names resolve into `198.18.0.0/15`. Through Mochi's network tools, names that resolve to private and loopback addresses (a `10.x` and a `127.x` name, the router) stay unreachable; research either returns correct public results or fails closed with one truthful explanation of the proxy. Feishu, ChatGPT and GitHub keep working through the proxy. Remove the proxy before the next scenario.
11. **Login Items.** In System Settings › General › Login Items & Extensions, record the name and publisher macOS shows for Mochi's background item; this is evidence for the publisher decision. Turn the item off: Mochi shows one truthful problem with one recovery action and claims neither duty nor online status, including after relaunch. Turn it back on and start duty: the same Bot record and Session continue.
12. **In-app update.** Use two immutable, signed and notarized candidates N and N+1 and record both manifests. The accepted candidate must participate as sender or receiver; the first 0.3.0 base is the sender to a private N+1 rehearsal. Use an isolated distribution fixture without changing the public stable pointer. Complete check, resumable download, install intent, whole-product switch and restored window entirely in Mochi. Record that accepted messages, final replies, queued work, schedules, compaction and authorization settle first; automatic installation refuses dirty settings. Exercise paused/unconnected Bots, withdrawn or altered downloads, wrong Team/product/caller path, cancelled/revoked authority, account switching, and interrupted recovery. Compare accounts, history bytes/cwd, Bot policies and selections before/after. After automatic reopen, verify that the App uses the installing user's home and private state rather than the privileged helper's environment, and that its window becomes interactive. A finalized cleanup interruption must never roll back newly accepted work. Record real Feishu messages around the offline window, without claiming delivery beyond observations. Measure download time, waiting, offline duration, time to interaction, clicks and authorization prompts separately. Root helper compilation, WebKit fixtures and C audit-token tests are supporting evidence, not this checkpoint's result.
13. **Interrupted update.** On sacrificial targets with a previous healthy candidate, interrupt before old-service stop, after stop, after component commit and after new-service bootstrap before readiness. The old healthy version survives or the one bounded repair state converges by rerunning the same signed candidate. Do not interrupt a recipient's work.
14. **Repair.** Reopen the same installed App and use in-product preparation. Prove exact owned-artifact convergence, retained mutable policy/auth/records, one ready instance and the same embedded package.
15. **Multi-user Mac.** Add a second standard user. On a separate clean target, have that user create `/Users/Shared/mochi/materials` with an inheritable ACL that grants itself access before the first user installs; installation refuses or removes it. On the installed target, the second user cannot read the first user's Mochi data or materials, cannot reach the first user's Bot through its control socket, and cannot run the worker as `_mochi` through `sudo`. Opening Mochi as the second user shows one truthful next step and does not take over the first user's Bot, sudo rule or data without an explicitly authorized reinstall.
16. **Uninstall.** Start from “关于与更新” in the signed App. Cancel the native choice and a waiting uninstall and prove that installation/data remain intact. Keep an accepted turn in flight and prove that final delivery precedes shutdown. Verify keep-data removes the App and executable authority while retaining declared data/ownership. Reinstall the same candidate and prove retained identity, then verify delete-all removes all declared roots, service account, receipts and authority. Record unexpected residue before cleanup.
17. **Accessibility.** Use actual VoiceOver and keyboard across setup, settings, ready and exercised failures; inspect focus restoration, Reduce Motion, short/narrow reflow and one problem-change announcement. Observe native window, menu and quit behavior too. Screenshots/WebKit roles alone do not prove VoiceOver or AppKit behavior.

### Installed-permissions audit

Run as the administrator on the target, with `<user>` the installing account, and redact that name before hashing the transcript. The paths are those the installation contract declares; compare each against the installed `/Library/Application Support/Mochi/Resources/installation.json`.

```bash
walk() { p="$1"; while :; do /bin/ls -lde "$p"; [ "$p" = / ] && break; p="$(/usr/bin/dirname "$p")"; done; }
for p in /Applications/Mochi.app "/Library/Application Support/Mochi" "/Library/Application Support/Mochi Installer" \
  /usr/local/libexec/mochi-pi-runtime /usr/local/share/doc/mochi /etc/sudoers.d/mochi-pi-runtime \
  /Library/LaunchDaemons/app.mochi.update.plist /var/run/app.mochi.update.sock \
  /Users/Shared/mochi/materials /Users/_mochi/ ~<user>/"Library/Application Support/Mochi" \
  ~<user>/"Library/LaunchAgents/app.mochi.bridge.plist" ~<user>/"Library/Logs/Mochi"; do walk "$p"; done
/usr/bin/sudo /usr/bin/find "/Library/Application Support/Mochi" "/Library/Application Support/Mochi Installer" \
  /Users/Shared/mochi /Users/_mochi/ -exec /bin/ls -lde {} +
/usr/bin/sudo -l -U <user>
/usr/bin/sudo -l -U _mochi
/usr/bin/id -Gn _mochi
```

### JIT probe

`BUN_BE_BUN=1` makes a compiled Bun program run as the Bun CLI under its own signature, without running Mochi code. JavaScriptCore reports `1000000` when its optimizing JIT cannot run:

```bash
BUN_BE_BUN=1 <executable> -e 'const { numberOfDFGCompiles } = require("bun:jsc"); function f(n) { let s = 0; for (let i = 0; i < n; i++) s += i; return s } for (let i = 0; i < 3000; i++) f(10000); console.log(numberOfDFGCompiles(f))'
```

The packager runs the same check on every signed Bun executable before a candidate exists (`script/bun_signing.ts`); this scenario repeats it on the installed bytes.

If a dependency is unavailable, record `blocked`; if the contract is violated, record `fail`. Only an observed checkpoint with at least one immutable evidence reference may be marked `pass` or `fail`.

Reject first-run acceptance if a recipient needs to recognize Bun, Node, Pi, a LaunchAgent, a configuration path, or a terminal command, or is asked to grant Documents/Full Disk Access to an interpreter. Test a previous process's leftover status after restart: it must not be accepted as current, misreported as a different product edition, or accompanied by a historical “connected” message presented as live status. A preparation failure must retain one executable in-App recovery action; reopening a failed browser must preserve the pending login. Local WebKit fixtures prove these presentation contracts, not successful installation or OAuth on a clean Mac.

## Deterministic verdict

Copy the private evidence directory back to the release-engineering machine and verify it against the unchanged candidate directory:

```bash
bun run script/release_acceptance.ts verify \
  /absolute/candidate/Mochi-Release.json \
  /absolute/evidence/Mochi-Acceptance-clean-arm.json
```

The verifier fails closed on schema drift, unknown or reordered scenarios, missing checkpoints, path traversal, symlinks, changed evidence, changed artifacts, a different manifest digest, architecture mismatch, an unsupported macOS target, any unproven clean-baseline fact, or any `fail`/`blocked` checkpoint. Its JSON verdict includes the candidate manifest digest, acceptance record digest, source revision, architecture, counts, and remaining failures without emitting attachment contents or machine paths.

Repeat for every architecture actually advertised. Clean-Mac acceptance is complete only when every exact candidate has an `accepted: true` verdict plus retained live evidence. Verdicts include the observed target macOS. [Public staging](public-release.md) additionally verifies the exact source receipt and minimum-macOS target, then copies only accepted artifacts and reviewed public documents. Private records/attachments and raw logs never enter public staging. The same accepted bytes may then be uploaded to the separately approved public download destination; unit tests and development packages are not final acceptance.

Real provider login, organization approval and test-group/resource authorization require the account owner unless explicitly delegated within the test scope. Reboots, installation consent, disposable-data removal and native accessibility may use the user-authorized test operator; document that scope without recording credentials. Preserve existing real Bot memory and groups; this suite does not authorize production-group tests or destructive experiments on the developer's deployment.
