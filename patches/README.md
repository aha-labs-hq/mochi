# Dependency patches

Bun applies each file here through `patchedDependencies` in `package.json`.
Every patch has an entry below saying why it exists, where upstream stands and
how to prove it still works. `test/dependencyPatches.test.ts` fails when a patch
is unregistered or has no entry.

A patch exists to change a dependency's code. Bun resolves versions from the
registry manifest, never from a patched `package.json`, so a patch that edits
dependency versions changes nothing. Version pins belong in `overrides`; a pin
for one dependent is nested under it, as `miniflare`'s `undici` is.

Bun applies a patch by position and does not check the lines it removes, so
after an upgrade a stale patch can land on changed code without an error. On
every upgrade of a patched package, read the upstream change, recreate the
patch against the new release with `bun patch`, delete it once upstream ships
the change, and run the checks listed for it.

## `@earendil-works/pi-ai@1.1.0`

Adds an optional pair of fixed OpenAI Codex callback pages to
`registerBunOAuthFlows`, passed to Pi's shared loopback callback server, plus
response headers that prevent caching and referrer disclosure. Mochi's worker
supplies its pages from `src/oauthPage.ts`. The patch also fails
immediately when the fixed callback port cannot bind, before the authorization
URL is published, instead of Pi's fallback to a pasted redirect URL. Pi itself
closes the listener and the unused manual-code waiter on cancellation.
Provider URL/state/PKCE checks, token exchange, credential persistence and
other providers remain unchanged.

It exists because this release hardcodes Pi's own HTML and labels receipt as
successful authentication before token exchange. Upstream has no page hook
yet; prefer one when it exists. Never copy the provider OAuth implementation
into Mochi to change presentation.

Check: `test/runtimeOAuthPage.test.ts` (the actual listener), the WebKit
callback tests, and `bun run runtime:build`, which requires
`callback-server.js` in the compiled worker.

## `node-forge@github:digitalbazaar/forge#7232404`

`sandbox-runtime` depends on `node-forge`, whose npm releases (1.4.0 included)
skip the element count of the nested `DigestInfo.DigestAlgorithm` in RSA
PKCS#1 v1.5 verification: GHSA-86w9-cpqp-85rv / CVE-2026-85393, a high-severity
signature forgery. The `node-forge` override pins upstream commit
`723240415b25120d47146f982809fa69344ab890`, which carries the fix, and this
patch keeps a minimal local guard on the same structure.

Do not return to a semver range until a stable npm release contains the same
fix and passes the check without this patch.

Check: `test/nodeForgeSecurity.test.ts` verifies a valid signature and rejects
one with extra nested elements.

## `@earendil-works/pi-coding-agent@1.1.0`

Today it changes only the `typebox` version in `package.json`, which the
`typebox` override already decides, so it has no effect. Remove that hunk when
this patch next changes, and delete the patch if nothing else remains.

## `@anthropic-ai/sandbox-runtime@0.0.77`

Adds a macOS Seatbelt syscall filter for `setpgid` (82), `setsid` (147), and
`posix_spawn` (244). Upstream's process permissions allow detached descendants
to leave the process group that Mochi owns. `posix_spawn` must also be denied:
it can change groups internally without making either of the first two
syscalls. Shell fork/exec, pipes and synchronous system commands remain usable;
Bun/Node child APIs that rely on posix_spawn fail explicitly with EPERM.

Mochi's credential-free execution supervisor starts the group before applying
the sandbox; the worker acknowledges that exact group before tool code runs.
The private IPC lease reaps it on either owner's death. Tool output formatting
stays inside the sandbox, including Pi's temporary truncation files. This is
process lifetime confinement, not a per-turn CPU, memory or disk quota.

Upstream 0.0.77 has no such filter. Re-evaluate the syscall table and recreate
this patch on any sandbox-runtime or supported macOS upgrade. The startup
self-check exercises all three denied paths from a non-group-leader process
and fails closed if the filter no longer works. Check:
`test/runtimeExecution.test.ts` on each supported macOS release, including
normal commands, detachment, successful exit, timeout, cancellation, worker
death and supervisor death; then validate the signed release executable in the
isolated native acceptance environment.
