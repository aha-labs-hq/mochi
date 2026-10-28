# Mochi public release preparation

This document owns the handoff to public distribution. It adds no competing candidate identity, installer or acceptance suite. The source is public under the Apache License 2.0; GitHub Releases are not a download channel. Public distribution publishes accepted binaries and user documents at an issuer-approved public destination.

The first public release supports Apple silicon only, is signed and notarized with the issuer's individual Apple Developer ID, downloads from <https://mochi.host/download/> and updates through the App after the signed update chain has been accepted.

## Authorities

- [`release-production.md`](release-production.md) / `script/build_product_package.ts`: exact source inputs, signed/notarized artifacts and immutable candidate.
- [`release-acceptance.md`](release-acceptance.md) / `script/release_acceptance.ts`: candidate schema 4, current schema-8 live evidence, credential closure and verdict.
- `script/verify.ts`: full-suite receipt, source tree, platform, architecture, pinned toolchain and log digest. Production and staging consume the same receipt; another tree or a passing subset is rejected.
- `script/stage_release_publication.ts`: one read-only `validateReleasePublication` gate for public attachments and website download facts; allowlisted attachments in one private directory, and `verifyStagedPublication`, which re-proves that directory before upload, readback or linking. It uploads nothing and changes no repository, account or running Bot.
- [`release/distribution.json`](../release/distribution.json): the Developer ID Team, the Cloudflare account, the R2 bucket `mochi-releases` and the download base `https://downloads.mochi.host/`.
- `script/release_upload.ts`, `script/release_readback.ts` and `script/deploy_site.ts`: create the accepted objects once, read them back anonymously, and deploy the formal `/download/` page only from a publication that reads back.

## Critical path to the first public release

Take the steps in order; each starts only when the previous one has its evidence.

1. **First-install permissions.** Fix the first-install directory permissions, then install the ad-hoc development package (`bun run product:package` without `--release`) on a macOS 14 VM and run the [installed-permissions audit](release-acceptance.md#installed-permissions-audit) before spending a notarization cycle.
2. **Fixes before signing.** Fake-IP egress, the App's package verification, installer recovery that fails closed, and the Bridge and worker JIT entitlement are merged with passing receipts.
3. **Apple identity.** Once the membership is active, create the Developer ID Application and Developer ID Installer certificates on the release Mac, store one `notarytool` keychain profile, and commit the Team ID as `developerIdTeamId` in `release/distribution.json`.
4. **Verification receipt.** Run `bun run verify` on the committed release revision (procedure step 1).
5. **Signed candidate.** Package, notarize, staple and pass Gatekeeper through [production](release-production.md) (procedure steps 2–3).
6. **Clean-Mac acceptance.** Run the finite suite on clean macOS 14.x targets, including the fake-IP proxy, release-signature runtime, installed-permissions, Login Items and multi-user scenarios (procedure step 4).
7. **Public identity.** Settle the [issuer decisions](#issuer-decisions) and the publication details (procedure step 5).
8. **Stage, upload and read back.** Stage the accepted files, upload them with the bucket token once the upload is authorized, and read every file back anonymously (procedure step 6 and [publication and readback](#publication-and-readback)).
9. **Formal download page.** Deploy `/download/` with `site:deploy:release` from the same accepted, read-back publication.

## Issuer decisions

Only the issuer can settle these:

- **Publisher and signing identity.** The Developer ID is an individual account, so Gatekeeper, the Installer and Login Items show the account holder's personal name while the site and documents name the publisher. Either ship with that difference and say so in the public documents, or move signing to an organization account (a new Team, membership review and certificates) before step 5.
- **Download bucket token.** In the Cloudflare dashboard, create an R2 API token with Object Read & Write limited to the `mochi-releases` bucket. Give its S3 Access Key ID and Secret Access Key to `release:upload` only through the environment, and revoke the token after the upload. Nothing in the repository creates or stores it.
- **Legal review.** Review the user instructions, privacy notice, data-flow claims, provider terms (including ChatGPT subscription use) and retention commitments before step 8.

## Before issuing a protected candidate

Close the historical credential-exposure review with the credential owners. The retired installer launch no longer inherits a secret-bearing environment, but code removal does not revoke credentials already exposed. Retain a private redacted inventory of affected credential kinds/provider owners, revocation outcomes/times and current-authority checks. Shared evidence contains only proof/counts, never values, credential digests, raw installation logs or private paths. The September 11 GitHub issuer rotation is partial evidence, not closure of unrelated credentials.

Review [`release/public/`](../release/public/): user instructions and data notices covering selection, shared group memory, independent Bots, model billing, read-only mailboxes, material gaps, arrangements, in-app updates, removal and remote-authority data flows. These are engineering-backed drafts until the issuer confirms public identity, contact points, hosted/support retention and applicable provider terms. Do not infer a legal entity or retention period from a GitHub organization name.

## Produce, accept, then stage

1. Integrate and run `bun run verify` on the committed candidate. Retain result/log. A squash merge with the same tree may use that receipt; changed trees or architectures need matching full verification.
2. Provide explicit same-Team Developer ID Application/Installer names of the Team in `release/distribution.json`, with usable private keys in the release Mac's Keychain, and an explicit `notarytool` profile. Follow [Apple's Developer ID instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) and [notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution). The producer never chooses identities or reads their private keys.
3. Follow [production](release-production.md) with the pinned official Lark CLI, private native OAuth registration, reviewed limitations and verification receipt. Apple acceptance, staple and Gatekeeper proof precede candidate creation. Issuer inputs are never customer setup tasks.
4. Run [live acceptance](release-acceptance.md) on disposable clean targets, including the declared minimum macOS major. Repeat for every advertised architecture. Do not rebuild during acceptance.
5. Copy [`publication.example.json`](../release/publication.example.json) outside Git and fill the public publisher name, download-page URL, support URL (an HTTPS page or a `mailto:` address) and privacy contact email. Empty fields and reserved example/test addresses are rejected. Confirm destinations are reachable without source-repository access.
6. Stage concrete public attachments from the exact clean source checkout:

```bash
install -d -m 700 /absolute/private/mochi-publication
bun run release:stage -- \
  /absolute/candidate/Mochi-Release.json \
  /absolute/git-common/mochi-verification/commit/run/result.json \
  /absolute/private/publication.json \
  /absolute/private/mochi-publication \
  /absolute/evidence/Mochi-Acceptance-clean-arm.json
```

Additional accepted target records may be appended; target IDs must be distinct. Staging checks all artifact/evidence digests, passing checkpoints and at least one target on the minimum macOS major, then copies and re-verifies the candidate. Existing publication directories are never overwritten.

`Mochi-<version>-<architecture>-<manifest-digest-prefix>/` contains exactly:

```text
Mochi.dmg
Mochi-Release.json
README.md
PRIVACY.md
RELEASE_NOTES.md
SHA256SUMS.txt
```

Only `Mochi.dmg` is the install action. The internal package stays embedded in the App and in private acceptance evidence; it is not a public attachment. Uninstall and the data-retention choice live in the App. The byte-identical candidate record also records the internal package digest, without advertising another download. Documents are rendered from the candidate's committed sources with reviewed contact information. Artifact bytes stay unchanged. Private acceptance records/attachments, logs, signing/OAuth inputs and customer identity are excluded.

## Publication and readback

The website's formal download build consumes the same candidate, full-suite receipt, publication details and schema-8 acceptance records through `validateReleasePublication`. See [`site/README.md`](../site/README.md) for the build inputs. It derives the version, architecture, minimum system, limitations, sizes, digests and immutable directory links from that candidate; no independent website release manifest or accepted flag exists. Partial inputs fail before build output is replaced. The default remains beta registration; a [public beta](#public-beta) is chosen explicitly. Publication runs from a clean checkout that contains the candidate's source revision, so the website can change without a new App build; the published files and their documents always come from the candidate's own revision. Every deployment then submits the sitemap's pages to IndexNow (`site/build/indexnow.ts`); a refusal is reported without undoing the deployment.

Binaries live in the R2 bucket `mochi-releases` behind `https://downloads.mochi.host/`, not in Pages ([Cloudflare Pages limits individual files to 25 MiB](https://developers.cloudflare.com/pages/platform/limits/)); `release/distribution.json` owns both. The staged directory name is the object prefix, so each file is public at `https://downloads.mochi.host/<directory>/<file>`. The first download build describes one accepted architecture; do not advertise others without their exact candidate and target proof.

Upload is a separate, explicitly authorized action after review of the staged directory. `release:upload`, `release:readback` and the release site deployment take the staging inputs, with the staged directory in place of the output directory:

```bash
export MOCHI_R2_ACCESS_KEY_ID MOCHI_R2_SECRET_ACCESS_KEY   # from the bucket token; never in files or shell history
bun run release:upload -- \
  /absolute/candidate/Mochi-Release.json \
  /absolute/git-common/mochi-verification/commit/run/result.json \
  /absolute/private/publication.json \
  /absolute/private/mochi-publication/Mochi-<version>-arm64-<manifest-digest-prefix> \
  /absolute/evidence/Mochi-Acceptance-clean-arm.json
bun run release:readback -- <the same arguments>
```

Upload repeats the publication gate and re-proves every staged byte, then creates each object once with `If-None-Match: *`. The disk image and packages are `attachment` downloads with their original filenames (`application/x-apple-diskimage`, `application/octet-stream`); the record is `application/json`; documents and checksums are UTF-8 text. Every object is `Cache-Control: public, max-age=31536000, immutable`. A key that already holds the same size and SHA-256 is reported as already present; any other existing object stops the upload, because published objects are never replaced. The token is read only from the environment and never printed.

Readback fetches every file anonymously, without credentials, cookies or followed redirects, and fails unless the status, size, SHA-256, `Content-Type`, `Content-Disposition` and `Cache-Control` all match the staged directory. A successful upload is not public readback.

```bash
bun run site:deploy:release -- \
  --release-manifest /absolute/candidate/Mochi-Release.json \
  --verification-result /absolute/git-common/mochi-verification/commit/run/result.json \
  --publication /absolute/private/publication.json \
  --publication-directory /absolute/private/mochi-publication/Mochi-<version>-arm64-<manifest-digest-prefix> \
  --acceptance-record /absolute/evidence/Mochi-Acceptance-clean-arm.json
```

The release deployment repeats the readback, builds the site from the same inputs and the configured download base, refuses to deploy unless the built `/download/` page links the published `Mochi.dmg`, and then deploys the Pages project. `site:deploy` remains the registration entry; no entry falls back to another, and all replace the live site, so do not run the registration entry once a download page is live.

Then check by hand: the actual browser download, architecture selection, minimum OS, limitations, support and privacy links, no private-source login dependency, and the narrow-screen page. Retain the original accepted candidate for recovery.

The first update-capable base is 0.3.0 with installation contract 6. Older private installations require a reviewed offline transition; they are not silently upgraded. In-app check/download/install is implemented, but public feed publication remains blocked on the signed N-to-N+1 acceptance. No public feed is changed by building or verifying this source.

## Human handoff

| Required contribution | Concrete deliverable |
| --- | --- |
| Apple authority | Exact same-Team Application/Installer names and their Team ID in `release/distribution.json`; private keys locally in Keychain; explicit notary profile name. Never send passwords, keys or notary credentials in chat. |
| Download storage | A bucket-scoped R2 token for `mochi-releases`, supplied through the environment for one upload and revoked afterwards. |
| Credential owners | Private redacted credential-exposure inventory, revocation proof for every affected old credential, current-authority proof. |
| Public identity | Four publication fields, public download destination and confirmed service/support retention. |
| Customer authorization | Disposable accounts/new Feishu App or organization, required admin approval, selected test GitHub project/mailbox, approved group and test content. Human login/consent. |
| Clean targets | Advertised architecture(s), including declared minimum macOS major; clean Mac/snapshots, standard user and admin for install. |
| Live observations | Schema-8 records with redacted evidence: real Issue write/revocation, replies, mailbox scope, Bots/models, due/sleep schedules, reboot, sacrificial update/repair/uninstall, keyboard/VoiceOver. |

Missing contributions remain `blocked`; templates, mocked providers, development installs and staged fixtures are never called public releases.

## Public beta

A public beta puts an exact signed candidate on the same `/download/` page before the whole suite is accepted. `PUBLIC_BETA_CHECKPOINTS` in `script/release_acceptance.ts` owns its gate, as the owner decided on 2026-10-28: each acceptance record must prove the clean target baseline and pass the checkpoints a clean Mac proves without customer accounts — the signed disk image installs for a standard user with one separate administrator authorization, the installation matches its declared permissions, and delete-all uninstall leaves no product residue — with one target on the declared minimum macOS major. Checkpoints that need customer accounts, the issuer's reviews, updates or a kept-data reinstall may stay blocked; state what they leave unproven in the candidate's reviewed limitations.

Everything else is the release path: the same candidate, full-suite receipt, publication details, staging, upload and anonymous readback. Pass `--public-beta` as the first argument of `release:stage`, `release:upload` and `release:readback`, then run `site:deploy:public-beta` with the release deployment's inputs. The beta's directory is `Mochi-<version>-beta-<architecture>-<manifest-digest-prefix>/`, so the same candidate can later be published as a release without replacing an object. Its notes and download page call it 公开测试版 and say that updates arrive as a new disk image on the download page.

A public beta never publishes the update feed: `release:update` accepts only a release. Replacing an installed App with a newer version in Finder is refused by design ([software updates](design/software-updates.md)), so until a feed carries accepted updates, beta users uninstall from the current App with their data kept, then install the next disk image. The notes, the guide and the download page say so, and say that moving the App to the Trash does not stop the background service.

## Publishing and withdrawing the update feed

`release/updates.json` owns the fixed stable-feed path, existing Aha Labs Ed25519 public key and lowest update-capable base. `bun run release:update` consumes the same publication input and exact acceptance verdict as the download page, adding `publicationDirectory` and a plain-text `notesPath`. It never creates signing credentials.

```sh
bun run release:update stage /absolute/publication.json /absolute/stable.json /absolute/sparkle/bin/sign_update
bun run release:update publish /absolute/publication.json /absolute/stable.json
```

Staging uses Sparkle's official `sign_update --account aha-labs -p` against the existing Keychain key; no private key is exported. Publishing proves the immutable downloads anonymously first, verifies the current signed pointer, and writes with the previous ETag (or create-only when absent). R2 [conditional writes](https://developers.cloudflare.com/r2/api/s3/extensions/#conditional-operations-in-putobject) make concurrent replacements fail instead of silently winning. The pointer has `Cache-Control: no-store`; anonymous readback must match the exact signed envelope. A timeout or mismatched readback is an unknown publication result, not permission to repeat a write or claim success. Inspect the current object before proceeding.

To withdraw a target, use `withdraw` in place of `stage`, review that envelope, then publish it with the same accepted candidate input. Withdrawal retains the candidate/version identity and advances the feed timestamp; it blocks pending installations without downgrading installed software. The desktop rechecks before requesting installation, and the root helper checks the fixed official feed again after work becomes idle. A network failure at either point retains the current installation. Public cache behavior and these exact signed bytes are part of release acceptance.
