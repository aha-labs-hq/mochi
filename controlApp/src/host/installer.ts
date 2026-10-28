import { join } from "node:path";
import {
  developerIdApplicationRequirement,
  type PackageTrust,
  packageTrustFromEnvironment,
} from "../../build/packageTrust.ts";

export { developerIdApplicationRequirement } from "../../build/packageTrust.ts";

import { fail } from "../shared/problem.ts";
import {
  type DesktopEnvironment,
  exactFile,
  locationReady,
} from "./contract.ts";
import { type CommandRunner, run } from "./process.ts";

declare const MOCHI_PACKAGE_TRUST: string;

/** Baked in by the product packager; an App built without it cannot prepare an installed product. */
const BUILD_PACKAGE_TRUST = packageTrustFromEnvironment(
  typeof MOCHI_PACKAGE_TRUST === "string" && MOCHI_PACKAGE_TRUST
    ? MOCHI_PACKAGE_TRUST
    : undefined,
);

/** Exit status of the privileged step when the package is not the expected one. */
const PACKAGE_MISMATCH_STATUS = 65;

/** The in-process native host owns the system prompt and returns its structured error number. */
export type SetupAuthorization = (script: string) => Promise<number>;

/**
 * Root reads pkgutil's report on its private copy and accepts only a
 * distribution signature whose leaf is the expected Team's Developer ID Installer.
 */
export const INSTALLER_SIGNATURE_CHECK = `mochi_installer_signature_matches() {
  local team="$1" line status="" leaf=""
  while IFS= read -r line; do
    line="\${line#"\${line%%[![:space:]]*}"}"
    case "$line" in
      "Status: "*) status="\${line#Status: }" ;;
      "1. "*) leaf="\${line#1. }" ;;
    esac
  done
  [[ "$status" == "signed by a developer certificate issued by Apple for distribution" &&
    "$leaf" == "Developer ID Installer: "*" ($team)" ]]
}`;

/**
 * The package inside the App stays user-writable while the authorization
 * dialog is open, so root first copies it into its own private directory and
 * proves and installs only that copy.
 */
export const PRIVILEGED_SETUP_SCRIPT = `set -euo pipefail
umask 077
${INSTALLER_SIGNATURE_CHECK}
source_package="$1"
mode="$2"
team="\${3:-}"
if [[ "$mode" == development && -z "$team" ]]; then
  :
elif [[ "$mode" == developer-id && "$team" =~ ^[A-Z0-9]{10}$ ]]; then
  :
else
  echo "Mochi setup received an invalid package trust" >&2
  exit 64
fi
work="$(/usr/bin/mktemp -d /private/tmp/app.mochi.setup.XXXXXXXX)"
trap '/bin/rm -rf "$work"' EXIT
package="$work/Mochi-Setup.pkg"
/bin/cp "$source_package" "$package"
if [[ "$mode" == developer-id ]]; then
  if ! signature="$(/usr/sbin/pkgutil --check-signature "$package")" ||
    ! mochi_installer_signature_matches "$team" <<<"$signature"; then
    echo "Mochi setup package is not signed by Developer ID Installer team $team" >&2
    exit ${PACKAGE_MISMATCH_STATUS}
  fi
fi
/usr/sbin/installer -pkg "$package" -target /`;

/** Authorization executes the same embedded package as before; its transaction owns installation. */
export async function prepareProduct(
  env: DesktopEnvironment,
  command: CommandRunner = run,
  trust: PackageTrust | null = BUILD_PACKAGE_TRUST,
  authorize?: SetupAuthorization,
): Promise<"completed" | "cancelled"> {
  if (!locationReady(env) || env.manifest.serviceMode !== "installed")
    fail("application_location_invalid");
  if (!trust) fail("component_contract_unavailable");
  const path = join(env.application, env.manifest.embeddedSetupPackagePath);
  if (!exactFile(path, "file")) fail("component_contract_unavailable");
  const verification = await command([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    ...(trust.mode === "developer-id"
      ? [`-R=${developerIdApplicationRequirement(trust.teamId)}`]
      : []),
    env.application,
  ]);
  if (verification.code !== 0) fail("component_contract_mismatch");
  if (!authorize) fail("component_contract_unavailable");
  const status = await authorize(installerScript(path, trust));
  if (status === 0) return "completed";
  if (status === -128) return "cancelled";
  if (status === PACKAGE_MISMATCH_STATUS) fail("component_contract_mismatch");
  fail("product_preparation_failed");
}

export function installerScript(path: string, trust: PackageTrust): string {
  if (/[\r\n\0]/.test(path)) fail("component_contract_unavailable");
  const trustArguments =
    trust.mode === "developer-id"
      ? `developer-id ${validTeam(trust.teamId)}`
      : "development";
  return [
    "with timeout of 600 seconds",
    `set setupScript to ${appleScriptString(PRIVILEGED_SETUP_SCRIPT)}`,
    `set packagePath to ${appleScriptString(path)}`,
    `do shell script "/usr/bin/env -i HOME=/var/root USER=root LOGNAME=root PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 /bin/bash -c " & quoted form of setupScript & " mochi-setup " & quoted form of packagePath & " ${trustArguments}" with administrator privileges with prompt "Mochi 需要准备安全的后台组件。"`,
    "end timeout",
  ].join("\n");
}

function validTeam(teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) fail("component_contract_unavailable");
  return teamId;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}
