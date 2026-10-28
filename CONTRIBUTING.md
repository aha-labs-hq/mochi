# Contributing to Mochi

Thanks for helping. Mochi is maintained by Aha Labs; this guide says what a pull
request needs.

## Before you start

- Read [AGENTS.md](AGENTS.md) (in Chinese). It holds the architecture, security
  and session contracts every change must keep. Changes to security boundaries,
  session identity or the tool surface need a maintainer's agreement first:
  open an issue.
- For anything beyond a small fix, open an issue to agree on the approach.

## Build and test

Use macOS on Apple silicon and the Bun version pinned in `package.json`
(`packageManager`).

```sh
bun install --frozen-lockfile
bun test
bun run check
bun run app:check
```

`bun run verify` runs the complete suite from a clean, detached clone of your
committed HEAD; run it before asking for review. `bun run app:start` builds and
opens a development app. It needs your own Feishu, GitHub and model accounts
and never replaces an installed Mochi.

## Pull requests

- Fork, branch from `main`, keep one coherent change per pull request, and
  include tests that fail without your change.
- Say what changed, why, and which checks you ran.
- Update the documentation that owns the behavior you change.
- Maintainers squash-merge after review. The `mochi-companion[bot]` actor and the
  `github:*` scripts are maintainer automation.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0 (see [LICENSE](LICENSE), section 5). Do not contribute
artwork or brand assets; see [TRADEMARKS.md](TRADEMARKS.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
