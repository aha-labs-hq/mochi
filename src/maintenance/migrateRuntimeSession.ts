import { AGENT_TOOLS, AGENT_TOOL_CAPABILITY_ABI } from "../agent/tools.ts";
import { loadBotContext, type BotContext } from "../config.ts";
import { botArgument } from "./types.ts";
import { ProcessLock } from "../processLock.ts";
import { selectBotLayout } from "../product/fleet.ts";
import { PiRuntimeClient } from "../runtime/client.ts";
import { runtimeSystemPrompt } from "../runtime/instructions.ts";
import { verifyRuntimeIsolation } from "../runtime/isolation.ts";
import { activatePreparedRuntimeMigration } from "../runtime/sessionMigration.ts";
import { StateStore } from "../state.ts";

/** Migrates one Bot's Session onto the current capability ABI, leaving other Bots untouched. */
export async function run(argv: readonly string[]): Promise<void> {
  const activate = argv.includes("--activate");
  const layout = selectBotLayout(botArgument(argv, "runtime:session:migrate", ["--activate"]));
  const lock = await ProcessLock.acquire(layout.stateLockPath);
  const state = new StateStore(layout.stateDatabasePath);
  try {
    const binding = state.runtimeSession();
    if (!binding) throw new Error(`Bot ${layout.botId} has no permanent Runtime Session yet`);
    if (binding.capabilityAbi === AGENT_TOOL_CAPABILITY_ABI) {
      throw new Error("Permanent Runtime Session already has the current capability ABI");
    }
    const bot = loadBotContext(layout, binding.sessionId);
    await verifyRuntimeIsolation(bot.runtime);
    if (activate) {
      await activatePreparedRuntimeMigration({
        state,
        sourceSessionId: binding.sessionId,
        capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
        createVerifier: (sessionId) => createClient(bot, sessionId),
      });
      process.stdout.write("Activated the reviewed Runtime Session migration; previous history remains in lineage.\n");
      return;
    }
    const prepared = state.runtimeSessionMigration();
    const targetSessionId = prepared?.targetSessionId ?? crypto.randomUUID();
    if (prepared && (
      prepared.sourceSessionId !== binding.sessionId
      || prepared.capabilityAbi !== AGENT_TOOL_CAPABILITY_ABI
    )) throw new Error("A different Runtime Session migration is already prepared");

    const client = createClient(bot, targetSessionId);
    let result: Awaited<ReturnType<PiRuntimeClient["migrateSession"]>>;
    try {
      const account = await client.accountRead();
      if (account.status !== "signedIn") throw new Error("A model connection is required");
      result = await client.migrateSession(binding.sessionId);
    } finally {
      await client.close();
    }
    const verifier = createClient(bot, targetSessionId);
    try {
      await verifier.resumeSession();
    } finally {
      await verifier.close();
    }
    state.prepareRuntimeSessionMigration({
      sourceSessionId: binding.sessionId,
      targetSessionId,
      capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      transcriptSha256: result.transcriptSha256,
      sourceTurnCount: binding.turnCount,
    });
    process.stdout.write(
      `Prepared Bot ${layout.botId} Runtime Session migration from ${binding.sessionId} (${binding.turnCount} turns) `
      + `to ${targetSessionId}.\n`,
    );
  } finally {
    state.close();
    await lock.release();
  }
}

function createClient(bot: BotContext, sessionId: string): PiRuntimeClient {
  return new PiRuntimeClient({
    config: { ...bot.runtime, sessionId },
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
