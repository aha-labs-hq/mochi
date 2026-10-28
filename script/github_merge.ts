import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadGovernanceManifest } from "./github_governance.ts";
import { findPassedVerification } from "./verify.ts";

/** Runs `gh` or `git` and returns standard output; a non-zero exit throws. */
export type Command = (executable: "gh" | "git", args: string[]) => string;

interface PullRequest {
  number: number;
  state: string;
  isDraft: boolean;
  title: string;
  body: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  url: string;
}

export interface MergeResult {
  number: number;
  url: string;
  head: string;
  tree: string;
  receipt: string;
  mergeCommit: string;
}

const PULL_FIELDS =
  "number,state,isDraft,title,body,headRefName,headRefOid,baseRefName,isCrossRepository,url";

const defaultCommand: Command = (executable, args) =>
  execFileSync(executable, args, {
    encoding: "utf8",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();

/** The maintainer's merge path; exact verification receipts are enforced locally. */
export async function mergePullRequest(input: {
  root: string;
  number: number;
  bodyFile?: string;
  run?: Command;
  branchDeletion?: { attempts: number; intervalMs: number };
}): Promise<MergeResult> {
  const run = input.run ?? defaultCommand;
  const git = (...args: string[]) => run("git", ["-C", input.root, ...args]);
  const { repository } = loadGovernanceManifest(
    join(input.root, ".github/governance.json"),
  );
  const base = `refs/remotes/origin/${repository.defaultBranch}`;
  const fetchBase = `+refs/heads/${repository.defaultBranch}:${base}`;
  const view = (fields: string) =>
    JSON.parse(
      run("gh", [
        "pr",
        "view",
        String(input.number),
        "--repo",
        repository.slug,
        "--json",
        fields,
      ]),
    ) as Record<string, unknown>;

  const pull = view(PULL_FIELDS) as unknown as PullRequest;
  if (pull.number !== input.number || pull.state !== "OPEN" || pull.isDraft)
    throw new Error(
      `PR #${input.number} is ${pull.isDraft ? "a draft" : pull.state}; only an open, ready PR can merge`,
    );
  if (
    pull.baseRefName !== repository.defaultBranch ||
    pull.isCrossRepository ||
    !pull.headRefName.startsWith(repository.branchPrefix) ||
    !/^[0-9a-f]{40}$/.test(pull.headRefOid)
  )
    throw new Error(
      `PR #${input.number} must merge a ${repository.branchPrefix}* branch of ${repository.slug} into ${repository.defaultBranch}`,
    );
  if (!pull.title || pull.title.length > 256 || /[\r\n\0]/.test(pull.title))
    throw new Error(`PR #${input.number} has an invalid title`);
  const head = pull.headRefOid;

  git(
    "fetch",
    "--no-tags",
    "--quiet",
    "origin",
    fetchBase,
    `refs/pull/${input.number}/head`,
  );
  try {
    git("cat-file", "-e", `${head}^{commit}`);
  } catch {
    throw new Error(`PR head ${head} was not fetched from origin`);
  }
  const baseCommit = git("rev-parse", base);
  try {
    git("merge-base", "--is-ancestor", baseCommit, head);
  } catch {
    throw new Error(
      `origin/${repository.defaultBranch} ${baseCommit} is not in PR head ${head}; merge it into ${pull.headRefName} with github:commit, verify that head and propose again`,
    );
  }
  const { resultPath, report } = await findPassedVerification({
    sourceRoot: input.root,
    sourceRevision: head,
    architecture: arch() === "arm64" ? "arm64" : "x86_64",
  });

  const body = input.bodyFile
    ? await readFile(resolve(input.bodyFile), "utf8")
    : pull.body;
  if (!body.trim() || body.length > 65_536 || body.includes("\0"))
    throw new Error(
      `The squash body is empty or invalid; give PR #${input.number} a body or pass --body-file`,
    );
  const staging = await mkdtemp(join(tmpdir(), "mochi-merge-"));
  try {
    const bodyPath = join(staging, "body.md");
    await writeFile(bodyPath, body, { mode: 0o600 });
    run("gh", [
      "pr",
      "merge",
      String(input.number),
      "--repo",
      repository.slug,
      "--squash",
      "--match-head-commit",
      head,
      "--subject",
      `${pull.title} (#${input.number})`,
      "--body-file",
      bodyPath,
    ]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  // Everything below reads back what GitHub did; none of it can undo the merge.
  const merged = view("state,mergeCommit") as {
    state?: string;
    mergeCommit?: { oid?: string } | null;
  };
  const mergeCommit = merged.mergeCommit?.oid ?? "";
  if (merged.state !== "MERGED" || !/^[0-9a-f]{40}$/.test(mergeCommit))
    throw new Error(`GitHub does not report PR #${input.number} as merged`);
  git("fetch", "--no-tags", "--quiet", "origin", fetchBase);
  try {
    git("merge-base", "--is-ancestor", mergeCommit, base);
  } catch {
    throw new Error(
      `Merge commit ${mergeCommit} is not on origin/${repository.defaultBranch}`,
    );
  }
  const mergedTree = git("rev-parse", `${mergeCommit}^{tree}`);
  if (mergedTree !== report.tree)
    throw new Error(
      `${repository.defaultBranch} moved during the merge: ${mergeCommit} has tree ${mergedTree}, not the verified ${report.tree}; verify ${repository.defaultBranch} now`,
    );
  const wait = input.branchDeletion ?? { attempts: 10, intervalMs: 1_000 };
  for (let attempt = 1; ; attempt++) {
    // GitHub deletes the head branch asynchronously (delete_branch_on_merge).
    if (
      !git("ls-remote", "--heads", "origin", `refs/heads/${pull.headRefName}`)
    )
      break;
    if (attempt >= wait.attempts)
      throw new Error(
        `Branch ${pull.headRefName} still exists after the merge; check delete_branch_on_merge with bun run governance:audit`,
      );
    await Bun.sleep(wait.intervalMs);
  }
  return {
    number: input.number,
    url: pull.url,
    head,
    tree: report.tree,
    receipt: resultPath,
    mergeCommit,
  };
}

function parseArguments(args: string[]): {
  number: number;
  bodyFile?: string;
} {
  const usage =
    "Usage: bun run github:merge -- <PR number> [--body-file <path>]";
  const [number, ...rest] = args;
  if (!number || !/^[1-9][0-9]{0,8}$/.test(number)) throw new Error(usage);
  if (rest.length === 0) return { number: Number(number) };
  if (rest.length !== 2 || rest[0] !== "--body-file" || !rest[1])
    throw new Error(usage);
  return { number: Number(number), bodyFile: rest[1] };
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const { repository } = loadGovernanceManifest(
      join(root, ".github/governance.json"),
    );
    const origin = defaultCommand("git", [
      "-C",
      root,
      "remote",
      "get-url",
      "origin",
    ]).replace(/\.git$/, "");
    if (
      origin !== `https://github.com/${repository.slug}` &&
      origin !== `git@github.com:${repository.slug}`
    )
      throw new Error(`Origin is not ${repository.slug}`);
    const result = await mergePullRequest({
      root,
      ...parseArguments(process.argv.slice(2)),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
