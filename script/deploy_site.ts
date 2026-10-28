import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readBackStagedPublication } from "./release_readback.ts";
import { releaseDistribution } from "./release_distribution.ts";
import type { PublicationChannel } from "./stage_release_publication.ts";
import { INDEXNOW_ENDPOINT, indexNowSubmission, sitemapUrls } from "../site/build/indexnow.ts";

/**
 * The three ways mochi.host is deployed, chosen explicitly:
 *
 *   --registration  the beta-registration site from site/publication.json
 *   --public-beta   the /download/ page for a public beta publication
 *   --release       the formal /download/ page
 *
 * Both download pages are built only from a publication that is already
 * uploaded and reads back anonymously. All deploy the same Pages project;
 * none falls back to another.
 */

export type SiteDeployment =
  | { mode: "registration" }
  | {
    mode: PublicationChannel;
    candidateManifestPath: string;
    verificationResultPath: string;
    publicationDetailsPath: string;
    publicationDirectory: string;
    acceptanceRecordPaths: string[];
  };

export function parseSiteDeployment(args: readonly string[]): SiteDeployment {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      registration: { type: "boolean", default: false },
      "public-beta": { type: "boolean", default: false },
      release: { type: "boolean", default: false },
      "release-manifest": { type: "string" },
      "verification-result": { type: "string" },
      publication: { type: "string" },
      "publication-directory": { type: "string" },
      "acceptance-record": { type: "string", multiple: true },
    },
  });
  const releaseInputs = [
    values["release-manifest"], values["verification-result"], values.publication,
    values["publication-directory"], ...(values["acceptance-record"] ?? []),
  ];
  const modes = [values.registration, values["public-beta"], values.release].filter(Boolean).length;
  if (positionals.length || modes !== 1)
    throw new Error("Choose exactly one site deployment: --registration, or --public-beta or --release with its publication inputs");
  if (values.registration) {
    if (releaseInputs.some((value) => value !== undefined)) throw new Error("The registration site takes no release inputs");
    return { mode: "registration" };
  }
  const required = ["release-manifest", "verification-result", "publication", "publication-directory"] as const;
  const missing = required.filter((name) => !values[name]);
  if (missing.length || !values["acceptance-record"]?.length)
    throw new Error(`The download site requires --${[...missing, ...(values["acceptance-record"]?.length ? [] : ["acceptance-record"])].join(", --")}`);
  if (releaseInputs.some((value) => !value || !isAbsolute(value))) throw new Error("Download site inputs must be absolute paths");
  return {
    mode: values.release ? "release" : "public-beta",
    candidateManifestPath: values["release-manifest"]!,
    verificationResultPath: values["verification-result"]!,
    publicationDetailsPath: values.publication!,
    publicationDirectory: values["publication-directory"]!,
    acceptanceRecordPaths: values["acceptance-record"]!,
  };
}

/** The built download page must offer exactly the published disk image. */
export function requireReleaseDownloadPage(html: string, diskImageUrl: string): void {
  if (!html.includes(`href="${diskImageUrl}"`))
    throw new Error("The built /download/ page does not link the published Mochi.dmg; nothing was deployed");
}

async function run(command: string[], cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const child = Bun.spawn(command, { cwd, env: environment, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${command.slice(0, 3).join(" ")} failed`);
}

async function main(): Promise<void> {
  const deployment = parseSiteDeployment(process.argv.slice(2));
  const root = resolve(import.meta.dir, "..");
  const distribution = await releaseDistribution();
  const buildSite = (args: string[]) => run([process.execPath, "run", "site/build/site.ts", ...args, "--indexable"], root);
  if (deployment.mode !== "registration") {
    const { mode: channel, ...publication } = deployment;
    const readback = await readBackStagedPublication({ sourceRoot: root, channel, ...publication });
    if (!readback.accepted) throw new Error(`The publication does not read back: ${readback.failures.join("; ")}`);
    await buildSite([
      ...(channel === "public-beta" ? ["--public-beta"] : []),
      "--publication", deployment.publicationDetailsPath,
      "--release-manifest", deployment.candidateManifestPath,
      "--verification-result", deployment.verificationResultPath,
      ...deployment.acceptanceRecordPaths.flatMap((path) => ["--acceptance-record", path]),
      "--artifact-base-url", distribution.downloads.baseUrl,
    ]);
    const diskImage = readback.files.find(({ filename }) => filename === "Mochi.dmg")!;
    requireReleaseDownloadPage(await readFile(join(root, "site/dist/download/index.html"), "utf8"), diskImage.url);
  } else {
    await buildSite(["--publication", "site/publication.json"]);
  }
  await run([join(root, "node_modules/.bin/wrangler"), "pages", "deploy", "--cwd", "site", "--branch", "main"], root, {
    ...process.env,
    XDG_CONFIG_HOME: join(process.env.HOME!, ".config/aha-labs"),
    CLOUDFLARE_ACCOUNT_ID: distribution.cloudflareAccountId,
  });
  await submitIndexNow(join(root, "site/dist/sitemap.xml"));
}

/** Tells the IndexNow engines about every page just deployed. A refusal is reported, not hidden; the deployment stands. */
async function submitIndexNow(sitemapPath: string): Promise<void> {
  const submission = indexNowSubmission(sitemapUrls(await readFile(sitemapPath, "utf8")));
  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(submission),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) {
    console.log(`IndexNow accepted ${submission.urlList.length} URLs (HTTP ${response.status})`);
    return;
  }
  console.error(`IndexNow refused the submission with HTTP ${response.status}. The site is deployed; check ${submission.keyLocation} and resubmit.`);
  process.exitCode = 1;
}

if (import.meta.main) await main();
