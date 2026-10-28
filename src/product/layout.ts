import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
/** The root the installer owns. The system path is spelled only here. */
export const INSTALLED_PRODUCT_ROOT = "/Library/Application Support/Mochi";
/** The LaunchAgent identity; both deployment modes share it. */
export const SERVICE_LABEL = "app.mochi.bridge";

/**
 * Home-relative paths the console user owns in both deployment modes. The
 * installation inventory, the Bridge and the App all derive their absolute
 * paths from these; no other module spells a product root.
 */
export const USER_DATA_DIRECTORY = "Library/Application Support/Mochi";
export const USER_LOG_DIRECTORY = "Library/Logs/Mochi";
export const USER_LAUNCH_AGENT_PATH = `Library/LaunchAgents/${SERVICE_LABEL}.plist`;
export const STATUS_SNAPSHOT_NAME = "status.json";
export const CONTROL_SOCKET_NAME = "control.sock";

export const PRODUCT_ROOT_ENVIRONMENT_KEY = "MOCHI_PRODUCT_ROOT";
export const PRODUCT_DATA_ROOT_ENVIRONMENT_KEY = "MOCHI_DATA_ROOT";
export const GITHUB_REGISTRATION_RESOURCE_NAME = "github-oauth.json";

/** One directory per Bot. Every Bot-owned path derives from this root. */
export const BOTS_DIRECTORY_NAME = "Bots";

/** The Bot roster. The only place a Bot local identity and name are decided. */
export const FLEET_RECORD_NAME = "fleet.json";

export const INSTALLED_BRIDGE_PATH = `${INSTALLED_PRODUCT_ROOT}/bin/mochi-bridge`;
export const INSTALLED_LARK_CLI_PATH = `${INSTALLED_PRODUCT_ROOT}/bin/lark-cli`;

const BOT_ID_PATTERN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export type ProductMode = "development" | "installed";

/** Paths owned by one Bot. Never mix two Bots' paths in one value. */
export interface BotLayout {
  botId: string;
  configurationDirectory: string;
  botConfigPath: string;
  stateDirectory: string;
  stateDatabasePath: string;
  stateLockPath: string;
  feishuConnectionDirectory: string;
  githubCredentialPath: string;
  materialStagingRoot: string;
}

/** The console user's paths, identical in both modes: what the App and the Bridge meet at. */
export interface UserLayout {
  /** One Bridge lock beside the shared status and control socket, in both modes. */
  deploymentLockPath: string;
  dataDirectory: string;
  statusSnapshotPath: string;
  controlSocketPath: string;
  launchAgentPath: string;
  logDirectory: string;
  /** The Bridge's structured log. */
  structuredLogPath: string;
  /** The App's structured log. */
  companionLogPath: string;
}

export function userLayout(homeDirectory: string): UserLayout {
  if (!isAbsolute(homeDirectory)) throw new Error("Home directory must be absolute");
  const home = resolve(homeDirectory);
  const dataDirectory = join(home, USER_DATA_DIRECTORY);
  const logDirectory = join(home, USER_LOG_DIRECTORY);
  return Object.freeze({
    dataDirectory,
    deploymentLockPath: join(dataDirectory, "bot.lock"),
    statusSnapshotPath: join(dataDirectory, STATUS_SNAPSHOT_NAME),
    controlSocketPath: join(dataDirectory, CONTROL_SOCKET_NAME),
    launchAgentPath: join(home, USER_LAUNCH_AGENT_PATH),
    logDirectory,
    structuredLogPath: join(logDirectory, "service.jsonl"),
    companionLogPath: join(logDirectory, "companion.jsonl"),
  });
}

export interface ProductLayout extends UserLayout {
  mode: ProductMode;
  immutableRoot: string;
  mutableRoot: string;
  botsDirectory: string;
  fleetRecordPath: string;
  protocolDirectory: string;
  githubOAuthClientPath: string;
  bridgeExecutablePath: string;
  larkCliPath: string;
  workingDirectory: string;
  /** Throws on any identity that is not a Bot UUID; the roster is the admission gate. */
  bot(botId: string): BotLayout;
}

interface SharedLayoutInput {
  mode: ProductMode;
  immutableRoot: string;
  mutableRoot: string;
  configurationDirectory?: string;
  protocolDirectory: string;
  bridgeExecutablePath: string;
  larkCliPath: string;
  workingDirectory: string;
  homeDirectory: string;
}

/**
 * Resolves every product-owned path from one explicit mode boundary.
 *
 * Both deployments run independently of the checkout. Installed mode is fixed: a
 * LaunchAgent cannot redirect Mochi to an arbitrary executable or resource
 * tree by editing environment variables. Bot-owned paths are derived by `bot()`
 * so no caller can assemble a second convention.
 */
export function resolveProductLayout(input: {
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
} = {}): ProductLayout {
  const environment = input.environment ?? process.env;
  const homeDirectory = resolve(input.homeDirectory ?? homedir());
  const configuredProductRoot = environment[PRODUCT_ROOT_ENVIRONMENT_KEY]?.trim();

  if (!configuredProductRoot) {
    for (const key of [PRODUCT_DATA_ROOT_ENVIRONMENT_KEY]) {
      if (environment[key] !== undefined) throw new Error(`${key} cannot redirect development deployment`);
    }
    return developmentLayout(homeDirectory);
  }
  if (!isAbsolute(configuredProductRoot) || resolve(configuredProductRoot) !== INSTALLED_PRODUCT_ROOT) {
    throw new Error(`${PRODUCT_ROOT_ENVIRONMENT_KEY} must be ${INSTALLED_PRODUCT_ROOT}`);
  }

  const expectedMutableRoot = userLayout(homeDirectory).dataDirectory;
  const configuredMutableRoot = environment[PRODUCT_DATA_ROOT_ENVIRONMENT_KEY]?.trim();
  if (configuredMutableRoot && (
    !isAbsolute(configuredMutableRoot) || resolve(configuredMutableRoot) !== expectedMutableRoot
  )) {
    throw new Error(`${PRODUCT_DATA_ROOT_ENVIRONMENT_KEY} must be ${expectedMutableRoot}`);
  }
  return installedLayout(homeDirectory, expectedMutableRoot);
}

let cachedLayout: ProductLayout | undefined;

export function productLayout(): ProductLayout {
  cachedLayout ??= resolveProductLayout();
  return cachedLayout;
}

function developmentLayout(homeDirectory: string): ProductLayout {
  const mutableRoot = join(userLayout(homeDirectory).dataDirectory, "Development");
  const immutableRoot = join(mutableRoot, "Runtime");
  return sharedLayout({
    mode: "development",
    immutableRoot,
    mutableRoot,
    protocolDirectory: join(immutableRoot, "Resources", "protocol"),
    bridgeExecutablePath: join(immutableRoot, "bin", "mochi-bridge"),
    larkCliPath: join(immutableRoot, "bin", "lark-cli"),
    workingDirectory: "/var/empty",
    homeDirectory,
  });
}

function installedLayout(
  homeDirectory: string,
  mutableRoot: string,
): ProductLayout {
  return sharedLayout({
    mode: "installed",
    immutableRoot: INSTALLED_PRODUCT_ROOT,
    mutableRoot,
    protocolDirectory: join(INSTALLED_PRODUCT_ROOT, "Resources", "protocol"),
    bridgeExecutablePath: INSTALLED_BRIDGE_PATH,
    larkCliPath: INSTALLED_LARK_CLI_PATH,
    workingDirectory: "/var/empty",
    homeDirectory,
  });
}

function sharedLayout(input: SharedLayoutInput): ProductLayout {
  const botsDirectory = join(input.mutableRoot, BOTS_DIRECTORY_NAME);
  const paths = Object.freeze({
    ...userLayout(input.homeDirectory),
    mode: input.mode,
    immutableRoot: input.immutableRoot,
    mutableRoot: input.mutableRoot,
    botsDirectory,
    fleetRecordPath: join(input.mutableRoot, FLEET_RECORD_NAME),
    protocolDirectory: input.protocolDirectory,
    githubOAuthClientPath: join(input.immutableRoot, "Resources", GITHUB_REGISTRATION_RESOURCE_NAME),
    bridgeExecutablePath: input.bridgeExecutablePath,
    larkCliPath: input.larkCliPath,
    workingDirectory: input.workingDirectory,
  });
  return { ...paths, bot: (botId: string) => botLayout(botsDirectory, botId) };
}

export function isBotId(value: unknown): value is string {
  return typeof value === "string" && BOT_ID_PATTERN.test(value);
}

export function botLayout(botsDirectory: string, botId: string): BotLayout {
  if (!isBotId(botId)) {
    throw new Error(`Bot identity must be a lowercase UUID: ${JSON.stringify(botId)}`);
  }
  const directory = join(botsDirectory, botId);
  const configurationDirectory = join(directory, "Configuration");
  const stateDirectory = join(directory, "State");
  return Object.freeze({
    botId,
    configurationDirectory,
    botConfigPath: join(configurationDirectory, "bot.toml"),
    stateDirectory,
    stateDatabasePath: join(stateDirectory, "bot.sqlite"),
    stateLockPath: join(stateDirectory, "bot.lock"),
    feishuConnectionDirectory: join(directory, "Connections", "feishu"),
    githubCredentialPath: join(directory, "Connections", "github.json"),
    materialStagingRoot: join(stateDirectory, "materialStaging"),
  });
}
