#!/bin/bash
set -u
umask 077

case "${1:-}" in
  deleteAll) UNINSTALL_POLICY=deleteAll ;;
  keepData) UNINSTALL_POLICY=keepData ;;
  *) echo 'Mochi uninstall mode is invalid' >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
INSTALLATION_MANIFEST="$SCRIPT_DIR/installation.json"
cd / || exit 1
# shellcheck source=installer/lifecycle.sh
source "$SCRIPT_DIR/lifecycle.sh" || exit 1
mochi_require_contract "$INSTALLATION_MANIFEST" || exit 1
mochi_load_contract "$INSTALLATION_MANIFEST" || exit 1

RUNTIME_USER='_mochi'
RUNTIME_GROUP='_mochi'
MOCHI_RUNTIME_HOME="/Users/_mochi"
USER_ID="${2:-}"
RECIPIENT_USER="$(mochi_recipient_user "$INSTALLATION_MANIFEST" "$USER_ID")" || exit 1
MOCHI_CONSOLE_USER_HOME="/Users/${RECIPIENT_USER}"
# The account-scoped paths below are that account's; the installation is
# removed only by the account its sudoers rule names.
INSTALLED_FOR="$(mochi_installed_bridge_user "$INSTALLATION_MANIFEST")" || exit 1
if [[ -n "$INSTALLED_FOR" && "$INSTALLED_FOR" != "$RECIPIENT_USER" ]]; then
  echo "Mochi is set up for the macOS account $INSTALLED_FOR; sign in as that account and uninstall from Mochi" >&2
  exit 1
fi

WORK_ROOT="$(mochi_work_root "$INSTALLATION_MANIFEST")" || exit 1
REMAINING_FILE="$WORK_ROOT/remaining-ownership.txt"
UNINSTALL_POLICY_FILE="$WORK_ROOT/uninstall-policy"
FAILURES=0
RETAINED=0
if [[ -e "$UNINSTALL_POLICY_FILE" || -L "$UNINSTALL_POLICY_FILE" ]]; then
  [[ -f "$UNINSTALL_POLICY_FILE" && ! -L "$UNINSTALL_POLICY_FILE" ]] || {
    echo 'Mochi uninstall policy marker is unsafe' >&2
    exit 1
  }
fi
if [[ -f "$UNINSTALL_POLICY_FILE" \
  && "$(/bin/cat "$UNINSTALL_POLICY_FILE")" != "$UNINSTALL_POLICY" ]]; then
  echo "Mochi uninstall is already bound to $(/bin/cat "$UNINSTALL_POLICY_FILE"); retry that choice in Mochi" >&2
  exit 1
fi

record_remaining() {
  local id="$1"
  local path="$2"
  /bin/echo "$id: $path" >> "$REMAINING_FILE"
  FAILURES=$((FAILURES + 1))
}

record_retained() {
  local id="$1"
  local path="$2"
  /bin/echo "Mochi retained $id: $path"
  RETAINED=$((RETAINED + 1))
}

remove_path() {
  local id="$1"
  local path="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    if ! mochi_remove_owned_path "$path" >/dev/null 2>&1; then
      record_remaining "$id" "$path"
      return
    fi
  fi
  if [[ -e "$path" || -L "$path" ]]; then
    record_remaining "$id" "$path"
  fi
}

# Deleting a user record is the one step macOS gates behind the consent of the
# app's GUI audit session ("administer your computer"). It is asked for before
# anything is removed, so that a refusal leaves Mochi installed instead of a
# product that is gone except for its account.
remove_runtime_account() {
  local reason
  if /usr/bin/id -u "$RUNTIME_USER" >/dev/null 2>&1; then
    reason="$(/usr/bin/dscl . -delete "/Users/${RUNTIME_USER}" 2>&1)" || true
  fi
  if /usr/bin/id -u "$RUNTIME_USER" >/dev/null 2>&1; then
    echo "macOS did not let the installer remove the hidden Mochi account ${RUNTIME_USER}: ${reason:-no reason given}" >&2
    echo 'Nothing has been removed. Reopen Mochi and retry uninstalling.' >&2
    return 1
  fi
}

mochi_stop_host_application "$INSTALLATION_MANIFEST" "$USER_ID" || exit 1

if [[ -n "$USER_ID" ]]; then
  /bin/launchctl bootout "gui/$USER_ID/app.mochi.bridge" >/dev/null 2>&1 || true
fi

# An interrupted installation first restores its predecessor; if that fails,
# nothing is removed and the journal stays for the next attempt.
mochi_recover_transaction "$INSTALLATION_MANIFEST" || {
  echo 'Mochi uninstall stopped because an interrupted installation could not be restored' >&2
  exit 1
}
if [[ "$UNINSTALL_POLICY" == deleteAll ]]; then
  if ! remove_runtime_account; then
    /bin/mkdir -p "$WORK_ROOT" || exit 1
    /bin/echo 'runtime-account-permission: _mochi' > "$REMAINING_FILE"
    /bin/chmod 600 "$REMAINING_FILE"
    exit 1
  fi
fi
/bin/mkdir -p "$WORK_ROOT" || exit 1
if [[ ! -f "$UNINSTALL_POLICY_FILE" ]]; then
  mochi_atomic_text "$UNINSTALL_POLICY_FILE" "$UNINSTALL_POLICY" || exit 1
fi
: > "$REMAINING_FILE" || exit 1
/bin/chmod 600 "$REMAINING_FILE" || exit 1

# External identities are handled before their package-owned executable is
# removed. Their retention is declared only by the installation manifest.
external_count="$(mochi_manifest_value "$INSTALLATION_MANIFEST" externalArtifactCount)"
external_index=0
while [[ "$external_index" -lt "$external_count" ]]; do
  id="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "externalArtifacts.$external_index.id")"
  kind="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "externalArtifacts.$external_index.kind")"
  identity="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "externalArtifacts.$external_index.identity")"
  action="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "externalArtifacts.$external_index.$UNINSTALL_POLICY")"
  if [[ "$action" == retain ]]; then
    if [[ "$kind" == runtime-account ]] && /usr/bin/id -u "$identity" >/dev/null 2>&1; then
      record_retained "$id" "$identity"
    fi

  fi
  external_index=$((external_index + 1))
done

component_count="$(mochi_manifest_value "$INSTALLATION_MANIFEST" transactionalComponentCount)"
component_index=0
while [[ "$component_index" -lt "$component_count" ]]; do
  id="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "transactionalComponents.$component_index.id")"
  # The host remains the recovery entry until all other cleanup succeeds.
  if [[ "$id" == host-application || "$id" == product-bin || "$id" == runtime-sudoers || "$id" == update-daemon ]]; then
    component_index=$((component_index + 1))
    continue
  fi
  action="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "transactionalComponents.$component_index.$UNINSTALL_POLICY")"
  destination="$(mochi_component_destination "$INSTALLATION_MANIFEST" "$component_index")"
  if [[ "$action" == remove ]]; then
    remove_path "$id" "$destination"
  elif [[ -e "$destination" || -L "$destination" ]]; then
    record_retained "$id" "$destination"
  fi
  component_index=$((component_index + 1))
done

root_count="$(mochi_manifest_value "$INSTALLATION_MANIFEST" retainedRootCount)"
root_index=0
while [[ "$root_index" -lt "$root_count" ]]; do
  id="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.id")"
  if [[ "$id" == deployment-data || "$id" == update-socket ]]; then
    root_index=$((root_index + 1))
    continue
  fi
  scope="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.scope")"
  relative_path="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.path")"
  root="$(mochi_scoped_path "$scope" "$relative_path")"
  cleanup_index=0
  while cleanup="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.cleanup.$cleanup_index" 2>/dev/null)"; do
    remove_path "$id-cleanup-$cleanup_index" "$root/$cleanup"
    cleanup_index=$((cleanup_index + 1))
  done
  action="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.$UNINSTALL_POLICY")"
  if [[ "$action" == remove ]]; then
    remove_path "$id" "$root"
  elif [[ -e "$root" || -L "$root" ]]; then
    record_retained "$id" "$root"
  fi
  root_index=$((root_index + 1))
done

if [[ "$UNINSTALL_POLICY" == deleteAll ]] && /usr/bin/dscl . -read "/Groups/${RUNTIME_GROUP}" >/dev/null 2>&1; then
  /usr/bin/dscl . -delete "/Groups/${RUNTIME_GROUP}" >/dev/null 2>&1 || true
  if /usr/bin/dscl . -read "/Groups/${RUNTIME_GROUP}" >/dev/null 2>&1; then
    record_remaining runtime-account "$RUNTIME_GROUP"
  fi
fi

# Keep the authenticated recovery transport while data cleanup can still fail.
if [[ "$FAILURES" -gt 0 ]]; then
  /bin/cat "$REMAINING_FILE" >&2
  exit 1
fi
component_index=0
while [[ "$component_index" -lt "$component_count" ]]; do
  id="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "transactionalComponents.$component_index.id")"
  case "$id" in
    product-bin|runtime-sudoers|update-daemon)
      remove_path "$id" "$(mochi_component_destination "$INSTALLATION_MANIFEST" "$component_index")"
      ;;
  esac
  component_index=$((component_index + 1))
done
root_index=0
while [[ "$root_index" -lt "$root_count" ]]; do
  id="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.id")"
  if [[ "$id" == deployment-data ]]; then
    scope="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.scope")"
    relative_path="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.path")"
    root="$(mochi_scoped_path "$scope" "$relative_path")"
    action="$(mochi_manifest_value "$INSTALLATION_MANIFEST" "retainedRoots.$root_index.$UNINSTALL_POLICY")"
    if [[ "$action" == remove ]]; then remove_path "$id" "$root"; else record_retained "$id" "$root"; fi
  fi
  root_index=$((root_index + 1))
done

# Directories the installer created above its components go once empty.
if ! UNREMOVED_DIRECTORY="$(mochi_remove_created_directories "$INSTALLATION_MANIFEST")"; then
  record_remaining created-directory "$UNREMOVED_DIRECTORY"
fi

/usr/sbin/pkgutil --forget app.mochi.product >/dev/null 2>&1 || true
if [[ "$FAILURES" -gt 0 ]]; then
  echo 'Mochi uninstall is incomplete. Remaining package-owned targets:' >&2
  /bin/cat "$REMAINING_FILE" >&2
  echo "Reopen Mochi, repair its background components and retry; the exact list is stored at $REMAINING_FILE" >&2
  exit 1
fi

/bin/rm -f "/Library/Application Support/Mochi/Installation/update-pending" || exit 1
if ! mochi_remove_update_socket "$INSTALLATION_MANIFEST"; then
  record_remaining update-socket 'launchd listener'
  exit 1
fi
remove_path app "$(mochi_host_application_destination "$INSTALLATION_MANIFEST")"
[[ "$FAILURES" -eq 0 ]] || exit 1
/bin/rm -rf "$WORK_ROOT"
if [[ "$UNINSTALL_POLICY" == keepData && "$RETAINED" -eq 0 ]]; then
  echo 'Mochi keep-data uninstall found no retained product data.'
fi
exit 0
