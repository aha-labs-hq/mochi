import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReleaseAcceptanceTemplate, createReleaseCandidateManifest, PUBLIC_BETA_CHECKPOINTS, RELEASE_ACCEPTANCE_SCENARIOS,
} from "../script/release_acceptance.ts";
import { parseSiteDeployment, requireReleaseDownloadPage } from "../script/deploy_site.ts";
import { parseReleaseDistribution, releaseDistribution, requireDeveloperIdTeam } from "../script/release_distribution.ts";
import { readBackPublication } from "../script/release_readback.ts";
import { r2CredentialsFromEnvironment, signS3Request, uploadPublication } from "../script/release_upload.ts";
import {
  parsePublicationDetails, publicationArguments, publicationObjectHeaders, stageReleasePublication, validateReleasePublication,
  verifyStagedPublication,
} from "../script/stage_release_publication.ts";
import { verificationEnvironment, verifyLocal } from "../script/verify.ts";
import { websiteRelease, websiteReleaseInput, type WebsiteReleaseInput } from "../site/build/release.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const publicDetails = {
  schemaVersion: 1 as const, publisherName: "Mochi Release Fixture",
  downloadPageUrl: "https://mochi-product.tld/download", supportUrl: "https://mochi-product.tld/support",
  privacyContactEmail: "privacy@mochi-product.tld",
};

describe("public release staging", () => {
  test("requires reviewed public contacts and rejects placeholders, credentials, hidden fields and multiline copy", () => {
    expect(parsePublicationDetails(publicDetails)).toEqual(publicDetails);
    const mailSupport = { ...publicDetails, supportUrl: "mailto:support@mochi-product.tld" };
    expect(parsePublicationDetails(mailSupport)).toEqual(mailSupport);
    for (const details of [
      { ...publicDetails, supportUrl: "mailto:support@placeholder.example" },
      { ...publicDetails, supportUrl: "mailto:support@mochi-product.tld?subject=Help" },
      { ...publicDetails, supportUrl: "mailto:" },
      { ...publicDetails, publisherName: "" },
      { ...publicDetails, downloadPageUrl: "https://example.com/download" },
      { ...publicDetails, supportUrl: "https://name:password@mochi-product.tld/support" },
      { ...publicDetails, privacyContactEmail: "privacy@placeholder.example" },
      { ...publicDetails, publisherName: "Name\nSecret" },
      { ...publicDetails, privateCredential: "must-not-ship" },
    ]) expect(() => parsePublicationDetails(details)).toThrow();
  });

  test("stages only immutable fixture artifacts and committed public docs, without private acceptance or logs", async () => {
    const fixture = await publicationFixture();
    const result = await stageReleasePublication(fixture.input);
    expect(result.fileCount).toBe(6);
    const files = await readdir(result.publicationDirectory);
    expect(files.sort()).toEqual([
      "Mochi-Release.json",
      "Mochi.dmg", "PRIVACY.md", "README.md", "RELEASE_NOTES.md", "SHA256SUMS.txt",
    ]);
    for (const filename of ["Mochi.dmg"]) {
      expect(await readFile(join(result.publicationDirectory, filename))).toEqual(await readFile(join(fixture.candidate, filename)));
    }
    expect((await readFile(join(result.publicationDirectory, "PRIVACY.md"), "utf8"))).toContain("privacy@mochi-product.tld");
    const checksums = await readFile(join(result.publicationDirectory, "SHA256SUMS.txt"), "utf8");
    for (const filename of files.filter((name) => name !== "SHA256SUMS.txt")) {
      expect(checksums).toContain(`${hash(await readFile(join(result.publicationDirectory, filename)))}  ${filename}\n`);
    }
    expect(await readFile(join(result.publicationDirectory, "README.md"), "utf8")).not.toContain("{{");
    await expect(stageReleasePublication(fixture.input)).rejects.toThrow("already exists");
  });

  test("refuses to stage a missing live schedule checkpoint or newer-system-only support proof", async () => {
    const fixture = await publicationFixture();
    const record = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    const checkpoint = record.scenarios.find((item: { id: string }) => item.id === "schedules").checkpoints[1];
    checkpoint.result = "blocked";
    await writeFile(fixture.recordPath, JSON.stringify(record));
    await expect(stageReleasePublication(fixture.input)).rejects.toThrow("real-due-result-at-agreed-location is blocked");
    expect(await readdir(fixture.output)).toEqual([]);
    checkpoint.result = "pass";
    record.target.macOSVersion = "15.6.1";
    await writeFile(fixture.recordPath, JSON.stringify(record));
    await expect(stageReleasePublication(fixture.input)).rejects.toThrow("minimum macOS major version");
    expect(await readdir(fixture.output)).toEqual([]);
  });

  test("a public beta needs its install, permission and removal checkpoints, and says it is a beta", async () => {
    const fixture = await publicationFixture();
    const record = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    const scenario = (id: string) => record.scenarios.find((item: { id: string }) => item.id === id);
    const checkpoint = (id: string) => {
      const [scenarioId, checkpointId] = id.split("/");
      return scenario(scenarioId!).checkpoints.find((item: { id: string }) => item.id === checkpointId);
    };
    const suite = RELEASE_ACCEPTANCE_SCENARIOS.flatMap(({ id, checkpoints }) => checkpoints.map((item) => `${id}/${item}`));
    expect(PUBLIC_BETA_CHECKPOINTS.every((id) => suite.includes(id))).toBe(true);
    // Everything that needs customer accounts, the issuer or an update stays blocked.
    for (const id of suite.filter((item) => !(PUBLIC_BETA_CHECKPOINTS as readonly string[]).includes(item))) checkpoint(id).result = "blocked";
    await writeFile(fixture.recordPath, JSON.stringify(record));
    await expect(stageReleasePublication(fixture.input)).rejects.toThrow("Release acceptance is incomplete");
    const beta = { ...fixture.input, channel: "public-beta" as const };
    const { publicationDirectory } = await stageReleasePublication(beta);
    expect(publicationDirectory.split("/").at(-1)).toMatch(/^Mochi-0\.2\.0-beta-(arm64|x86_64)-[0-9a-f]{16}$/);
    const notes = await readFile(join(publicationDirectory, "RELEASE_NOTES.md"), "utf8");
    expect(notes).toStartWith("# Mochi 0.2.0 公开测试版\n");
    expect(notes).toContain("应用内更新尚未开放");
    expect(notes).toContain("不要把新版本直接拖进「应用程序」覆盖旧版");
    const { release } = await websiteRelease({ ...beta, artifactBaseUrl: "https://downloads.mochi-product.tld/" });
    expect(release.channel).toBe("public-beta");
    expect(release.artifacts[0]!.url).toContain("/Mochi-0.2.0-beta-");
    for (const id of PUBLIC_BETA_CHECKPOINTS) {
      checkpoint(id).result = "blocked";
      await writeFile(fixture.recordPath, JSON.stringify(record));
      await expect(validateReleasePublication(beta)).rejects.toThrow(`Public beta acceptance is incomplete: ${id} is blocked`);
      checkpoint(id).result = "pass";
    }
    record.target.baseline.bunAbsent = false;
    await writeFile(fixture.recordPath, JSON.stringify(record));
    await expect(validateReleasePublication(beta)).rejects.toThrow("target baseline is not proven: bunAbsent");
  });

  test("the website may move ahead of the candidate, but never away from it", async () => {
    const fixture = await publicationFixture();
    const git = (args: string[]) => execFileSync("git", ["-C", fixture.root, ...args], {
      env: verificationEnvironment(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const commit = (message: string) => git(["-c", "user.name=Publication Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-m", message]);
    const candidate = git(["rev-parse", "HEAD"]);
    await writeFile(join(fixture.root, "site-change.txt"), "a later website change\n");
    git(["add", "."]);
    commit("site change");
    const { release } = await websiteRelease({ ...fixture.input, artifactBaseUrl: "https://downloads.mochi-product.tld/" });
    expect(release.productVersion).toBe("0.2.0");
    git(["checkout", "-q", "--orphan", "unrelated"]);
    commit("unrelated history");
    await expect(validateReleasePublication(fixture.input)).rejects.toThrow("later commit that contains it");
    git(["checkout", "-q", candidate]);
    await expect(validateReleasePublication(fixture.input)).resolves.toBeDefined();
  });

  test("publication commands take the public beta only as an explicit leading choice", () => {
    const paths = ["/c/Mochi-Release.json", "/r/result.json", "/p/publication.json", "/s/directory", "/e/a.json"];
    expect(publicationArguments(paths, "release:stage").channel).toBe("release");
    expect(publicationArguments(["--public-beta", ...paths], "release:stage")).toMatchObject({
      channel: "public-beta", directory: "/s/directory", acceptanceRecordPaths: ["/e/a.json"],
    });
    expect(() => publicationArguments([...paths, "--public-beta"], "release:stage")).toThrow("Usage");
    expect(() => publicationArguments(["--public-beta"], "release:stage")).toThrow("Usage");
  });

  test("refuses changed evidence or source and never creates public attachments on failure", async () => {
    const fixture = await publicationFixture();
    await writeFile(join(fixture.evidence, "observation.txt"), "changed fixture evidence");
    await expect(stageReleasePublication(fixture.input)).rejects.toThrow("does not match the record");
    expect(await readdir(fixture.output)).toEqual([]);
    await writeFile(join(fixture.root, "untracked-private-input.txt"), "never published");
    await expect(stageReleasePublication(fixture.input)).rejects.toThrow("clean source checkout");
    expect(await readdir(fixture.output)).toEqual([]);
  });

  test("website downloads require complete release inputs and a stable public storage address", () => {
    expect(websiteReleaseInput("/source", { acceptanceRecordPaths: [] })).toBeNull();
    expect(websiteReleaseInput("/source", { publicationDetailsPath: "/publication.json", acceptanceRecordPaths: [] })).toBeNull();
    expect(() => websiteReleaseInput("/source", { publicBeta: true, publicationDetailsPath: "/publication.json", acceptanceRecordPaths: [] }))
      .toThrow("Website downloads require");
    expect(() => websiteReleaseInput("/source", { candidateManifestPath: "", acceptanceRecordPaths: [] })).toThrow();
    const complete = { candidateManifestPath: "/Mochi-Release.json", verificationResultPath: "/result.json",
      publicationDetailsPath: "/publication.json", acceptanceRecordPaths: ["/acceptance.json"], artifactBaseUrl: "https://downloads.mochi-product.tld/" };
    for (const key of ["candidateManifestPath", "verificationResultPath", "publicationDetailsPath", "artifactBaseUrl"] as const) {
      const partial: WebsiteReleaseInput = { ...complete };
      delete partial[key];
      expect(() => websiteReleaseInput("/source", partial)).toThrow("Website downloads require");
    }
    expect(() => websiteReleaseInput("/source", { ...complete, acceptanceRecordPaths: [] })).toThrow();
    for (const artifactBaseUrl of ["http://downloads.mochi-product.tld/", "https://example.com/", "https://example.com./", "https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://downloads.local/",
      "https://user:password@downloads.mochi-product.tld/", "https://downloads.mochi-product.tld/no-slash",
      "https://downloads.mochi-product.tld/?token=private", "https://downloads.mochi-product.tld/#fragment"])
      expect(() => websiteReleaseInput("/source", { ...complete, artifactBaseUrl })).toThrow();
  });

  test("website derives only public facts and immutable links from the same accepted candidate as staging", async () => {
    const fixture = await publicationFixture();
    const { release, details } = await websiteRelease({ ...fixture.input, artifactBaseUrl: "https://downloads.mochi-product.tld/releases/" });
    expect(details).toEqual(publicDetails);
    const staged = await stageReleasePublication(fixture.input);
    const prefix = staged.publicationDirectory.split("/").at(-1)!;
    expect(release.productVersion).toBe("0.2.0");
    expect(release.minimumMacOS).toBe("14.0");
    expect(release.artifacts.map((item) => item.filename)).toEqual(["Mochi.dmg"]);
    for (const artifact of release.artifacts) {
      expect(artifact.url).toBe(`https://downloads.mochi-product.tld/releases/${prefix}/${artifact.filename}`);
      expect(artifact.sha256).toBe(hash(await readFile(join(fixture.candidate, artifact.filename))));
    }
    expect(release.channel).toBe("release");
    expect(Object.keys(release).sort()).toEqual(["architecture", "artifacts", "channel", "checksumsUrl", "limitations", "minimumMacOS", "notesUrl", "productVersion"]);
    expect(JSON.stringify(release)).not.toContain(fixture.root);
    expect(JSON.stringify(release)).not.toContain("observation.txt");
    expect(JSON.stringify(release)).not.toContain("private-signing-input");
  });

  test("website rejects incomplete acceptance, minimum-system gaps and mutated artifacts without copying files", async () => {
    const fixture = await publicationFixture();
    const input = { ...fixture.input, artifactBaseUrl: "https://downloads.mochi-product.tld/" };
    const record = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    record.scenarios[0].checkpoints[0].result = "blocked";
    await writeFile(fixture.recordPath, JSON.stringify(record));
    await expect(websiteRelease(input)).rejects.toThrow("Release acceptance is incomplete");
    record.scenarios[0].checkpoints[0].result = "pass";
    record.target.macOSVersion = "15.6.1";
    await writeFile(fixture.recordPath, JSON.stringify(record));
    await expect(websiteRelease(input)).rejects.toThrow("minimum macOS major version");
    record.target.macOSVersion = "14.7.8";
    await writeFile(fixture.recordPath, JSON.stringify(record));
    await writeFile(join(fixture.candidate, "Mochi.dmg"), "changed bytes");
    await expect(websiteRelease(input)).rejects.toThrow();
    expect(await readdir(fixture.output)).toEqual([]);
  });
});

describe("release upload, readback and download deployment", () => {
  const credentials = { accessKeyId: "MOCHITESTKEYID", secretAccessKey: "mochi-test-secret-never-sent" };
  const accountId = "0123456789abcdef0123456789abcdef";

  test("the committed distribution owns the bucket and download base, and refuses release signing until the Team exists", async () => {
    const distribution = await releaseDistribution();
    expect(distribution.downloads).toEqual({ bucket: "mochi-releases", baseUrl: "https://downloads.mochi.host/" });
    expect(() => requireDeveloperIdTeam({ ...distribution, developerIdTeamId: null })).toThrow("developerIdTeamId");
    expect(requireDeveloperIdTeam({ ...distribution, developerIdTeamId: "ABCDE12345" })).toBe("ABCDE12345");
    for (const change of [
      { developerIdTeamId: "abcde12345" },
      { cloudflareAccountId: "account" },
      { downloads: { bucket: "mochi-releases", baseUrl: "https://downloads.mochi.host/releases/" } },
      { downloads: { bucket: "mochi-releases", baseUrl: "http://downloads.mochi.host/" } },
      { downloads: { bucket: "Mochi_Releases", baseUrl: "https://downloads.mochi.host/" } },
      { secret: "never" },
    ]) expect(() => parseReleaseDistribution({ ...distribution, ...change })).toThrow();
  });

  test("a staged directory is re-proven against the accepted candidate before it leaves the machine", async () => {
    const fixture = await publicationFixture();
    const { publicationDirectory } = await stageReleasePublication(fixture.input);
    const input = { ...fixture.input, publicationDirectory };
    const staged = await verifyStagedPublication(input);
    expect(staged.files.map(({ filename }) => filename).sort()).toEqual((await readdir(publicationDirectory)).sort());
    for (const file of staged.files) expect(file.sha256).toBe(hash(await readFile(file.path)));
    await writeFile(join(publicationDirectory, "README.md"), "edited after review\n");
    await expect(verifyStagedPublication(input)).rejects.toThrow("README.md does not match");
    await rm(join(publicationDirectory, "README.md"));
    await expect(verifyStagedPublication(input)).rejects.toThrow("exactly the accepted public files");
    const renamed = join(fixture.output, "Mochi-renamed");
    await rename(publicationDirectory, renamed);
    await expect(verifyStagedPublication({ ...input, publicationDirectory: renamed })).rejects.toThrow("must be Mochi-0.2.0-");
  });

  test("signs requests exactly like AWS Signature Version 4", () => {
    // AWS's published GET Object example for S3 Signature Version 4.
    const headers = signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      now: new Date("2013-05-24T00:00:00Z"),
      region: "us-east-1",
    });
    expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
      + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  test("the R2 token is read only from the environment and never echoed", () => {
    expect(r2CredentialsFromEnvironment({ MOCHI_R2_ACCESS_KEY_ID: "id", MOCHI_R2_SECRET_ACCESS_KEY: "secret" }))
      .toEqual({ accessKeyId: "id", secretAccessKey: "secret" });
    for (const environment of [{}, { MOCHI_R2_ACCESS_KEY_ID: "only-id" }, { MOCHI_R2_SECRET_ACCESS_KEY: "only-secret" }]) {
      expect(() => r2CredentialsFromEnvironment(environment)).toThrow("bucket-scoped R2 API token");
      try { r2CredentialsFromEnvironment(environment); } catch (error) {
        expect(String(error)).not.toContain("only-");
      }
    }
  });

  test("uploads each accepted file once with its public representation and reads it back anonymously", async () => {
    const fixture = await publicationFixture();
    const { publicationDirectory } = await stageReleasePublication(fixture.input);
    const staged = await verifyStagedPublication({ ...fixture.input, publicationDirectory });
    const bucket = fakeR2(accountId, "mochi-releases");
    const upload = () => uploadPublication({
      accountId, bucket: "mochi-releases", directoryName: staged.directoryName, files: staged.files,
      credentials, fetch: bucket.fetch, now: () => new Date("2026-10-15T00:00:00Z"),
    });
    const first = await upload();
    expect(first.map(({ result }) => result)).toEqual(staged.files.map(() => "uploaded"));
    expect(JSON.stringify(first)).not.toContain(credentials.secretAccessKey);
    for (const request of bucket.requests) {
      expect(request.authorization).toStartWith(`AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/20261015/auto/s3/aws4_request`);
      expect(JSON.stringify(request)).not.toContain(credentials.secretAccessKey);
    }
    const dmg = bucket.objects.get(`${staged.directoryName}/Mochi.dmg`)!;
    expect(dmg.headers).toMatchObject({
      "content-type": "application/x-apple-diskimage",
      "content-disposition": 'attachment; filename="Mochi.dmg"',
      "cache-control": "public, max-age=31536000, immutable",
    });
    const puts = bucket.requests.filter(({ method }) => method === "PUT");
    expect(puts).toHaveLength(6);
    for (const put of puts) {
      expect(put.signedHeaders).toBe("cache-control;content-disposition;content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256");
      expect(put.payloadSha256).toBe(hash(put.body!));
    }

    expect((await upload()).map(({ result }) => result)).toEqual(staged.files.map(() => "already-present"));
    expect(bucket.requests.filter(({ method }) => method === "PUT")).toHaveLength(6);

    const readback = await readBackPublication({
      baseUrl: "https://downloads.mochi-product.tld/", directoryName: staged.directoryName, files: staged.files, fetch: bucket.publicFetch,
    });
    expect(readback.failures).toEqual([]);
    expect(readback.accepted).toBe(true);
    expect(readback.files.map(({ url }) => url)).toContain(`https://downloads.mochi-product.tld/${staged.directoryName}/Mochi.dmg`);
    for (const request of bucket.publicRequests) expect(request).toEqual({ authorization: null, cookie: null, redirect: "manual" });

    dmg.headers["cache-control"] = "no-store";
    const notes = bucket.objects.get(`${staged.directoryName}/RELEASE_NOTES.md`)!;
    notes.body = Buffer.from("changed after upload");
    bucket.objects.delete(`${staged.directoryName}/PRIVACY.md`);
    const broken = await readBackPublication({
      baseUrl: "https://downloads.mochi-product.tld/", directoryName: staged.directoryName, files: staged.files, fetch: bucket.publicFetch,
    });
    expect(broken.accepted).toBe(false);
    expect(broken.failures).toEqual(expect.arrayContaining([
      'Mochi.dmg cache-control is "no-store", expected "public, max-age=31536000, immutable"',
      "RELEASE_NOTES.md bytes differ from the accepted file",
      "PRIVACY.md returned HTTP 404",
    ]));

    notes.headers["x-amz-meta-sha256"] = "0".repeat(64);
    await expect(upload()).rejects.toThrow("never replaced");
  });

  test("only known public files have an HTTP representation", () => {
    expect(() => publicationObjectHeaders("Mochi.pkg")).toThrow("No public representation");
    expect(publicationObjectHeaders("SHA256SUMS.txt").contentType).toBe("text/plain; charset=utf-8");
    expect(() => publicationObjectHeaders("private-signing-input.txt")).toThrow("No public representation");
  });

  test("site deployment is an explicit registration, public beta or release choice, and downloads need every published fact", () => {
    expect(() => parseSiteDeployment([])).toThrow("exactly one");
    expect(() => parseSiteDeployment(["--registration", "--release"])).toThrow("exactly one");
    expect(() => parseSiteDeployment(["--public-beta", "--release"])).toThrow("exactly one");
    expect(() => parseSiteDeployment(["--beta"])).toThrow();
    expect(parseSiteDeployment(["--registration"])).toEqual({ mode: "registration" });
    expect(() => parseSiteDeployment(["--registration", "--publication", "/publication.json"])).toThrow("no release inputs");
    const complete = ["--release", "--release-manifest", "/c/Mochi-Release.json", "--verification-result", "/r/result.json",
      "--publication", "/p/publication.json", "--publication-directory", "/s/Mochi-0.2.0-arm64-0123456789abcdef",
      "--acceptance-record", "/e/a.json", "--acceptance-record", "/e/b.json"];
    expect(parseSiteDeployment(complete)).toEqual({
      mode: "release", candidateManifestPath: "/c/Mochi-Release.json", verificationResultPath: "/r/result.json",
      publicationDetailsPath: "/p/publication.json", publicationDirectory: "/s/Mochi-0.2.0-arm64-0123456789abcdef",
      acceptanceRecordPaths: ["/e/a.json", "/e/b.json"],
    });
    expect(parseSiteDeployment(["--public-beta", ...complete.slice(1)])).toMatchObject({ mode: "public-beta", acceptanceRecordPaths: ["/e/a.json", "/e/b.json"] });
    expect(() => parseSiteDeployment(["--release"])).toThrow(
      "--release-manifest, --verification-result, --publication, --publication-directory, --acceptance-record");
    expect(() => parseSiteDeployment(["--public-beta"])).toThrow("--release-manifest");
    expect(() => parseSiteDeployment(complete.map((value) => value === "/r/result.json" ? "result.json" : value))).toThrow("absolute");
    expect(() => parseSiteDeployment([...complete, "--artifact-base-url", "https://elsewhere.tld/"])).toThrow();
    const url = "https://downloads.mochi.host/Mochi-0.2.0-arm64-0123456789abcdef/Mochi.dmg";
    expect(() => requireReleaseDownloadPage(`<a href="${url}">下载</a>`, url)).not.toThrow();
    expect(() => requireReleaseDownloadPage('<a href="/beta/">申请内测</a>', url)).toThrow("nothing was deployed");
  });
});

/** An in-memory R2 bucket behind its S3 endpoint and its public custom domain. */
function fakeR2(accountId: string, bucketName: string) {
  const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
  const requests: Array<{ method: string; key: string; authorization: string | null; signedHeaders: string | undefined;
    payloadSha256: string | null; body: Buffer | undefined }> = [];
  const publicRequests: Array<{ authorization: string | null; cookie: string | null; redirect: string | undefined }> = [];
  const prefix = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/`;
  const fetchImplementation = async (target: string | URL | Request, init: RequestInit = {}) => {
    const url = String(target);
    if (!url.startsWith(prefix)) return new Response("wrong endpoint", { status: 400 });
    const key = decodeURIComponent(url.slice(prefix.length));
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization");
    const body = init.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : undefined;
    requests.push({ method: init.method ?? "GET", key, authorization,
      signedHeaders: /SignedHeaders=([^,]+)/.exec(authorization ?? "")?.[1], payloadSha256: headers.get("x-amz-content-sha256"), body });
    if (!authorization) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const existing = objects.get(key);
    if (init.method === "HEAD") {
      return existing
        ? new Response(null, { status: 200, headers: { "content-length": String(existing.body.length), "x-amz-meta-sha256": existing.headers["x-amz-meta-sha256"]! } })
        : new Response(null, { status: 404 });
    }
    if (init.method === "PUT") {
      if (existing && headers.get("if-none-match") === "*") return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
      if (hash(body!) !== headers.get("x-amz-content-sha256")) return new Response("<Error><Code>XAmzContentSHA256Mismatch</Code></Error>", { status: 400 });
      const stored: Record<string, string> = {};
      for (const name of ["content-type", "content-disposition", "cache-control", "x-amz-meta-sha256"]) stored[name] = headers.get(name)!;
      objects.set(key, { body: body!, headers: stored });
      return new Response(null, { status: 200 });
    }
    return new Response("unsupported", { status: 405 });
  };
  const publicFetch = async (target: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    publicRequests.push({ authorization: headers.get("authorization"), cookie: headers.get("cookie"), redirect: init.redirect });
    const key = new URL(String(target)).pathname.slice(1);
    const object = objects.get(key);
    if (!object) return new Response("Not Found", { status: 404 });
    const { "x-amz-meta-sha256": _metadata, ...representation } = object.headers;
    return new Response(new Uint8Array(object.body), { status: 200, headers: representation });
  };
  return {
    objects, requests, publicRequests,
    fetch: fetchImplementation as unknown as typeof fetch,
    publicFetch: publicFetch as unknown as typeof fetch,
  };
}

async function publicationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "mochi-publication-fixture-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "source"), candidate = join(directory, "candidate");
  const evidence = join(directory, "evidence"), output = join(directory, "output");
  for (const path of [join(root, "script"), join(root, "release/public"), candidate, evidence, output])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: `bun@${Bun.version}` }));
  await writeFile(join(root, "script/verify_suite.sh"), "set -e\necho publication-fixture-pass\n");
  await writeFile(join(root, "release/public/quick-start.md"), "Fixture download: {{DOWNLOAD_PAGE_URL}}. Support: {{SUPPORT_URL}}.");
  await writeFile(join(root, "release/public/privacy.md"), "Fixture publisher: {{PUBLISHER_NAME}}. Contact: {{PRIVACY_CONTACT_EMAIL}}.");
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], {
    env: verificationEnvironment(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git(["init", "-b", "main"]);
  git(["add", "."]);
  git(["-c", "user.name=Publication Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-m", "fixture"]);
  const { evidenceDirectory } = await verifyLocal(root);
  const artifacts = ["Mochi.dmg", "Mochi.pkg"];
  for (const filename of artifacts) await writeFile(join(candidate, filename), `fixture artifact: ${filename}\n`);
  const { manifestPath } = await createReleaseCandidateManifest({
    candidateDirectory: candidate, sourceRevision: git(["rev-parse", "HEAD"]), productVersion: "0.2.0",
    architecture: process.arch === "arm64" ? "arm64" : "x86_64", minimumMacOS: "14.0", limitations: ["Fixture only"],
  });
  const recordPath = join(evidence, "Mochi-Acceptance-fixture.json");
  await createReleaseAcceptanceTemplate({ candidateManifestPath: manifestPath, outputPath: recordPath, targetId: "clean-fixture", macOSVersion: "14.7.8" });
  const observation = "redacted fixture observation";
  await writeFile(join(evidence, "observation.txt"), observation);
  const reference = { kind: "operatorRecord", path: "observation.txt", sha256: hash(observation), sizeBytes: Buffer.byteLength(observation) };
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  for (const key of Object.keys(record.target.baseline)) record.target.baseline[key] = true;
  record.target.evidence = [reference];
  for (const scenario of record.scenarios) {
    for (const checkpoint of scenario.checkpoints) { checkpoint.result = "pass"; checkpoint.evidence = [reference]; }
  }
  await writeFile(recordPath, JSON.stringify(record));
  const publicationDetailsPath = join(directory, "publication.json");
  await writeFile(publicationDetailsPath, JSON.stringify(publicDetails));
  await writeFile(join(candidate, "private-signing-input.txt"), "must never enter public attachments");
  return { root, candidate, recordPath, evidence, output, artifacts, input: {
    channel: "release" as const, sourceRoot: root, candidateManifestPath: manifestPath, acceptanceRecordPaths: [recordPath],
    verificationResultPath: join(evidenceDirectory, "result.json"), publicationDetailsPath, outputDirectory: output,
  } };
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
