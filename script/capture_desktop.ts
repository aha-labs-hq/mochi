import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertElectrobunBundle } from "../controlApp/build/electrobun.ts";

// The documented postBuild hook exposes the real bundle before Electrobun wraps it.
// Mochi already has a single DMG/package authority and ships this signed inner App.
const directory = process.env.ELECTROBUN_BUILD_DIR;
const name = process.env.ELECTROBUN_APP_NAME;
if (!directory || (name !== "Mochi" && name !== "Mochi Development"))
  throw new Error("Unexpected desktop build hook context");
const source = join(directory, `${name}.app`);
assertElectrobunBundle(source);
const destination = resolve("controlApp/.build/inner/Mochi.app");
mkdirSync(resolve("controlApp/.build/inner"), { recursive: true });
rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
