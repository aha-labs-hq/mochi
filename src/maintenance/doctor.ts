import { AGENT_TOOL_CAPABILITY_ABI } from "../agent/tools.ts";
import { MATERIAL_WORKSPACE_ROOT, MaterialWorkspace, verifyMaterialRoot } from "../attachments/materialWorkspace.ts";
import { loadBotContext } from "../config.ts";
import { botArgument } from "./types.ts";
import { selectBotLayout } from "../product/fleet.ts";
import { createBotFeishuConnection } from "../lark/productConnection.ts";
import { readFleetStatusSnapshot, type FleetStatusSnapshot } from "../control/statusSnapshot.ts";
import { productLayout, type ProductLayout, SERVICE_LABEL } from "../product/layout.ts";
import { verifyOfficialLarkBinary } from "../product/larkBinary.ts";
import { compareTenantScopes, parseGrantedTenantScopes } from "../lark/permissions.ts";
import { runLarkCommand, runLarkJson } from "../lark/process.ts";
import type { RuntimePolicy } from "../runtime/policy.ts";
import { verifyRuntimeIsolation } from "../runtime/isolation.ts";
import { StateStore } from "../state.ts";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function run(argv: readonly string[]): Promise<void> {
  const layout = selectBotLayout(botArgument(argv, "doctor"));
  const feishu = createBotFeishuConnection(layout);
  await feishu.refresh();
  const lark = feishu.runtimeBinding();
  await feishu.close();
  if (!lark) throw new Error(`Bot ${layout.botId} has no verified Feishu connection`);
  const store = new StateStore(layout.stateDatabasePath);
  const binding = store.runtimeSession();
  store.close();
  if (!binding) throw new Error(`Bot ${layout.botId} has no permanent Runtime Session`);
  const bot = loadBotContext(layout, binding.sessionId);
  const config = bot.runtime;
  const checks: CheckResult[] = [];
  await check(checks, "lark-cli", async () => {
    await verifyOfficialLarkBinary(lark.cliPath);
    const version = await runLarkCommand(lark.cliPath, ["--version"]);
    return `${version}; official signature, architecture and supported version verified`;
  });
  await check(checks, "lark-profile", async () => {
    const profiles = await runLarkJson(lark, ["profile", "list"]);
    const profile = Array.isArray(profiles)
      ? profiles.find((item) => isRecord(item) && item.name === lark.profile)
      : undefined;
    if (!isRecord(profile) || profile.appId !== lark.targetAppId) {
      throw new Error("target profile not found");
    }
    return `profile=${String(profile.name)} appId=${String(profile.appId)}`;
  });
  await check(checks, "lark-event", async () => {
    const dryRun = await runLarkJson(lark, [
      "event", "consume", "im.message.receive_v1", "--as", "bot", "--dry-run",
    ]);
    const decision = isRecord(dryRun) && isRecord(dryRun.data) && isRecord(dryRun.data.decision)
      ? dryRun.data.decision
      : undefined;
    if (!isRecord(dryRun) || dryRun.ok !== true || decision?.status !== "ready") {
      throw new Error(`event consume dry-run status=${String(decision?.status ?? "unknown")}`);
    }
    return "im.message.receive_v1 ready";
  });
  await check(checks, "lark-tenant-scopes", async () => {
    const scopes = parseGrantedTenantScopes(await runLarkJson(lark, [
      "api", "GET", "/open-apis/application/v6/scopes", "--as", "bot",
    ]));
    const comparison = compareTenantScopes(scopes);
    if (comparison.missing.length) {
      throw new Error(`missing required tenant scopes: ${JSON.stringify(comparison.missing)}`);
    }
    return `required scopes present; retained extras=${comparison.extra.length}`;
  });
  await check(checks, "material-workspace", async () => {
    verifyMaterialRoot(MATERIAL_WORKSPACE_ROOT, config.runtimeUser);
    const workspace = new MaterialWorkspace();
    try {
      return `root=${MATERIAL_WORKSPACE_ROOT} turn=${workspace.cwd}`;
    } finally {
      workspace.dispose();
    }
  });
  await check(checks, "github-published-status", async () => {
    // Never create a second rotating-token owner beside the Bridge. This is reported
    // availability, not a fresh provider probe; explicit refresh belongs to settings/control.
    const snapshot = await liveBridgeStatus();
    // Reported availability, read from each Bot's connector catalog: a selected
    // resource for the GitHub connection is what proves a project was chosen.
    const githubSelections = (bot: FleetStatusSnapshot["bots"][number]): number | null => {
      const connections = bot.connectorCatalog?.connections
        .filter((connection) => connection.providerId === "github" && connection.status === "ready");
      if (!connections?.length) return null;
      return connections.reduce((total, connection) =>
        total + connection.resources.filter((resource) => resource.selected).length, 0);
    };
    if (!snapshot.bots.some((bot) => githubSelections(bot) !== null)) {
      throw new Error("GitHub status is unavailable; inspect and refresh projects in Mochi settings");
    }
    const configured = snapshot.bots
      .filter((bot) => bot.enabled)
      .map((bot) => ({ botId: bot.botId, selected: githubSelections(bot) ?? 0 }));
    if (configured.length === 0) throw new Error("No enabled Bot is registered");
    if (configured.every((bot) => bot.selected === 0)) {
      throw new Error("Select at least one project for at least one Bot in Mochi settings");
    }
    const summary = configured.map((bot) => `${bot.botId}=${bot.selected}`).join(",");
    return `Bridge-reported selected projects per Bot: ${summary}; not a fresh provider probe`;
  });
  await check(checks, "pi-isolation", async () => verifyRuntimeIsolation(config));
  await check(checks, "pi-session-published-status", async () => {
    const state = new StateStore(layout.stateDatabasePath);
    try {
      const capabilityStatus = state.assertRuntimeSessionCandidate(
        config.sessionId,
        AGENT_TOOL_CAPABILITY_ABI,
      );
      if (capabilityStatus !== "active") throw new Error("The permanent Runtime Session is not active");
      const runtime = describePublishedRuntime(await liveBridgeStatus(), layout.botId, config);
      return `${runtime}; permanent binding and capability ABI verified locally; not an independent resume`;
    } finally {
      state.close();
    }
  });
  console.log(`Bot ${layout.botId}`);
  for (const result of checks) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  if (checks.some((result) => !result.ok)) process.exitCode = 1;
}

async function liveBridgeStatus(): Promise<FleetStatusSnapshot> {
  const launch = await runCommand(["/bin/launchctl", "print", `gui/${process.getuid!()}/${SERVICE_LABEL}`]);
  return readPublishedBridgeStatus(productLayout(), launch);
}

/** Reads only the current publisher; diagnostics never acquire its account or Session locks. */
export function readPublishedBridgeStatus(
  product: Pick<ProductLayout, "bridgeExecutablePath" | "statusSnapshotPath">,
  launch: string,
): FleetStatusSnapshot {
  const program = launch.match(/^\s*program = (.+)$/m)?.[1];
  const pid = Number(launch.match(/^\s*pid = (\d+)$/m)?.[1]);
  if (program !== product.bridgeExecutablePath || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Cannot confirm the Bridge status owner");
  }
  const result = readFleetStatusSnapshot(product.statusSnapshotPath, pid);
  if (result.kind !== "current") throw new Error(`Bridge status is unavailable (${result.kind})`);
  if (!result.snapshot.controlAvailable || result.snapshot.problem) throw new Error("The Bridge is not ready");
  return result.snapshot;
}

/** Listening is published only after this Bot's permanent Session has resumed successfully. */
export function describePublishedRuntime(
  snapshot: FleetStatusSnapshot,
  botId: string,
  policy: RuntimePolicy,
): string {
  if (snapshot.runtimeAccount.status !== "signedIn") throw new Error("A verified model connection is required");
  const bot = snapshot.bots.find((entry) => entry.botId === botId);
  if (!bot?.enabled || bot.lifecycle !== "listening" || !bot.eventStreamReady || bot.problem) {
    throw new Error("This Bot has not published a ready Runtime Session");
  }
  if (bot.botPolicy.model !== policy.model || bot.botPolicy.reasoningEffort !== policy.reasoningEffort) {
    throw new Error("The Bot's published model policy differs from its current configuration");
  }
  return `Bridge-reported Runtime ready for Bot ${botId}; model=${policy.model} effort=${policy.reasoningEffort}`;
}

async function check(results: CheckResult[], name: string, operation: () => Promise<string>): Promise<void> {
  try {
    results.push({ name, ok: true, detail: await operation() });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runCommand(command: string[]): Promise<string> {
  const process = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim().slice(0, 2_000)}`);
  return stdout.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


if (import.meta.main) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
