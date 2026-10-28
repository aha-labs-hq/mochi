import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GITHUB_API_VERSION,
  GITHUB_INTEGRATION,
} from "../src/github/integration.ts";
import { loadGovernanceManifest } from "./github_governance.ts";

const governance = loadGovernanceManifest();
const BOT_LOGIN = governance.identity.botLogin;
const BOT_NAME = "Mochi Companion[bot]";
const BOT_EMAIL = governance.identity.botCommitEmail;
const REPOSITORY = governance.repository.slug;
const KEYCHAIN_SERVICE = "app.mochi.github-authority";
const KEYCHAIN_ACCOUNT = "maintainer";

const [command, ...args] = process.argv.slice(2);
if (command === "commit") commit(args);
else if (command === "propose") await propose(args);
else
  fail(
    "Usage: bun run github:commit -- <git commit arguments> | bun run github:propose -- --title <title> --body-file <path> [--draft]",
  );

function commit(args: string[]): never {
  assertRepository();
  assertBranch();
  if (args.length === 0) fail("Pass explicit git commit arguments");
  const result = spawnSync(
    "git",
    [
      "-c",
      `user.name=${BOT_NAME}`,
      "-c",
      `user.email=${BOT_EMAIL}`,
      "commit",
      ...args,
    ],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

async function propose(args: string[]): Promise<void> {
  assertRepository();
  const branch = assertBranch();
  if (git(["status", "--porcelain"]))
    fail("Commit all changes before proposing them");
  const title = option(args, "--title");
  const bodyPath = resolve(option(args, "--body-file"));
  const draft = args.includes("--draft");
  const allowed = new Set(["--title", "--body-file", "--draft"]);
  for (let index = 0; index < args.length; index++) {
    if (!allowed.has(args[index] ?? "")) fail(`Unknown option: ${args[index]}`);
    if (args[index] !== "--draft") index++;
  }
  if (title.length < 1 || title.length > 256 || /[\r\n\0]/.test(title))
    fail("Invalid PR title");
  const body = readFileSync(bodyPath, "utf8");
  if (body.length < 1 || body.length > 65_536 || body.includes("\0"))
    fail("Invalid PR body");
  const author = git(["log", "-1", "--format=%an%x00%ae"]).split("\0");
  if (author[0] !== BOT_NAME || author[1] !== BOT_EMAIL) {
    fail(
      `HEAD must be authored by ${BOT_NAME} <${BOT_EMAIL}>; use bun run github:commit`,
    );
  }

  const maintainerSecret = execFileSync(
    "security",
    [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(maintainerSecret))
    fail("Maintainer authority is unavailable");
  const authority = await json(
    `${GITHUB_INTEGRATION.authorityUrl}/v1/maintainer/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Mochi-Maintainer ${maintainerSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1, purpose: "change_proposal" }),
    },
  );
  const token = readAuthorityToken(authority);
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  const pushed = spawnSync(
    "git",
    ["push", "origin", `HEAD:refs/heads/${branch}`],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (pushed.status !== 0) fail("App-authenticated push failed");

  const head = `${REPOSITORY.split("/")[0]}:${branch}`;
  const existing = await github(
    `/repos/${REPOSITORY}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=2`,
    token,
  );
  if (!Array.isArray(existing) || existing.length > 1)
    fail("Unexpected existing PR response");
  let pull: unknown;
  if (existing.length === 1) {
    const current = record(existing[0]);
    const currentUser = record(current.user);
    if (currentUser.login !== BOT_LOGIN)
      fail("Refusing to adopt a PR created by another identity");
    pull = await github(
      `/repos/${REPOSITORY}/pulls/${number(current.number)}`,
      token,
      {
        method: "PATCH",
        body: { title, body },
      },
    );
  } else {
    pull = await github(`/repos/${REPOSITORY}/pulls`, token, {
      method: "POST",
      body: { title, body, head: branch, base: "main", draft },
    });
  }
  const result = record(pull);
  const resultUser = record(result.user);
  const resultHead = record(result.head);
  if (
    !number(result.number) ||
    typeof result.html_url !== "string" ||
    resultUser.login !== BOT_LOGIN ||
    typeof resultHead.sha !== "string"
  ) {
    fail("GitHub did not confirm the Mochi App as PR creator");
  }
  process.stdout.write(
    `${JSON.stringify({ number: result.number, url: result.html_url, actor: resultUser.login, head: resultHead.sha })}\n`,
  );
}

function readAuthorityToken(value: unknown): string {
  const data = record(value);
  const actor = record(data.actor);
  const repository = record(data.repository);
  const permissions = record(data.permissions);
  if (
    data.version !== 1 ||
    actor.login !== BOT_LOGIN ||
    repository.id !== governance.identity.maintainerRepositoryId ||
    repository.fullName !== REPOSITORY ||
    permissions.contents !== "write" ||
    permissions.metadata !== "read" ||
    permissions.pull_requests !== "write" ||
    typeof data.token !== "string" ||
    !/^ghs_[A-Za-z0-9._-]{1,4096}$/.test(data.token) ||
    typeof data.expiresAt !== "string" ||
    Date.parse(data.expiresAt) <= Date.now()
  )
    fail("Maintainer authority returned an invalid capability");
  return data.token;
}

async function github(
  path: string,
  token: string,
  options: { method?: "POST" | "PATCH"; body?: unknown } = {},
): Promise<unknown> {
  return json(`https://api.github.com${path}`, {
    method: options.method ?? "GET",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "mochi-maintainer",
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function json(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(`Request failed (${response.status})`);
  }
  const text = await response.text();
  if (text.length > 2_000_000) fail("Response exceeded the bounded size");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("Response was not valid JSON");
  }
}

function assertRepository(): void {
  const root = git(["rev-parse", "--show-toplevel"]);
  const metadata = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as { name?: unknown };
  if (metadata.name !== "mochi") fail("Run inside the Mochi repository");
  const remote = git(["remote", "get-url", "origin"]);
  const origins = [
    `https://github.com/${REPOSITORY}`,
    `https://github.com/${REPOSITORY}.git`,
    `git@github.com:${REPOSITORY}`,
    `git@github.com:${REPOSITORY}.git`,
  ];
  if (!origins.includes(remote)) fail(`Origin is not ${REPOSITORY}`);
}

function assertBranch(): string {
  const branch = git(["branch", "--show-current"]);
  if (
    !/^codex\/[A-Za-z0-9._/-]{1,200}$/.test(branch) ||
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.includes("//")
  ) {
    fail("Use a codex/* proposal branch; main is human-owned");
  }
  return branch;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--") || args.indexOf(name, index + 1) >= 0)
    fail(`Missing or repeated ${name}`);
  return value;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("Invalid response");
  return value as Record<string, unknown>;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail("Invalid numeric identity");
  return value;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
