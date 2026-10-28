import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPassedVerification,
  pruneVerificationEvidence,
  requirePassedVerification,
  runLogged,
  VERIFICATION_RETENTION_DAYS,
  verificationEnvironment,
  verifyLocal,
} from "../script/verify.ts";

const fixtures: string[] = [];
afterEach(async () => {
  for (const directory of fixtures.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    env: verificationEnvironment(process.env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixture(suite = "echo fixture-pass") {
  const base = await mkdtemp(join(tmpdir(), "mochi-verification-test-"));
  fixtures.push(base);
  const root = join(base, "repo");
  await mkdir(join(root, "script"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ packageManager: `bun@${Bun.version}` }),
  );
  await writeFile(join(root, ".gitignore"), "dist/\n.env\n");
  await writeFile(join(root, "tracked.txt"), "committed\n");
  await writeFile(
    join(root, "script/verify_suite.sh"),
    `#!/bin/bash\nset -euo pipefail\n${suite}\n`,
  );
  git(root, ["init", "-b", "main"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Verification Test",
    "-c",
    "user.email=verification@users.noreply.github.com",
    "commit",
    "-m",
    "fixture",
  ]);
  return { root, base, commit: git(root, ["rev-parse", "HEAD"]) };
}

describe("local commit verification", () => {
  test("the suite gets a normal system umask without changing its caller or private evidence", async () => {
    const { root } = await fixture('test "$(umask)" = 0022');
    const previous = process.umask(0o077);
    try {
      const { report, evidenceDirectory } = await verifyLocal(root);
      expect(report.result).toBe("passed");
      expect(process.umask()).toBe(0o077);
      expect((await stat(evidenceDirectory)).mode & 0o077).toBe(0);
    } finally {
      process.umask(previous);
    }
  });
  test("release consumes the retained tree-bound receipt, accepts an unchanged merge tree and rejects changed logs", async () => {
    const { root } = await fixture();
    const { evidenceDirectory, report } = await verifyLocal(root);
    const resultPath = join(evidenceDirectory, "result.json");
    const input = {
      resultPath,
      sourceRoot: root,
      sourceRevision: report.commit,
      architecture: (process.arch === "arm64" ? "arm64" : "x86_64") as
        | "arm64"
        | "x86_64",
    };
    expect(await requirePassedVerification(input)).toEqual(report);
    git(root, [
      "-c",
      "user.name=Verification Test",
      "-c",
      "user.email=verification@users.noreply.github.com",
      "commit",
      "--allow-empty",
      "-m",
      "same tree, new commit",
    ]);
    expect(
      (
        await requirePassedVerification({
          ...input,
          sourceRevision: git(root, ["rev-parse", "HEAD"]),
        })
      ).tree,
    ).toBe(report.tree);
    await writeFile(join(evidenceDirectory, "verification.log"), "changed log");
    await expect(requirePassedVerification(input)).rejects.toThrow(
      "log does not match its receipt",
    );
  });

  test("release rejects running receipts, wrong source trees, architectures and toolchains", async () => {
    const { root } = await fixture();
    const { evidenceDirectory, report } = await verifyLocal(root);
    const resultPath = join(evidenceDirectory, "result.json");
    const input = {
      resultPath,
      sourceRoot: root,
      sourceRevision: report.commit,
      architecture: (process.arch === "arm64" ? "arm64" : "x86_64") as
        | "arm64"
        | "x86_64",
    };
    for (const [change, error] of [
      [{ result: "running" }, "completed passing"],
      [{ tree: "a".repeat(40) }, "source tree"],
      [{ architecture: "unknown" }, "architecture"],
      [{ bunVersion: "0.0.0" }, "toolchain"],
    ] as const) {
      await writeFile(resultPath, JSON.stringify({ ...report, ...change }));
      await expect(requirePassedVerification(input)).rejects.toThrow(error);
    }
  });

  test("only build environment is inherited, never credentials or product overrides", () => {
    const environment = verificationEnvironment({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      GITHUB_TOKEN: "private-value",
      MOCHI_APP_SIGN_IDENTITY: "paid-certificate",
      MOCHI_CONTROL_MANIFEST_SOURCE: "private-manifest",
      BUN_OPTIONS: "--preload malicious.ts",
      GIT_DIR: "/elsewhere",
      GIT_CONFIG_GLOBAL: "/private-config",
    });
    expect(environment.HOME).toBe("/Users/test");
    expect(environment.CI).toBe("true");
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    for (const key of [
      "GITHUB_TOKEN",
      "MOCHI_APP_SIGN_IDENTITY",
      "MOCHI_CONTROL_MANIFEST_SOURCE",
      "BUN_OPTIONS",
      "GIT_DIR",
    ])
      expect(environment[key]).toBeUndefined();
  });

  test("verifies a clean committed clone and retains private hash-bound evidence without touching development artifacts", async () => {
    const { root, commit } = await fixture(`
test ! -e .env
test ! -e dist/development
mkdir dist
echo built > dist/generated
echo fixture-pass
`);
    await writeFile(join(root, ".env"), "local-only");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/development"), "running-version");
    const { report, evidenceDirectory } = await verifyLocal(root);
    expect(report.result).toBe("passed");
    expect(report.commit).toBe(commit);
    expect(report.tree).toBe(git(root, ["rev-parse", "HEAD^{tree}"]));
    expect(
      JSON.parse(
        await readFile(join(evidenceDirectory, "result.json"), "utf8"),
      ),
    ).toEqual(report);
    const log = await readFile(join(evidenceDirectory, "verification.log"));
    expect(report.logSHA256).toBe(
      new Bun.CryptoHasher("sha256").update(log).digest("hex"),
    );
    expect(log.toString()).toContain("fixture-pass");
    expect(
      (await stat(join(evidenceDirectory, "result.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(evidenceDirectory, "verification.log"))).mode & 0o777,
    ).toBe(0o600);
    const checkout = log.toString().match(/Cloning into '([^']+)'/)?.[1];
    expect(checkout).toBeDefined();
    expect(existsSync(checkout!)).toBeFalse();
    expect(await readFile(join(root, "dist/development"), "utf8")).toBe(
      "running-version",
    );
    expect(existsSync(join(root, "dist/generated"))).toBeFalse();
    expect(git(root, ["status", "--porcelain"])).toBe("");
  });

  test("dirty or mismatched-toolchain candidates are refused before any build", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "uncommitted.txt"), "uncommitted");
    await expect(verifyLocal(root)).rejects.toThrow("clean committed tree");
    await rm(join(root, "uncommitted.txt"));
    await writeFile(join(root, "tracked.txt"), "changed");
    await expect(verifyLocal(root)).rejects.toThrow("clean committed tree");
    expect(existsSync(join(root, ".git/mochi-verification"))).toBeFalse();

    const wrong = await fixture();
    await writeFile(
      join(wrong.root, "package.json"),
      JSON.stringify({ packageManager: "bun@0.0.0" }),
    );
    git(wrong.root, ["add", "package.json"]);
    git(wrong.root, [
      "-c",
      "user.name=Verification Test",
      "-c",
      "user.email=verification@users.noreply.github.com",
      "commit",
      "-m",
      "wrong toolchain",
    ]);
    await expect(verifyLocal(wrong.root)).rejects.toThrow("requires bun@0.0.0");
  });

  test("a failed check stays failed and never executes later shell steps", async () => {
    const { root } = await fixture(
      "echo failing-check\nfalse\necho should-not-run",
    );
    const { report, evidenceDirectory } = await verifyLocal(root);
    expect(report.result).toBe("failed");
    expect(report.failure).toContain("command failed");
    const log = await readFile(
      join(evidenceDirectory, "verification.log"),
      "utf8",
    );
    expect(log).toContain("failing-check");
    expect(log).not.toContain("should-not-run");
  });

  test("a failed receipt names the suite step that stopped it", async () => {
    const step = /^step\(\) \{\n[\s\S]*?^\}$/m.exec(
      await readFile(
        join(import.meta.dir, "../script/verify_suite.sh"),
        "utf8",
      ),
    )?.[0];
    expect(step).toBeDefined();
    const { root } = await fixture(
      `${step}\nstep "First check" true\nstep "Broken check" sh -c "exit 3"\nstep "Never run" true`,
    );
    const { report, evidenceDirectory } = await verifyLocal(root);
    expect(report.failure).toBe("Step failed: Broken check (exit 3)");
    expect(
      await readFile(join(evidenceDirectory, "verification.log"), "utf8"),
    ).not.toContain("Never run");
  });

  test("merge lookup finds the newest passing receipt for a tree and otherwise names the latest failure", async () => {
    const { root, commit } = await fixture();
    const architecture = (process.arch === "arm64" ? "arm64" : "x86_64") as
      | "arm64"
      | "x86_64";
    await verifyLocal(root);
    const { evidenceDirectory } = await verifyLocal(root);
    const found = await findPassedVerification({
      sourceRoot: root,
      sourceRevision: commit,
      architecture,
    });
    expect(found.resultPath).toBe(join(evidenceDirectory, "result.json"));

    const failing = await fixture("false");
    await expect(
      findPassedVerification({
        sourceRoot: failing.root,
        sourceRevision: failing.commit,
        architecture,
      }),
    ).rejects.toThrow("it was never verified");
    await verifyLocal(failing.root);
    await expect(
      findPassedVerification({
        sourceRoot: failing.root,
        sourceRevision: failing.commit,
        architecture,
      }),
    ).rejects.toThrow("its latest run is failed: Verification command failed");
  });

  test("retention keeps recent runs and each referenced tree's newest pass, and never touches other files", async () => {
    const base = await mkdtemp(join(tmpdir(), "mochi-retention-test-"));
    fixtures.push(base);
    const now = Date.parse("2026-10-15T00:00:00Z");
    const day = 24 * 60 * 60_000;
    const old = now - (VERIFICATION_RETENTION_DAYS + 1) * day;
    const recent = now - day;
    const [kept, released] = ["a".repeat(40), "b".repeat(40)];
    const run = async (
      commit: string,
      name: string,
      receipt?: { result: string; tree: string; startedAt: number },
    ) => {
      const directory = join(base, commit, `run-${name}`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "verification.log"), "log");
      if (receipt)
        await writeFile(
          join(directory, "result.json"),
          JSON.stringify({
            ...receipt,
            startedAt: new Date(receipt.startedAt).toISOString(),
          }),
        );
      else await utimes(directory, old / 1000, old / 1000);
    };
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    await run(first, "Pass01", {
      result: "passed",
      tree: kept,
      startedAt: old,
    });
    await run(first, "Pass00", {
      result: "passed",
      tree: kept,
      startedAt: old - day,
    });
    await run(first, "Fail00", {
      result: "failed",
      tree: kept,
      startedAt: old,
    });
    await run(second, "Other0", {
      result: "passed",
      tree: released,
      startedAt: old,
    });
    await run(second, "Recent", {
      result: "failed",
      tree: released,
      startedAt: recent,
    });
    await run(second, "Broken");
    const third = "3".repeat(40);
    await run(third, "Gone00", {
      result: "running",
      tree: released,
      startedAt: old,
    });
    await mkdir(join(base, third, "native-audit"));
    await writeFile(join(base, third, "pull-request.md"), "foreign");
    const fourth = "4".repeat(40);
    await run(fourth, "Gone01", {
      result: "failed",
      tree: released,
      startedAt: old,
    });

    const result = await pruneVerificationEvidence(base, new Set([kept]), now);
    expect(result.removedRuns).toBe(6);
    expect(result.removedBytes).toBeGreaterThan(0);
    expect((await readdir(join(base, first))).sort()).toEqual(["run-Pass01"]);
    expect((await readdir(join(base, second))).sort()).toEqual(["run-Recent"]);
    expect((await readdir(join(base, third))).sort()).toEqual([
      "native-audit",
      "pull-request.md",
    ]);
    expect(existsSync(join(base, fourth))).toBeFalse();
  });

  test("a check that mutates tracked input cannot pass", async () => {
    const { root } = await fixture("echo modified > tracked.txt");
    const { report } = await verifyLocal(root);
    expect(report.result).toBe("failed");
    expect(report.failure).toContain("clean committed tree");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
      "committed\n",
    );
  });

  test("linked worktrees keep evidence in the shared Git directory, not each other's checkout", async () => {
    const { root, base, commit } = await fixture();
    const linked = join(base, "parallel");
    git(root, ["worktree", "add", "--detach", linked, commit]);
    const { evidenceDirectory, report } = await verifyLocal(linked);
    expect(report.result).toBe("passed");
    expect(
      evidenceDirectory.startsWith(
        join(await realpath(root), ".git/mochi-verification", commit),
      ),
    ).toBeTrue();
    expect(git(root, ["branch", "--show-current"])).toBe("main");
    expect(git(linked, ["status", "--porcelain"])).toBe("");
  });

  test("cancellation is recorded as failure, not a partial success", async () => {
    const { root } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("Cancelled by user"));
    const { report } = await verifyLocal(root, controller.signal);
    expect(report.result).toBe("failed");
    expect(report.failure).toBe("Verification interrupted");
  });

  test("deadlines terminate unresponsive process groups", async () => {
    const { root } = await fixture();
    const logPath = join(root, "process.log");
    const log = openSync(logPath, "wx", 0o600);
    try {
      await expect(
        runLogged(
          [
            process.execPath,
            "-e",
            'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);',
          ],
          root,
          verificationEnvironment(process.env),
          log,
          new AbortController().signal,
          200,
        ),
      ).rejects.toThrow("timed out");
    } finally {
      closeSync(log);
    }
    const pid = Number((await readFile(logPath, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 5_000);

  test("abort interrupts an already running check", async () => {
    const { root } = await fixture();
    const log = openSync(join(root, "abort.log"), "wx", 0o600);
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error("Stop this check")),
      100,
    );
    try {
      await expect(
        runLogged(
          [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          root,
          verificationEnvironment(process.env),
          log,
          controller.signal,
        ),
      ).rejects.toThrow("Stop this check");
    } finally {
      clearTimeout(deadline);
      closeSync(log);
    }
  });
});
