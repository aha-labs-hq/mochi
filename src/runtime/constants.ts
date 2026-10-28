export const PI_RUNTIME_USER = "_mochi";
export const PI_RUNTIME_GROUP = "_mochi";
export const PI_RUNTIME_HOME = "/Users/_mochi";
export const PI_RUNTIME_CWD = "/Users/_mochi/empty-workspace";
export const PI_MATERIAL_ROOT = "/Users/Shared/mochi/materials";
export const PI_WORKER_PATH = "/usr/local/libexec/mochi-pi-runtime";
export const PI_RUNTIME_NOTICES_PATH = "/usr/local/share/doc/mochi/THIRD_PARTY_NOTICES.txt";
export const PI_SUDO_PATH = "/usr/bin/sudo";

export function isFixedPiMaterialRoot(value: string): boolean {
  return value === PI_MATERIAL_ROOT;
}
