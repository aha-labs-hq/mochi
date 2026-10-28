#!/usr/bin/env bash
# The single verification checklist. Run through `bun run verify` for commit-bound evidence.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() {
  local name="$1"
  shift
  echo "[verify] $name"
  "$@" && return
  local status=$?
  echo "[verify] Step failed: $name (exit $status)"
  # `bun run verify` records the failed step in its receipt.
  [[ -z "${MOCHI_VERIFY_FAILED_STEP:-}" ]] ||
    printf '%s (exit %s)\n' "$name" "$status" > "$MOCHI_VERIFY_FAILED_STEP"
  exit "$status"
}

step "Repository boundary" ./script/check_repository.sh
step "Governance contract" bun run governance:check
step "Locked dependencies" bun install --frozen-lockfile
step "GitHub identity authority" bun run github:identity:check
step "Code quality" bun run quality:check
step "Bridge types" bun run check
step "Compiled runtime" bun run runtime:build
step "Runtime versions and notices" bun -e '
  import { BRIDGE_VERSION } from "./src/product/version.ts";
  import { PI_WORKER_PROTOCOL_VERSION } from "./src/runtime/protocol.ts";
  for (const [binary, version] of [["mochi-bridge", BRIDGE_VERSION], ["mochi-pi-runtime", PI_WORKER_PROTOCOL_VERSION]]) {
    const child = Bun.spawnSync([`./dist/${binary}`, "--version"]);
    if (child.exitCode !== 0 || child.stdout.toString().trim() !== `${binary} ${version}`)
      throw new Error(`Compiled ${binary} version mismatch`);
  }
  if ((await Bun.file("dist/THIRD_PARTY_NOTICES.txt").text()).trim().length === 0)
    throw new Error("Missing runtime notices");
'
step "Installer syntax" bash -n installer/preinstall.sh installer/postinstall.sh installer/uninstall.sh installer/lifecycle.sh script/build_and_run.sh script/verify_suite.sh
step "Native update helper" bun run script/build_update_helper.ts
step "Update helper version" ./dist/mochi-update --version
step "Desktop assembly and types" ./script/build_and_run.sh --build-only
step "Ad-hoc signature" codesign --verify --deep --strict ./dist/Mochi.app
step "Website types" bun run site:check
step "Website build" bun run site:build
step "Bridge and companion tests" bun test
step "WebKit browser (downloads the pinned build when not cached)" bunx --no-install playwright install webkit
step "WebKit UI tests" bun run app:test:ui
# Last: published advisories change over time, so a new one never hides the results above.
step "Dependency advisories (network; changes over time)" bun audit --audit-level=moderate
