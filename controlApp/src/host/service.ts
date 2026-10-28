import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildLaunchAgentPlist,
  type ServicePaths,
} from "../../../src/control/launchAgent.ts";
import { isStableControlPlane } from "../../../src/control/readiness.ts";
import {
  type FleetStatusSnapshot,
  MAXIMUM_STATUS_BYTES,
  readFleetStatusSnapshot,
} from "../../../src/control/statusSnapshot.ts";
import {
  INSTALLED_BRIDGE_PATH,
  INSTALLED_PRODUCT_ROOT,
  resolveProductLayout,
  SERVICE_LABEL,
} from "../../../src/product/layout.ts";
import type { DesktopSnapshot, ServiceOperation } from "../shared/model.ts";
import {
  bridgeProblem,
  DesktopFailure,
  fail,
  problem,
} from "../shared/problem.ts";
import { type DesktopEnvironment, exactFile } from "./contract.ts";
import { type CommandRunner, run } from "./process.ts";
import { ProcessFamily, processTable } from "./processFamily.ts";

export interface LaunchStatus {
  state?: string;
  pid?: number;
  /** macOS may resubmit the exact legacy job after Login Items is re-enabled. */
  systemManaged?: boolean;
  identity: Record<string, unknown>;
}
export function parseLaunchStatus(text: string): LaunchStatus {
  const fields: Record<string, string> = {};
  const args: string[] = [];
  const env: Record<string, string> = {};
  let section: "arguments" | "environment" | null = null;
  let depth = 0;
  for (const line of text.split("\n")) {
    const value = line.trim();
    if (section) {
      if (value === "}") {
        section = null;
        depth--;
        continue;
      }
      if (section === "arguments") args.push(value);
      else {
        const match = value.match(/^([^ ]+) => (.*)$/);
        if (match) env[match[1]!] = match[2]!;
      }
      continue;
    }
    if (value === "}") {
      depth--;
      continue;
    }
    if (depth === 1 && value === "arguments = {") section = "arguments";
    else if (depth === 1 && value === "environment = {")
      section = "environment";
    else if (depth === 1) {
      const match = value.match(/^([^=]+) = (.*)$/);
      if (match && fields[match[1]!.trim()] === undefined)
        fields[match[1]!.trim()] = match[2]!;
    }
    if (value.endsWith("{")) depth++;
  }
  if (depth !== 0 || section) fail("service_configuration_invalid");
  const pid = Number(fields.pid);
  return {
    ...(fields.type === "Submitted" &&
    fields.managed_by === "com.apple.xpc.ServiceManagement" &&
    /^\(submitted by smd\.\d+\)$/.test(fields.path ?? "")
      ? { systemManaged: true }
      : {}),
    ...(fields.state ? { state: fields.state } : {}),
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    identity: {
      path: fields.path,
      program: fields.program,
      arguments: args,
      workingDirectory: fields["working directory"],
      stdout: fields["stdout path"],
      stderr: fields["stderr path"],
      environment: Object.fromEntries(
        Object.entries(env).filter(([key]) => key.startsWith("MOCHI_")),
      ),
    },
  };
}

export { phaseForBot as phaseFor } from "./fleet.ts";

/** The existing LaunchAgent remains the lifecycle authority; no Bridge process is spawned here. */
export class DesktopService {
  readonly target: string;
  private stoppingFamily: ProcessFamily | null = null;
  private configurationCache: {
    stamp: string;
    value: Record<string, unknown>;
  } | null = null;
  private observationLease: {
    configuration: Record<string, unknown>;
    launch: LaunchStatus;
    runId: string;
    expires: number;
  } | null = null;
  constructor(
    readonly env: DesktopEnvironment,
    private readonly backgroundStatus: () => number,
    readonly command: CommandRunner = run,
  ) {
    this.target = `gui/${process.getuid!()}/${SERVICE_LABEL}`;
  }

  async configuration(): Promise<Record<string, unknown> | null> {
    if (!existsSync(this.env.plistPath)) {
      this.configurationCache = null;
      return null;
    }
    if (!exactFile(this.env.plistPath, "file"))
      fail("service_configuration_invalid");
    const stat = lstatSync(this.env.plistPath);
    if (stat.size > 65_536) fail("service_configuration_invalid");
    const stamp = `${this.env.manifest.serviceMode}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (this.configurationCache?.stamp === stamp)
      return this.configurationCache.value;
    const parsed = await this.plist(readFileSync(this.env.plistPath, "utf8"));
    const arguments_ = parsed.ProgramArguments;
    const cwd = parsed.WorkingDirectory;
    if (
      !Array.isArray(arguments_) ||
      !arguments_.every((arg) => typeof arg === "string") ||
      typeof cwd !== "string" ||
      !cwd.startsWith("/")
    )
      fail("service_configuration_invalid");
    const development = resolveProductLayout({
      homeDirectory: this.env.home,
      environment: {},
    });
    if (
      arguments_.length !== 1 ||
      ![INSTALLED_BRIDGE_PATH, development.bridgeExecutablePath].includes(
        arguments_[0]!,
      )
    )
      fail("service_configuration_invalid");
    const mode =
      arguments_[0] === INSTALLED_BRIDGE_PATH ? "installed" : "development";
    if (mode !== this.env.manifest.serviceMode)
      fail("service_identity_mismatch");
    const layout = resolveProductLayout({
      homeDirectory: this.env.home,
      environment:
        mode === "installed"
          ? { MOCHI_PRODUCT_ROOT: INSTALLED_PRODUCT_ROOT }
          : {},
    });
    const paths: ServicePaths = {
      mode,
      command: arguments_,
      workingDirectory: layout.workingDirectory,
      immutableRoot: layout.immutableRoot,
      mutableRoot: layout.mutableRoot,
      dataDirectory: layout.mutableRoot,
      plistPath: this.env.plistPath,
      structuredLogPath: this.env.logPath,
      statusPath: this.env.statusPath,
    };
    if (
      !isDeepStrictEqual(parsed, await this.plist(buildLaunchAgentPlist(paths)))
    )
      fail("service_configuration_invalid");
    this.configurationCache = { stamp, value: parsed };
    return parsed;
  }

  async inspect(forceIdentity = false): Promise<{
    installed: boolean;
    launch: LaunchStatus | null;
    status: FleetStatusSnapshot | null;
    problem: DesktopSnapshot["problem"];
  }> {
    const configuration = await this.configuration();
    // A fresh heartbeat cannot override a change in the user's macOS consent.
    // Check before the observation lease and never present stale online facts.
    const authorizationProblem = configuration
      ? this.authorizationProblem()
      : null;
    if (authorizationProblem) {
      this.observationLease = null;
      return {
        installed: true,
        launch: null,
        status: null,
        problem: authorizationProblem,
      };
    }
    const lease = this.observationLease;
    if (
      !forceIdentity &&
      lease &&
      lease.configuration === configuration &&
      lease.expires > Date.now() &&
      lease.launch.pid
    ) {
      const read = this.readStatus(lease.launch.pid);
      if (
        read.kind === "current" &&
        read.snapshot.runId === lease.runId &&
        read.snapshot.productVersion === this.env.manifest.productVersion
      ) {
        return {
          installed: true,
          launch: lease.launch,
          status: read.snapshot,
          problem: read.snapshot.problem
            ? bridgeProblem(read.snapshot.problem)
            : null,
        };
      }
    }
    this.observationLease = null;
    const launch = await this.launch();
    if (launch) this.requireIdentity(configuration, launch);
    if (!launch)
      return {
        installed: configuration !== null,
        launch,
        status: null,
        problem: null,
      };
    if (launch.state !== "running" || !launch.pid)
      return {
        installed: true,
        launch,
        status: null,
        problem: problem("status_unavailable"),
      };
    const read = this.readStatus(launch.pid);
    // Job identity is already verified. An old PID's file is unavailable
    // evidence, not proof that the user opened a different product edition.
    if (read.kind !== "current")
      return {
        installed: true,
        launch,
        status: null,
        problem: problem(
          read.kind === "expired"
            ? "status_expired"
            : read.kind === "invalid"
              ? "component_contract_mismatch"
              : "status_unavailable",
        ),
      };
    if (read.snapshot.productVersion !== this.env.manifest.productVersion)
      fail("component_contract_mismatch");
    // Never extend a launch identity lease merely because a new heartbeat arrived.
    if (configuration)
      this.observationLease = {
        configuration,
        launch,
        runId: read.snapshot.runId,
        expires: Date.parse(read.snapshot.validUntil),
      };
    return {
      installed: true,
      launch,
      status: read.snapshot,
      problem: read.snapshot.problem
        ? bridgeProblem(read.snapshot.problem)
        : null,
    };
  }

  async requireControl(): Promise<FleetStatusSnapshot> {
    // Observation caching is never an authorization shortcut.
    const evidence = await this.inspect(true);
    if (!evidence.status?.controlAvailable) {
      if (
        evidence.problem?.code === "background_permission_required" ||
        evidence.problem?.code === "background_permission_unavailable"
      )
        throw new DesktopFailure(evidence.problem);
      fail("control_unavailable");
    }
    return evidence.status;
  }

  async perform(operation: ServiceOperation): Promise<void> {
    this.observationLease = null;
    const configuration = await this.configuration();
    const previous = await this.launch();
    if (!configuration) {
      if (operation === "stop" && !previous && !this.stoppingFamily) return;
      fail("installation_required");
    }
    if (previous) this.requireIdentity(configuration, previous);
    if (operation !== "stop") {
      const authorizationProblem = this.authorizationProblem();
      if (authorizationProblem) throw new DesktopFailure(authorizationProblem);
    }
    if (operation !== "stop" && this.stoppingFamily) {
      if (this.stoppingFamily.remaining(await processTable(this.command)))
        fail("service_shutdown_failed");
      this.stoppingFamily = null;
    }
    if (operation === "stop" && !previous && !this.stoppingFamily) return;
    if (operation === "stop" && previous) {
      const table = await processTable(this.command);
      if (this.stoppingFamily) this.stoppingFamily.include(previous.pid, table);
      else this.stoppingFamily = new ProcessFamily(previous.pid, table);
    }
    const previousStatus = previous?.pid ? this.readStatus(previous.pid) : null;
    const previousRun =
      previousStatus?.kind === "current" ? previousStatus.snapshot.runId : null;
    const started = Date.now();
    const args =
      operation === "stop"
        ? ["bootout", this.target]
        : previous
          ? ["kickstart", "-k", this.target]
          : ["bootstrap", `gui/${process.getuid!()}`, this.env.plistPath];
    if (operation !== "stop" || previous) {
      const result = await this.command(["/bin/launchctl", ...args]);
      if (result.code !== 0) fail("service_operation_failed");
    }
    const deadline = Date.now() + 20_000;
    do {
      if (operation !== "stop") {
        const authorizationProblem = this.authorizationProblem();
        if (authorizationProblem)
          throw new DesktopFailure(authorizationProblem);
      }
      const launch = await this.launch();
      if (operation === "stop") {
        const remaining = this.stoppingFamily!.remaining(
          await processTable(this.command),
        );
        if (!launch && remaining === 0) {
          this.stoppingFamily = null;
          return;
        }
      } else if (launch?.pid && launch.state === "running") {
        this.requireIdentity(configuration, launch);
        const read = this.readStatus(launch.pid);
        if (
          read.kind === "current" &&
          read.snapshot.productVersion === this.env.manifest.productVersion &&
          read.snapshot.runId !== previousRun &&
          Date.parse(read.snapshot.updatedAt) >= started &&
          // Readiness is the deployment's: control is served and every enabled Bot
          // has settled. One Bot still starting must not block a service start.
          isStableControlPlane(read.snapshot)
        )
          return;
      }
      await Bun.sleep(250);
    } while (Date.now() < deadline);
    fail(
      operation === "stop"
        ? "service_shutdown_failed"
        : "service_readiness_timeout",
    );
  }

  private async plist(input: string): Promise<Record<string, unknown>> {
    const result = await this.command(
      ["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"],
      { input },
    );
    if (result.code !== 0) fail("service_configuration_invalid");
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }
  private authorizationProblem(): DesktopSnapshot["problem"] {
    try {
      // SMAppServiceStatusEnabled = 1; RequiresApproval = 2. Unregistered,
      // not-found and unknown values are not proof that starting is allowed.
      const status = this.backgroundStatus();
      if (status === 1) return null;
      if (status === 2) return problem("background_permission_required");
    } catch {
      // No private BTM database parsing or assumed permission on API failure.
    }
    return problem("background_permission_unavailable");
  }
  private readStatus(pid: number) {
    if (existsSync(this.env.statusPath)) {
      if (!exactFile(this.env.statusPath, "file"))
        fail("component_contract_mismatch");
      const stat = lstatSync(this.env.statusPath);
      if (
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAXIMUM_STATUS_BYTES
      )
        fail("component_contract_mismatch");
    }
    return readFleetStatusSnapshot(this.env.statusPath, pid);
  }
  private async launch(): Promise<LaunchStatus | null> {
    const result = await this.command(["/bin/launchctl", "print", this.target]);
    if (result.code === 113) return null;
    if (result.code !== 0) fail("service_operation_failed");
    return parseLaunchStatus(result.stdout);
  }
  private requireIdentity(
    config: Record<string, unknown> | null,
    launch: LaunchStatus,
  ): void {
    if (
      !config ||
      !isDeepStrictEqual(
        {
          ...launch.identity,
          // launchd itself supplies these fields. All executable, arguments,
          // working directory and Mochi environment checks remain exact.
          ...(launch.systemManaged
            ? { path: resolve(this.env.plistPath) }
            : {}),
        },
        {
          path: resolve(this.env.plistPath),
          program: (config.ProgramArguments as string[])[0],
          arguments: config.ProgramArguments,
          workingDirectory: config.WorkingDirectory,
          stdout: config.StandardOutPath,
          stderr: config.StandardErrorPath,
          environment: config.EnvironmentVariables,
        },
      )
    )
      fail("service_identity_mismatch");
  }
}
