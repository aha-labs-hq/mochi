#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ $# -gt 1 ]]; then
  echo "usage: $0 [--build-only|--verify]" >&2
  exit 2
fi
case "${1:---run}" in
  --run|--build-only|--verify) exec bun run script/build_desktop.ts "${1:---run}" ;;
  *) echo "usage: $0 [--build-only|--verify]" >&2; exit 2 ;;
esac
