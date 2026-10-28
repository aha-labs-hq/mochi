import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { type BotLayout } from "./product/layout.ts";
import {
  PI_RUNTIME_CWD,
  PI_RUNTIME_HOME,
  PI_RUNTIME_USER,
  PI_SUDO_PATH,
  PI_WORKER_PATH,
} from "./runtime/constants.ts";

import {
  REASONING_EFFORTS,
  isReasoningEffort,
  type ReasoningEffort,
  type RuntimePolicy,
} from "./runtime/policy.ts";

export interface BotConfig {
  agent: {
    instructionsFile: string;
  };
  runtime: RuntimePolicy & {
    turnTimeoutSeconds: number;
  };
}

/**
 * Everything one Bot needs in order to run, resolved from its own BotLayout.
 *
 * There is no deployment-wide policy left to read: `bot.toml` under the Bot's own
 * configuration directory owns model, reasoning effort, turn timeout and the
 * instruction document. A second Bot can therefore differ in every one of them
 * without a shared default to reconcile.
 */
export interface BotContext {
  botId: string;
  layout: BotLayout;
  agent: {
    instructions: string;
    instructionsPath: string;
  };
  runtime: RuntimeConfig & { sessionId: string };
}

export interface RuntimeConfig {
  botId: string;
  workerPath: string;
  sudoPath: string;
  runtimeUser: string;
  runtimeHome: string;
  runtimeCwd: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  turnTimeoutMilliseconds: number;
}

/** Resolves one Bot's complete runtime and agent configuration. */
export function loadBotContext(layout: BotLayout, sessionId: string): BotContext {
  const botConfig = loadBotConfig(layout);
  return {
    botId: layout.botId,
    layout,
    agent: loadAgentInstructions(layout, botConfig),
    runtime: { ...loadRuntimeConfig(botConfig, layout.botId), sessionId },
  };
}

/**
 * The same configuration for a Bot whose first Session does not exist yet.
 *
 * The Session identity it carries is the durable first-run candidate, which is
 * prepared before any worker starts. The customer's explicit initialization
 * bootstraps exactly that identity and activates it; until then it is a
 * candidate, and `runtime.sessionId` is not a permanent Session.
 */
export function loadBotContextBeforeSetup(
  layout: BotLayout,
  candidateSessionId: string,
): BotContext {
  const botConfig = loadBotConfig(layout);
  return {
    botId: layout.botId,
    layout,
    agent: loadAgentInstructions(layout, botConfig),
    runtime: { ...loadRuntimeConfig(botConfig, layout.botId), sessionId: candidateSessionId },
  };
}

export function loadRuntimeConfig(botConfig: BotConfig, botId: string): RuntimeConfig {
  const currentUser = process.env.USER?.trim();
  if (currentUser && PI_RUNTIME_USER === currentUser) {
    throw new Error("The Pi runtime user must be distinct from the Bridge user");
  }
  return {
    botId,
    workerPath: PI_WORKER_PATH,
    sudoPath: PI_SUDO_PATH,
    runtimeUser: PI_RUNTIME_USER,
    runtimeHome: PI_RUNTIME_HOME,
    runtimeCwd: PI_RUNTIME_CWD,
    model: botConfig.runtime.model,
    reasoningEffort: botConfig.runtime.reasoningEffort,
    turnTimeoutMilliseconds: botConfig.runtime.turnTimeoutSeconds * 1_000,
  };
}

export function loadBotConfig(layout: BotLayout): BotConfig {
  return parseBotConfig(Bun.TOML.parse(readFileSync(layout.botConfigPath, "utf8")));
}

export function saveBotPolicy(layout: BotLayout, policy: RuntimePolicy): void {
  const botConfigPath = layout.botConfigPath;
  const current = loadBotConfig(layout);
  const next: BotConfig = {
    ...current,
    runtime: {
      ...current.runtime,
      model: nonEmptyString(policy.model, "config.runtime.model"),
      reasoningEffort: policy.reasoningEffort,
    },
  };
  if (!isReasoningEffort(next.runtime.reasoningEffort)) {
    throw new Error(`Unsupported reasoning effort: ${next.runtime.reasoningEffort}`);
  }
  const serialized = serializeBotConfig(next);
  const verified = parseBotConfig(Bun.TOML.parse(serialized));
  if (verified.runtime.model !== policy.model || verified.runtime.reasoningEffort !== policy.reasoningEffort) {
    throw new Error("Bot policy serialization did not preserve the requested values");
  }

  const mode = statSync(botConfigPath).mode & 0o777;
  const temporaryPath = `${botConfigPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, botConfigPath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

export function serializeBotConfig(config: BotConfig): string {
  return [
    "[agent]",
    `instructions_file = ${JSON.stringify(config.agent.instructionsFile)}`,
    "",
    "[runtime]",
    `model = ${JSON.stringify(config.runtime.model)}`,
    `reasoning_effort = ${JSON.stringify(config.runtime.reasoningEffort)}`,
    `turn_timeout_seconds = ${config.runtime.turnTimeoutSeconds}`,
    "",
  ].join("\n");
}

export function parseBotConfig(value: unknown): BotConfig {
  const root = strictObject(value, "config");
  requireKeys(root, ["agent", "runtime"], "config");
  const agent = strictObject(root.agent, "config.agent");
  requireKeys(agent, ["instructions_file"], "config.agent");
  const runtime = strictObject(root.runtime, "config.runtime");
  requireKeys(runtime, ["model", "reasoning_effort", "turn_timeout_seconds"], "config.runtime");

  const model = nonEmptyString(runtime.model, "config.runtime.model");
  const reasoningEffort = nonEmptyString(runtime.reasoning_effort, "config.runtime.reasoning_effort");
  if (!isReasoningEffort(reasoningEffort)) {
    throw new Error(`config.runtime.reasoning_effort must be one of ${[...REASONING_EFFORTS].join(", ")}`);
  }
  const turnTimeoutSeconds = runtime.turn_timeout_seconds;
  if (!Number.isInteger(turnTimeoutSeconds) || Number(turnTimeoutSeconds) <= 0) {
    throw new Error("config.runtime.turn_timeout_seconds must be a positive integer");
  }
  return {
    agent: {
      instructionsFile: nonEmptyString(agent.instructions_file, "config.agent.instructions_file"),
    },
    runtime: {
      model,
      reasoningEffort: reasoningEffort as ReasoningEffort,
      turnTimeoutSeconds: Number(turnTimeoutSeconds),
    },
  };
}

export function loadAgentInstructions(layout: BotLayout, botConfig = loadBotConfig(layout)): BotContext["agent"] {
  const instructionsPath = agentInstructionsPath(botConfig.agent.instructionsFile, layout.configurationDirectory);
  const instructions = readFileSync(instructionsPath, "utf8").trim();
  if (!instructions) throw new Error("config.agent.instructions_file must not be empty");
  return { instructions, instructionsPath };
}

export function agentInstructionsPath(instructionsFile: string, configurationDirectory: string): string {
  const candidate = resolve(configurationDirectory, instructionsFile);
  if (!candidate.startsWith(`${configurationDirectory}/`) || !candidate.endsWith(".md")) {
    throw new Error("config.agent.instructions_file must be a Markdown file inside the configuration directory");
  }
  const instructionsPath = realpathSync(candidate);
  const configDirectory = realpathSync(configurationDirectory);
  if (!instructionsPath.startsWith(`${configDirectory}/`)) {
    throw new Error("config.agent.instructions_file must not escape the configuration directory through a symlink");
  }
  return instructionsPath;
}

function strictObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !(key in value));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length) throw new Error(`${path} is missing ${missing.join(", ")}`);
  if (unknown.length) throw new Error(`${path} contains unknown keys: ${unknown.join(", ")}`);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

