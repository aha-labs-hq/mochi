import type {
  BotStatus,
  FleetStatusSnapshot,
} from "../../../src/control/statusSnapshot.ts";
import { githubSelectedResourceIds } from "../shared/connectorView.ts";
import type { DesktopSnapshot, Phase } from "../shared/model.ts";

/**
 * One Bot, as the desktop sees it: the label and identity the renderer may show,
 * plus enough state to explain why it is or is not working.
 */
export interface DesktopBotView {
  botId: string;
  label: string;
  characterId: string;
  groupCount: number | null;
  projectCount: number | null;
  /** The selected model reference, used only to show which provider this Bot uses. */
  model?: string;
  enabled: boolean;
  lifecycle: BotStatus["lifecycle"];
  phase: Phase;
  problemCode: string | null;
}

/** Project each Bot's independent facts for the roster. */
export function desktopBots(
  fleet: FleetStatusSnapshot,
): readonly DesktopBotView[] {
  return fleet.bots.map((bot) => ({
    botId: bot.botId,
    label: bot.label,
    characterId: bot.characterId,
    groupCount:
      bot.feishuGroups?.filter((group) => group.enabled).length ?? null,
    projectCount:
      bot.connectorCatalog === null
        ? null
        : githubSelectedResourceIds(bot.connectorCatalog).length,
    model: bot.botPolicy.model,
    enabled: bot.enabled,
    lifecycle: bot.lifecycle,
    phase: phaseForBot(bot),
    problemCode: bot.problem?.code ?? null,
  }));
}

/** The Bot the customer is looking at: the remembered one, else the first enabled. */
export function selectDesktopBot(
  fleet: FleetStatusSnapshot,
  selectedBotId: string | null,
): BotStatus | null {
  return (
    fleet.bots.find((bot) => bot.botId === selectedBotId) ??
    fleet.bots.find((bot) => bot.enabled) ??
    fleet.bots[0] ??
    null
  );
}

/**
 * The renderer's phase for one Bot.
 *
 * It is derived from the Bot's own lifecycle, never from a deployment-level fact:
 * a Bot waiting for its own Feishu connection is not the same as a deployment
 * whose account is missing, and the two must not collapse into one message.
 */
export function phaseForBot(
  bot: Pick<
    BotStatus,
    | "lifecycle"
    | "eventStreamReady"
    | "organizingContext"
    | "activeTurn"
    | "queueDepth"
    | "contextOrganizationAvailable"
    | "enabled"
    | "setup"
  >,
): Phase {
  if (bot.setup?.stage === "initializing" || bot.lifecycle === "starting")
    return "starting";
  if (!bot.enabled) return "stopped";
  if (bot.lifecycle !== "listening" || !bot.eventStreamReady)
    return "attention";
  if (bot.organizingContext) return "organizingContext";
  if (bot.activeTurn || bot.queueDepth > 0) return "working";
  return bot.contextOrganizationAvailable ? "contextFull" : "listening";
}

export function projectFleet(
  base: DesktopSnapshot,
  fleet: FleetStatusSnapshot,
  selectedBotId: string | null,
): DesktopSnapshot {
  const bot = selectDesktopBot(fleet, selectedBotId);
  const percent =
    bot?.contextUsedTokens !== undefined && bot.contextWindowTokens
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round((bot.contextUsedTokens / bot.contextWindowTokens) * 100),
          ),
        )
      : null;
  return {
    ...base,
    // `loaded` means the Bridge is serving, which is a deployment fact.
    loaded: true,
    controlReady: fleet.controlAvailable,
    account: fleet.runtimeAccount,
    // The Bridge owns this answer; the desktop never re-derives admission.
    accountChangeReady: fleet.accountChangeReady,
    bots: desktopBots(fleet),
    selectedBotId: bot?.botId ?? null,
    phase: bot ? phaseForBot(bot) : "attention",
    eventStreamReady: bot?.eventStreamReady ?? false,
    feishuGroups: bot?.feishuGroups ?? null,
    feishu: bot?.feishu ?? base.feishu,
    policy: bot?.botPolicy ?? null,
    setup: bot
      ? (bot.setup?.stage ?? null)
      : fleet.runtimeAccount.status === "signedIn"
        ? "ready"
        : fleet.runtimeAccount.status === "signingIn"
          ? "signingIn"
          : fleet.runtimeAccount.status === "unknown"
            ? "checking"
            : "signIn",
    queueDepth: bot?.queueDepth ?? null,
    contextPercent: percent,
    canOrganize: bot?.contextOrganizationAvailable ?? false,
    connectorCatalog: bot?.connectorCatalog ?? null,
  };
}
