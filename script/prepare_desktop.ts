// The upstream SDK ships TypeScript source, not declarations. Project its actual
// public types once, so application strictness does not typecheck vendor internals.
import { resolve } from "node:path";
import {
  pinnedElectrobunEnvironment,
  verifyDesktopToolchain,
} from "../controlApp/build/toolchain.ts";

const root = resolve(import.meta.dir, "..");
// Hutch downloads the SDK and its toolchain here; prove them before anything runs them.
const electrobun = await pinnedElectrobunEnvironment(root);
await spawn(["node_modules/.bin/electrobun", "prepare"], electrobun);
await verifyDesktopToolchain(root, electrobun);
await spawn(["node_modules/.bin/tsc", "-p", "controlApp/tsconfig.sdk.json"]);

async function spawn(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const child = Bun.spawn(args, {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error(`Desktop SDK preparation failed: ${args[0]}`);
}
