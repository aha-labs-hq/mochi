import {
  closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync,
  linkSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseBotConfig, serializeBotConfig } from "../config.ts";
import { productLayout, type BotLayout } from "./layout.ts";

export const DEFAULT_INSTRUCTIONS_FILE_NAME = "AGENTS.md";

/**
 * The default configuration a Bot starts with.
 *
 * It is read from the shipped product resources, never written by Mochi: the
 * model, the reasoning effort and the instruction document are the customer's to
 * change, and inventing a second default here would drift from the packaged one.
 */
export function defaultsDirectory(): string {
  return join(productLayout().immutableRoot, "Resources", "defaults");
}

/**
 * Creates one Bot's configuration directory from the shipped defaults.
 *
 * A Bot without `bot.toml` cannot be loaded at all, and a Bot without an
 * instruction document has no prompt. Both are therefore created before the Bot
 * is published in the roster. Failure removes only the new files; the fleet
 * discards the unpublished Bot directory.
 */
export function provisionBotConfiguration(layout: BotLayout): void {
  const defaults = defaultsDirectory();
  const botConfig = parseBotConfig(Bun.TOML.parse(readFileSync(join(defaults, "bot.toml"), "utf8")));
  const instructions = readFileSync(join(defaults, DEFAULT_INSTRUCTIONS_FILE_NAME), "utf8");
  if (!instructions.trim()) throw new Error("Shipped default instruction document is empty");

  mkdirSync(layout.configurationDirectory, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  try {
    writeExclusive(layout.botConfigPath, serializeBotConfig(botConfig));
    written.push(layout.botConfigPath);
    writeExclusive(join(layout.configurationDirectory, botConfig.agent.instructionsFile), instructions);
    written.push(join(layout.configurationDirectory, botConfig.agent.instructionsFile));
  } catch (error) {
    for (const path of written) rmSync(path, { force: true });
    throw error;
  }
}

/** Writes a new file without ever replacing one a customer may already own. */
function writeExclusive(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
