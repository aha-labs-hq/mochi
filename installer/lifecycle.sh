#!/bin/bash

# Shared native-package transaction engine. This file is sourced by the
# background-component package and its in-App uninstall action; it deliberately owns no
# customer connection policy. The host App shares the component journal.
#
# Every function checks each fallible step itself and returns 1 on failure.
# Callers run these functions under `||`, `if`, and (uninstall.sh) without
# errexit, where bash suspends `set -e` for the whole function body; an
# unchecked step would fail silently and the function would keep going.

MOCHI_INSTALL_TESTING="${MOCHI_INSTALL_TESTING:-0}"
MOCHI_INSTALL_TEST_ROOT="${MOCHI_INSTALL_TEST_ROOT:-}"
MOCHI_INSTALL_TEST_INTERRUPT_AFTER="${MOCHI_INSTALL_TEST_INTERRUPT_AFTER:-}"
MOCHI_INSTALL_TEST_TRACE_FILE="${MOCHI_INSTALL_TEST_TRACE_FILE:-}"
MOCHI_INSTALL_TEST_DURABILITY_TOOL="${MOCHI_INSTALL_TEST_DURABILITY_TOOL:-}"
MOCHI_INSTALL_BOUNDARY_COUNT=0
DEFAULT_MOCHI_RUNTIME_HOME="/Users/_mochi"
MOCHI_RUNTIME_HOME="${MOCHI_RUNTIME_HOME:-$DEFAULT_MOCHI_RUNTIME_HOME}"
MOCHI_CONSOLE_USER_HOME="${MOCHI_CONSOLE_USER_HOME:-}"
# Marks a system directory this installer created, so uninstall removes only
# directories Mochi created and nothing else has used since.
MOCHI_CREATED_DIRECTORY_ATTRIBUTE='app.mochi.installer.created'
# Set by mochi_recover_transaction: none, rolled-back, or completed.
MOCHI_RECOVERY=''
# The package's own manifest, once mochi_load_contract has read it.
MOCHI_CONTRACT=''

if [[ "$MOCHI_INSTALL_TESTING" == 1 ]]; then
  [[ "$(/usr/bin/id -u)" != 0 ]] || {
    echo 'Mochi installation test mode is forbidden for root' >&2
    return 1 2>/dev/null || exit 1
  }
  [[ -n "$MOCHI_INSTALL_TEST_ROOT" && "$MOCHI_INSTALL_TEST_ROOT" == /* \
    && -d "$MOCHI_INSTALL_TEST_ROOT" && ! -L "$MOCHI_INSTALL_TEST_ROOT" ]] || {
    echo 'Mochi installation test mode requires one existing absolute fixture root' >&2
    return 1 2>/dev/null || exit 1
  }
else
  [[ -z "$MOCHI_INSTALL_TEST_ROOT" \
    && -z "$MOCHI_INSTALL_TEST_INTERRUPT_AFTER" \
    && -z "$MOCHI_INSTALL_TEST_TRACE_FILE" \
    && -z "$MOCHI_INSTALL_TEST_DURABILITY_TOOL" ]] || {
    echo 'Mochi installation test controls are unavailable in a privileged install' >&2
    return 1 2>/dev/null || exit 1
  }
fi

mochi_sync() {
  local tool
  if [[ "$MOCHI_INSTALL_TESTING" == 1 ]]; then
    tool="$MOCHI_INSTALL_TEST_DURABILITY_TOOL"
  else
    tool="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && pwd)/mochi-file-sync"
  fi
  [[ -n "$tool" && -x "$tool" && ! -L "$tool" ]] || {
    echo 'Mochi requires its package-local durability utility' >&2
    return 1
  }
  "$tool" "$@"
}

mochi_manifest_value() {
  local manifest="$1"
  local key="$2"
  local name value
  if [[ -n "$MOCHI_CONTRACT" && "$manifest" == "$MOCHI_CONTRACT" ]]; then
    name="MOCHI_CONTRACT_${key//[^A-Za-z0-9]/_}"
    if [[ -n "${!name+set}" ]]; then
      printf '%s\n' "${!name}"
      return 0
    fi
  fi
  # macOS 14 writes missing-key diagnostics to stdout. Only successful values
  # belong in the data channel; optional inventory reads use the exit status.
  value="$(/usr/bin/plutil -extract "$key" raw -o - "$manifest")" || return 1
  printf '%s\n' "$value"
}

# The package's own manifest cannot change while the package runs, so every
# field a pass over the component inventory reads is read once, here, into
# this shell. Other manifests, such as an installed record that a commit
# replaces, are always read from disk.
mochi_load_contract() {
  local manifest="$1"
  local count index key value
  MOCHI_CONTRACT=''
  for key in workRoot payloadRoot transactionRoot productVersion transactionalComponentCount; do
    value="$(/usr/bin/plutil -extract "$key" raw -o - "$manifest")" || return 1
    printf -v "MOCHI_CONTRACT_$key" '%s' "$value"
  done
  count="$MOCHI_CONTRACT_transactionalComponentCount"
  index=0
  while [[ "$index" -lt "$count" ]]; do
    for key in id source destinationScope destination kind verification; do
      value="$(/usr/bin/plutil -extract "transactionalComponents.$index.$key" raw -o - "$manifest")" || return 1
      printf -v "MOCHI_CONTRACT_transactionalComponents_${index}_$key" '%s' "$value"
    done
    index=$((index + 1))
  done
  MOCHI_CONTRACT="$manifest"
}

mochi_require_contract() {
  local manifest="$1"
  [[ -f "$manifest" && ! -L "$manifest" ]] || {
    echo "Mochi installation contract is missing: $manifest" >&2
    return 1
  }
  [[ "$(mochi_manifest_value "$manifest" schemaVersion)" == 6 ]] || {
    echo 'Mochi installation contract schema is unsupported' >&2
    return 1
  }
  [[ "$(mochi_manifest_value "$manifest" installationState.schemaVersion)" == 1 \
    && "$(mochi_manifest_value "$manifest" installationState.minimumReadableVersion)" == 0 ]] || {
    echo 'Mochi installation state contract is unsupported' >&2
    return 1
  }
  [[ "$(mochi_manifest_value "$manifest" hostApplication.id)" == app \
    && "$(mochi_manifest_value "$manifest" hostApplication.classification)" == immutable \
    && "$(mochi_manifest_value "$manifest" hostApplication.deliveredBy)" == disk-image \
    && "$(mochi_manifest_value "$manifest" hostApplication.destinationScope)" == system \
    && "$(mochi_manifest_value "$manifest" hostApplication.destination)" == /Applications/Mochi.app \
    && "$(mochi_manifest_value "$manifest" hostApplication.kind)" == directory \
    && "$(mochi_manifest_value "$manifest" hostApplication.bundleIdentifier)" == app.mochi.companion \
    && "$(mochi_manifest_value "$manifest" hostApplication.embeddedPackage)" == Contents/Resources/Mochi-Setup.pkg \
    && "$(mochi_manifest_value "$manifest" hostApplication.verification)" == host-application \
    && "$(mochi_manifest_value "$manifest" hostApplication.keepData)" == remove \
    && "$(mochi_manifest_value "$manifest" hostApplication.deleteAll)" == remove ]] || {
    echo 'Mochi host application contract is unsupported' >&2
    return 1
  }
  local work
  work="$(mochi_manifest_value "$manifest" workRoot)" || return 1
  [[ "$work" == /* && "$(mochi_manifest_value "$manifest" payloadRoot)" == "$work/Payload" \
    && "$(mochi_manifest_value "$manifest" transactionRoot)" == "$work/Transaction" ]] || {
    echo 'Mochi installation work-root contract is unsupported' >&2
    return 1
  }
  local declared actual
  declared="$(mochi_manifest_value "$manifest" transactionalComponentCount)" || return 1
  actual=0
  while mochi_manifest_value "$manifest" "transactionalComponents.$actual.id" >/dev/null 2>&1; do
    actual=$((actual + 1))
  done
  [[ "$declared" == "$actual" && "$actual" -gt 0 ]] || {
    echo 'Mochi transactional component inventory is inconsistent' >&2
    return 1
  }
}

mochi_contract_structure_matches() {
  local expected="$1"
  local actual="$2"
  mochi_require_contract "$actual" || return 1
  local key
  for key in payloadRoot transactionRoot \
    installationState.schemaVersion installationState.minimumReadableVersion \
    installationState.migrations.0.id installationState.migrations.0.from installationState.migrations.0.to \
    transactionalComponentCount externalArtifactCount; do
    [[ "$(mochi_manifest_value "$expected" "$key")" == "$(mochi_manifest_value "$actual" "$key")" ]] || {
      echo "Installed Mochi installation contract drifted at $key" >&2
      return 1
    }
  done
  for key in id classification deliveredBy destinationScope destination kind bundleIdentifier \
    embeddedPackage verification keepData deleteAll; do
    [[ "$(mochi_manifest_value "$expected" "hostApplication.$key")" \
      == "$(mochi_manifest_value "$actual" "hostApplication.$key")" ]] || {
      echo "Installed Mochi host application contract drifted at $key" >&2
      return 1
    }
  done
  local count index field cleanup expected_cleanup actual_cleanup
  count="$(mochi_manifest_value "$expected" transactionalComponentCount)" || return 1
  index=0
  while [[ "$index" -lt "$count" ]]; do
    for field in id classification stagedBy source destinationScope destination kind verification keepData deleteAll; do
      [[ "$(mochi_manifest_value "$expected" "transactionalComponents.$index.$field")" \
        == "$(mochi_manifest_value "$actual" "transactionalComponents.$index.$field")" ]] || {
        echo "Installed Mochi component contract drifted at $index.$field" >&2
        return 1
      }
    done
    index=$((index + 1))
  done
  # A newer package may declare additional product-owned mutable roots. Every
  # pre-existing entry and policy must still match exactly; removal/reordering
  # or changing a prior target never becomes a silent migration.
  count="$(mochi_manifest_value "$actual" retainedRootCount)" || return 1
  local expected_count
  expected_count="$(mochi_manifest_value "$expected" retainedRootCount)" || return 1
  [[ "$count" =~ ^[0-9]+$ && "$count" -le "$expected_count" ]] || return 1
  index=0
  while [[ "$index" -lt "$count" ]]; do
    for field in id classification scope path keepData deleteAll; do
      [[ "$(mochi_manifest_value "$expected" "retainedRoots.$index.$field")" \
        == "$(mochi_manifest_value "$actual" "retainedRoots.$index.$field")" ]] || {
        echo "Installed Mochi retained-root contract drifted at $index.$field" >&2
        return 1
      }
    done
    cleanup=0
    while true; do
      expected_cleanup="$(mochi_manifest_value "$expected" "retainedRoots.$index.cleanup.$cleanup" 2>/dev/null || true)"
      actual_cleanup="$(mochi_manifest_value "$actual" "retainedRoots.$index.cleanup.$cleanup" 2>/dev/null || true)"
      [[ "$expected_cleanup" == "$actual_cleanup" ]] || {
        echo "Installed Mochi cleanup contract drifted at $index.$cleanup" >&2
        return 1
      }
      [[ -n "$expected_cleanup" ]] || break
      cleanup=$((cleanup + 1))
    done
    index=$((index + 1))
  done
  count="$(mochi_manifest_value "$expected" externalArtifactCount)" || return 1
  index=0
  while [[ "$index" -lt "$count" ]]; do
    for field in id classification kind identity keepData deleteAll; do
      [[ "$(mochi_manifest_value "$expected" "externalArtifacts.$index.$field")" \
        == "$(mochi_manifest_value "$actual" "externalArtifacts.$index.$field")" ]] || {
        echo "Installed Mochi external-artifact contract drifted at $index.$field" >&2
        return 1
      }
    done
    index=$((index + 1))
  done
}

mochi_system_path() {
  local path="$1"
  [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *'/../'* && "$path" != */.. ]] || {
    echo "Unsafe Mochi system path: $path" >&2
    return 1
  }
  if [[ "$MOCHI_INSTALL_TESTING" == 1 ]]; then
    printf '%s\n' "$MOCHI_INSTALL_TEST_ROOT$path"
  else
    printf '%s\n' "$path"
  fi
}

mochi_scoped_path() {
  local scope="$1"
  local path="$2"
  case "$scope" in
    system)
      mochi_system_path "$path"
      ;;
    consoleUserHome)
      [[ -n "$MOCHI_CONSOLE_USER_HOME" && "$path" != /* && "$path" != *$'\n'* \
        && "$path" != ../* && "$path" != */../* ]] || {
        echo "Unsafe Mochi console-user path: $path" >&2
        return 1
      }
      mochi_system_path "$MOCHI_CONSOLE_USER_HOME/$path"
      ;;
    runtimeHome)
      [[ "$path" != /* && "$path" != *$'\n'* && "$path" != ../* && "$path" != */../* ]] || {
        echo "Unsafe Mochi runtime path: $path" >&2
        return 1
      }
      if [[ "$path" == . ]]; then
        mochi_system_path "$MOCHI_RUNTIME_HOME"
      else
        mochi_system_path "$MOCHI_RUNTIME_HOME/$path"
      fi
      ;;
    *)
      echo "Unsupported Mochi installation path scope: $scope" >&2
      return 1
      ;;
  esac
}

mochi_work_root() {
  local work
  work="$(mochi_manifest_value "$1" workRoot)" || return 1
  mochi_system_path "$work"
}

mochi_payload_root() {
  local payload
  payload="$(mochi_manifest_value "$1" payloadRoot)" || return 1
  mochi_system_path "$payload"
}

mochi_transaction_root() {
  local transaction
  transaction="$(mochi_manifest_value "$1" transactionRoot)" || return 1
  mochi_system_path "$transaction"
}

mochi_component_source() {
  local manifest="$1"
  local index="$2"
  local source payload
  source="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.source")" || return 1
  [[ "$source" != /* && "$source" != *$'\n'* && "$source" != ../* && "$source" != */../* ]] || {
    echo "Unsafe Mochi component source: $source" >&2
    return 1
  }
  payload="$(mochi_payload_root "$manifest")" || return 1
  printf '%s\n' "$payload/$source"
}

mochi_component_destination() {
  local manifest="$1"
  local index="$2"
  local scope destination
  scope="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.destinationScope")" || return 1
  destination="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.destination")" || return 1
  mochi_scoped_path "$scope" "$destination"
}

mochi_component_index() {
  local manifest="$1"
  local expected="$2"
  local count index
  count="$(mochi_manifest_value "$manifest" transactionalComponentCount)" || return 1
  index=0
  while [[ "$index" -lt "$count" ]]; do
    if [[ "$(mochi_manifest_value "$manifest" "transactionalComponents.$index.id")" == "$expected" ]]; then
      printf '%s\n' "$index"
      return 0
    fi
    index=$((index + 1))
  done
  echo "Mochi installation contract has no component named $expected" >&2
  return 1
}

mochi_component_source_by_id() {
  local index
  index="$(mochi_component_index "$1" "$2")" || return 1
  mochi_component_source "$1" "$index"
}

mochi_component_destination_by_id() {
  local index
  index="$(mochi_component_index "$1" "$2")" || return 1
  mochi_component_destination "$1" "$index"
}

# A destination in a home an account owns, which that account can redirect at
# any moment by swapping its directories for links; nothing for a system path.
mochi_component_account_path() {
  local scope
  scope="$(mochi_manifest_value "$1" "transactionalComponents.$2.destinationScope")" || return 1
  [[ "$scope" == system ]] || mochi_component_destination "$1" "$2"
}

mochi_host_application_destination() {
  local scope destination
  scope="$(mochi_manifest_value "$1" hostApplication.destinationScope)" || return 1
  destination="$(mochi_manifest_value "$1" hostApplication.destination)" || return 1
  mochi_scoped_path "$scope" "$destination"
}

# Match the installed executable and its recipient, never a display name that
# another build or account can share. A failed inventory cannot prove exit.
mochi_host_application_processes() {
  local executable="$1" user_id="$2" snapshot pid owner command
  snapshot="$(/bin/ps -axww -o pid=,uid=,comm=)" || return 1
  while read -r pid owner command; do
    if [[ "$owner" == "$user_id" && "$command" == "$executable" ]]; then
      printf '%s\n' "$pid"
    fi
  done <<< "$snapshot"
  return 0
}

# The App's normal quit may need the still-running Bridge or decline because
# settings are unsaved. Do not remove its resources or stop services until it
# has actually exited; cancellation leaves the installation intact.
mochi_stop_host_application() {
  local manifest="$1" user_id="$2" executable pids pid owner command current attempt
  [[ "$user_id" =~ ^[0-9]+$ && "$user_id" -gt 0 ]] || return 1
  executable="$(mochi_host_application_destination "$manifest")/Contents/MacOS/Mochi" || return 1
  pids="$(mochi_host_application_processes "$executable" "$user_id")" || return 1
  for pid in $pids; do
    current="$(/bin/ps -ww -p "$pid" -o uid=,comm=)" || continue
    read -r owner command <<< "$current"
    if [[ "$owner" == "$user_id" && "$command" == "$executable" ]]; then
      /bin/kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for ((attempt = 0; attempt < 20; attempt++)); do
    pids="$(mochi_host_application_processes "$executable" "$user_id")" || return 1
    [[ -z "$pids" ]] && return 0
    /bin/sleep 0.5 || return 1
  done
  echo 'Mochi is still open. Quit Mochi, then retry uninstalling from Mochi. Nothing has been removed.' >&2
  return 1
}

# The directory holding an absolute path, without starting a process.
mochi_parent() {
  local parent="${1%/*}"
  printf '%s\n' "${parent:-/}"
}

# Enters the directory holding an absolute path and proves it is that
# directory; the caller then names the entry relative to it, so a link an
# account later swaps into its own directories cannot redirect root. Bash's
# own `pwd -P` resolves the remembered path again and would pass a link that
# cd followed and the account then replaced; /bin/pwd reports the directory
# actually entered. macOS's three immutable root aliases are the only
# permitted normalization.
mochi_enter_parent() {
  local path="$1" parent expected actual
  [[ "$path" == /* && "$path" != / && "$path" != */ && "$path" != *'/../'* ]] || return 1
  parent="${path%/*}"
  parent="${parent:-/}"
  expected="$parent"
  case "$expected" in
    /var|/var/*|/tmp|/tmp/*|/etc|/etc/*) expected="/private$expected" ;;
  esac
  cd "$parent" || return 1
  actual="$(/bin/pwd -P)" || return 1
  [[ "$actual" == "$expected" ]] || {
    echo "Mochi refuses a redirected directory: $parent" >&2
    return 1
  }
}

# Hold the verified parent as cwd during removal. A recipient-owned ancestor
# cannot redirect root cleanup through a symlink between checking and rm.
mochi_remove_owned_path() (
  local path="$1"
  [[ -e "$path" || -L "$path" ]] || return 0
  mochi_enter_parent "$path" || return 1
  /bin/rm -rf "./${path##*/}"
)

# launchd keeps the listener alive until the helper boots out. Unlink only its
# declared socket, after other cleanup succeeds, while the App can still recover.
mochi_remove_update_socket() {
  local manifest="$1" count index=0 path owner=0
  count="$(mochi_manifest_value "$manifest" retainedRootCount)" || return 1
  while [[ "$index" -lt "$count" ]]; do
    if [[ "$(mochi_manifest_value "$manifest" "retainedRoots.$index.id")" == update-socket ]]; then
      [[ "$(mochi_manifest_value "$manifest" "retainedRoots.$index.scope")" == system ]] || return 1
      path="$(mochi_system_path "$(mochi_manifest_value "$manifest" "retainedRoots.$index.path")")" || return 1
      [[ -e "$path" || -L "$path" ]] || return 0
      if [[ "$MOCHI_INSTALL_TESTING" == 1 ]]; then owner="$(/usr/bin/id -u)"; fi
      [[ -S "$path" && ! -L "$path" && "$(/usr/bin/stat -f '%u' "$path")" == "$owner" ]] || {
        echo "Mochi update socket has an unexpected owner or type: $path" >&2; return 1;
      }
      mochi_remove_owned_path "$path" || return 1
      [[ ! -e "$path" && ! -L "$path" ]]
      return $?
    fi
    index=$((index + 1))
  done
  echo 'Mochi installation contract does not declare its update socket' >&2
  return 1
}

mochi_boundary() {
  local label="$1"
  MOCHI_INSTALL_BOUNDARY_COUNT=$((MOCHI_INSTALL_BOUNDARY_COUNT + 1))
  if [[ -n "$MOCHI_INSTALL_TEST_TRACE_FILE" ]]; then
    /bin/echo "$MOCHI_INSTALL_BOUNDARY_COUNT $label" >> "$MOCHI_INSTALL_TEST_TRACE_FILE"
  fi
  if [[ -n "$MOCHI_INSTALL_TEST_INTERRUPT_AFTER" \
    && "$MOCHI_INSTALL_BOUNDARY_COUNT" == "$MOCHI_INSTALL_TEST_INTERRUPT_AFTER" ]]; then
    /bin/kill -KILL $$
  fi
}

mochi_atomic_text() {
  local path="$1"
  local value="$2"
  local temporary="$path.tmp.$$"
  printf '%s\n' "$value" > "$temporary" || return 1
  /bin/chmod 600 "$temporary" || return 1
  mochi_sync tree "$temporary" || return 1
  /bin/mv -f "$temporary" "$path" || return 1
  mochi_sync directory "$(mochi_parent "$path")" || return 1
  mochi_boundary "write:$path"
}

# rm -rf reports a partial failure but leaves the rest of the tree behind; the
# path must be gone before anything is moved into its place. A second argument
# repeats a path that lies in a directory an account owns; it is removed from
# inside that directory (mochi_enter_parent).
mochi_remove_tree() (
  local path="$1" target="$1"
  if [[ -n "${2:-}" ]]; then
    [[ "$2" == "$path" ]] && mochi_enter_parent "$path" || return 1
    target="./${path##*/}"
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    /bin/rm -rf "$target" || true
  fi
  [[ ! -e "$target" && ! -L "$target" ]] || {
    echo "Mochi could not remove $path" >&2
    return 1
  }
  [[ ! -d "$(mochi_parent "$target")" ]] || mochi_sync directory "$(mochi_parent "$target")"
)

# mv moves a source into a destination directory that still exists, nesting
# it; a component only ever moves onto an absent path, and -h replaces a link
# found there instead of following it. A third argument repeats whichever side
# lies in a directory an account owns; that side is named from inside its
# directory (mochi_enter_parent).
mochi_move() (
  local source="$1" destination="$2" from="$1" to="$2"
  case "${3:-}" in
    '') ;;
    "$source") mochi_enter_parent "$source" || return 1; from="./${source##*/}" ;;
    "$destination") mochi_enter_parent "$destination" || return 1; to="./${destination##*/}" ;;
    *) return 1 ;;
  esac
  [[ ! -e "$to" && ! -L "$to" ]] || {
    echo "Mochi refuses to move onto an existing path: $destination" >&2
    return 1
  }
  mochi_sync tree "$from" || return 1
  /bin/mv -h "$from" "$to" || {
    echo "Mochi could not move $source to $destination" >&2
    return 1
  }
  mochi_sync directory "$(mochi_parent "$from")" "$(mochi_parent "$to")"
)

mochi_verify_path_shape() {
  local path="$1"
  local kind="$2"
  if [[ "$kind" == directory ]]; then
    [[ -d "$path" && ! -L "$path" ]] || { echo "Invalid Mochi directory component: $path" >&2; return 1; }
    if /usr/bin/find "$path" -xdev -type l -print -quit | /usr/bin/grep -q .; then
      echo "Mochi component contains a symbolic link: $path" >&2
      return 1
    fi
  elif [[ "$kind" == file ]]; then
    [[ -f "$path" && ! -L "$path" ]] || { echo "Invalid Mochi file component: $path" >&2; return 1; }
  else
    echo "Unsupported Mochi component kind: $kind" >&2
    return 1
  fi
}

mochi_verify_component_semantics() {
  local manifest="$1"
  local index="$2"
  local path="$3"
  [[ "$MOCHI_INSTALL_TESTING" == 1 ]] && return 0
  local verification product_version bridge_version identity
  verification="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.verification")" || return 1
  product_version="$(mochi_manifest_value "$manifest" productVersion)" || return 1
  bridge_version="$(mochi_manifest_value "$manifest" compatibility.bridgeVersion)" || return 1
  case "$verification" in
    host-application)
      mochi_verify_host_application "$manifest" "$path"
      ;;
    update-daemon)
      [[ "$(/usr/bin/stat -f '%Su:%Lp' "$path")" == root:644 ]] \
        && /usr/bin/plutil -lint "$path" >/dev/null \
        && [[ "$(mochi_manifest_value "$path" Label)" == app.mochi.update \
          && "$(mochi_manifest_value "$path" ProgramArguments.0)" == '/Library/Application Support/Mochi/bin/mochi-update' \
          && "$(mochi_manifest_value "$path" Sockets.Listener.SockPathName)" == /var/run/app.mochi.update.sock ]]
      ;;
    product-bin)
      [[ "$("$path/mochi-bridge" --version)" == "mochi-bridge $bridge_version" ]] \
        && /usr/bin/codesign --verify --strict "$path/mochi-bridge" \
        && /usr/bin/codesign --verify --strict "$path/mochi-update" \
        && [[ "$("$path/mochi-update" --version)" == "mochi-update 1" ]] \
        && /usr/bin/codesign --verify --strict "$path/lark-cli" \
        && identity="$(/usr/bin/codesign -dv --verbose=2 "$path/lark-cli" 2>&1)" \
        && [[ "$identity" == *'Identifier=lark-cli'* && "$identity" == *'TeamIdentifier=JBRN9C6V7T'* ]]
      ;;
    product-resources)
      [[ "$(mochi_manifest_value "$path/product.json" version)" == "$product_version" ]] \
        && /usr/bin/cmp -s "$manifest" "$path/installation.json" \
        && [[ -s "$path/defaults/bot.toml" && -s "$path/defaults/AGENTS.md" && -d "$path/protocol" ]] \
        && "$(/usr/bin/dirname "$path")/bin/mochi-bridge" --validate-github-registration "$path/github-oauth.json"
      ;;
    runtime-worker)
      [[ "$("$path" --version)" == 'mochi-pi-runtime 11' ]] \
        && /usr/bin/codesign --verify --strict "$path"
      ;;
    notices)
      [[ -s "$path/THIRD_PARTY_NOTICES.txt" && -s "$path/lark-cli-LICENSE.txt" ]]
      ;;
    sudoers)
      [[ "$(/usr/bin/stat -f '%Su:%Lp' "$path")" == root:440 ]] \
        && /usr/sbin/visudo -cf "$path" >/dev/null
      ;;
    launch-agent)
      /usr/bin/plutil -lint "$path" >/dev/null \
        && [[ "$(mochi_manifest_value "$path" Label)" == app.mochi.bridge ]]
      ;;
    installation-record)
      /usr/bin/cmp -s "$manifest" "$path"
      ;;
    *)
      echo "Unsupported Mochi component verification: $verification" >&2
      return 1
      ;;
  esac || {
    echo "Mochi component failed $verification verification: $path" >&2
    return 1
  }
}

mochi_verify_host_application() {
  local manifest="$1"
  [[ "$MOCHI_INSTALL_TESTING" == 1 ]] && return 0
  local application control package
  application="${2:-$(mochi_host_application_destination "$manifest")}" || return 1
  mochi_verify_path_shape "$application" "$(mochi_manifest_value "$manifest" hostApplication.kind)" || return 1
  control="$application/Contents/Resources/MochiControlManifest.json"
  package="$application/$(mochi_manifest_value "$manifest" hostApplication.embeddedPackage)"
  # Rendered by the packager from the same release Team as the App's own gate.
  local host_requirement='@MOCHI_HOST_APPLICATION_REQUIREMENT@'
  local signature_arguments=(--verify --strict)
  [[ -z "$host_requirement" ]] || signature_arguments+=("-R=$host_requirement")
  /usr/bin/codesign "${signature_arguments[@]}" "$application" \
    && [[ "$(mochi_manifest_value "$application/Contents/Info.plist" CFBundleIdentifier)" \
      == "$(mochi_manifest_value "$manifest" hostApplication.bundleIdentifier)" \
      && "$(mochi_manifest_value "$application/Contents/Info.plist" CFBundleShortVersionString)" \
      == "$(mochi_manifest_value "$manifest" productVersion)" ]] \
    && [[ -f "$control" && ! -L "$control" \
      && "$(mochi_manifest_value "$control" schemaVersion)" == "$(mochi_manifest_value "$manifest" compatibility.schemaVersion)" \
      && "$(mochi_manifest_value "$control" serviceMode)" == installed \
      && "$(mochi_manifest_value "$control" productVersion)" == "$(mochi_manifest_value "$manifest" productVersion)" \
      && "$(mochi_manifest_value "$control" bridgeVersion)" == "$(mochi_manifest_value "$manifest" compatibility.bridgeVersion)" \
      && "$(mochi_manifest_value "$control" statusVersion)" == "$(mochi_manifest_value "$manifest" compatibility.statusVersion)" \
      && "$(mochi_manifest_value "$control" controlProtocolVersion)" == "$(mochi_manifest_value "$manifest" compatibility.controlProtocolVersion)" \
      && "$(mochi_manifest_value "$control" installedApplicationPath)" == "$(mochi_manifest_value "$manifest" hostApplication.destination)" \
      && "$(mochi_manifest_value "$control" embeddedSetupPackagePath)" == "$(mochi_manifest_value "$manifest" hostApplication.embeddedPackage)" ]] \
    && [[ -f "$package" && ! -L "$package" && -s "$package" ]] || {
    echo "Mochi host application failed verification: $application" >&2
    return 1
  }
}

# The App captures its UID before administrator authorization. PackageKit
# supplies the original package path; no console state or ambient environment
# is an account authority. Updates already have a root-owned authenticated request.
mochi_install_recipient() {
  local manifest="$1" package="$2" parent update recipient
  # PackageKit reports /private/tmp package paths using macOS's /tmp alias.
  case "$package" in /tmp/app.mochi.setup.*) package="/private$package" ;; esac
  parent="$(mochi_parent "$package")" || return 1
  if [[ "$parent" =~ ^/private/tmp/app[.]mochi[.]setup[.][A-Za-z0-9]{8}$ \
    && "$package" == "$parent/Mochi-Setup.pkg" ]]; then
    [[ -d "$parent" && ! -L "$parent" \
      && "$(/usr/bin/stat -f '%u:%Lp' "$parent")" == 0:700 \
      && -f "$package" && ! -L "$package" \
      && "$(/usr/bin/stat -f '%u:%Lp' "$package")" == 0:600 \
      && -f "$parent/recipient" && ! -L "$parent/recipient" \
      && "$(/usr/bin/stat -f '%u:%Lp' "$parent/recipient")" == 0:600 ]] || return 1
    recipient="$(/bin/cat "$parent/recipient")" || return 1
  else
    update="$(mochi_work_root "$manifest")/Update" || return 1
    [[ "$package" == "$update/Mochi.app/Contents/Resources/Mochi-Setup.pkg" \
      && -d "$update" && ! -L "$update" \
      && "$(/usr/bin/stat -f '%u:%Lp' "$update")" == 0:700 \
      && -f "$update/request.json" && ! -L "$update/request.json" \
      && "$(/usr/bin/stat -f '%u:%Lp' "$update/request.json")" == 0:600 \
      && "$(mochi_manifest_value "$update/request.json" version)" == "$(mochi_manifest_value "$manifest" productVersion)" \
      && -z "$(mochi_manifest_value "$update/request.json" mode 2>/dev/null || true)" ]] || return 1
    recipient="$(mochi_manifest_value "$update/request.json" uid)" || return 1
  fi
  mochi_recipient_user "$manifest" "$recipient" >/dev/null || return 1
  printf '%s\n' "$recipient"
}

mochi_recipient_user() {
  local manifest="$1" uid="$2" name home
  [[ "$uid" =~ ^[1-9][0-9]{2,9}$ ]] && (( uid >= 501 && uid <= 4294967294 )) || {
    echo 'Mochi requires the requesting App account' >&2; return 1;
  }
  name="$(/usr/bin/id -un "$uid")" || return 1
  mochi_require_bridge_user "$manifest" "$name" || return 1
  [[ "$(/usr/bin/id -u "$name")" == "$uid" ]] || return 1
  home="$(/usr/bin/dscl . -read "/Users/${name}" NFSHomeDirectory | /usr/bin/sed 's/^[^:]*: //')" || return 1
  [[ "$home" == "/Users/${name}" ]] || {
    echo 'Mochi requires the standard local macOS home directory' >&2; return 1;
  }
  printf '%s\n' "$name"
}

# Only the root-owned update helper can prepare this source. Ordinary first
# install/repair stages the exact App the user is already running. Both paths
# enter the same component journal, including the host App.
mochi_application_source() {
  local manifest="$1" update
  update="$(mochi_work_root "$manifest")/Update"
  if [[ -e "$update/request.json" || -L "$update/request.json" ]]; then
    [[ -d "$update" && ! -L "$update" \
      && "$(/usr/bin/stat -f '%Su:%Lp' "$update")" == root:700 \
      && -f "$update/request.json" && ! -L "$update/request.json" \
      && "$(/usr/bin/stat -f '%Su:%Lp' "$update/request.json")" == root:600 \
      && "$(mochi_manifest_value "$update/request.json" version)" == "$(mochi_manifest_value "$manifest" productVersion)" ]] || return 1
    # An uninstall retains a verified App copy for retry, not an update
    # candidate. Repair after a refused removal must use the installed App.
    case "$(mochi_manifest_value "$update/request.json" mode 2>/dev/null || true)" in
      repair|uninstall) mochi_host_application_destination "$manifest" ;;
      '') printf '%s\n' "$update/Mochi.app" ;;
      *) echo 'Mochi installation request has an unknown operation' >&2; return 1 ;;
    esac
  else
    mochi_host_application_destination "$manifest"
  fi
}

# System paths must remain reachable and irreplaceable by ordinary accounts.
# Administrators already have installation authority; existing administrator-
# owned directories (for example /usr/local/share) need not be taken over.
mochi_verify_reachable_ancestors() {
  local logical="$1"
  local directory physical expected actual metadata owner group mode groups acl fixture_owner
  fixture_owner=''
  if [[ "$MOCHI_INSTALL_TESTING" == 1 ]]; then
    # Unprivileged transaction fixtures model root ownership with their owner.
    fixture_owner="$(/usr/bin/id -u)" || return 1
  fi
  directory="$(mochi_parent "$logical")"
  while [[ "$directory" != / ]]; do
    physical="$(mochi_system_path "$directory")" || return 1
    [[ -d "$physical" ]] || { echo "Mochi requires the directory $directory" >&2; return 1; }
    expected="$physical"
    case "$expected" in
      /var|/var/*|/tmp|/tmp/*|/etc|/etc/*) expected="/private$expected" ;;
    esac
    actual="$(cd "$physical" && pwd -P)" || return 1
    [[ "$actual" == "$expected" ]] || {
      echo "Mochi refuses a redirected system directory: $directory" >&2
      return 1
    }
    metadata="$(/usr/bin/stat -L -f '%u %g %Mp%Lp' "$physical")" || return 1
    read -r owner group mode <<< "$metadata"
    [[ "$owner" =~ ^[0-9]+$ && "$group" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]+$ ]] || return 1
    if [[ "$owner" != 0 && "$owner" != "$fixture_owner" ]]; then
      groups="$(/usr/bin/id -G "$owner")" || return 1
      [[ " $groups " == *' 80 '* ]] || {
        echo "Mochi refuses a system directory owned by an ordinary account: $directory" >&2
        return 1
      }
    fi
    if (( (8#$mode & 8#0001) == 0 )); then
      echo "Mochi cannot reach $logical: $directory has mode $mode, which other accounts cannot search" >&2
      return 1
    fi
    if (( (8#$mode & 8#0002) != 0 && (8#$mode & 8#1000) == 0 )); then
      echo "Mochi cannot trust $logical: any account may replace entries in $directory (mode $mode)" >&2
      return 1
    fi
    if (( (8#$mode & 8#0020) != 0 && (8#$mode & 8#1002) != 8#1002 )) && [[ "$group" != 80 ]]; then
      echo "Mochi refuses ordinary group write access to a system directory: $directory" >&2
      return 1
    fi
    acl="$(/bin/ls -lde "$physical")" || return 1
    if ! /usr/bin/awk '
      /^[[:space:]]*[0-9]+: / && / allow / && /(^|[ ,])(write|append|delete|delete_child|add_file|add_subdirectory|writeattr|writeextattr|writesecurity|chown)([ ,]|$)/ { exit 1 }
    ' <<< "$acl"; then
      echo "Mochi refuses an additional write ACL on a system directory: $directory" >&2
      return 1
    fi
    directory="$(mochi_parent "$directory")"
  done
}

# Callers have already required the contract.
mochi_verify_components() {
  local manifest="$1"
  local location="$2"
  local count index path kind scope
  count="$(mochi_manifest_value "$manifest" transactionalComponentCount)" || return 1
  index=0
  while [[ "$index" -lt "$count" ]]; do
    if [[ "$location" == source ]]; then
      path="$(mochi_component_source "$manifest" "$index")" || return 1
    elif [[ "$location" == destination ]]; then
      path="$(mochi_component_destination "$manifest" "$index")" || return 1
      scope="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.destinationScope")" || return 1
      if [[ "$scope" == system ]]; then
        mochi_verify_reachable_ancestors \
          "$(mochi_manifest_value "$manifest" "transactionalComponents.$index.destination")" || return 1
      fi
    else
      echo "Unsupported Mochi verification location: $location" >&2
      return 1
    fi
    kind="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.kind")" || return 1
    mochi_verify_path_shape "$path" "$kind" || return 1
    mochi_verify_component_semantics "$manifest" "$index" "$path" || return 1
    index=$((index + 1))
  done
}

# Creates each missing directory above a system component as root:wheel 755,
# one level at a time: install -d gives only its last level the requested mode
# and leaves intermediates at the installer's umask 077, which no other account
# can enter. Each directory appears complete under its final name, carrying
# Mochi's mark. A directory that already exists is never changed.
mochi_ensure_system_directory() {
  local logical="$1"
  local physical parent temporary
  physical="$(mochi_system_path "$logical")" || return 1
  if [[ -d "$physical" ]]; then
    # Check existing authority before creating anything beneath it.
    mochi_verify_reachable_ancestors "$logical/.mochi-directory.new"
    return $?
  fi
  [[ ! -e "$physical" && ! -L "$physical" ]] || {
    echo "Mochi requires a directory at $logical" >&2
    return 1
  }
  parent="$(mochi_parent "$logical")"
  mochi_ensure_system_directory "$parent" || return 1
  # A fixed name: one installer runs at a time, and a leftover is replaced.
  temporary="$(mochi_parent "$physical")/.mochi-directory.new"
  mochi_remove_tree "$temporary" || return 1
  if [[ "$MOCHI_INSTALL_TESTING" == 1 ]]; then
    /usr/bin/install -d -m 755 "$temporary" || return 1
  else
    /usr/bin/install -d -m 755 -o root -g wheel "$temporary" || return 1
  fi
  /usr/bin/xattr -w "$MOCHI_CREATED_DIRECTORY_ATTRIBUTE" 1 "$temporary" || return 1
  mochi_move "$temporary" "$physical" || return 1
  mochi_boundary "create-directory:$logical"
}

mochi_prepare_destination_parents() {
  local manifest="$1"
  local count index scope logical source destination parent source_device destination_device
  count="$(mochi_manifest_value "$manifest" transactionalComponentCount)" || return 1
  index=0
  while [[ "$index" -lt "$count" ]]; do
    scope="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.destinationScope")" || return 1
    logical="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.destination")" || return 1
    source="$(mochi_component_source "$manifest" "$index")" || return 1
    destination="$(mochi_component_destination "$manifest" "$index")" || return 1
    parent="$(mochi_parent "$destination")"
    if [[ "$scope" == system ]]; then
      mochi_ensure_system_directory "$(mochi_parent "$logical")" || return 1
      mochi_verify_reachable_ancestors "$logical" || return 1
    else
      # An account's own directories are created by that account, never by root.
      [[ -d "$parent" && ! -L "$parent" ]] || {
        echo "Mochi requires the account directory $parent" >&2
        return 1
      }
    fi
    if [[ "$MOCHI_INSTALL_TESTING" != 1 ]]; then
      source_device="$(/usr/bin/stat -f '%d' "$source")" || return 1
      destination_device="$(/usr/bin/stat -f '%d' "$parent")" || return 1
      [[ "$source_device" == "$destination_device" ]] || {
        echo "Mochi component cannot be atomically installed across filesystems: $destination" >&2
        return 1
      }
    fi
    index=$((index + 1))
  done
}

# Replays an interrupted transaction from its journal. A finalized journal is
# only cleaned up once the installed set verifies; any other journal restores
# every started component's predecessor, newest first. Any failed step stops
# with the journal and every unrestored backup still in place, so the same
# package can retry, and sets nothing in MOCHI_RECOVERY.
mochi_recover_transaction() {
  local manifest="$1"
  local transaction payload path journal_count=0
  MOCHI_RECOVERY=''
  transaction="$(mochi_transaction_root "$manifest")" || return 1
  payload="$(mochi_payload_root "$manifest")" || return 1
  for path in "$transaction" "$transaction.finalized" "$transaction.restored"; do
    if [[ -e "$path" || -L "$path" ]]; then
      [[ -d "$path" && ! -L "$path" ]] || {
        echo 'Mochi installation journal must be a real directory' >&2
        return 1
      }
      journal_count=$((journal_count + 1))
    fi
  done
  [[ "$journal_count" -le 1 ]] || {
    echo 'Mochi installation has conflicting journals; all evidence is preserved' >&2
    return 1
  }
  # A journal is atomically retired before recursive deletion. Even if rm
  # deletes its markers first, the name permanently excludes rollback.
  if [[ -d "$transaction.finalized" ]]; then
    mochi_verify_components "$manifest" destination || return 1
    mochi_remove_tree "$payload" || return 1
    mochi_remove_tree "$transaction.finalized" || return 1
    MOCHI_RECOVERY=completed
    return 0
  fi
  if [[ -d "$transaction.restored" ]]; then
    mochi_remove_tree "$transaction.restored" || return 1
    MOCHI_RECOVERY=rolled-back
    return 0
  fi
  if [[ ! -e "$transaction" && ! -L "$transaction" ]]; then
    MOCHI_RECOVERY=none
    return 0
  fi
  [[ -d "$transaction" && ! -L "$transaction" ]] || {
    echo "Mochi installation journal is not a directory: $transaction" >&2
    return 1
  }
  # Account-scoped destinations resolve against the console account, so a
  # journal replays only for the account whose paths it recorded.
  [[ "$(/bin/cat "$transaction/account-home" 2>/dev/null)" == "$MOCHI_CONSOLE_USER_HOME" ]] || {
    echo 'The interrupted Mochi installation belongs to another macOS account; sign in as that account and reopen Mochi' >&2
    return 1
  }
  if [[ -f "$transaction/finalized" ]]; then
    mochi_verify_components "$manifest" destination || {
      echo "Mochi installation was finalized, but its installed components no longer verify; the journal is kept at $transaction" >&2
      return 1
    }
    # The journal goes last: until then its finalized mark still describes the state.
    mochi_remove_tree "$payload" || return 1
    mochi_boundary "remove:$payload"
    mochi_retire_transaction "$transaction" finalized || return 1
    mochi_boundary "remove:$transaction"
    MOCHI_RECOVERY=completed
    return 0
  fi
  local count index entry source destination account backup
  count="$(mochi_manifest_value "$manifest" transactionalComponentCount)" || return 1
  index=$((count - 1))
  while [[ "$index" -ge 0 ]]; do
    entry="$transaction/entries/$index"
    if [[ -f "$entry/started" ]]; then
      source="$(mochi_component_source "$manifest" "$index")" || return 1
      destination="$(mochi_component_destination "$manifest" "$index")" || return 1
      account="$(mochi_component_account_path "$manifest" "$index")" || return 1
      backup="$entry/original"
      if [[ ! -e "$source" && ! -L "$source" ]] && [[ -e "$destination" || -L "$destination" ]]; then
        /bin/mkdir -p "$(mochi_parent "$source")" || return 1
        mochi_move "$destination" "$source" "$account" || return 1
        mochi_boundary "restore-stage:$index"
      fi
      if [[ -e "$backup" || -L "$backup" ]]; then
        mochi_remove_tree "$destination" "$account" || return 1
        mochi_move "$backup" "$destination" "$account" || return 1
        mochi_boundary "restore-original:$index"
      elif [[ -f "$entry/original-absent" ]]; then
        mochi_remove_tree "$destination" "$account" || return 1
        mochi_boundary "restore-absence:$index"
      fi
    fi
    index=$((index - 1))
  done
  mochi_retire_transaction "$transaction" restored || return 1
  mochi_boundary "remove:$transaction"
  MOCHI_RECOVERY=rolled-back
}

mochi_retire_transaction() {
  local transaction="$1" state="$2"
  [[ "$state" == finalized || "$state" == restored ]] || return 1
  mochi_move "$transaction" "$transaction.$state" || return 1
  mochi_boundary "retire:$state"
  mochi_remove_tree "$transaction.$state" || return 1
}

mochi_transaction_pending() {
  local transaction="$1"
  [[ -e "$transaction" || -L "$transaction" \
    || -e "$transaction.finalized" || -L "$transaction.finalized" \
    || -e "$transaction.restored" || -L "$transaction.restored" ]]
}

mochi_transaction_finalized() {
  [[ -f "$1/finalized" || -d "$1.finalized" ]]
}

mochi_commit_transaction() {
  local manifest="$1"
  local application_mode="${2:-replace-application}"
  [[ "$application_mode" == replace-application || "$application_mode" == retain-application ]] || return 1
  local transaction journal
  transaction="$(mochi_transaction_root "$manifest")" || return 1
  if mochi_transaction_pending "$transaction" || [[ -L "$transaction" ]]; then
    echo 'Mochi installation transaction must be recovered before commit' >&2
    return 1
  fi
  [[ -n "$MOCHI_CONSOLE_USER_HOME" ]] || {
    echo 'Mochi installation transaction requires the console account home' >&2
    return 1
  }
  mochi_verify_components "$manifest" source || return 1
  mochi_prepare_destination_parents "$manifest" || return 1
  if [[ "$application_mode" == retain-application ]]; then
    local host_source host_destination
    host_source="$(mochi_component_source_by_id "$manifest" host-application)" || return 1
    host_destination="$(mochi_component_destination_by_id "$manifest" host-application)" || return 1
    mochi_verify_path_shape "$host_destination" directory || return 1
    /usr/bin/diff -qr "$host_source" "$host_destination" >/dev/null || {
      echo 'Mochi cannot retain an application that changed during preparation' >&2
      return 1
    }
  fi
  # The journal appears under its final name already naming its account, so
  # recovery never meets a journal that cannot say whose paths it holds.
  journal="$(mochi_parent "$transaction")/.Transaction.new"
  mochi_remove_tree "$journal" || return 1
  /bin/mkdir -p "$journal/entries" || return 1
  printf '%s\n' "$MOCHI_CONSOLE_USER_HOME" > "$journal/account-home" || return 1
  mochi_move "$journal" "$transaction" || return 1
  mochi_boundary "begin:$transaction"
  local count index entry source destination account
  count="$(mochi_manifest_value "$manifest" transactionalComponentCount)" || return 1
  index=0
  while [[ "$index" -lt "$count" ]]; do
    entry="$transaction/entries/$index"
    source="$(mochi_component_source "$manifest" "$index")" || return 1
    destination="$(mochi_component_destination "$manifest" "$index")" || return 1
    account="$(mochi_component_account_path "$manifest" "$index")" || return 1
    /bin/mkdir "$entry" || return 1
    mochi_sync directory "$transaction/entries" || return 1
    if [[ "$application_mode" == retain-application \
      && "$(mochi_manifest_value "$manifest" "transactionalComponents.$index.id")" == host-application ]]; then
      # Keep the running bundle's directory identity and resources reachable
      # throughout preparation/repair, even when its staged bytes are identical.
      mochi_atomic_text "$entry/retained" "$index" || return 1
      mochi_boundary "retain:$index"
      index=$((index + 1))
      continue
    fi
    mochi_atomic_text "$entry/started" "$index" || return 1
    if [[ -e "$destination" || -L "$destination" ]]; then
      mochi_move "$destination" "$entry/original" "$account" || return 1
      mochi_boundary "backup:$index"
    else
      mochi_atomic_text "$entry/original-absent" "$index" || return 1
    fi
    mochi_move "$source" "$destination" "$account" || return 1
    mochi_boundary "install:$index"
    index=$((index + 1))
  done
  mochi_verify_components "$manifest" destination || return 1
  mochi_atomic_text "$transaction/committed" "$(mochi_manifest_value "$manifest" productVersion)" || return 1
}

mochi_finalize_transaction() {
  local manifest="$1"
  local transaction payload work
  transaction="$(mochi_transaction_root "$manifest")" || return 1
  payload="$(mochi_payload_root "$manifest")" || return 1
  work="$(mochi_work_root "$manifest")" || return 1
  [[ -f "$transaction/committed" ]] || {
    echo 'Mochi installation transaction is not committed' >&2
    return 1
  }
  mochi_verify_components "$manifest" destination || return 1
  mochi_atomic_text "$transaction/finalized" "$(mochi_manifest_value "$manifest" productVersion)" || return 1
  # Once finalized, data can advance; rollback is permanently forbidden.
  if declare -F mochi_after_finalize >/dev/null; then mochi_after_finalize || return 1; fi
  mochi_remove_tree "$payload" || return 1
  mochi_boundary "remove:$payload"
  mochi_retire_transaction "$transaction" finalized || return 1
  mochi_boundary "remove:$transaction"
  # The work root also holds an unfinished uninstaller's markers; it goes only when empty.
  /bin/rmdir "$work" >/dev/null 2>&1 || true
}

# Removes the directories this installer created above system components once
# nothing else uses them, after the components themselves are gone. A missing
# directory is passed over; one without Mochi's mark, or with any entry left,
# belongs to someone else and ends the walk. Prints the directory it could not
# remove.
mochi_remove_created_directories() {
  local manifest="$1"
  local count index scope directory physical
  count="$(mochi_manifest_value "$manifest" transactionalComponentCount)" || return 1
  index=0
  while [[ "$index" -lt "$count" ]]; do
    scope="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.destinationScope")" || return 1
    if [[ "$scope" == system ]]; then
      directory="$(mochi_manifest_value "$manifest" "transactionalComponents.$index.destination")" || return 1
      directory="$(mochi_parent "$directory")"
      while [[ "$directory" != / ]]; do
        physical="$(mochi_system_path "$directory")" || return 1
        if [[ -e "$physical" || -L "$physical" ]]; then
          [[ -d "$physical" && ! -L "$physical" ]] || break
          /usr/bin/xattr -p "$MOCHI_CREATED_DIRECTORY_ATTRIBUTE" "$physical" >/dev/null 2>&1 || break
          [[ -z "$(/bin/ls -A "$physical")" ]] || break
          /bin/rmdir "$physical" || {
            printf '%s\n' "$directory"
            return 1
          }
        fi
        directory="$(mochi_parent "$directory")"
      done
    fi
    index=$((index + 1))
  done
}

# The sudoers principal must be an account the runtime policy accepts.
mochi_require_bridge_user() {
  local manifest="$1"
  local user="$2"
  local pattern
  pattern="$(mochi_manifest_value "$manifest" runtimeSudoers.bridgeUserPattern)" || return 1
  [[ "$user" != root && "$user" =~ $pattern ]] || {
    echo "Mochi cannot serve the macOS account '$user'" >&2
    return 1
  }
}

# Fills the manifest's runtime sudoers rule, the policy src/runtime/sudoers.ts
# owns, with the Bridge account and the digest of the staged worker.
mochi_render_runtime_sudoers() {
  local manifest="$1"
  local user="$2"
  local worker="$3"
  local rule digest
  mochi_require_bridge_user "$manifest" "$user" || return 1
  digest="$(/usr/bin/shasum -a 256 "$worker")" || return 1
  digest="${digest%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo 'Mochi could not digest the runtime worker' >&2; return 1; }
  rule="$(mochi_manifest_value "$manifest" runtimeSudoers.rule)" || return 1
  [[ "$rule" == '{bridgeUser} '*'sha256:{workerSha256} '* ]] || {
    echo 'Mochi runtime sudoers rule is unsupported' >&2
    return 1
  }
  rule="${rule//'{bridgeUser}'/$user}"
  rule="${rule//'{workerSha256}'/$digest}"
  printf '%s\n' "$rule"
}

# The account the installed sudoers rule lets start the worker, which is the
# account this installation serves. Prints nothing when no rule is installed.
mochi_installed_bridge_user() {
  local manifest="$1"
  local rule user
  rule="$(mochi_component_destination_by_id "$manifest" runtime-sudoers)" || return 1
  [[ -e "$rule" || -L "$rule" ]] || return 0
  [[ -f "$rule" && ! -L "$rule" ]] || { echo "Installed Mochi sudoers rule is unsafe: $rule" >&2; return 1; }
  user="$(/usr/bin/awk 'NR == 1 { print $1 }' "$rule")" || return 1
  mochi_require_bridge_user "$manifest" "$user" || return 1
  printf '%s\n' "$user"
}

# Gives one directory directly in the world-writable `/Users/Shared/` to an
# account. It is created in one step, or adopted only while it is a real
# directory that root or that account owns; another account's directory is
# refused, not taken over. The ownership change never follows a symbolic
# link, and the result is proven afterwards.
mochi_adopt_shared_directory() {
  local logical="$1"
  local owner="$2"
  local path current
  path="$(mochi_system_path "$logical")" || return 1
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    /bin/mkdir -m 700 "$path" || return 1
  fi
  [[ -d "$path" && ! -L "$path" ]] || { echo "Mochi requires a real directory at $logical" >&2; return 1; }
  current="$(/usr/bin/stat -f '%Su' "$path")" || return 1
  [[ "$current" == root || "$current" == "$owner" ]] || {
    echo "$logical belongs to the macOS account $current; remove it, then reopen Mochi" >&2
    return 1
  }
  /usr/sbin/chown -h "$owner" "$path" || return 1
  [[ -d "$path" && ! -L "$path" && "$(/usr/bin/stat -f '%Su' "$path")" == "$owner" ]] || {
    echo "$logical changed while Mochi took ownership of it" >&2
    return 1
  }
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  action="${1:-}"
  manifest="${2:-}"
  mochi_require_contract "$manifest"
  mochi_load_contract "$manifest"
  case "$action" in
    verify-source) mochi_verify_components "$manifest" source ;;
    verify-destination) mochi_verify_components "$manifest" destination ;;
    recover) mochi_recover_transaction "$manifest" ;;
    commit) mochi_commit_transaction "$manifest" ;;
    finalize) mochi_finalize_transaction "$manifest" ;;
    apply)
      mochi_recover_transaction "$manifest"
      [[ "$MOCHI_RECOVERY" != completed ]] || exit 0
      payload="$(mochi_payload_root "$manifest")"
      if [[ ! -e "$payload" && ! -L "$payload" ]]; then
        # A previous apply finished; only its verification is repeated.
        mochi_verify_components "$manifest" destination
        exit 0
      fi
      mochi_commit_transaction "$manifest"
      mochi_finalize_transaction "$manifest"
      ;;
    remove-created-directories) mochi_remove_created_directories "$manifest" ;;
    *)
      echo 'Usage: lifecycle.sh <verify-source|verify-destination|recover|commit|finalize|apply|remove-created-directories> manifest.json' >&2
      exit 64
      ;;
  esac
fi
