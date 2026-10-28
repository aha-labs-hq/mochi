import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildLaunchAgentPlist } from "../../src/control/launchAgent.ts";
import { mochiControlManifest } from "../../src/control/manifest.ts";
import { FleetStatusProjection } from "../../src/control/statusSnapshot.ts";
import { resolveProductLayout } from "../../src/product/layout.ts";
import { productVersion } from "../../src/product/version.ts";
import { environmentFor } from "../src/host/contract.ts";
import { type CommandRunner, run } from "../src/host/process.ts";
import { DesktopService, parseLaunchStatus } from "../src/host/service.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(mode: "development" | "installed" = "development") {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mochi-service-test-")));
  roots.push(home);
  const env = environmentFor(
    mochiControlManifest(mode, productVersion()),
    join(home, "Mochi.app"),
    home,
  );
  const layout = resolveProductLayout({
    homeDirectory: home,
    environment:
      mode === "installed"
        ? { MOCHI_PRODUCT_ROOT: "/Library/Application Support/Mochi" }
        : {},
  });
  const xml = buildLaunchAgentPlist({
    mode,
    command: [layout.bridgeExecutablePath],
    workingDirectory: layout.workingDirectory,
    immutableRoot: layout.immutableRoot,
    mutableRoot: layout.mutableRoot,
    dataDirectory: layout.mutableRoot,
    plistPath: env.plistPath,
    structuredLogPath: env.logPath,
    statusPath: env.statusPath,
  });
  mkdirSync(dirname(env.plistPath), { recursive: true });
  writeFileSync(env.plistPath, xml, { mode: 0o600 });
  const config = JSON.parse(
    (
      await run(["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"], {
        input: xml,
      })
    ).stdout,
  );
  let pid = process.pid,
    loaded = true,
    program = config.ProgramArguments[0] as string,
    printCode = 0;
  let onStart = () => {};
  let backgroundStatus = 1;
  let launchOrigin = `path = ${env.plistPath}`;
  let processPresent: boolean | undefined;
  let failProcessInspectionAfterUnload = false;
  const operations: string[] = [];
  let inspections = 0;
  const launch = () =>
    `gui/501/app.mochi.bridge = {\n ${launchOrigin}\n program = ${program}\n arguments = {\n${config.ProgramArguments.join("\n")}\n}\n working directory = ${config.WorkingDirectory}\n stdout path = /dev/null\n stderr path = /dev/null\n environment = {\n${Object.entries(
      config.EnvironmentVariables,
    )
      .map(([k, v]) => `${k} => ${v}`)
      .join("\n")}\n}\n state = running\n pid = ${pid}\n}`;
  const command: CommandRunner = async (args, options) => {
    if (args[0] === "/usr/bin/plutil") return run(args, options);
    if (args[0] === "/bin/ps")
      return {
        code: !loaded && failProcessInspectionAfterUnload ? 1 : 0,
        stdout:
          (processPresent ?? loaded)
            ? `${pid} 1 Wed Sep 9 12:00:00 2026\n`
            : "",
        stderr: "",
      };
    if (args[0] !== "/bin/launchctl")
      throw new Error("Unexpected native command");
    if (args[1] === "print") {
      inspections++;
      return {
        code: printCode || (loaded ? 0 : 113),
        stdout: loaded ? launch() : "",
        stderr: "",
      };
    }
    operations.push(args[1]!);
    if (args[1] === "bootout") loaded = false;
    else {
      loaded = true;
      onStart();
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  // The desktop reads one deployment status file; a Bot publishes into it through
  // the fleet projection that owns the roster and the single atomic write.
  const fleet = new FleetStatusProjection(env.statusPath);
  fleet.roster([
    { id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true },
  ]);
  const bot = fleet.bot(BOT_ID);
  bot.policy({ model: "gpt-test", reasoningEffort: "max" });
  bot.starting();
  fleet.controlReady();
  fleet.accountChanged({
    status: "signedIn",
    account: {
      provider: "openai-codex",
      authType: "oauth",
      subscription: true,
    },
    connections: [
      { provider: "openai-codex", authType: "oauth", subscription: true },
    ],
  });
  bot.eventStreamReady();
  return {
    env,
    service: new DesktopService(env, () => backgroundStatus, command),
    backgroundStatus(value: number) {
      backgroundStatus = value;
    },
    fleet,
    bot,
    operations,
    inspections: () => inspections,
    config,
    launchOrigin(value: string) {
      launchOrigin = value;
    },
    loaded(value: boolean) {
      loaded = value;
    },
    pid(value: number) {
      pid = value;
    },
    program(value: string) {
      program = value;
    },
    printCode(value: number) {
      printCode = value;
    },
    onStart(callback: () => void) {
      onStart = callback;
    },
    processPresent(value: boolean) {
      processPresent = value;
    },
    failProcessInspectionAfterUnload(value: boolean) {
      failProcessInspectionAfterUnload = value;
    },
  };
}

describe("LaunchAgent evidence and identity", () => {
  test("a failed stop retains process identity across retries and blocks a second runtime", async () => {
    const f = await fixture();
    f.processPresent(true);
    f.failProcessInspectionAfterUnload(true);
    await expect(f.service.perform("stop")).rejects.toThrow(
      "service_shutdown_failed",
    );
    f.failProcessInspectionAfterUnload(false);
    await expect(f.service.perform("start")).rejects.toThrow(
      "service_shutdown_failed",
    );
    let complete = false;
    const retry = f.service.perform("stop").then(() => {
      complete = true;
    });
    await Bun.sleep(20);
    expect(complete).toBe(false);
    expect(f.operations).toEqual(["bootout"]);
    f.processPresent(false);
    await retry;
    expect(complete).toBe(true);
    f.fleet.stopping();
  });
  test("observation reuses verified identity, but every control action revalidates it", async () => {
    const f = await fixture();
    for (let index = 0; index < 20; index++) await f.service.inspect();
    expect(f.inspections()).toBe(1);
    f.program("/tmp/not-mochi");
    await expect(f.service.requireControl()).rejects.toThrow();
    expect(f.inspections()).toBe(2);
    expect(f.operations).toEqual([]);
  });
  test("expired status cannot extend an observation lease", async () => {
    const f = await fixture();
    const status = JSON.parse(readFileSync(f.env.statusPath, "utf8"));
    status.updatedAt = new Date(Date.now() - 1000).toISOString();
    status.validUntil = new Date(Date.now() + 30).toISOString();
    writeFileSync(f.env.statusPath, JSON.stringify(status));
    expect((await f.service.inspect()).status).not.toBeNull();
    await Bun.sleep(40);
    expect((await f.service.inspect()).problem?.code).toBe("status_expired");
    expect(f.inspections()).toBe(2);
  });
  test("reads only top-level launchctl fields", () => {
    const parsed = parseLaunchStatus(
      "job = {\nstate = running\nnested = {\npid = 99\n}\npid = 12\n}",
    );
    expect(parsed.pid).toBe(12);
    expect(parsed.state).toBe("running");
    expect(() => parseLaunchStatus("job = {\nstate = running")).toThrow();
  });
  for (const mode of ["development", "installed"] as const)
    test(`${mode}: uses the canonical complete plist`, async () => {
      const f = await fixture(mode);
      expect(await f.service.configuration()).toEqual(f.config);
      expect((await f.service.inspect()).status?.bots[0]?.lifecycle).toBe(
        "listening",
      );
      expect(f.operations).toEqual([]);
    });
  test("rejects extra plist fields and arbitrary executables", async () => {
    const f = await fixture();
    writeFileSync(f.env.plistPath, JSON.stringify({ ...f.config, Evil: true }));
    await expect(f.service.configuration()).rejects.toThrow(
      "service_configuration_invalid",
    );
    writeFileSync(
      f.env.plistPath,
      JSON.stringify({ ...f.config, ProgramArguments: ["/usr/bin/true"] }),
    );
    await expect(f.service.configuration()).rejects.toThrow(
      "service_configuration_invalid",
    );
  });
  test("fails closed on deployment or loaded-job drift before any command", async () => {
    const f = await fixture();
    f.program("/usr/bin/true");
    await expect(f.service.inspect()).rejects.toThrow(
      "service_identity_mismatch",
    );
    await expect(f.service.perform("stop")).rejects.toThrow(
      "service_identity_mismatch",
    );
    f.env.manifest = mochiControlManifest("installed", productVersion());
    await expect(f.service.configuration()).rejects.toThrow(
      "service_identity_mismatch",
    );
    expect(f.operations).toEqual([]);
  });
  test("rejects the retired checkout interpreter and nonempty working directory", async () => {
    const f = await fixture();
    for (const change of [
      {
        ProgramArguments: [
          "/opt/homebrew/bin/bun",
          "run",
          "/checkout/src/index.ts",
        ],
      },
      { WorkingDirectory: "/checkout" },
    ]) {
      writeFileSync(
        f.env.plistPath,
        JSON.stringify({ ...f.config, ...change }),
      );
      await expect(f.service.configuration()).rejects.toThrow(
        "service_configuration_invalid",
      );
      expect(f.operations).toEqual([]);
    }
  });
  test("missing plist with a loaded job is not a usable service", async () => {
    const f = await fixture();
    unlinkSync(f.env.plistPath);
    await expect(f.service.inspect()).rejects.toThrow(
      "service_identity_mismatch",
    );
  });
  test("only launchctl's not-found result means stopped", async () => {
    const f = await fixture();
    f.loaded(false);
    expect((await f.service.inspect()).launch).toBeNull();
    f.printCode(1);
    await expect(f.service.inspect()).rejects.toThrow(
      "service_operation_failed",
    );
  });
  test("stop waits for the process after launchd has already removed the job", async () => {
    const f = await fixture();
    f.processPresent(true);
    let complete = false;
    const stopping = f.service.perform("stop").then(() => {
      complete = true;
    });
    while (!f.operations.includes("bootout")) await Bun.sleep(1);
    await Bun.sleep(20);
    expect(complete).toBe(false);
    f.processPresent(false);
    await stopping;
    expect(complete).toBe(true);
  });
  test("an App that has never installed a service can exit without installing one", async () => {
    const f = await fixture();
    f.loaded(false);
    unlinkSync(f.env.plistPath);
    await f.service.perform("stop");
    expect(f.operations).toEqual([]);
  });
  test("status must belong to the exact process and validity window", async () => {
    const f = await fixture();
    f.pid(process.pid + 1);
    expect((await f.service.inspect()).problem?.code).toBe(
      "status_unavailable",
    );
    expect((await f.service.inspect()).status).toBeNull();
    await expect(f.service.requireControl()).rejects.toThrow(
      "control_unavailable",
    );
    expect(f.operations).toEqual([]);
    f.pid(process.pid);
    const snapshot = f.fleet.snapshot();
    writeFileSync(
      f.env.statusPath,
      JSON.stringify({
        ...snapshot,
        updatedAt: new Date(Date.now() - 30000).toISOString(),
        validUntil: new Date(Date.now() - 20000).toISOString(),
      }),
    );
    expect((await f.service.inspect()).problem?.code).toBe("status_expired");
  });
  test("does not follow status aliases or expose a permissive status file", async () => {
    const f = await fixture();
    chmodSync(f.env.statusPath, 0o644);
    await expect(f.service.inspect()).rejects.toThrow(
      "component_contract_mismatch",
    );
    const copy = join(dirname(f.env.statusPath), "alias-target.json");
    writeFileSync(copy, readFileSync(f.env.statusPath));
    unlinkSync(f.env.statusPath);
    symlinkSync(copy, f.env.statusPath);
    await expect(f.service.inspect()).rejects.toThrow(
      "component_contract_mismatch",
    );
  });
  test("start bootstraps only the fixed job and requires a new current snapshot", async () => {
    const f = await fixture();
    f.loaded(false);
    f.onStart(() => {
      const next = new FleetStatusProjection(f.env.statusPath);
      next.roster([
        { id: BOT_ID, label: "麻薯", characterId: "mochi", enabled: true },
      ]);
      const restarted = next.bot(BOT_ID);
      restarted.policy({ model: "gpt-test", reasoningEffort: "max" });
      restarted.starting();
      next.controlReady();
      next.accountChanged({
        status: "signedIn",
        account: {
          provider: "openai-codex",
          authType: "oauth",
          subscription: true,
        },
        connections: [
          { provider: "openai-codex", authType: "oauth", subscription: true },
        ],
      });
      restarted.eventStreamReady();
    });
    await f.service.perform("start");
    expect(f.operations).toEqual(["bootstrap"]);
    await f.service.perform("stop");
    expect(f.operations).toEqual(["bootstrap", "bootout"]);
    await f.service.perform("stop");
    expect(f.operations).toHaveLength(2);
  });
});

describe("macOS background authorization", () => {
  test("revocation overrides a cached online snapshot and blocks start, restart and control", async () => {
    const f = await fixture();
    expect((await f.service.inspect()).status?.controlAvailable).toBe(true);
    f.backgroundStatus(2);
    const denied = await f.service.inspect();
    expect(denied.installed).toBe(true);
    expect(denied.status).toBeNull();
    expect(denied.launch).toBeNull();
    expect(denied.problem?.code).toBe("background_permission_required");
    expect(denied.problem?.recoveryAction).toBe("openLoginItems");
    for (const operation of ["start", "restart"] as const)
      await expect(f.service.perform(operation)).rejects.toThrow(
        "background_permission_required",
      );
    await expect(f.service.requireControl()).rejects.toThrow(
      "background_permission_required",
    );
    expect(f.operations).toEqual([]);
    f.backgroundStatus(1);
    expect((await f.service.inspect()).status?.controlAvailable).toBe(true);
    f.backgroundStatus(2);
    await f.service.perform("stop");
    expect(f.operations).toEqual(["bootout"]);
    f.fleet.stopping();
  });

  test("unknown or missing authorization never becomes an implicit approval", async () => {
    const f = await fixture();
    for (const status of [0, 3, -1, 99]) {
      f.backgroundStatus(status);
      expect((await f.service.inspect()).problem?.code).toBe(
        "background_permission_unavailable",
      );
      await expect(f.service.perform("start")).rejects.toThrow(
        "background_permission_unavailable",
      );
    }
    expect(f.operations).toEqual([]);
    f.fleet.stopping();
  });
});

test("macOS re-enabling a legacy item preserves exact executable and deployment identity", async () => {
  const f = await fixture();
  f.launchOrigin(
    "path = (submitted by smd.84)\n type = Submitted\n managed_by = com.apple.xpc.ServiceManagement",
  );
  expect((await f.service.inspect(true)).status?.controlAvailable).toBe(true);
  f.program("/tmp/untrusted-bridge");
  await expect(f.service.inspect(true)).rejects.toThrow(
    "service_identity_mismatch",
  );
  f.program(f.config.ProgramArguments[0]);
  f.launchOrigin(
    "path = (submitted by other.84)\n type = Submitted\n managed_by = com.apple.xpc.ServiceManagement",
  );
  await expect(f.service.inspect(true)).rejects.toThrow(
    "service_identity_mismatch",
  );
  f.launchOrigin(
    "path = (submitted by smd.84)\n type = Submitted\n managed_by = unrelated",
  );
  await expect(f.service.inspect(true)).rejects.toThrow(
    "service_identity_mismatch",
  );
  f.fleet.stopping();
});
