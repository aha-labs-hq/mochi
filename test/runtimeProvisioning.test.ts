import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_WORKER_PROTOCOL_VERSION } from "../src/runtime/protocol.ts";
import {
  assertFixedRuntime,
  authorizeProvisioning,
  provisioningAuthorizationScript,
  directoryServiceAttributeValue,
} from "../src/provisionRuntime.ts";
import { buildRuntimeSudoersRule, runtimeSudoersTemplate } from "../src/runtime/sudoers.ts";
import type { RuntimeConfig } from "../src/config.ts";

const config: RuntimeConfig = {
  botId: "11111111-2222-4333-8444-555555555555",
  workerPath: "/usr/local/libexec/mochi-pi-runtime",
  sudoPath: "/usr/bin/sudo",
  runtimeUser: "_mochi",
  runtimeHome: "/Users/_mochi",
  runtimeCwd: "/Users/_mochi/empty-workspace",
  model: "gpt-5.6-terra",
  reasoningEffort: "max",
  turnTimeoutMilliseconds: 600_000,
};

describe("Pi runtime provisioning contract", () => {
  test("native installer verifies the same worker protocol as Bridge", () => {
    const script = readFileSync(new URL("../installer/lifecycle.sh", import.meta.url), "utf8");
    expect(script).toContain(`== 'mochi-pi-runtime ${PI_WORKER_PROTOCOL_VERSION}'`);
  });
  test("pins the security boundary to one worker, user, home, and cwd", () => {
    expect(() => assertFixedRuntime(config, "bridge-user")).not.toThrow();
    expect(() => assertFixedRuntime({ ...config, runtimeUser: "someone-else" }, "bridge-user"))
      .toThrow("PI_RUNTIME_USER");
    expect(() => assertFixedRuntime({ ...config, workerPath: "/tmp/worker" }, "bridge-user"))
      .toThrow("PI_WORKER_PATH");
  });

  test("generates a digest-pinned command with no wildcard", () => {
    const digest = "a".repeat(64);
    expect(buildRuntimeSudoersRule("bridge-user", config, digest)).toBe(
      `bridge-user ALL=(_mochi) CWD=/Users/_mochi/empty-workspace NOPASSWD: sha256:${digest} /usr/local/libexec/mochi-pi-runtime ""\n`,
    );
    expect(() => buildRuntimeSudoersRule("bridge user", config, digest)).toThrow("unsafe Bridge username");
  });

  test("admits each macOS short name that sudoers reads as that account", () => {
    const digest = "a".repeat(64);
    // Managed Macs commonly name accounts first.last; short names may carry capitals.
    for (const name of ["bridge-user", "first.last", "John", "J.SMITH", "_svc"]) {
      expect(buildRuntimeSudoersRule(name, config, digest)).toStartWith(`${name} ALL=(_mochi) `);
    }
    // An all-uppercase word is a sudoers alias; the rest are not macOS short names.
    for (const name of ["JOHN", "J_2", "bridge user", "2fa", ".hidden", "-n", "first.last@corp", ""]) {
      expect(() => buildRuntimeSudoersRule(name, config, digest)).toThrow("unsafe Bridge username");
    }
  });

  test.skipIf(process.platform !== "darwin")("sudoers reads each admitted name as an account and the refused shape as an alias", () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-sudoers-"));
    const check = (rule: string) => {
      writeFileSync(join(directory, "rule"), rule);
      const result = spawnSync("/usr/sbin/visudo", ["-cf", join(directory, "rule")], { encoding: "utf8" });
      return { status: result.status, stderr: result.stderr };
    };
    try {
      const digest = "a".repeat(64);
      for (const name of ["first.last", "John", "J.SMITH"]) {
        expect({ name, ...check(buildRuntimeSudoersRule(name, config, digest)) }).toEqual({ name, status: 0, stderr: "" });
      }
      // visudo accepts this rule, so only the account policy keeps it from naming nobody.
      const alias = check(`${runtimeSudoersTemplate(config).replace("{bridgeUser}", "JOHN").replace("{workerSha256}", digest)}\n`);
      expect(alias.status).toBe(0);
      expect(alias.stderr).toContain('User_Alias "JOHN" referenced but not defined');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts standard and native Directory Services attribute labels", () => {
    expect(directoryServiceAttributeValue("NFSHomeDirectory: /Users/_mochi", "NFSHomeDirectory"))
      .toBe("/Users/_mochi");
    expect(directoryServiceAttributeValue("dsAttrTypeNative:IsHidden: 1", "IsHidden"))
      .toBe("1");
    expect(() => directoryServiceAttributeValue("AnotherAttribute: 1", "IsHidden"))
      .toThrow("unexpected IsHidden record");
  });
});


describe("native maintenance authorization", () => {
  test("cancellation is distinct from preparation failure and does not retry", async () => {
    let calls = 0;
    expect(await authorizeProvisioning("/tmp/helper", "bridge-user", "/tmp/worker", async () => {
      calls++;
      return { code: 1, stderr: "User canceled. (-128)\n" };
    })).toBe("cancelled");
    expect(calls).toBe(1);
    await expect(authorizeProvisioning("/tmp/helper", "bridge-user", "/tmp/worker", async () =>
      ({ code: 1, stderr: "installation failed (1)" }))).rejects.toThrow("preparation failed");
    expect(await authorizeProvisioning("/tmp/helper", "bridge-user", "/tmp/worker", async () =>
      ({ code: 0, stderr: "" }))).toBe("completed");
  });
  test("uses native authorization with a clean environment and rejects malformed input", () => {
    const script = provisioningAuthorizationScript("/tmp/Mochi helper", "bridge-user", "/tmp/worker");
    expect(script).toContain("with administrator privileges");
    expect(script).toContain("/usr/bin/env -i HOME=/var/root USER=root LOGNAME=root");
    expect(script).toContain("'--authorized' 'bridge-user' '/tmp/worker'");
    expect(script).not.toContain("sudo");
    expect(() => provisioningAuthorizationScript("relative", "bridge-user", "/tmp/worker")).toThrow();
    expect(() => provisioningAuthorizationScript("/tmp/helper", "user; id", "/tmp/worker")).toThrow();
    expect(() => provisioningAuthorizationScript("/tmp/helper", "bridge-user", "/tmp/a\nb")).toThrow();
  });
});


test("native authorization preserves shell metacharacters as one literal argument", async () => {
  if (process.platform !== "darwin") return;
  const input = "/tmp/Mochi's \"worker\" $(id) `id` \\ file";
  const script = provisioningAuthorizationScript("/bin/echo", "bridge-user", input);
  const expression = script.slice("do shell script ".length, script.indexOf(" with administrator privileges"));
  const apple = Bun.spawn(["/usr/bin/osascript", "-e", "return " + expression], { stdout: "pipe", stderr: "pipe" });
  const command = (await new Response(apple.stdout).text()).trim();
  expect(await apple.exited).toBe(0);
  const shell = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  expect((await new Response(shell.stdout).text()).trim()).toBe("--authorized bridge-user " + input);
  expect(await shell.exited).toBe(0);
});
