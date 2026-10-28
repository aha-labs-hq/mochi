import { isAbsolute, posix } from "node:path";
import {
  INSTALLED_PRODUCT_ROOT,
  SERVICE_LABEL,
  USER_DATA_DIRECTORY,
  USER_LAUNCH_AGENT_PATH,
  USER_LOG_DIRECTORY,
} from "./layout.ts";
import { PI_RUNTIME_CWD, PI_RUNTIME_USER, PI_SUDO_PATH, PI_WORKER_PATH } from "../runtime/constants.ts";
import { BRIDGE_USER_PATTERN, runtimeSudoersTemplate } from "../runtime/sudoers.ts";

export const INSTALLATION_CONTRACT_SCHEMA_VERSION = 6;
export const INSTALLATION_STATE_SCHEMA_VERSION = 1;
export const INSTALLED_APPLICATION_PATH = "/Applications/Mochi.app";
export const EMBEDDED_SETUP_PACKAGE_PATH = "Contents/Resources/Mochi-Setup.pkg";

export const INSTALLER_WORK_ROOT = "/Library/Application Support/Mochi Installer";
export const INSTALLER_PAYLOAD_ROOT = `${INSTALLER_WORK_ROOT}/Payload`;
export const INSTALLER_TRANSACTION_ROOT = `${INSTALLER_WORK_ROOT}/Transaction`;
export const INSTALLER_UPDATE_ROOT = `${INSTALLER_WORK_ROOT}/Update`;
export const UPDATE_SERVICE_LABEL = "app.mochi.update";
export const UPDATE_SERVICE_PLIST = `/Library/LaunchDaemons/${UPDATE_SERVICE_LABEL}.plist`;
export const UPDATE_SERVICE_SOCKET = "/var/run/app.mochi.update.sock";

export type InstallationPathScope = "system" | "consoleUserHome" | "runtimeHome";
export type InstallationRemoval = "remove" | "retain";

export interface InstallationCompatibility {
  schemaVersion: number;
  bridgeVersion: number;
  statusVersion: number;
  controlProtocolVersion: number;
}

export interface InstallationComponent {
  id: string;
  classification: "immutable" | "privileged";
  stagedBy: "package" | "postinstall";
  source: string;
  destinationScope: InstallationPathScope;
  destination: string;
  kind: "file" | "directory";
  verification:
    | "product-bin"
    | "product-resources"
    | "runtime-worker"
    | "notices"
    | "sudoers"
    | "launch-agent"
    | "installation-record"
    | "host-application"
    | "update-daemon";
  keepData: InstallationRemoval;
  deleteAll: InstallationRemoval;
}

export interface InstallationHostApplication {
  id: "app";
  classification: "immutable";
  deliveredBy: "disk-image";
  destinationScope: "system";
  destination: typeof INSTALLED_APPLICATION_PATH;
  kind: "directory";
  bundleIdentifier: "app.mochi.companion";
  embeddedPackage: typeof EMBEDDED_SETUP_PACKAGE_PATH;
  verification: "host-application";
  keepData: InstallationRemoval;
  deleteAll: InstallationRemoval;
}

export interface InstallationRetainedRoot {
  id: string;
  classification: "mutable";
  scope: InstallationPathScope;
  path: string;
  cleanup: readonly string[];
  keepData: InstallationRemoval;
  deleteAll: InstallationRemoval;
}

export interface InstallationExternalArtifact {
  id: string;
  classification: "privileged";
  kind: "runtime-account";
  identity: string;
  keepData: InstallationRemoval;
  deleteAll: InstallationRemoval;
}

/** The runtime sudoers rule with the Bridge account and worker digest left for the installer to fill. */
export interface InstallationSudoers {
  bridgeUserPattern: string;
  rule: string;
}

export interface InstallationMigration {
  id: string;
  from: number;
  to: number;
}

export interface InstallationManifest {
  schemaVersion: typeof INSTALLATION_CONTRACT_SCHEMA_VERSION;
  productVersion: string;
  compatibility: InstallationCompatibility;
  workRoot: string;
  payloadRoot: string;
  transactionRoot: string;
  runtimeSudoers: InstallationSudoers;
  installationState: {
    schemaVersion: typeof INSTALLATION_STATE_SCHEMA_VERSION;
    minimumReadableVersion: 0;
    migrations: readonly InstallationMigration[];
  };
  hostApplication: InstallationHostApplication;
  transactionalComponentCount: number;
  transactionalComponents: readonly InstallationComponent[];
  retainedRootCount: number;
  retainedRoots: readonly InstallationRetainedRoot[];
  externalArtifactCount: number;
  externalArtifacts: readonly InstallationExternalArtifact[];
}

const HOST_APPLICATION: InstallationHostApplication = Object.freeze({
  id: "app",
  classification: "immutable",
  deliveredBy: "disk-image",
  destinationScope: "system",
  destination: INSTALLED_APPLICATION_PATH,
  kind: "directory",
  bundleIdentifier: "app.mochi.companion",
  embeddedPackage: EMBEDDED_SETUP_PACKAGE_PATH,
  verification: "host-application",
  keepData: "remove",
  deleteAll: "remove",
});

const TRANSACTIONAL_COMPONENTS: readonly InstallationComponent[] = [
  {
    id: "host-application", classification: "immutable", stagedBy: "postinstall",
    source: "Prepared/Mochi.app", destinationScope: HOST_APPLICATION.destinationScope,
    destination: HOST_APPLICATION.destination, kind: "directory", verification: "host-application",
    keepData: "remove", deleteAll: "remove",
  },
  {
    id: "product-bin",
    classification: "immutable",
    stagedBy: "package",
    source: "Product/bin",
    destinationScope: "system",
    destination: `${INSTALLED_PRODUCT_ROOT}/bin`,
    kind: "directory",
    verification: "product-bin",
    keepData: "remove",
    deleteAll: "remove",
  },
  {
    id: "product-resources",
    classification: "immutable",
    stagedBy: "package",
    source: "Product/Resources",
    destinationScope: "system",
    destination: `${INSTALLED_PRODUCT_ROOT}/Resources`,
    kind: "directory",
    verification: "product-resources",
    keepData: "remove",
    deleteAll: "remove",
  },
  {
    id: "runtime-worker",
    classification: "immutable",
    stagedBy: "package",
    source: "Runtime/mochi-pi-runtime",
    destinationScope: "system",
    destination: PI_WORKER_PATH,
    kind: "file",
    verification: "runtime-worker",
    keepData: "remove",
    deleteAll: "remove",
  },
  {
    id: "notices",
    classification: "immutable",
    stagedBy: "package",
    source: "Documentation/mochi",
    destinationScope: "system",
    destination: "/usr/local/share/doc/mochi",
    kind: "directory",
    verification: "notices",
    keepData: "remove",
    deleteAll: "remove",
  },
  {
    id: "runtime-sudoers",
    classification: "privileged",
    stagedBy: "postinstall",
    source: "Prepared/mochi-pi-runtime.sudoers",
    destinationScope: "system",
    destination: "/etc/sudoers.d/mochi-pi-runtime",
    kind: "file",
    verification: "sudoers",
    keepData: "remove",
    deleteAll: "remove",
  },
  {
    id: "launch-agent",
    classification: "privileged",
    stagedBy: "postinstall",
    source: `Prepared/${SERVICE_LABEL}.plist`,
    destinationScope: "consoleUserHome",
    destination: USER_LAUNCH_AGENT_PATH,
    kind: "file",
    verification: "launch-agent",
    keepData: "remove",
    deleteAll: "remove",
  },
  {
    id: "update-daemon", classification: "privileged", stagedBy: "package",
    source: "Product/app.mochi.update.plist", destinationScope: "system",
    destination: UPDATE_SERVICE_PLIST, kind: "file", verification: "update-daemon",
    keepData: "remove", deleteAll: "remove",
  },
  {
    id: "installation-record",
    classification: "privileged",
    stagedBy: "postinstall",
    source: "Prepared/installed.json",
    destinationScope: "system",
    destination: `${INSTALLED_PRODUCT_ROOT}/Installation/installed.json`,
    kind: "file",
    verification: "installation-record",
    keepData: "retain",
    deleteAll: "remove",
  },
];

const RETAINED_ROOTS: readonly InstallationRetainedRoot[] = [
  {
    id: "update-cache", classification: "mutable", scope: "consoleUserHome",
    path: "Library/Caches/app.mochi.companion", cleanup: ["Updates"],
    keepData: "retain", deleteAll: "remove",
  },
  {
    id: "deployment-data",
    classification: "mutable",
    scope: "system",
    path: INSTALLED_PRODUCT_ROOT,
    cleanup: [],
    keepData: "retain",
    deleteAll: "remove",
  },
  {
    id: "user-data",
    classification: "mutable",
    scope: "consoleUserHome",
    path: USER_DATA_DIRECTORY,
    cleanup: ["status.json", "control.sock", "bot.lock"],
    keepData: "retain",
    deleteAll: "remove",
  },
  {
    id: "user-logs",
    classification: "mutable",
    scope: "consoleUserHome",
    path: USER_LOG_DIRECTORY,
    cleanup: [],
    keepData: "retain",
    deleteAll: "remove",
  },
  {
    id: "runtime-home",
    classification: "mutable",
    scope: "runtimeHome",
    path: ".",
    cleanup: [],
    keepData: "retain",
    deleteAll: "remove",
  },
  {
    id: "shared-materials",
    classification: "mutable",
    scope: "system",
    path: "/Users/Shared/mochi",
    cleanup: [],
    keepData: "retain",
    deleteAll: "remove",
  },
  {
    id: "user-preferences", classification: "mutable", scope: "consoleUserHome",
    path: "Library/Preferences/app.mochi.companion.plist", cleanup: [],
    keepData: "retain", deleteAll: "remove",
  },
  {
    id: "webview-data", classification: "mutable", scope: "consoleUserHome",
    path: "Library/WebKit/app.mochi.companion", cleanup: [],
    keepData: "remove", deleteAll: "remove",
  },
  {
    id: "saved-application-state", classification: "mutable", scope: "consoleUserHome",
    path: "Library/Saved Application State/app.mochi.companion.savedState", cleanup: [],
    keepData: "remove", deleteAll: "remove",
  },
  {
    id: "update-socket", classification: "mutable", scope: "system",
    path: UPDATE_SERVICE_SOCKET, cleanup: [],
    keepData: "remove", deleteAll: "remove",
  },
];

const RUNTIME_SUDOERS: InstallationSudoers = Object.freeze({
  bridgeUserPattern: BRIDGE_USER_PATTERN.source,
  rule: runtimeSudoersTemplate({
    sudoPath: PI_SUDO_PATH,
    runtimeUser: PI_RUNTIME_USER,
    workerPath: PI_WORKER_PATH,
    runtimeCwd: PI_RUNTIME_CWD,
  }),
});

const EXTERNAL_ARTIFACTS: readonly InstallationExternalArtifact[] = [
  {
    id: "runtime-account",
    classification: "privileged",
    kind: "runtime-account",
    identity: "_mochi",
    keepData: "retain",
    deleteAll: "remove",
  },
];

export function installationManifest(
  productVersion: string,
  compatibility: InstallationCompatibility,
): InstallationManifest {
  requireSemanticVersion(productVersion);
  requirePositiveInteger(compatibility.schemaVersion, "schemaVersion");
  requirePositiveInteger(compatibility.bridgeVersion, "bridgeVersion");
  requirePositiveInteger(compatibility.statusVersion, "statusVersion");
  requirePositiveInteger(compatibility.controlProtocolVersion, "controlProtocolVersion");
  return Object.freeze({
    schemaVersion: INSTALLATION_CONTRACT_SCHEMA_VERSION,
    productVersion,
    compatibility: Object.freeze({
      schemaVersion: compatibility.schemaVersion,
      bridgeVersion: compatibility.bridgeVersion,
      statusVersion: compatibility.statusVersion,
      controlProtocolVersion: compatibility.controlProtocolVersion,
    }),
    workRoot: INSTALLER_WORK_ROOT,
    payloadRoot: INSTALLER_PAYLOAD_ROOT,
    transactionRoot: INSTALLER_TRANSACTION_ROOT,
    runtimeSudoers: RUNTIME_SUDOERS,
    installationState: Object.freeze({
      schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
      minimumReadableVersion: 0 as const,
      migrations: Object.freeze([{ id: "adopt-pre-contract-installation", from: 0, to: 1 }]),
    }),
    hostApplication: HOST_APPLICATION,
    transactionalComponentCount: TRANSACTIONAL_COMPONENTS.length,
    transactionalComponents: TRANSACTIONAL_COMPONENTS,
    retainedRootCount: RETAINED_ROOTS.length,
    retainedRoots: RETAINED_ROOTS,
    externalArtifactCount: EXTERNAL_ARTIFACTS.length,
    externalArtifacts: EXTERNAL_ARTIFACTS,
  });
}

export function parseInstallationManifest(value: unknown): InstallationManifest {
  const root = record(value, "installation manifest");
  const productVersion = string(root.productVersion, "productVersion");
  const compatibility = record(root.compatibility, "compatibility");
  const expected = installationManifest(productVersion, {
    schemaVersion: integer(compatibility.schemaVersion, "compatibility.schemaVersion"),
    bridgeVersion: integer(compatibility.bridgeVersion, "compatibility.bridgeVersion"),
    statusVersion: integer(compatibility.statusVersion, "compatibility.statusVersion"),
    controlProtocolVersion: integer(
      compatibility.controlProtocolVersion,
      "compatibility.controlProtocolVersion",
    ),
  });
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("Installation manifest does not match the versioned Mochi authority");
  }
  return expected;
}

export function installationComponentSource(
  manifest: InstallationManifest,
  component: InstallationComponent,
): string {
  return posix.join(manifest.payloadRoot, component.source);
}

export function installationComponent(
  manifest: InstallationManifest,
  id: string,
): InstallationComponent {
  const component = manifest.transactionalComponents.find((entry) => entry.id === id);
  if (!component) throw new Error(`Installation manifest has no component named ${id}`);
  return component;
}

function requireSemanticVersion(value: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("Product version must use semantic versioning");
}

function requirePositiveInteger(value: number, path: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${path} must be a positive integer`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (path === "productVersion") requireSemanticVersion(value);
  else if (isAbsolute(value)) throw new Error(`${path} must not be absolute`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number") throw new Error(`${path} must be a number`);
  requirePositiveInteger(value, path);
  return value;
}
