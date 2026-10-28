#!/bin/bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
INSTALLATION_MANIFEST="$SCRIPT_DIR/installation.json"
# Every path below is absolute; the recipient account may not be able to enter
# the installer's own directory when commands run as that account.
cd /
# shellcheck source=installer/lifecycle.sh
source "$SCRIPT_DIR/lifecycle.sh"
mochi_require_contract "$INSTALLATION_MANIFEST"
mochi_load_contract "$INSTALLATION_MANIFEST"

RUNTIME_USER='_mochi'
RUNTIME_GROUP='_mochi'
RUNTIME_HOME="/Users/_mochi"
RUNTIME_CWD="$RUNTIME_HOME/empty-workspace"
USER_ID="$(mochi_install_recipient "$INSTALLATION_MANIFEST" "${1:-}")" || {
  echo 'Mochi installation recipient context is missing or invalid' >&2; exit 1;
}
RECIPIENT_USER="$(mochi_recipient_user "$INSTALLATION_MANIFEST" "$USER_ID")"
USER_HOME="/Users/${RECIPIENT_USER}"
MOCHI_CONSOLE_USER_HOME="$USER_HOME"
MOCHI_RUNTIME_HOME="$RUNTIME_HOME"
# One installation serves one account: the one its sudoers rule names. An
# update or repair started from another account, including one reached by fast
# user switching, stops here before anything changes.
INSTALLED_FOR="$(mochi_installed_bridge_user "$INSTALLATION_MANIFEST")"
[[ -z "$INSTALLED_FOR" || "$INSTALLED_FOR" == "$RECIPIENT_USER" ]] || {
  echo "Mochi is set up for the macOS account $INSTALLED_FOR; sign in as that account to update or repair it" >&2
  exit 1
}

PRODUCT_ROOT='/Library/Application Support/Mochi'
DATA_ROOT="$USER_HOME/Library/Application Support/Mochi"
LOG_ROOT="$USER_HOME/Library/Logs/Mochi"
PLIST="$USER_HOME/Library/LaunchAgents/app.mochi.bridge.plist"
STATUS="$DATA_ROOT/status.json"
CONTROL_SOCKET="$DATA_ROOT/control.sock"
TRANSACTION_ROOT="$(mochi_transaction_root "$INSTALLATION_MANIFEST")"
STAGED_WORKER="$(mochi_component_source_by_id "$INSTALLATION_MANIFEST" runtime-worker)"
PRODUCT_VERSION="$(mochi_manifest_value "$INSTALLATION_MANIFEST" productVersion)"
HOST_BUNDLE_IDENTIFIER="$(mochi_manifest_value "$INSTALLATION_MANIFEST" hostApplication.bundleIdentifier)"
EXPECTED_BRIDGE_VERSION="$(mochi_manifest_value "$INSTALLATION_MANIFEST" compatibility.bridgeVersion)"
EXPECTED_STATUS_VERSION="$(mochi_manifest_value "$INSTALLATION_MANIFEST" compatibility.statusVersion)"
EXPECTED_CONTROL_VERSION="$(mochi_manifest_value "$INSTALLATION_MANIFEST" compatibility.controlProtocolVersion)"
APPLICATION_SOURCE="$(mochi_application_source "$INSTALLATION_MANIFEST")"
mochi_verify_host_application "$INSTALLATION_MANIFEST" "$APPLICATION_SOURCE"
UPDATE_MODE=false
UPDATE_ROOT="$(mochi_work_root "$INSTALLATION_MANIFEST")/Update"
UPDATE_HOLD="$PRODUCT_ROOT/Installation/update-pending"
UPDATE_HELPER="$UPDATE_ROOT/runner"
if [[ "$APPLICATION_SOURCE" == "$UPDATE_ROOT/Mochi.app" ]]; then UPDATE_MODE=true; fi
mochi_after_finalize() {
  if [[ -f "$UPDATE_HOLD" ]]; then "$UPDATE_HELPER" --committed; fi
}
SERVICE_WAS_LOADED=false
SERVICE_WAS_HEALTHY=false
SERVICE_STOPPED=false
COMPONENTS_FINALIZED=false
INSTALL_SUCCEEDED=false
UPDATE_DAEMON_ADDED=false

# Paths in the recipient account's home are created and changed as that account,
# so a symbolic link placed there can never redirect a root operation. The one
# root change there, the journaled LaunchAgent rename, first enters and proves
# its directory (mochi_enter_parent).
as_recipient_user() {
  /usr/bin/sudo -n -u "$RECIPIENT_USER" -- "$@"
}

launchagent_loaded() {
  /bin/launchctl print "gui/$USER_ID/app.mochi.bridge" >/dev/null 2>&1
}

status_matches() {
  local product_version="$1"
  local bridge_version="$2"
  local status_version="$3"
  local control_version="$4"
  [[ -f "$STATUS" && ! -L "$STATUS" \
    && "$(/usr/bin/plutil -extract version raw -o - "$STATUS" 2>/dev/null)" == "$status_version" \
    && "$(/usr/bin/plutil -extract productVersion raw -o - "$STATUS" 2>/dev/null)" == "$product_version" \
    && "$(/usr/bin/plutil -extract bridgeVersion raw -o - "$STATUS" 2>/dev/null)" == "$bridge_version" \
    && "$(/usr/bin/plutil -extract controlProtocolVersion raw -o - "$STATUS" 2>/dev/null)" == "$control_version" \
    && "$(/usr/bin/plutil -extract controlAvailable raw -o - "$STATUS" 2>/dev/null)" == true ]]
}

wait_for_status() {
  local product_version="$1"
  local bridge_version="$2"
  local status_version="$3"
  local control_version="$4"
  # Installation prepares the host, not a customer's Bot or remote accounts.
  # Fleet status has no top-level lifecycle; an empty roster is ready for setup.
  for _ in {1..80}; do
    if status_matches "$product_version" "$bridge_version" "$status_version" "$control_version"; then
      return 0
    fi
    /bin/sleep 0.25
  done
  return 1
}

rollback_on_error() {
  local exit_code=$?
  trap - EXIT
  [[ "$INSTALL_SUCCEEDED" == true ]] && exit "$exit_code"
  if [[ "$COMPONENTS_FINALIZED" == true ]] || mochi_transaction_finalized "$TRANSACTION_ROOT"; then
    echo "Mochi preparation committed; reopen Mochi to finish preparation (exit $exit_code)" >&2
    exit "$exit_code"
  fi
  if mochi_transaction_pending "$TRANSACTION_ROOT" && ! mochi_transaction_finalized "$TRANSACTION_ROOT"; then
    if [[ -f "$UPDATE_HOLD" ]]; then
      "$UPDATE_HELPER" --stop || exit "$exit_code"
    else
      /bin/launchctl bootout "gui/$USER_ID/app.mochi.bridge" >/dev/null 2>&1 || true
    fi
    if ! mochi_recover_transaction "$INSTALLATION_MANIFEST"; then
      # Restarting a half-restored component set would run mixed versions.
      echo "Mochi could not restore its previous components and kept its installation journal; reopen Mochi to try again (exit $exit_code)" >&2
      exit "$exit_code"
    fi
  fi
  if [[ "$UPDATE_DAEMON_ADDED" == true ]]; then
    /bin/launchctl bootout system/app.mochi.update >/dev/null 2>&1 || true
  fi
  if [[ "$SERVICE_STOPPED" == true && "$SERVICE_WAS_LOADED" == true && -f "$PLIST" ]]; then
    # A failed/busy handoff may have left the old Bridge running. Never remove
    # its socket or status. kickstart without -k starts a stopped loaded job but
    # does not interrupt a live one; a fresh Bridge owns stale-file cleanup.
    if launchagent_loaded; then
      /bin/launchctl kickstart "gui/$USER_ID/app.mochi.bridge" >/dev/null 2>&1 || true
    else
      /bin/launchctl bootstrap "gui/$USER_ID" "$PLIST" >/dev/null 2>&1 || true
    fi
    if launchagent_loaded; then
      if [[ "$SERVICE_WAS_HEALTHY" == true ]]; then
        wait_for_status "$OLD_PRODUCT_VERSION" "$OLD_BRIDGE_VERSION" \
          "$OLD_STATUS_VERSION" "$OLD_CONTROL_VERSION" >/dev/null 2>&1 || true
      fi
    fi
  fi
  if [[ -f "$UPDATE_HOLD" ]]; then
    "$UPDATE_HELPER" --restored || {
      echo 'Mochi restoration is not verified; update hold remains in place' >&2
      exit "$exit_code"
    }
  fi
  if [[ "$UPDATE_MODE" != true && ! -f "$UPDATE_HOLD" && -x "$UPDATE_HELPER" \
    && "$(mochi_manifest_value "$UPDATE_ROOT/request.json" mode 2>/dev/null || true)" == repair ]]; then
    "$UPDATE_HELPER" --clean || true
  fi
  echo "Mochi preparation did not finish (exit $exit_code)" >&2
  exit "$exit_code"
}
trap rollback_on_error EXIT

require_directory() {
  local path="$1"
  local owner="$2"
  [[ -d "$path" && ! -L "$path" ]] || { echo "Unsafe directory: $path" >&2; return 1; }
  [[ "$(/usr/bin/stat -f '%Su' "$path")" == "$owner" ]] || {
    echo "Unexpected directory owner: $path" >&2
    return 1
  }
}

# A directory macOS keeps in the account's home: created private when absent,
# otherwise left exactly as the account has it.
require_user_directory() {
  local path="$1"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    as_recipient_user /bin/mkdir -m 700 "$path" || return 1
  fi
  require_directory "$path" "$RECIPIENT_USER"
}

# A directory Mochi owns in the account's home, private to that account.
prepare_user_directory() {
  local path="$1"
  require_user_directory "$path" || return 1
  as_recipient_user /bin/chmod 700 "$path"
}

compare_semver() {
  local left="$1" right="$2"
  local left_major left_minor left_patch right_major right_minor right_patch pair a b
  IFS=. read -r left_major left_minor left_patch <<<"$left"
  IFS=. read -r right_major right_minor right_patch <<<"$right"
  for pair in "$left_major:$right_major" "$left_minor:$right_minor" "$left_patch:$right_patch"; do
    a="${pair%%:*}"
    b="${pair#*:}"
    if ((10#$a < 10#$b)); then /bin/echo -1; return; fi
    if ((10#$a > 10#$b)); then /bin/echo 1; return; fi
  done
  /bin/echo 0
}

validate_previous_installation() {
  local installed_record="$PRODUCT_ROOT/Installation/installed.json"
  local previous_state=0
  if [[ -e "$installed_record" || -L "$installed_record" ]]; then
    [[ -f "$installed_record" && ! -L "$installed_record" ]] || {
      echo 'Installed Mochi installation record is unsafe' >&2
      return 1
    }
    [[ "$(mochi_manifest_value "$installed_record" schemaVersion)" == "$(mochi_manifest_value "$INSTALLATION_MANIFEST" schemaVersion)" ]] || {
      echo 'Installed Mochi installation contract is unsupported' >&2
      return 1
    }
    mochi_contract_structure_matches "$INSTALLATION_MANIFEST" "$installed_record"
    previous_state="$(mochi_manifest_value "$installed_record" installationState.schemaVersion)"
    [[ "$previous_state" =~ ^[0-9]+$ && "$previous_state" -le 1 ]] || {
      echo 'Installed Mochi state is newer than this package can safely read' >&2
      return 1
    }
    local installed_version
    installed_version="$(mochi_manifest_value "$installed_record" productVersion)"
    [[ "$(compare_semver "$installed_version" "$PRODUCT_VERSION")" -le 0 ]] || {
      echo 'Mochi refuses to downgrade over a newer installed product' >&2
      return 1
    }
    if [[ "$UPDATE_MODE" != true && "$installed_version" != "$PRODUCT_VERSION" ]] \
      && previous_installation_is_live; then
      echo 'Use Mochi’s in-app update so the App and its components share one recoverable transaction' >&2
      return 1
    fi
  fi
  if [[ "$previous_state" -lt 1 ]]; then
    [[ "$(mochi_manifest_value "$INSTALLATION_MANIFEST" installationState.migrations.0.from)" == "$previous_state" \
      && "$(mochi_manifest_value "$INSTALLATION_MANIFEST" installationState.migrations.0.to)" == 1 ]] || {
      echo 'Mochi has no declared installation-state migration for this product' >&2
      return 1
    }
  fi
}

if launchagent_loaded; then SERVICE_WAS_LOADED=true; fi
# A keep-data uninstall retains the installation record with the user's data but
# removes the sudoers rule, the LaunchAgent and every component. With neither the
# rule nor a loaded service the record describes data to keep, not an installation
# to repair or update: there is no service to hand off from, and the update helper
# checks the recipient account against that rule before anything else. Reopening
# Mochi then prepares afresh over the retained data.
previous_installation_is_live() {
  [[ -n "$INSTALLED_FOR" || "$SERVICE_WAS_LOADED" == true ]]
}
OLD_PRODUCT_VERSION="$PRODUCT_VERSION"
OLD_BRIDGE_VERSION="$EXPECTED_BRIDGE_VERSION"
OLD_STATUS_VERSION="$EXPECTED_STATUS_VERSION"
OLD_CONTROL_VERSION="$EXPECTED_CONTROL_VERSION"
OLD_INSTALLATION_RECORD="$PRODUCT_ROOT/Installation/installed.json"
if [[ -f "$OLD_INSTALLATION_RECORD" && ! -L "$OLD_INSTALLATION_RECORD" ]]; then
  OLD_PRODUCT_VERSION="$(mochi_manifest_value "$OLD_INSTALLATION_RECORD" productVersion 2>/dev/null || /bin/echo "$PRODUCT_VERSION")"
  OLD_BRIDGE_VERSION="$(mochi_manifest_value "$OLD_INSTALLATION_RECORD" compatibility.bridgeVersion 2>/dev/null || /bin/echo "$EXPECTED_BRIDGE_VERSION")"
  OLD_STATUS_VERSION="$(mochi_manifest_value "$OLD_INSTALLATION_RECORD" compatibility.statusVersion 2>/dev/null || /bin/echo "$EXPECTED_STATUS_VERSION")"
  OLD_CONTROL_VERSION="$(mochi_manifest_value "$OLD_INSTALLATION_RECORD" compatibility.controlProtocolVersion 2>/dev/null || /bin/echo "$EXPECTED_CONTROL_VERSION")"
fi
if [[ "$SERVICE_WAS_LOADED" == true ]] \
  && status_matches "$OLD_PRODUCT_VERSION" "$OLD_BRIDGE_VERSION" "$OLD_STATUS_VERSION" "$OLD_CONTROL_VERSION"; then
  SERVICE_WAS_HEALTHY=true
fi

if [[ ! -e "$UPDATE_ROOT" ]]; then /usr/bin/install -d -o root -g wheel -m 700 "$UPDATE_ROOT"; fi
[[ -d "$UPDATE_ROOT" && ! -L "$UPDATE_ROOT" && "$(/usr/bin/stat -f '%Su:%Lp' "$UPDATE_ROOT")" == root:700 ]] || exit 1
if [[ -n "$UPDATE_HELPER" ]]; then
  STAGED_UPDATE_HELPER="$(mochi_component_source_by_id "$INSTALLATION_MANIFEST" product-bin)/mochi-update"
  /usr/bin/codesign --verify --strict "$STAGED_UPDATE_HELPER"
  /bin/cp "$STAGED_UPDATE_HELPER" "$UPDATE_HELPER"
  /usr/sbin/chown root:wheel "$UPDATE_HELPER"
  /bin/chmod 700 "$UPDATE_HELPER"
fi

# An interrupted commit restores its recorded predecessor before a new
# bounded commit begins; a failed restoration stops here with its journal.
if mochi_transaction_pending "$TRANSACTION_ROOT" || [[ -f "$UPDATE_HOLD" ]]; then
  # A finalized set may already be accepting new work. Only finish cleanup;
  # never stop it or restore its predecessor because cleanup was interrupted.
  if ! mochi_transaction_finalized "$TRANSACTION_ROOT"; then
    if [[ -f "$UPDATE_HOLD" ]]; then "$UPDATE_HELPER" --stop
    else /bin/launchctl bootout "gui/$USER_ID/app.mochi.bridge" >/dev/null 2>&1 || true; fi
    SERVICE_STOPPED=true
  fi
  mochi_recover_transaction "$INSTALLATION_MANIFEST"
  if [[ "$MOCHI_RECOVERY" == completed ]]; then
    if ! launchagent_loaded; then /bin/launchctl bootstrap "gui/$USER_ID" "$PLIST"; fi
    if [[ -f "$UPDATE_HOLD" ]]; then "$UPDATE_HELPER" --health; fi
    mochi_after_finalize
    if [[ "$UPDATE_MODE" != true ]]; then "$UPDATE_HELPER" --clean; fi
    INSTALL_SUCCEEDED=true
    exit 0
  fi
  if [[ -f "$UPDATE_HOLD" ]]; then
    as_recipient_user /bin/rm -f "$STATUS" "$CONTROL_SOCKET"
    /bin/launchctl bootstrap "gui/$USER_ID" "$PLIST"
    "$UPDATE_HELPER" --restored
    SERVICE_STOPPED=false
    SERVICE_WAS_LOADED=true
  fi
fi

validate_previous_installation

require_directory "$USER_HOME" "$RECIPIENT_USER"
require_directory "$USER_HOME/Library" "$RECIPIENT_USER"
require_user_directory "$USER_HOME/Library/Application Support"
require_user_directory "$USER_HOME/Library/Logs"
require_user_directory "$USER_HOME/Library/LaunchAgents"
prepare_user_directory "$DATA_ROOT"
prepare_user_directory "$LOG_ROOT"
if /usr/bin/find "$DATA_ROOT" "$LOG_ROOT" -xdev -type l -print -quit | /usr/bin/grep -q .; then
  echo 'Mochi data directories must not contain symbolic links' >&2
  exit 1
fi

# The runtime account owns a primary group of its own. In staff it could enter
# the owner's home and read every group-readable file there.
RUNTIME_GID="$(/usr/bin/dscl . -read "/Groups/${RUNTIME_GROUP}" PrimaryGroupID 2>/dev/null | /usr/bin/awk '{print $2}' || true)"
if [[ -z "$RUNTIME_GID" ]]; then
  RUNTIME_GID="$(/usr/bin/dscl . -list /Groups PrimaryGroupID | /usr/bin/awk '$2 >= 401 && $2 < 500 { used[$2]=1 } END { for (i=401;i<500;i++) if (!used[i]) { print i; exit } }')"
  [[ -n "$RUNTIME_GID" ]] || { echo 'No hidden service group ID is available' >&2; exit 1; }
  /usr/bin/dscl . -create "/Groups/${RUNTIME_GROUP}" RealName 'Mochi Pi Runtime'
  /usr/bin/dscl . -create "/Groups/${RUNTIME_GROUP}" PrimaryGroupID "$RUNTIME_GID"
fi
[[ "$RUNTIME_GID" =~ ^[0-9]+$ && "$RUNTIME_GID" -ge 401 && "$RUNTIME_GID" -lt 500 ]] || {
  echo 'Mochi runtime group has an invalid GID' >&2
  exit 1
}
if ! /usr/bin/id -u "$RUNTIME_USER" >/dev/null 2>&1; then
  NEXT_UID="$(/usr/bin/dscl . -list /Users UniqueID | /usr/bin/awk '$2 >= 401 && $2 < 500 { used[$2]=1 } END { for (i=401;i<500;i++) if (!used[i]) { print i; exit } }')"
  [[ -n "$NEXT_UID" ]] || { echo 'No hidden service user ID is available' >&2; exit 1; }
  /usr/bin/dscl . -create "/Users/${RUNTIME_USER}"
  /usr/bin/dscl . -create "/Users/${RUNTIME_USER}" RealName 'Mochi Pi Runtime'
  /usr/bin/dscl . -create "/Users/${RUNTIME_USER}" PrimaryGroupID "$RUNTIME_GID"
  /usr/bin/dscl . -create "/Users/${RUNTIME_USER}" NFSHomeDirectory "$RUNTIME_HOME"
  /usr/bin/dscl . -create "/Users/${RUNTIME_USER}" UserShell /usr/bin/false
  /usr/bin/dscl . -create "/Users/${RUNTIME_USER}" IsHidden 1
  /usr/bin/dscl . -create "/Users/${RUNTIME_USER}" UniqueID "$NEXT_UID"
fi
RUNTIME_UID="$(/usr/bin/id -u "$RUNTIME_USER")"
[[ "$RUNTIME_UID" -ge 401 && "$RUNTIME_UID" -lt 500 ]] || { echo 'Mochi runtime user has an invalid UID' >&2; exit 1; }
for ATTRIBUTE_EXPECTED in \
  "NFSHomeDirectory:$RUNTIME_HOME" 'UserShell:/usr/bin/false' "PrimaryGroupID:$RUNTIME_GID" 'IsHidden:1'; do
  ATTRIBUTE="${ATTRIBUTE_EXPECTED%%:*}"
  EXPECTED="${ATTRIBUTE_EXPECTED#*:}"
  # Native attributes include a namespace, e.g. dsAttrTypeNative:IsHidden: 1.
  # Strip the complete attribute label, retaining every value for strict comparison.
  ACTUAL="$(/usr/bin/dscl . -read "/Users/${RUNTIME_USER}" "$ATTRIBUTE" | /usr/bin/sed 's/^[^[:space:]]*: //')"
  [[ "$ACTUAL" == "$EXPECTED" ]] || { echo "Mochi runtime user $ATTRIBUTE is invalid" >&2; exit 1; }
done
if /usr/bin/id -Gn "$RUNTIME_USER" | /usr/bin/grep -qwE 'admin|staff'; then
  echo 'Mochi runtime user must not belong to the admin or staff group' >&2
  exit 1
fi
# The runtime account owns its home, so root never follows a link it could
# have placed there: directories are created in one step and changed with -h.
for RUNTIME_DIRECTORY in "$RUNTIME_HOME" "$RUNTIME_CWD"; do
  if [[ ! -e "$RUNTIME_DIRECTORY" && ! -L "$RUNTIME_DIRECTORY" ]]; then
    /bin/mkdir -m 700 "$RUNTIME_DIRECTORY"
    /usr/sbin/chown -h "$RUNTIME_USER:$RUNTIME_GROUP" "$RUNTIME_DIRECTORY"
  fi
  [[ -d "$RUNTIME_DIRECTORY" && ! -L "$RUNTIME_DIRECTORY" \
    && "$(/usr/bin/stat -f '%Su' "$RUNTIME_DIRECTORY")" == "$RUNTIME_USER" ]] || {
    echo "Mochi runtime directory is unsafe or has an unexpected owner: $RUNTIME_DIRECTORY" >&2
    exit 1
  }
  /bin/chmod -h 700 "$RUNTIME_DIRECTORY"
done
if /usr/bin/find "$RUNTIME_HOME" -xdev -type l -print -quit | /usr/bin/grep -q .; then
  echo 'Mochi runtime home must not contain symbolic links' >&2
  exit 1
fi

# Bridge owns the material root's access policy and establishes it at every
# start. Only root can safely hand it the parent in world-writable `/Users/Shared/`.
mochi_adopt_shared_directory /Users/Shared/mochi "$RECIPIENT_USER"

PREPARED_SUDOERS="$(mochi_component_source_by_id "$INSTALLATION_MANIFEST" runtime-sudoers)"
PREPARED_PLIST="$(mochi_component_source_by_id "$INSTALLATION_MANIFEST" launch-agent)"
PREPARED_RECORD="$(mochi_component_source_by_id "$INSTALLATION_MANIFEST" installation-record)"
/bin/mkdir -p "$(/usr/bin/dirname "$PREPARED_SUDOERS")"
RUNTIME_SUDOERS="$(mochi_render_runtime_sudoers "$INSTALLATION_MANIFEST" "$RECIPIENT_USER" "$STAGED_WORKER")"
/bin/echo "$RUNTIME_SUDOERS" > "$PREPARED_SUDOERS"

/bin/cat > "$PREPARED_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>app.mochi.bridge</string>
<key>AssociatedBundleIdentifiers</key><string>$HOST_BUNDLE_IDENTIFIER</string>
<key>ProgramArguments</key><array><string>$PRODUCT_ROOT/bin/mochi-bridge</string></array>
<key>WorkingDirectory</key><string>/var/empty</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>@MOCHI_BRIDGE_PROCESS_TYPE@</string>
<key>Umask</key><integer>63</integer>
<key>EnvironmentVariables</key><dict>
<key>MOCHI_STRUCTURED_LOG_PATH</key><string>$LOG_ROOT/service.jsonl</string>
<key>MOCHI_PRODUCT_ROOT</key><string>$PRODUCT_ROOT</string>
<key>MOCHI_DATA_ROOT</key><string>$DATA_ROOT</string>
</dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
PLIST
/bin/cp "$INSTALLATION_MANIFEST" "$PREPARED_RECORD"
/usr/sbin/chown root:wheel "$PREPARED_SUDOERS" "$PREPARED_RECORD"
/usr/sbin/chown "$RECIPIENT_USER:staff" "$PREPARED_PLIST"
/bin/chmod 440 "$PREPARED_SUDOERS"
/bin/chmod 600 "$PREPARED_PLIST" "$PREPARED_RECORD"
/usr/sbin/visudo -cf "$PREPARED_SUDOERS" >/dev/null

# Every source, compatibility version, generated privileged artifact, target
# parent and its reachability, and same-filesystem rename is proven before a
# healthy service stops.
STAGED_APPLICATION="$(mochi_component_source_by_id "$INSTALLATION_MANIFEST" host-application)"
APPLICATION_COMMIT_MODE=replace-application
if [[ "$UPDATE_MODE" != true ]]; then
  APPLICATION_COMMIT_MODE=retain-application
  /usr/sbin/chown -R root:wheel "$APPLICATION_SOURCE"
fi
/usr/bin/ditto "$APPLICATION_SOURCE" "$STAGED_APPLICATION"
/usr/sbin/chown -R root:wheel "$STAGED_APPLICATION"
mochi_verify_components "$INSTALLATION_MANIFEST" source
mochi_prepare_destination_parents "$INSTALLATION_MANIFEST"
# Finish staging writes while the previous service can still accept work.
mochi_sync tree "$(mochi_payload_root "$INSTALLATION_MANIFEST")" "$UPDATE_HELPER"
if [[ "$UPDATE_MODE" == true ]]; then
  SERVICE_STOPPED=true
  "$UPDATE_HELPER" --handoff
elif [[ -f "$OLD_INSTALLATION_RECORD" ]] && previous_installation_is_live; then
  # A repair may restore an offline service, but it never cancels accepted
  # work in a running one. Busy/unsupported admission fails before commit.
  SERVICE_STOPPED=true
  "$UPDATE_HELPER" --repair "$USER_ID"
fi
if [[ "$SERVICE_STOPPED" != true ]]; then
  /bin/launchctl bootout "gui/$USER_ID/app.mochi.bridge" >/dev/null 2>&1 || true
  SERVICE_STOPPED=true
fi

mochi_commit_transaction "$INSTALLATION_MANIFEST" "$APPLICATION_COMMIT_MODE"
as_recipient_user /bin/rm -f "$STATUS" "$CONTROL_SOCKET"
/bin/launchctl bootstrap "gui/$USER_ID" "$PLIST"
wait_for_status "$PRODUCT_VERSION" "$EXPECTED_BRIDGE_VERSION" \
  "$EXPECTED_STATUS_VERSION" "$EXPECTED_CONTROL_VERSION" || {
  echo 'Mochi did not publish a compatible setup state' >&2
  exit 1
}
if [[ -f "$UPDATE_HOLD" ]]; then "$UPDATE_HELPER" --health; fi
# The existing service keeps serving this installation until its process exits;
# launchd starts the replaced executable on the next socket connection.
if ! /bin/launchctl print system/app.mochi.update >/dev/null 2>&1; then
  /bin/launchctl bootstrap system /Library/LaunchDaemons/app.mochi.update.plist
  UPDATE_DAEMON_ADDED=true
fi
mochi_finalize_transaction "$INSTALLATION_MANIFEST"
COMPONENTS_FINALIZED=true
if [[ "$UPDATE_MODE" != true ]]; then "$UPDATE_HELPER" --clean; fi
INSTALL_SUCCEEDED=true
trap - EXIT
