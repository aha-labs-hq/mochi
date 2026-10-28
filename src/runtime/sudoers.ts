import type { RuntimeConfig } from "../config.ts";
import { runtimeWorkerCommand } from "./process.ts";

/**
 * Account names that may own the Bridge and therefore appear as the sudoers
 * principal: macOS short names of letters, digits, `_`, `.` and `-` that start
 * with a letter or `_`, except an all-uppercase name. sudoers reads such a word
 * as an alias, so its rule would match no account while visudo still passes.
 * The package scripts and the update helper check this same pattern; a name
 * that is a sudoers keyword, such as `Defaults`, fails visudo before commit.
 */
export const BRIDGE_USER_PATTERN = /^([a-z_]|[A-Z][A-Za-z0-9_.-]*[a-z.-])[A-Za-z0-9_.-]*$/;
/** The two values only an installation knows; everything else in the rule is fixed here. */
export const SUDOERS_BRIDGE_USER_FIELD = "{bridgeUser}";
export const SUDOERS_WORKER_SHA256_FIELD = "{workerSha256}";
const SAFE_TOKEN = /^[A-Za-z0-9_./-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

type SudoersConfig = Pick<RuntimeConfig, "sudoPath" | "runtimeUser" | "workerPath" | "runtimeCwd">;

/**
 * The one runtime sudoers policy, with the Bridge account and worker digest
 * left as fields. The package installer fills them from the installation
 * manifest; development provisioning fills them through buildRuntimeSudoersRule.
 */
export function runtimeSudoersTemplate(config: SudoersConfig): string {
  if (!BRIDGE_USER_PATTERN.test(config.runtimeUser)) throw new Error(`unsafe runtime username: ${config.runtimeUser}`);
  if (!SAFE_TOKEN.test(config.runtimeCwd)) throw new Error(`unsafe runtime cwd: ${config.runtimeCwd}`);

  const command = runtimeWorkerCommand(config);
  const prefix = [config.sudoPath, "-n", "-H", "-u", config.runtimeUser];
  if (!prefix.every((value, index) => command[index] === value)) {
    throw new Error("runtime launcher no longer has the expected sudo boundary");
  }
  const delegated = command.slice(prefix.length);
  if (delegated.length !== 1 || delegated[0] !== config.workerPath || !SAFE_TOKEN.test(delegated[0])) {
    throw new Error("runtime launcher must delegate only the fixed worker binary");
  }
  // sudoers requires an explicit empty argument string; omission permits arbitrary arguments.
  return `${SUDOERS_BRIDGE_USER_FIELD} ALL=(${config.runtimeUser}) CWD=${config.runtimeCwd} NOPASSWD: sha256:${SUDOERS_WORKER_SHA256_FIELD} ${delegated[0]} ""`;
}

export function buildRuntimeSudoersRule(bridgeUser: string, config: SudoersConfig, workerSha256: string): string {
  if (!BRIDGE_USER_PATTERN.test(bridgeUser)) throw new Error(`unsafe Bridge username: ${bridgeUser}`);
  if (!SHA256_HEX.test(workerSha256)) throw new Error("worker SHA-256 must be lowercase hexadecimal");
  const rule = runtimeSudoersTemplate(config)
    .replace(SUDOERS_BRIDGE_USER_FIELD, bridgeUser)
    .replace(SUDOERS_WORKER_SHA256_FIELD, workerSha256);
  return `${rule}\n`;
}
