import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductReleaseRun, RELEASE_ARTIFACT_NAMES, releaseFileSha256, type ReleaseNotary } from "../script/product_release_run.ts";
import { createReleaseCandidateManifest } from "../script/release_acceptance.ts";

const revision = "a".repeat(40);
const id = "123e4567-e89b-42d3-a456-426614174000";
const otherId = "123e4567-e89b-42d3-a456-426614174001";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(seal = true) {
  const output = await realpath(await mkdtemp(join(tmpdir(), "mochi-production-test-")));
  roots.push(output);
  const run = await ProductReleaseRun.create(output, revision, ["--release"], "exact release inputs");
  for (const name of ["payload", "scripts", "Mochi.app"]) {
    await mkdir(join(run.work, name));
    await writeFile(join(run.work, name, "content"), `immutable ${name}`);
  }
  await writeFile(join(run.work, "mochi-file-sync"), "durability tool");
  for (const name of RELEASE_ARTIFACT_NAMES.filter(name => name !== "Mochi.dmg")) await writeFile(join(run.originals, name), `signed ${name}`);
  if (seal) await run.sealAssembly();
  return { run, output, record: async () => JSON.parse(await readFile(run.path, "utf8")) };
}

function transport(run: ProductReleaseRun) {
  let status = "In Progress";
  let submittedPath = join(run.originals, "Mochi.pkg");
  const calls = { submit: 0, info: 0, staple: 0, validate: 0 };
  const client: ReleaseNotary = {
    submit: async path => {
      calls.submit++;
      submittedPath = path;
      return { id, message: "Successfully uploaded file" }; // submit --no-wait has no status.
    },
    info: async () => { calls.info++; return { id, status }; },
    log: async () => ({ jobId: id, status, statusCode: status === "Accepted" ? 0 : 4000, sha256: await releaseFileSha256(submittedPath), issues: null }),
    staple: async path => { calls.staple++; await appendFile(path, " stapled ticket"); },
    validate: async path => { calls.validate++; expect(await readFile(path, "utf8")).toEndWith(" stapled ticket"); },
  };
  return { client, calls, accept: () => { status = "Accepted"; }, reject: () => { status = "Invalid"; } };
}

describe("durable release production", () => {
  test("pending work survives a new process and Accepted is bound to original bytes before stapling a copy", async () => {
    const { run, output, record } = await fixture();
    const remote = transport(run);
    const originalDigest = await releaseFileSha256(join(run.originals, "Mochi.pkg"));
    expect(await run.notarize("Mochi.pkg", remote.client)).toBe(false);
    const resumed = await ProductReleaseRun.load(run.path);
    await resumed.verifyContext(revision, "exact release inputs", output);
    expect(await resumed.notarize("Mochi.pkg", remote.client)).toBe(false);
    expect(remote.calls.submit).toBe(1);
    await expect(ProductReleaseRun.create(output, revision, ["--release"], "exact release inputs")).rejects.toThrow("Unfinished production exists");
    await expect(resumed.publish("Mochi-incomplete", "a".repeat(64))).rejects.toThrow("incomplete");
    remote.accept();
    expect(await resumed.notarize("Mochi.pkg", remote.client)).toBe(true);
    expect(await releaseFileSha256(join(run.originals, "Mochi.pkg"))).toBe(originalDigest);
    expect(await releaseFileSha256(join(run.candidate, "Mochi.pkg"))).not.toBe(originalDigest);
    expect(remote.calls).toEqual({ submit: 1, info: 3, staple: 1, validate: 1 });
    expect((await record()).artifacts["Mochi.pkg"].status).toBe("Accepted");
    expect((await stat(run.path)).mode & 0o777).toBe(0o600);
    expect((await stat(run.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(run.directory, "Mochi.pkg.notary.json"))).mode & 0o777).toBe(0o600);
  });

  test("the submission ID is durable before a failing status query", async () => {
    const { run, record } = await fixture();
    const remote = transport(run);
    await expect(run.notarize("Mochi.pkg", { ...remote.client, info: async () => {
      expect((await record()).artifacts["Mochi.pkg"].submissionId).toBe(id);
      throw Error("query timeout");
    } })).rejects.toThrow("query timeout");
    remote.accept();
    expect(await (await ProductReleaseRun.load(run.path)).notarize("Mochi.pkg", remote.client)).toBe(true);
    expect(remote.calls.submit).toBe(1);
  });

  test("an unknown upload outcome is preserved and never automatically retried", async () => {
    const { run, record } = await fixture();
    const remote = transport(run);
    await expect(run.notarize("Mochi.pkg", { ...remote.client, submit: async () => {
      expect((await record()).artifacts["Mochi.pkg"].submissionStarted).toBe(true);
      throw Error("connection lost after upload");
    } })).rejects.toThrow("connection lost");
    await expect((await ProductReleaseRun.load(run.path)).notarize("Mochi.pkg", remote.client)).rejects.toThrow("Automatic re-upload is forbidden");
    expect(remote.calls.submit).toBe(0);
  });

  test("rejection retains its log without creating final bytes or resubmitting", async () => {
    const { run, record } = await fixture();
    const remote = transport(run);
    remote.reject();
    await expect(run.notarize("Mochi.pkg", remote.client)).rejects.toThrow("Apple rejected");
    expect((await record()).artifacts["Mochi.pkg"].status).toBe("Invalid");
    const log = JSON.parse(await readFile(join(run.directory, "Mochi.pkg.notary.json"), "utf8"));
    expect(log.status).toBe("Invalid");
    await expect((await ProductReleaseRun.load(run.path)).notarize("Mochi.pkg", remote.client)).rejects.toThrow("Apple rejected");
    expect(remote.calls.submit).toBe(1);
    expect(remote.calls.staple).toBe(0);
  });

  test("another submission, unknown status or Accepted log for different bytes cannot advance", async () => {
    for (const bad of ["id", "status", "sha256", "log-job", "log-status"] as const) {
      const { run } = await fixture();
      const remote = transport(run);
      remote.accept();
      const client: ReleaseNotary = { ...remote.client,
        info: async () => ({ id: bad === "id" ? otherId : id, status: bad === "status" ? "Processing" : "Accepted" }),
        log: async () => ({ ...await remote.client.log(id) as object,
          ...(bad === "sha256" ? { sha256: "0".repeat(64) } : {}),
          ...(bad === "log-job" ? { jobId: otherId } : {}),
          ...(bad === "log-status" ? { status: "Invalid" } : {}),
        }),
      };
      await expect(run.notarize("Mochi.pkg", client)).rejects.toThrow();
      expect(remote.calls.staple).toBe(0);
      await expect(run.publish("Mochi-invalid", "a".repeat(64))).rejects.toThrow("incomplete");
    }
  });

  test("changed source, inputs, assembly, modes, original or stapled bytes fail closed", async () => {
    const { run, output } = await fixture();
    const restored = await ProductReleaseRun.load(run.path);
    await expect(restored.verifyContext("b".repeat(40), "exact release inputs", output)).rejects.toThrow("same verified source");
    await expect(restored.verifyContext(revision, "different identity", output)).rejects.toThrow("same verified source");
    await chmod(join(run.work, "scripts/content"), 0o400);
    await expect(restored.verifyContext(revision, "exact release inputs", output)).rejects.toThrow("assembly changed");
    const separate = await fixture();
    const remote = transport(separate.run);
    await appendFile(join(separate.run.originals, "Mochi.pkg"), "changed");
    await expect(separate.run.notarize("Mochi.pkg", remote.client)).rejects.toThrow("Original artifact changed");
    expect(remote.calls.submit).toBe(0);
    const final = await fixture();
    const accepted = transport(final.run); accepted.accept();
    await final.run.notarize("Mochi.pkg", accepted.client);
    await appendFile(join(final.run.candidate, "Mochi.pkg"), "changed");
    await expect(final.run.notarize("Mochi.pkg", accepted.client)).rejects.toThrow("Stapled artifact changed");
    expect(accepted.calls.submit).toBe(1);
    expect(accepted.calls.staple).toBe(1);
  });

  test("an interrupted staple repeats only the local copy, with the existing accepted submission", async () => {
    const { run } = await fixture();
    const remote = transport(run); remote.accept();
    await expect(run.notarize("Mochi.pkg", { ...remote.client, staple: async path => {
      await appendFile(path, "partial ticket"); throw Error("stapler interrupted");
    } })).rejects.toThrow("interrupted");
    await (await ProductReleaseRun.load(run.path)).notarize("Mochi.pkg", remote.client);
    expect(await readFile(join(run.candidate, "Mochi.pkg"), "utf8")).toBe("signed Mochi.pkg stapled ticket");
    expect(remote.calls.submit).toBe(1);
  });

  test("incomplete assembly and unsafe evidence are rejected before notarization", async () => {
    const { run, output } = await fixture(false);
    await expect(run.verifyContext(revision, "exact release inputs", output)).rejects.toThrow("before sealing");
    await symlink(output, join(run.work, "Mochi.app/escape"));
    await expect(run.sealAssembly()).rejects.toThrow("symlink escapes");
    const other = await fixture();
    await chmod(other.run.path, 0o644);
    await expect(ProductReleaseRun.load(other.run.path)).rejects.toThrow("private");
    await expect(ProductReleaseRun.load(join(other.run.directory, "other.json"))).rejects.toThrow("production.json");
  });

  test("only the exact complete manifest publishes, and interrupted publication resumes without rebuilding", async () => {
    const { run, output } = await fixture();
    await writeFile(join(run.originals, "Mochi.dmg"), "signed disk image");
    await run.addArtifact("Mochi.dmg");
    for (const name of RELEASE_ARTIFACT_NAMES) {
      const remote = transport(run); remote.accept();
      await run.notarize(name, remote.client);
    }
    const { manifestSha256 } = await createReleaseCandidateManifest({ candidateDirectory: run.candidate, sourceRevision: revision,
      productVersion: "0.3.0", architecture: "arm64", minimumMacOS: "14.0", limitations: [] });
    const name = `Mochi-0.3.0-arm64-${manifestSha256.slice(0, 16)}`;
    const destination = await run.publish(name, manifestSha256);
    expect(destination).toBe(join(output, name));
    const resumed = await ProductReleaseRun.load(run.path);
    await resumed.verifyContext(revision, "exact release inputs", output);
    expect(await resumed.finishPublication()).toBe(destination);
    const next = await ProductReleaseRun.create(output, "b".repeat(40), ["--release"], "next inputs");
    expect(next.directory).not.toBe(run.directory);
    await appendFile(join(destination, "Mochi.dmg"), "tamper");
    await expect(resumed.finishPublication()).rejects.toThrow();
  });
});
