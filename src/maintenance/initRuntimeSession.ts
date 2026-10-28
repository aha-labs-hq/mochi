import { AGENT_TOOLS, AGENT_TOOL_CAPABILITY_ABI } from "../agent/tools.ts";
import { loadBotContext, type BotContext } from "../config.ts";
import { ProcessLock } from "../processLock.ts";
import { selectBotLayout } from "../product/fleet.ts";
import { PiRuntimeClient } from "../runtime/client.ts";
import { RuntimeAccountClient } from "../runtime/accountClient.ts";
import { productLayout } from "../product/layout.ts";
import { runtimeSystemPrompt } from "../runtime/instructions.ts";
import { verifyRuntimeIsolation } from "../runtime/isolation.ts";
import { ensureBootstrapLogin, RuntimeLoginObserver } from "../runtime/login.ts";
import { StateStore } from "../state.ts";
import { botArgument } from "./types.ts";

/**
 * Mints one Bot's permanent Runtime Session offline.
 *
 * The Session is minted per Bot because a Session carries the Bot's entire
 * memory: two Bots sharing one would read each other's history as their own.
 */
export async function run(argv: readonly string[]): Promise<void> {
  const layout = selectBotLayout(botArgument(argv, "runtime:session:init"));
  const bot = loadBotContext(layout, crypto.randomUUID());
  const hostLock = await ProcessLock.acquire(productLayout().deploymentLockPath);
  let lock: ProcessLock | undefined;
  let state: StateStore | undefined;
  try {
    lock = await ProcessLock.acquire(layout.stateLockPath);
    state = new StateStore(layout.stateDatabasePath);
    if (state.runtimeSessionMigration()) throw new Error("A Runtime Session migration is already prepared");
    if (state.runtimeSession()) throw new Error("Permanent Runtime Session is already initialized");
    await verifyRuntimeIsolation(bot.runtime);
    const loginObserver = new RuntimeLoginObserver();
    const account = new RuntimeAccountClient(loginObserver);
    try { await ensureBootstrapLogin(account, loginObserver); }
    finally { await account.close(); }
    const client = createClient(bot);
    let session: Awaited<ReturnType<PiRuntimeClient["bootstrapSession"]>>;
    try {
      session = await client.bootstrapSession();
    } finally {
      await client.close();
    }

    const verifier = createClient(bot);
    try {
      await verifier.resumeSession();
    } finally {
      await verifier.close();
    }
    state.initializeRuntimeSession(session.sessionId, session.capabilityAbi);
    process.stdout.write(`Bot ${layout.botId} Runtime Session ${session.sessionId}\n`);
  } finally {
    state?.close();
    await lock?.release();
    await hostLock.release();
  }
}

function createClient(bot: BotContext): PiRuntimeClient {
  return new PiRuntimeClient({
    config: bot.runtime,
    tools: AGENT_TOOLS,
    capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
    systemPrompt: runtimeSystemPrompt(bot.agent.instructions),
  });
}


if (import.meta.main) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
