import { loadBotConfig, loadRuntimeConfig } from "../config.ts";
import { ProcessLock } from "../processLock.ts";
import { Fleet } from "../product/fleet.ts";
import { productLayout } from "../product/layout.ts";
import { runtimeLauncherEnvironment, runtimeWorkerCommand } from "../runtime/process.ts";
import { exactKeys, record } from "../runtime/protocol.ts";
import { requireRuntimeBotId } from "../runtime/storage.ts";
import { RuntimeTransport } from "../runtime/transport.ts";

export async function run(argv: readonly string[]): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--bot") throw new Error("Usage: runtime:account:adopt --bot <source-bot-id>");
  const botId = requireRuntimeBotId(argv[1]);
  const layout = productLayout();
  const locks: ProcessLock[] = [];
  let transport: RuntimeTransport | undefined;
  try {
    locks.push(await ProcessLock.acquire(layout.deploymentLockPath));
    const bots = new Fleet(layout.fleetRecordPath).bots();
    if (!bots.some((bot) => bot.id === botId)) throw new Error("The selected Bot is not in this deployment");
    for (const bot of [...bots].sort((a, b) => a.id.localeCompare(b.id))) locks.push(await ProcessLock.acquire(layout.bot(bot.id).stateLockPath));
    const config = loadRuntimeConfig(loadBotConfig(layout.bot(botId)), botId);
    transport = new RuntimeTransport({ command: runtimeWorkerCommand(config), environment: runtimeLauncherEnvironment(),
      onEvent: () => { throw new Error("Unexpected account adoption event"); },
      onRequest: async () => ({ ok: false, error: { code: "unsupported", message: "No tools during account adoption" } }),
      onFatal: () => {}, onExit: () => {},
    });
    transport.start();
    const result = record(await transport.request("runtime.account.adopt", { botId }, 120_000), "account adoption result");
    exactKeys(result, ["archivedAccounts"], "account adoption result");
    if (!Number.isInteger(result.archivedAccounts) || (result.archivedAccounts as number) < 1 || (result.archivedAccounts as number) > 64) throw new Error("Invalid account adoption result");
    process.stdout.write(`Adopted Bot ${botId}'s ChatGPT login; retained ${result.archivedAccounts} original account archive(s). Sessions unchanged.\n`);
  } finally {
    if (transport) {
      await transport.request("runtime.shutdown", {}, 2_000).catch(() => undefined);
      await transport.stop(new Error("Account adoption finished"));
    }
    for (const lock of locks.reverse()) await lock.release();
  }
}

if (import.meta.main) run(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
