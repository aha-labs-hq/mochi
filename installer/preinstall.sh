#!/bin/bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
INSTALLATION_MANIFEST="$SCRIPT_DIR/installation.json"
# shellcheck source=installer/lifecycle.sh
source "$SCRIPT_DIR/lifecycle.sh"
mochi_require_contract "$INSTALLATION_MANIFEST"
mochi_load_contract "$INSTALLATION_MANIFEST"
PAYLOAD_ROOT="$(mochi_payload_root "$INSTALLATION_MANIFEST")"
WORK_ROOT="$(mochi_work_root "$INSTALLATION_MANIFEST")"
# PackageKit must not stage payload beneath replaceable system ancestors.
mochi_verify_reachable_ancestors "$WORK_ROOT"
mochi_verify_reachable_ancestors "$(mochi_host_application_destination "$INSTALLATION_MANIFEST")"
mochi_verify_host_application "$INSTALLATION_MANIFEST" "$(mochi_application_source "$INSTALLATION_MANIFEST")"

if [[ -e "$WORK_ROOT" || -L "$WORK_ROOT" ]]; then
  [[ -d "$WORK_ROOT" && ! -L "$WORK_ROOT" \
    && "$(/usr/bin/stat -f '%Su' "$WORK_ROOT")" == root ]] || {
    echo 'Mochi installer work root is unsafe' >&2
    exit 1
  }
else
  /usr/bin/install -d -o root -g wheel -m 700 "$WORK_ROOT"
fi
/usr/sbin/chown root:wheel "$WORK_ROOT"
/bin/chmod 700 "$WORK_ROOT"
if [[ -e "$PAYLOAD_ROOT" || -L "$PAYLOAD_ROOT" ]]; then
  [[ -d "$PAYLOAD_ROOT" && ! -L "$PAYLOAD_ROOT" ]] || {
    echo 'Mochi installer payload root is unsafe' >&2
    exit 1
  }
  mochi_remove_tree "$PAYLOAD_ROOT"
fi
