import metadata from "../../package.json";

export const BRIDGE_VERSION = 1;
export const MINIMUM_MACOS_VERSION = "14.0";

export function productVersion(): string {
  const value: unknown = metadata;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mochi product metadata must be an object");
  }
  const version = (value as Record<string, unknown>).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Mochi product version must use semantic versioning");
  }
  return version;
}
