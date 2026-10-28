import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

function compiledTrust(value?: string) {
  const env = { ...process.env };
  delete env.MOCHI_PACKAGE_TRUST;
  if (value !== undefined) env.MOCHI_PACKAGE_TRUST = value;
  return Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import config from "./electrobun.config.ts";
       import { packageTrustFromEnvironment } from "./controlApp/build/packageTrust.ts";
       const value = Function("return " + config.build.bun.define.MOCHI_PACKAGE_TRUST)();
       console.log(JSON.stringify(packageTrustFromEnvironment(value)));`,
    ],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
}

test("desktop build defines preserve absent and explicit package trust at startup", () => {
  for (const [input, expected] of [
    [undefined, null],
    ["development", { mode: "development" }],
    ["developer-id:ABCDEFGHIJ", { mode: "developer-id", teamId: "ABCDEFGHIJ" }],
  ] as const) {
    const result = compiledTrust(input);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(expected);
  }
  expect(compiledTrust("").exitCode).not.toBe(0);
  expect(compiledTrust("unknown").exitCode).not.toBe(0);
});
