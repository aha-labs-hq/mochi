/**
 * How in-product setup proves the embedded package before root installs it.
 * The product packager states it explicitly for every installed-mode App:
 * `development` for ad-hoc packages, or the Developer ID Team of a release.
 */
export type PackageTrust =
  | { readonly mode: "development" }
  | { readonly mode: "developer-id"; readonly teamId: string };

/** The same Apple designation is enforced by the App and its privileged package. */
export function developerIdApplicationRequirement(teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId))
    throw new Error("Invalid Developer ID Team");
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

/** Parses the packager's `MOCHI_PACKAGE_TRUST`; absent means the build cannot prepare an installed product. */
export function packageTrustFromEnvironment(
  value: string | undefined,
): PackageTrust | null {
  if (value === undefined) return null;
  if (value === "development") return { mode: "development" };
  const match = /^developer-id:([A-Z0-9]{10})$/.exec(value);
  if (match) return { mode: "developer-id", teamId: match[1]! };
  throw new Error(
    "MOCHI_PACKAGE_TRUST must be development or developer-id:<10-character Team ID>",
  );
}

export function packageTrustEnvironment(trust: PackageTrust): string {
  return trust.mode === "development"
    ? "development"
    : `developer-id:${trust.teamId}`;
}
