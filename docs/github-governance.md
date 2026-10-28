# GitHub governance

Mochi is maintained by one developer who may run several Codex worktrees in parallel. GitHub exists to make those streams safe to integrate, not to imitate a team process.

## Repository home

The source repository is [`aha-labs-hq/mochi`](https://github.com/aha-labs-hq/mochi), owned by Aha Labs (organization ID `330909798`) and public under the Apache License 2.0 since 2026-10-28. It was published from a fresh history; earlier development history and discussion remain private. `.github/governance.json` pins its repository ID. Contributors outside Aha Labs open pull requests from forks; see `CONTRIBUTING.md`.

The GitHub App `mochi-companion` (App ID `4850106`) is owned by Aha Labs. The maintainer route of the issue authority in `identity/` binds this repository's ID, owner and full name (`identity/wrangler.jsonc`). The authority runs on the issuer's Cloudflare account and holds the App's only private key as a secret binding; no key or credential lives in this repository. Proposal automation is usable only after the organization grants the App access to this repository and a repository-bound capability probe succeeds.

## The durable contract

Every change keeps four properties:

- one worktree owns one coherent diff;
- unrelated user changes never enter that diff;
- verification matches the real failure risk and its evidence is reported truthfully;
- integration into `main` is reviewable and recoverable.

Everything else is a tool chosen when it reduces uncertainty.

## Identity and authority

Mochi has one visible GitHub write actor: the GitHub App with stable App ID `4850106`, currently rendered as `mochi-companion[bot]`. The slug-derived login can change only if the App is renamed; the App ID is the durable identity. Human maintainers decide, review, and merge. They do not create Mochi's branches or Pull Requests with an ambient personal `gh` login.

The bot's visible avatar is the GitHub App badge, configured in the App's Developer Settings. It is separate from the customer's OAuth account avatar and from Mochi's local Feishu/companion artwork. A write using the customer's user token would attribute activity to that person and is a defect; product writes therefore use the remote authority's installation token, while changing the App badge requires a direct GitHub settings action and visible provider read-back.

The repository-owned authority is split deliberately:

- `bun run github:commit -- ...` records the App bot's verified noreply commit identity on a `codex/*` branch;
- `bun run github:propose -- --title ... --body-file ...` obtains a short-lived, one-repository App installation token from `mochi-github-authority`, pushes that branch, and creates or updates only a bot-owned PR;
- the authority's maintainer route is pinned to repository ID `1436737307` and only grants metadata/read, contents/write, and pull-requests/write;
- the issuer RSA key is a Cloudflare Worker secret and never enters a checkout, native package, renderer, Pi worker, command output, or PR;
- the local maintainer credential is held in macOS Keychain and authenticates only the pinned maintainer route. It is not a GitHub token.

The product's customer path uses the same App actor but a different closed endpoint. A customer's rotating user token proves only the connector's standing grant: the account, its App/installation/repository intersection and its repository role. It is no evidence that a person is present; scheduled turns are refused writes only by the worker's execution policy (`src/runtime/worker.ts`), which the authority cannot observe. The user token never performs the external write. On every request the authority re-proves that intersection and then:

- requires the repository role GitHub itself requires for the operation (GitHub Docs, "Repository roles for an organization"): read to open an Issue or comment; triage to apply labels, assignees or milestones and to close or reopen; write to edit a title or body, to lock, or to comment on a locked conversation. The native OAuth client secret is extractable, so the authority, not the App, is this gate; otherwise triage could rewrite anyone's Issue under the bot's name;
- limits writes per proven GitHub account and per installation with the `ratelimits` bindings in `identity/wrangler.jsonc`, counted per Cloudflare location, and refuses the excess as `429 rate_limited` with `Retry-After`;
- writes as the App with an Issue-only installation token scoped to that one repository ID and addresses the write as `/repositories/{id}/…`, never by name, so a rename or reused name cannot redirect it. Tokens are cached in the isolate per installation, repository and permission set, reused only while more than `TOKEN_REUSE_MARGIN_MS` of their life remains, and dropped as soon as GitHub refuses one.

[`identity/src/protocol.ts`](../identity/src/protocol.ts) is the wire contract: the Worker parses requests with it and the native client ([`writeAuthority.ts`](../src/github/writeAuthority.ts)) builds them with it. It also owns the operation policy and the role GitHub's reported repository permissions amount to: the native catalog derives each repository's role the same way, so every role on an installation that can write Issues gets the Issue capability, and the client refuses an operation its role cannot perform with the authority's own `permission_denied` before sending it. The authority still proves the role again at write time, and only it can check whether an Issue is locked. Installed Apps do not move when the Worker deploys, so the Worker accepts every client protocol version from `AUTHORITY_PROTOCOL.minimum` to `maximum` and refuses any other as `426 protocol_unsupported`; raise `minimum` only to retire Apps deliberately. Every refusal the authority makes itself names its code in `X-Mochi-Authority-Error`; a response without that header is GitHub's own answer, relayed unchanged. Local audit preserves who requested the action, the exact authorization quote and the selected repository; the model decides whether the conversation calls for a question before acting. Current product capability remains Issue-only. Future code/PR support requires a separately designed typed change-proposal transaction and must never expose a general App token to a C-end client.

### Authority deployment and rollback

`identity/src/` and `identity/wrangler.jsonc` are the sole source and deployment configuration for `mochi-github-authority`; `bun run github:identity:check` regenerates binding types, type-checks, and runs the fail-closed authority tests. `bun run github:identity:deploy` deploys that reviewed source to the manifest-pinned origin, `https://github-auth.mochi.host`, a Workers custom domain with `workers.dev` disabled. The authority belongs to the issuer's personal Cloudflare account: `account_id` in `identity/wrangler.jsonc` pins it, and the script uses the isolated login under `~/.config/aha-labs`, never a login's default account. `GITHUB_APP_PRIVATE_KEY` and `MAINTAINER_AUTH_TOKEN` are required secret bindings and are never accepted as ordinary vars or `.dev.vars` committed content. GitHub downloads App keys as PKCS#1, but the authority imports PKCS#8, so convert on the way in: `openssl pkcs8 -topk8 -nocrypt -in <key.pem> | XDG_CONFIG_HOME="$HOME/.config/aha-labs" bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --config identity/wrangler.jsonc`. Workers Logs keep only the authority's own entries (event, request ID, numeric account and repository IDs, outcome); invocation logs and traces are off, so request URLs, headers and tokens are never stored. Cloudflare deletes entries after at most 7 days. The public `/health` response proves only configured App identity and the accepted client protocol range. The secret-protected `/v1/maintainer/status` must authenticate live `GET /app` before the authority is considered usable.

Record the successful Cloudflare version ID with deployment evidence. If a new version breaks the authority, stop product GitHub writes and run `XDG_CONFIG_HOME="$HOME/.config/aha-labs" bunx wrangler rollback <known-good-version-id> --config identity/wrangler.jsonc --message <reason>`; then repeat health, issuer, and exact actor probes. Rolling back code does not roll back GitHub App permissions or rotate secrets, and each version keeps the secret values it was deployed with, so a version older than a secret change is not a rollback target. A compromised or uncertain key requires GitHub-side revocation, a new key, Worker secret replacement, and fresh live proof—not a code fallback.

The rate-limit bindings need no resource created before a deploy. Their namespace IDs are unique within the account, where the Aha Labs account service holds `41xx` and the authority `42xx`.

### Maintainer credential rotation

`MAINTAINER_AUTH_TOKEN` is one static secret, held as the Worker secret and as the macOS Keychain item `app.mochi.github-authority` / `maintainer`; whoever holds it can mint contents/write for the maintainer repository. The authority compares SHA-256 digests in constant time, and only an authenticated maintainer request counts against the `maintainer` rate-limit key, so a wrong credential cannot lock the maintainer out. Rotate it when the Keychain item or any copy may have been exposed and when the maintainer machine changes. There is one accepted value, so pause `github:propose` in every worktree first.

1. Generate a value without printing it: `openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | pbcopy`.
2. Replace the Worker secret, pasting at the prompt: `XDG_CONFIG_HOME="$HOME/.config/aha-labs" bunx wrangler secret put MAINTAINER_AUTH_TOKEN --config identity/wrangler.jsonc`. This deploys a new version; the old value stops authenticating once it is live, within seconds. Record its version ID: older versions keep the old value and are no longer rollback targets.
3. Replace the Keychain item, pasting at both prompts: `security add-generic-password -U -a maintainer -s app.mochi.github-authority -w`. The trailing `-w` keeps the value out of argv and shell history. Then clear the clipboard with `pbcopy < /dev/null`.
4. Prove it: `/v1/maintainer/status` answers 200 with the new value and 401 with the old one, and the next `github:propose` pushes as `mochi-companion[bot]`.

## Choose the smallest useful path

A bounded change in one worktree can be implemented and verified directly. A short branch and Pull Request are the normal integration surface when another worktree may advance `main`, when CI is useful, or when the diff benefits from a durable review boundary. The repository uses squash merges and deletes merged branches.

An Issue is optional. Create one when it preserves context across turns, records a real decision or blocker, captures evidence before implementation, or coordinates related work. Do not create an Issue after the fact merely to make a Pull Request look complete. Labels are optional retrieval aids, not a required state machine.

Pull Requests do not require a linked Issue or independent approval. The template asks only for the observable outcome and evidence; context, risk, rollback, and Issue links belong there when they materially help the change.

## Verification

Mochi does not require paid GitHub Actions. Keep the account's Actions spending budget at zero. The [hosted workflow](../.github/workflows/ci.yml) is manual-only, consumes hosted allowance when explicitly dispatched, and is not a merge prerequisite. Do not dispatch it, raise the budget, make the repository public, or install a self-hosted runner without an explicit request.

A fresh worktree needs `bun install --frozen-lockfile` before its first commit: the pre-commit hook runs that worktree's own lefthook and refuses the commit while dependencies are missing. `app:check` and `app:test:ui` run `app:prepare` themselves. Run `bash script/check_repository.sh` before the full suite: its credential scan also matches prose, such as a PEM header or a Feishu `cli_` App ID written in a document.

While iterating, run focused checks. Before integration, commit the intended changes and run:

```bash
bun run verify
```

[`script/verify.ts`](../script/verify.ts) refuses a dirty source tree or the wrong Bun version, clones committed `HEAD` into its own temporary detached checkout, and runs that commit's [`script/verify_suite.sh`](../script/verify_suite.sh). The shell file is the only executable checklist, shared with the optional hosted workflow: repository/governance and quality checks, types, compiled versions/notices, desktop assembly/ad-hoc signing, all Bun tests, WebKit UI tests and, last, the dependency advisory audit. Desktop assembly already checks desktop types; `bun test` already includes companion unit tests. No duplicate checklists or subset-success modes.

Two steps use the network. The pinned WebKit build downloads only when it is not cached, and its result does not change. `bun audit` does change: an advisory published today fails a tree that passed yesterday. It runs last, so it never hides the deterministic results, and a failed receipt names the step that stopped it. An advisory blocks merging like any other failure: fix the dependency in its own change, merge `origin/main` into waiting branches and verify them again. When no fixed version exists, accepting the advisory is a reviewed `--ignore=<GHSA>` with its reason in `verify_suite.sh`, never a skipped suite.

Each invocation retains `result.json` and `verification.log` under `<git-common-dir>/mochi-verification/<commit>/run-*/`, outside all worktrees. The result records commit/tree, OS/architecture, Bun version, timing, pass/fail (naming the failed step) and the log's SHA-256. Interrupted runs are never successful. Each invocation first prunes older runs: runs from the last 14 days stay whatever their result; an older run stays only if it is the newest passing receipt of a tree that a branch, remote branch or tag still reaches, which is the receipt merge and release look up. Give release commands that newest receipt. Pruning touches only `run-*` directories; anything else placed there stays until its owner removes it. The launcher removes its own build checkout on completion, leaving development artifacts and live services untouched. It excludes product credentials/configuration/signing overrides from the child environment; dependency/tool caches may be reused. This is build isolation, not an OS security sandbox. It never installs, launches, repairs or restarts Mochi, signs with Developer ID, or contacts real product accounts.

The PR Evidence section records the exact verified head and result, plus relevant test counts/failures. Retain the local log; copy reviewed excerpts when remote readers need them, since a local path is not accessible on GitHub. This is explicitly local evidence, not a manufactured Actions check. Quota-blocked historical Actions runs do not block merging under this contract; actual failed tests still do.

WebKit UI tests give each spec file its own Playwright project and browser-process lifetime, with two workers and no automatic retries. The pinned WebKit 2336 was reproduced stalling on its 70th fresh context before sending HTTP, even for static HTML; file isolation prevents accumulated browser state from blocking unrelated specs. Every `*.pw.ts` file is discovered automatically, and the test assertions and deadlines remain unchanged.

The maintainer merges only with:

```bash
bun run github:merge -- <N> [--body-file <message>]
```

[`script/github_merge.ts`](../script/github_merge.ts) reads the PR's head SHA and base with the maintainer's `gh` login and fetches both. It refuses unless the PR is open and ready, targets `main` from a `codex/*` branch, contains the current `origin/main`, and its head tree has a passing receipt that `requirePassedVerification` accepts, the same check a release makes. It then squash-merges with `--match-head-commit <head>`, the subject `<title> (#<N>)` and the PR body or the given file, so GitHub refuses a head that changed after the check. Afterwards it confirms that the PR is merged, `main` contains the merge commit with exactly the verified tree, and the head branch is deleted. If `main` moved between the check and the merge, it says so; verify `main` then. Rebase/conflict resolution or other tree changes require new evidence. `github:propose` cannot force-push, so bring a moved base in by merging `origin/main` into the branch with `github:commit`, then verify that exact head. Do not repeat the suite before every iterative push or after the same tree is squash-merged; there is no post-merge CI wait.

`github:merge` is a local gate. GitHub Free enforces none of it: the web UI or a bare `gh pr merge` still merges an unverified head. Merging any other way is a process failure.

Visual quality, credentials, runtime identity, external APIs, deployment, destructive effects, and irreversible decisions still require direct evidence or an explicit human checkpoint. The deterministic suite is not Developer ID/notarization, real OAuth, installation or clean-Mac release acceptance.

## Parallel worktrees

- Start from a known git state and give each worktree one branch and one purpose.
- Inspect status and diff before editing, committing, rebasing, and merging.
- Never switch, clean, overwrite, or absorb another worktree's changes to make the current branch pass.
- Refresh the intended integration base before merge and resolve only conflicts owned by the current change.
- Use the PR and its exact-commit local verification evidence as the shared integration fact; do not copy status into Markdown boards.

## Machine-owned surface

`.github/governance.json` owns the App/authority identity, required repository permissions, repository settings, branch prefix, managed label definitions, retired labels, and the small PR-template shape. It does not contain credentials or decide whether a change deserves an Issue or PR. `script/github_governance.ts` provides:

```bash
bun run governance:check
bun run governance:audit
bun run governance:apply
bun run governance:retire-labels
```

`governance:audit` requires the exact repository ID, App ID/owner/slug, declared App permissions, repository settings, and managed labels to match, while deliberately ignoring additional user-created labels. `governance:apply` changes repository settings and labels only; it does not edit App permissions, deploy the authority, create credentials, or install the App. `governance:retire-labels` deletes only explicitly retired labels after proving none is used. Workflow actions remain pinned to reviewed full commit identities and checkout credentials are not persisted.

`main` is protected on GitHub: changes land only through pull requests, and force pushes and deletion are refused. Verification receipts remain a local gate in `github:merge`; do not claim the server enforces them. The repository's safety comes from isolated worktrees, explicit diffs, exact-commit verification evidence and honest judgment at the real risk boundary.
