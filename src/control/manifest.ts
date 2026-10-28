import { CONTROL_SOCKET_NAME, type ProductMode, STATUS_SNAPSHOT_NAME } from "../product/layout.ts";
import {
  EMBEDDED_SETUP_PACKAGE_PATH,
  INSTALLED_APPLICATION_PATH,
} from "../product/installation.ts";
import { BRIDGE_VERSION } from "../product/version.ts";
import { MOCHI_CONTROL_PROTOCOL_VERSION } from "./protocol.ts";
import { STATUS_VERSION } from "./statusSnapshot.ts";

export const CONTROL_MANIFEST_SCHEMA_VERSION = 3;

export interface MochiControlManifest {
  schemaVersion: typeof CONTROL_MANIFEST_SCHEMA_VERSION;
  productVersion: string;
  serviceMode: ProductMode;
  bridgeVersion: typeof BRIDGE_VERSION;
  statusVersion: typeof STATUS_VERSION;
  controlProtocolVersion: typeof MOCHI_CONTROL_PROTOCOL_VERSION;
  controlSocketName: typeof CONTROL_SOCKET_NAME;
  statusSnapshotName: typeof STATUS_SNAPSHOT_NAME;
  installedApplicationPath: typeof INSTALLED_APPLICATION_PATH;
  embeddedSetupPackagePath: typeof EMBEDDED_SETUP_PACKAGE_PATH;
}

/** The complete signed App product compatibility contract. */
export function mochiControlManifest(
  serviceMode: ProductMode,
  productVersion: string,
): MochiControlManifest {
  if (!/^\d+\.\d+\.\d+$/.test(productVersion)) {
    throw new Error("Mochi product version must use semantic versioning");
  }
  return Object.freeze({
    schemaVersion: CONTROL_MANIFEST_SCHEMA_VERSION,
    productVersion,
    serviceMode,
    bridgeVersion: BRIDGE_VERSION,
    statusVersion: STATUS_VERSION,
    controlProtocolVersion: MOCHI_CONTROL_PROTOCOL_VERSION,
    controlSocketName: CONTROL_SOCKET_NAME,
    statusSnapshotName: STATUS_SNAPSHOT_NAME,
    installedApplicationPath: INSTALLED_APPLICATION_PATH,
    embeddedSetupPackagePath: EMBEDDED_SETUP_PACKAGE_PATH,
  });
}
