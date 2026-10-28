import {
  type PublicationChannel,
  type PublicationDetails,
  publicHttpsAddress,
  type ReleasePublicationInput,
  validateReleasePublication,
} from "../../script/stage_release_publication.ts";
import type { SiteRelease } from "../src/context.ts";

export interface WebsiteReleaseInput {
  /** Builds the public beta's download page instead of a release's. */
  publicBeta?: boolean;
  candidateManifestPath?: string;
  verificationResultPath?: string;
  publicationDetailsPath?: string;
  acceptanceRecordPaths: string[];
  artifactBaseUrl?: string;
}

/** The default site stays in beta. Partial release inputs fail before building. */
export function websiteReleaseInput(
  sourceRoot: string,
  input: WebsiteReleaseInput,
): (ReleasePublicationInput & { artifactBaseUrl: string }) | null {
  if (
    !input.publicBeta &&
    input.candidateManifestPath === undefined &&
    input.verificationResultPath === undefined &&
    !input.acceptanceRecordPaths.length &&
    input.artifactBaseUrl === undefined
  )
    return null;
  if (
    !input.candidateManifestPath ||
    !input.verificationResultPath ||
    !input.publicationDetailsPath ||
    !input.acceptanceRecordPaths.length ||
    !input.artifactBaseUrl
  )
    throw new Error(
      "Website downloads require a candidate, verification receipt, publication details, acceptance records and artifact base URL",
    );
  const base = artifactBase(input.artifactBaseUrl);
  const channel: PublicationChannel = input.publicBeta
    ? "public-beta"
    : "release";
  return {
    channel,
    sourceRoot,
    candidateManifestPath: input.candidateManifestPath,
    verificationResultPath: input.verificationResultPath,
    publicationDetailsPath: input.publicationDetailsPath,
    acceptanceRecordPaths: input.acceptanceRecordPaths,
    artifactBaseUrl: base.toString(),
  };
}

/** Never includes private evidence, issuer inputs, log paths or credentials. */
export async function websiteRelease(
  input: ReleasePublicationInput & { artifactBaseUrl: string },
): Promise<{ release: SiteRelease; details: PublicationDetails }> {
  const base = artifactBase(input.artifactBaseUrl);
  const { manifest, directoryName, details } =
    await validateReleasePublication(input);
  const url = (filename: string) =>
    new URL(`${directoryName}/${filename}`, base).toString();
  const release: SiteRelease = {
    channel: input.channel,
    productVersion: manifest.productVersion,
    architecture: manifest.architecture,
    minimumMacOS: manifest.minimumMacOS,
    limitations: manifest.limitations,
    artifacts: manifest.artifacts
      .filter((artifact) => artifact.role === "applicationDiskImage")
      .map((artifact) => ({
        ...artifact,
        role: "applicationDiskImage" as const,
        url: url(artifact.filename),
      })),
    notesUrl: url("RELEASE_NOTES.md"),
    checksumsUrl: url("SHA256SUMS.txt"),
  };
  return { release, details };
}

function artifactBase(text: string): URL {
  const base = publicHttpsAddress(text, "Artifact base URL");
  if (!base.pathname.endsWith("/") || base.search || base.hash)
    throw new Error(
      "Artifact base URL must end with / and contain no query or fragment",
    );
  return base;
}
