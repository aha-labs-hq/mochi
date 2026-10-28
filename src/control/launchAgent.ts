import { desktopIdentity } from "../../controlApp/build/identity.ts";
import { STRUCTURED_LOG_PATH_ENVIRONMENT_KEY } from "../log.ts";
import {
  PRODUCT_DATA_ROOT_ENVIRONMENT_KEY,
  PRODUCT_ROOT_ENVIRONMENT_KEY,
  type ProductMode,
  SERVICE_LABEL,
} from "../product/layout.ts";

// User messages and companion controls need prompt worker startup, without Background I/O throttling.
export const BRIDGE_PROCESS_TYPE = "Interactive";

export interface ServicePaths {
  mode: ProductMode;
  command: readonly string[];
  workingDirectory: string;
  immutableRoot: string;
  mutableRoot: string;
  dataDirectory: string;
  plistPath: string;
  structuredLogPath: string;
  statusPath: string;
}

export function buildLaunchAgentPlist(paths: ServicePaths): string {
  if (paths.command.length === 0 || !paths.command[0]!.startsWith("/")) {
    throw new Error("LaunchAgent executable must be an absolute path");
  }
  if (paths.command.length !== 1 || paths.command[0] !== `${paths.immutableRoot}/bin/mochi-bridge`) {
    throw new Error(
      "LaunchAgent must start the fixed Bridge executable directly",
    );
  }
  if (paths.workingDirectory !== "/var/empty") throw new Error("Bridge working directory must be /var/empty");
  // Login Items attributes the agent to the App of the same deployment instead of the bare executable.
  const application = desktopIdentity(paths.mode === "installed").identifier;
  const installedEnvironment =
    paths.mode === "installed"
      ? `
    <key>${PRODUCT_ROOT_ENVIRONMENT_KEY}</key>
    <string>${xml(paths.immutableRoot)}</string>
    <key>${PRODUCT_DATA_ROOT_ENVIRONMENT_KEY}</key>
    <string>${xml(paths.mutableRoot)}</string>`
      : "";
  const argumentsXml = paths.command
    .map((argument) => `    <string>${xml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>AssociatedBundleIdentifiers</key>
  <string>${xml(application)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>${BRIDGE_PROCESS_TYPE}</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${STRUCTURED_LOG_PATH_ENVIRONMENT_KEY}</key>
    <string>${xml(paths.structuredLogPath)}</string>${installedEnvironment}
  </dict>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
