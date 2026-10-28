import { createRequire } from "node:module";

// Playwright's Node ESM loader can race sharp's semver CommonJS dependency.
// Keep the native image boundary on sharp's supported require export.
const require = createRequire(import.meta.url);
const sharp = require("sharp") as typeof import("sharp").default;

export default sharp;
