import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Command, mergePullRequest } from "../script/github_merge.ts";
import { verificationEnvironment, verifyLocal } from "../script/verify.ts";

const fixtures: string[] = [];
afterEach(async () => {
  for (const directory of fixtures.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const identity = [
  "-c",
  "user.name=Merge Test",
  "-c",
  "user.email=merge@users.noreply.github.com",
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: verificationEnvironment(process.env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function commitOnMain(root: string, file: string): Promise<void> {
  git(root, "checkout", "-q", "main");
  await writeFile(join(root, file), `${file}\n`);
  git(root, "add", file);
  git(root, ...identity, "commit", "-q", "-m", file);
  git(root, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "codex/change");
}

/** A local origin, a verified `codex/change` head and a fake GitHub that squashes like the real one. */
async function fixture(
  options: {
    failing?: boolean;
    pull?: Record<string, unknown>;
    keepBranch?: boolean;
  } = {},
) {
  const base = await mkdtemp(join(tmpdir(), "mochi-merge-test-"));
  fixtures.push(base);
  const origin = join(base, "origin.git");
  const root = join(base, "repo");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  await mkdir(join(root, "script"), { recursive: true });
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ packageManager: `bun@${Bun.version}` }),
  );
  await writeFile(
    join(root, ".github/governance.json"),
    JSON.stringify({
      repository: {
        slug: "example/mochi",
        defaultBranch: "main",
        branchPrefix: "codex/",
      },
    }),
  );
  await writeFile(
    join(root, "script/verify_suite.sh"),
    "#!/bin/bash\nset -euo pipefail\ntest ! -e failing\n",
  );
  git(base, "init", "-q", "-b", "main", root);
  git(root, "add", ".");
  git(root, ...identity, "commit", "-q", "-m", "base");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "-b", "codex/change");
  await writeFile(join(root, options.failing ? "failing" : "change.txt"), "x");
  git(root, "add", ".");
  git(root, ...identity, "commit", "-q", "-m", "change");
  const head = git(root, "rev-parse", "HEAD");
  git(root, "push", "-q", "origin", "codex/change", "HEAD:refs/pull/7/head");
  await verifyLocal(root);

  const pull: Record<string, unknown> = {
    number: 7,
    state: "OPEN",
    isDraft: false,
    title: "Keep the gate honest",
    body: "Why it changed.\n",
    headRefName: "codex/change",
    headRefOid: head,
    baseRefName: "main",
    isCrossRepository: false,
    url: "https://github.com/example/mochi/pull/7",
    mergeCommit: null,
    ...options.pull,
  };
  const merges: string[][] = [];
  /** Origin changes staged to happen just before GitHub performs the merge. */
  const pendingEffects: Array<() => void> = [];
  const run: Command = (executable, args) => {
    if (executable === "git")
      return execFileSync("git", args, {
        env: verificationEnvironment(process.env),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const value = (name: string) => args[args.indexOf(name) + 1] ?? "";
    if (args[1] === "view")
      return JSON.stringify(
        Object.fromEntries(
          value("--json")
            .split(",")
            .map((field) => [field, pull[field]]),
        ),
      );
    merges.push(args);
    for (const effect of pendingEffects.splice(0)) effect();
    // GitHub refuses a head that moved since verification.
    if (
      value("--match-head-commit") !==
      git(origin, "rev-parse", "refs/pull/7/head")
    )
      throw new Error("Head branch was modified");
    const main = git(origin, "rev-parse", "refs/heads/main");
    const tree = git(
      origin,
      "merge-tree",
      "--write-tree",
      main,
      value("--match-head-commit"),
    );
    const commit = git(
      origin,
      ...identity,
      "commit-tree",
      tree,
      "-p",
      main,
      "-m",
      `${value("--subject")}\n\n${readFileSync(value("--body-file"), "utf8")}`,
    );
    git(origin, "update-ref", "refs/heads/main", commit);
    if (!options.keepBranch)
      git(origin, "update-ref", "-d", "refs/heads/codex/change");
    pull.state = "MERGED";
    pull.mergeCommit = { oid: commit };
    return "";
  };
  return {
    root,
    origin,
    base,
    head,
    merges,
    pendingEffects,
    merge: (extra: { bodyFile?: string } = {}) =>
      mergePullRequest({
        root,
        number: 7,
        run,
        branchDeletion: { attempts: 2, intervalMs: 1 },
        ...extra,
      }),
  };
}

describe("github:merge", () => {
  test("squash-merges a verified head that contains main and confirms main, tree and branch deletion", async () => {
    const { merge, origin, head, merges } = await fixture();
    const result = await merge();
    expect(merges).toHaveLength(1);
    expect(result.head).toBe(head);
    expect(result.tree).toBe(git(origin, "rev-parse", `${head}^{tree}`));
    expect(result.receipt).toMatch(/mochi-verification\/[0-9a-f]{40}\/run-/);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(
      result.mergeCommit,
    );
    expect(git(origin, "log", "-1", "--format=%B", "main")).toBe(
      "Keep the gate honest (#7)\n\nWhy it changed.",
    );
    expect(git(origin, "branch", "--list", "codex/change")).toBe("");
  });

  test("uses a given body file instead of the PR body", async () => {
    const { merge, origin, base } = await fixture();
    const bodyFile = join(base, "message.md");
    await writeFile(bodyFile, "Reviewed squash message.\n");
    await merge({ bodyFile });
    expect(git(origin, "log", "-1", "--format=%b", "main")).toBe(
      "Reviewed squash message.",
    );
  });

  test("refuses before merging when the head does not contain the current main", async () => {
    const { merge, root, merges } = await fixture();
    await commitOnMain(root, "later.txt");
    await expect(merge()).rejects.toThrow(
      /origin\/main [0-9a-f]{40} is not in PR head/,
    );
    expect(merges).toHaveLength(0);
  });

  test("refuses a tree that only failed verification and says why", async () => {
    const { merge, merges } = await fixture({ failing: true });
    await expect(merge()).rejects.toThrow(
      "has no passing verification receipt; its latest run is failed: Verification command failed",
    );
    expect(merges).toHaveLength(0);
  });

  test("refuses drafts, closed PRs, other bases and foreign heads without touching git", async () => {
    for (const [pull, error] of [
      [{ isDraft: true }, "is a draft"],
      [{ state: "CLOSED" }, "is CLOSED"],
      [{ baseRefName: "release" }, "into main"],
      [{ isCrossRepository: true }, "codex/* branch"],
      [{ headRefName: "feature/x" }, "codex/* branch"],
    ] as const) {
      const { merge, merges } = await fixture({ pull });
      await expect(merge()).rejects.toThrow(error);
      expect(merges).toHaveLength(0);
    }
  }, 30_000);

  test("reports a main that moved during the merge instead of claiming the verified tree", async () => {
    const { merge, root, merges, pendingEffects } = await fixture();
    pendingEffects.push(() => {
      git(root, "checkout", "-q", "main");
      execFileSync("/bin/sh", ["-c", "echo racing > racing.txt"], {
        cwd: root,
      });
      git(root, "add", "racing.txt");
      git(root, ...identity, "commit", "-q", "-m", "racing");
      git(root, "push", "-q", "origin", "main");
      git(root, "checkout", "-q", "codex/change");
    });
    await expect(merge()).rejects.toThrow("main moved during the merge");
    expect(merges).toHaveLength(1);
  });

  test("fails when GitHub keeps the merged branch", async () => {
    const { merge } = await fixture({ keepBranch: true });
    await expect(merge()).rejects.toThrow(
      "Branch codex/change still exists after the merge",
    );
  });
});
