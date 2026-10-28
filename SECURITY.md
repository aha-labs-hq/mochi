# Security policy

## Reporting a vulnerability

Report vulnerabilities privately, not in public issues:

- on GitHub, use **Security → Report a vulnerability** on this repository; or
- email hello@mochi.host with "Security" in the subject.

Include the affected version or commit, the steps to reproduce and the impact
you observed. We will acknowledge the report and keep you informed until a fix
ships.

## Scope

- The macOS app, its Bridge and isolated runtime, the installer and the update
  helper in this repository.
- The issue authority Worker in `identity/` (`github-auth.mochi.host`).
- Builds downloaded from <https://mochi.host/download/>.

Out of scope: vulnerabilities in Feishu or Lark, GitHub, OpenAI or other
providers (report them to the provider), and attacks that need code already
running as the Mac's own user.

## Supported versions

Only the latest public build receives fixes.
