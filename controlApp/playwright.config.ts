import { defineConfig } from "@playwright/test";
import { readdirSync } from "node:fs";

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.pw.ts",
  // WebKit 2336 stalls before HTTP on the 70th fresh context in one browser,
  // even with static HTML. Give each spec its own browser-process lifetime.
  projects: readdirSync(new URL("./tests/", import.meta.url))
    .filter((file) => file.endsWith(".pw.ts"))
    .sort()
    .map((file) => ({ name: file.slice(0, -6), testMatch: file })),
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  outputDir: ".build/ui-results",
  use: {
    baseURL: process.env.MOCHI_UI_TEST_URL,
    browserName: "webkit",
    viewport: { width: 520, height: 700 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
