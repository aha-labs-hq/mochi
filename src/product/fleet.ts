import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultBotCharacter, requireBotCharacter } from "./characters.ts";
import { PrivateRecord } from "../privateRecord.ts";
import { botLayout, isBotId, productLayout, type BotLayout } from "./layout.ts";

/**
 * One Bot's local identity. Remote facts (Feishu app id, bot open id, name and
 * avatar) are never mirrored here; they live with the connection that verified
 * them. This record decides only what Mochi needs in order to address a Bot on
 * this Mac: a stable directory identity and a human-readable label.
 */
export interface BotRecord {
  id: string;
  label: string;
  characterId: string;
  enabled: boolean;
  createdAt: string;
}

export interface FleetRecord {
  version: 2;
  bots: readonly BotRecord[];
}

export const DEFAULT_BOT_LABEL = "麻薯";
export const MAXIMUM_BOTS = 64;
const MAXIMUM_LABEL_LENGTH = 60;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const RECORD_KEYS = "bots,version";
const BOT_KEYS = "characterId,createdAt,enabled,id,label";

export class FleetError extends Error {
  constructor(readonly code: "fleet_storage_unavailable" | "fleet_bot_limit_reached") {
    super(code);
    this.name = "FleetError";
  }
}

/** The Bot roster: the only authority for which Bots this deployment runs. */
export class Fleet {
  readonly #record: PrivateRecord<FleetRecord>;

  constructor(readonly path = productLayout().fleetRecordPath) {
    this.#record = new PrivateRecord(path, parseFleetRecord, () => new FleetError("fleet_storage_unavailable"));
  }

  /** An absent roster is a deployment that has not created a Bot yet, not a failure. */
  bots(): readonly BotRecord[] {
    return this.#record.read()?.bots ?? [];
  }

  layout(botId: string): BotLayout {
    this.#require(botId);
    return botLayout(join(dirname(this.path), "Bots"), botId);
  }

  /** Creates the roster entry and the Bot's directory boundaries. Never creates a connection. */
  create(label: string = DEFAULT_BOT_LABEL, prepare?: (layout: BotLayout) => void): BotRecord {
    const bots = this.bots();
    if (bots.length >= MAXIMUM_BOTS) throw new FleetError("fleet_bot_limit_reached");
    const bot: BotRecord = {
      id: crypto.randomUUID(),
      label: requireLabel(label),
      characterId: defaultBotCharacter(),
      enabled: false,
      createdAt: new Date().toISOString(),
    };
    const layout = botLayout(join(dirname(this.path), "Bots"), bot.id);
    for (const directory of [layout.configurationDirectory, layout.stateDirectory]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    try {
      prepare?.(layout);
      this.#write([...bots, bot]);
      return bot;
    } catch (error) {
      rmSync(join(dirname(this.path), "Bots", bot.id), { recursive: true, force: true });
      throw error;
    }
  }

  rename(botId: string, label: string): BotRecord {
    const next = requireLabel(label);
    return this.#update(botId, (bot) => ({ ...bot, label: next }));
  }

  setCharacter(botId: string, characterId: string): BotRecord {
    return this.#update(botId, (bot) => ({ ...bot, characterId: requireBotCharacter(characterId) }));
  }

  setEnabled(botId: string, enabled: boolean): BotRecord {
    return this.#update(botId, (bot) => ({ ...bot, enabled }));
  }

  #update(botId: string, change: (bot: BotRecord) => BotRecord): BotRecord {
    const bots = this.bots();
    const index = bots.findIndex((bot) => bot.id === botId);
    if (index < 0) throw new FleetError("fleet_storage_unavailable");
    const changed = requireBot(change(bots[index]!), 0);
    const next = [...bots];
    next[index] = changed;
    this.#write(next);
    return changed;
  }

  #require(botId: string): BotRecord {
    const bot = this.bots().find((candidate) => candidate.id === botId);
    if (!bot) throw new FleetError("fleet_storage_unavailable");
    return bot;
  }

  #write(bots: readonly BotRecord[]): void {
    this.#record.write({ version: 2, bots });
  }
}

/**
 * Resolves the one Bot an offline maintenance command operates on.
 *
 * A deployment with a single Bot needs no argument. With more than one, the
 * command refuses to guess: choosing the wrong Bot would migrate the wrong
 * Session or upgrade the wrong database, and neither is recoverable by retrying.
 */
export function selectBot(argument: string | undefined, fleet = new Fleet()): BotRecord {
  const bots = fleet.bots();
  if (argument !== undefined) {
    const chosen = bots.find((bot) => bot.id === argument);
    if (!chosen) throw new Error(`No Bot has identity ${JSON.stringify(argument)}`);
    return chosen;
  }
  if (bots.length === 0) throw new Error("This Mochi deployment has no Bot yet");
  if (bots.length > 1) {
    const roster = bots.map((bot) => `  --bot ${bot.id}  ${bot.label}`).join("\n");
    throw new Error(`This deployment runs ${bots.length} Bots; name the one you mean:\n${roster}`);
  }
  return bots[0]!;
}

export function selectBotLayout(argument: string | undefined, fleet = new Fleet()): BotLayout {
  return productLayout().bot(selectBot(argument, fleet).id);
}

export function parseFleetRecord(value: unknown): FleetRecord {
  if (!record(value) || Object.keys(value).sort().join(",") !== RECORD_KEYS || value.version !== 2) {
    throw new FleetError("fleet_storage_unavailable");
  }
  if (!Array.isArray(value.bots) || value.bots.length > MAXIMUM_BOTS) throw new FleetError("fleet_storage_unavailable");
  const bots = value.bots.map(requireBot);
  const ids = new Set(bots.map((bot) => bot.id));
  if (ids.size !== bots.length) throw new FleetError("fleet_storage_unavailable");
  return { version: 2, bots };
}

function requireBot(value: unknown, index: number): BotRecord {
  if (!record(value) || Object.keys(value).sort().join(",") !== BOT_KEYS) {
    throw new FleetError("fleet_storage_unavailable");
  }
  if (!isBotId(value.id)) throw new FleetError("fleet_storage_unavailable");
  if (typeof value.enabled !== "boolean") throw new FleetError("fleet_storage_unavailable");
  if (typeof value.createdAt !== "string" || !ISO_INSTANT.test(value.createdAt)) {
    throw new FleetError("fleet_storage_unavailable");
  }
  return {
    id: value.id,
    label: requireLabel(value.label, index),
    characterId: requireBotCharacter(value.characterId),
    enabled: value.enabled,
    createdAt: value.createdAt,
  };
}

function requireLabel(value: unknown, index = -1): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label || label.length > MAXIMUM_LABEL_LENGTH || /[\r\n\t\0]/.test(label)) {
    const position = index >= 0 ? ` at position ${index}` : "";
    throw new Error(`Bot label must be a single line of at most ${MAXIMUM_LABEL_LENGTH} characters${position}`);
  }
  return label;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `mochi-bridge bot:list` — the roster an operator needs before naming a Bot. */
export async function runList(argv: readonly string[]): Promise<void> {
  if (argv.length !== 0) throw new Error("Usage: mochi-bridge bot:list");
  const fleet = new Fleet();
  const bots = fleet.bots();
  if (bots.length === 0) {
    console.log("This Mochi deployment has no Bot yet");
    return;
  }
  for (const bot of bots) {
    const state = bot.enabled ? "enabled" : "disabled";
    console.log(`${bot.id}  ${state}  ${bot.label}`);
  }
}
