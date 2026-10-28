import { lstatSync } from "node:fs";
import { INSTALLED_PRODUCT_ROOT } from "./layout.ts";

export const UPDATE_HOLD_PATH = `${INSTALLED_PRODUCT_ROOT}/Installation/update-pending`;

/** Root's journal keeps ingress closed through boot/rollback. No user preferences are changed. */
export function updatePending(): boolean {
  try {
    const file = lstatSync(UPDATE_HOLD_PATH);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.uid !== 0 ||
      (file.mode & 0o022) !== 0
    )
      throw Error("Unsafe update hold");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
