import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_INTEGRATION } from "../src/github/integration.ts";
import { parseGitHubClientRegistration, readGitHubClientRegistration, stageGitHubClientRegistration } from "../src/github/registration.ts";
import { parseDevelopmentDeployArguments } from "../script/deploy_development.ts";
import { parseArguments } from "../script/build_product_package.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const registration = { version: 1 as const, clientId: GITHUB_INTEGRATION.clientId, clientSecret: "fixture_not_a_real_secret_123456789" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mochi-registration-test-"));
  directories.push(directory);
  mkdirSync(join(directory, "Resources"), { mode: 0o700 });
  const source = join(directory, "source.json"), target = join(directory, "Resources/github-oauth.json");
  writeFileSync(source, JSON.stringify(registration), { mode: 0o600 });
  return { directory, source, target };
}

test("native registration is strict issuer metadata, never an RSA key or customer credential", () => {
  expect(parseGitHubClientRegistration(registration)).toEqual(registration);
  for (const value of [
    { ...registration, privateKey: "DO NOT SHIP" },
    { ...registration, accessToken: "ghu_customer" },
    { ...registration, clientId: "another-issuer" },
    { ...registration, clientSecret: "not-a-native-secret\n" },
    { ...registration, version: 2 },
  ]) expect(() => parseGitHubClientRegistration(value)).toThrow("issuer_not_configured");
});

test("the installer command validates through the Bridge entrypoint without starting a deployment or disclosing input", () => {
  const { directory, source } = fixture();
  const before = readFileSync(source, "utf8");
  const invoke = (args: string[]) => Bun.spawnSync([
    process.execPath, join(import.meta.dir, "../src/index.ts"), "--validate-github-registration", ...args,
  ], { cwd: directory, env: { HOME: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  const accepted = invoke([source]);
  expect(accepted.exitCode).toBe(0);
  expect(accepted.stdout.toString() + accepted.stderr.toString()).toBe("");
  expect(readFileSync(source, "utf8")).toBe(before);
  for (const args of [[], [source, source], ["relative.json"]]) {
    expect(invoke(args).exitCode).not.toBe(0);
  }
  chmodSync(source, 0o666);
  const writable = invoke([source]);
  expect(writable.exitCode).not.toBe(0);
  expect(writable.stderr.toString()).toContain("issuer_not_configured");
  expect(writable.stdout.toString() + writable.stderr.toString()).not.toContain(registration.clientSecret);
  chmodSync(source, 0o600);
  writeFileSync(source, JSON.stringify({ ...registration, version: 2 }));
  const malformed = invoke([source]);
  expect(malformed.exitCode).not.toBe(0);
  expect(malformed.stdout.toString() + malformed.stderr.toString()).not.toContain(registration.clientSecret);
  for (const path of [".pi", "Library/Application Support/Mochi", "Library/LaunchAgents", "Library/Logs/Mochi"]) {
    expect(existsSync(join(directory, path))).toBeFalse();
  }
});

test("build handoff validates and stages the same registration without publishing or overwriting", () => {
  const { source, target } = fixture();
  stageGitHubClientRegistration(source, target);
  expect(readGitHubClientRegistration(target, process.getuid!())).toEqual(registration);
  expect(statSync(target).mode & 0o777).toBe(0o444);
  expect(() => stageGitHubClientRegistration(source, target)).toThrow();
  expect(readFileSync(target, "utf8")).toBe(`${JSON.stringify(registration)}\n`);
  expect(() => readGitHubClientRegistration(target, process.getuid!() + 1)).toThrow("issuer_not_configured");
});

test("handoff refuses non-private sources while runtime permits immutable packaged metadata", () => {
  const { source, target } = fixture();
  chmodSync(source, 0o644);
  expect(() => stageGitHubClientRegistration(source, target)).toThrow("issuer_not_configured");
  expect(existsSync(target)).toBeFalse();
  expect(readGitHubClientRegistration(source, process.getuid!())).toEqual(registration);
  chmodSync(source, 0o664);
  expect(() => readGitHubClientRegistration(source, process.getuid!())).toThrow("issuer_not_configured");
});

test("redirected, hard-linked and malformed registration inputs fail before staging", () => {
  const { directory, source, target } = fixture();
  const alias = join(directory, "alias.json");
  symlinkSync(source, alias);
  expect(() => stageGitHubClientRegistration(alias, target)).toThrow("issuer_not_configured");
  linkSync(source, join(directory, "hard.json"));
  expect(() => stageGitHubClientRegistration(source, target)).toThrow("issuer_not_configured");
  const malformed = join(directory, "malformed.json");
  writeFileSync(malformed, "private: broken-json", { mode: 0o600 });
  expect(() => stageGitHubClientRegistration(malformed, target)).toThrow("issuer_not_configured");
  expect(existsSync(target)).toBeFalse();
});

test("deployment entrypoints require explicit native registration; recovery needs no new secret", () => {
  expect(parseDevelopmentDeployArguments(["--rollback"])).toEqual({ mode: "rollback" });
  expect(parseDevelopmentDeployArguments(["--accept"])).toEqual({ mode: "accept" });
  expect(parseDevelopmentDeployArguments(["--github-registration", "/private/oauth.json", "--lark-cli", "/bin/lark-cli"])).toEqual({
    mode: "deploy", githubRegistrationPath: "/private/oauth.json", larkCliPath: "/bin/lark-cli",
  });
  for (const values of [[], ["--lark-cli", "/bin/lark-cli"], ["--lark-cli", "relative"],
    ["--rollback", "--github-registration", "/private/oauth.json"],
    ["--accept", "--github-registration", "/private/oauth.json"],
    ["--github-registration", "/a", "--github-registration", "/b"],
  ]) expect(() => parseDevelopmentDeployArguments(values)).toThrow();
  expect(() => parseArguments(["--lark-cli", "/bin/lark-cli"])).toThrow("--github-registration");
});
