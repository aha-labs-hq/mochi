import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GovernanceLabel {
  name: string;
  color: string;
  description: string;
}

export interface GovernanceManifest {
  schemaVersion: number;
  identity: {
    appId: number;
    appOwnerId: number;
    appSlug: string;
    botLogin: string;
    botUserId: number;
    botCommitEmail: string;
    authorityUrl: string;
    maintainerRepositoryId: number;
    writeActor: "app";
    mergeActor: "human";
    requiredRepositoryPermissions: Record<string, "read" | "write">;
  };
  repository: {
    slug: string;
    defaultBranch: string;
    branchPrefix: string;
    settings: Record<string, boolean | string>;
  };
  labels: GovernanceLabel[];
  pullRequestTemplate: {
    sections: string[];
  };
  retiredLabels: string[];
}

const repositoryRoot = resolve(import.meta.dir, "..");
const manifestPath = resolve(repositoryRoot, ".github/governance.json");

const issueForms = [
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/change.yml",
  ".github/ISSUE_TEMPLATE/maintenance.yml",
];

const workflowFiles = [".github/workflows/ci.yml"];

const requiredContractFiles = [
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
  ".agents/skills/govern-mochi-github/SKILL.md",
  ".agents/skills/govern-mochi-github/agents/openai.yaml",
  "docs/github-governance.md",
  "script/verify.ts",
  "script/verify_suite.sh",
  "script/github_identity.ts",
  "script/github_merge.ts",
  "identity/wrangler.jsonc",
  "identity/src/index.ts",
  "identity/src/github.ts",
  "identity/src/protocol.ts",
  "src/github/writeAuthority.ts",
  ...issueForms,
  ...workflowFiles,
];

export function loadGovernanceManifest(
  path = manifestPath,
): GovernanceManifest {
  return JSON.parse(readFileSync(path, "utf8")) as GovernanceManifest;
}

export function markdownSections(markdown: string): Map<string, string> {
  const headings = [...markdown.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)];
  const sections = new Map<string, string>();
  for (const [index, heading] of headings.entries()) {
    const name = heading[1]?.trim();
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    if (name) sections.set(name, markdown.slice(start, end).trim());
  }
  return sections;
}

export function validateGovernanceManifest(
  manifest: GovernanceManifest,
): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 4)
    errors.push("governance schemaVersion must be 4");
  if (
    !Number.isSafeInteger(manifest.identity.appId) ||
    manifest.identity.appId <= 0 ||
    !Number.isSafeInteger(manifest.identity.appOwnerId) ||
    manifest.identity.appOwnerId <= 0 ||
    !Number.isSafeInteger(manifest.identity.botUserId) ||
    manifest.identity.botUserId <= 0 ||
    !Number.isSafeInteger(manifest.identity.maintainerRepositoryId) ||
    manifest.identity.maintainerRepositoryId <= 0 ||
    !/^[a-z0-9-]{1,100}$/.test(manifest.identity.appSlug) ||
    manifest.identity.botLogin !== `${manifest.identity.appSlug}[bot]` ||
    manifest.identity.botCommitEmail !==
      `${manifest.identity.botUserId}+${manifest.identity.botLogin}@users.noreply.github.com` ||
    !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(
      manifest.identity.authorityUrl,
    ) ||
    manifest.identity.writeActor !== "app" ||
    manifest.identity.mergeActor !== "human"
  ) {
    errors.push("GitHub App identity contract is invalid");
  }
  const requiredPermissions = manifest.identity.requiredRepositoryPermissions;
  if (
    Object.keys(requiredPermissions).sort().join(",") !==
      "actions,checks,contents,issues,metadata,pull_requests,statuses" ||
    requiredPermissions.contents !== "write" ||
    requiredPermissions.issues !== "write" ||
    requiredPermissions.pull_requests !== "write" ||
    Object.entries(requiredPermissions).some(
      ([key, value]) =>
        !["read", "write"].includes(value) ||
        (key !== "contents" &&
          key !== "issues" &&
          key !== "pull_requests" &&
          value !== "read"),
    )
  ) {
    errors.push("GitHub App repository permissions are invalid");
  }
  if (!/^[^/]+\/[^/]+$/.test(manifest.repository.slug)) {
    errors.push("repository.slug must be an exact owner/name pair");
  }
  if (!manifest.repository.defaultBranch.trim()) {
    errors.push("repository.defaultBranch cannot be empty");
  }
  if (!manifest.repository.branchPrefix.endsWith("/")) {
    errors.push("repository.branchPrefix must end with `/`");
  }

  const labelNames = new Set<string>();
  for (const label of manifest.labels) {
    if (!label.name.trim()) errors.push("managed label has no name");
    if (labelNames.has(label.name))
      errors.push(`duplicate label: ${label.name}`);
    labelNames.add(label.name);
    if (!/^[0-9a-f]{6}$/i.test(label.color)) {
      errors.push(`label ${label.name} has an invalid color`);
    }
    if (!label.description.trim())
      errors.push(`label ${label.name} has no description`);
  }

  if (manifest.pullRequestTemplate.sections.length === 0) {
    errors.push("pull request template must keep at least one useful section");
  }
  if (
    new Set(manifest.pullRequestTemplate.sections).size !==
    manifest.pullRequestTemplate.sections.length
  ) {
    errors.push("pull request template sections must be unique");
  }

  if (new Set(manifest.retiredLabels).size !== manifest.retiredLabels.length) {
    errors.push("retired labels must be unique");
  }
  for (const label of manifest.retiredLabels) {
    if (labelNames.has(label))
      errors.push(`managed label ${label} cannot also be retired`);
  }
  return errors;
}

export function liveGovernanceDrift(
  repository: Record<string, unknown>,
  liveLabels: Array<{ name: string; color: string; description: string }>,
  manifest = loadGovernanceManifest(),
): string[] {
  const drift: string[] = [];
  if (repository.default_branch !== manifest.repository.defaultBranch) {
    drift.push(
      `repository default branch: expected ${manifest.repository.defaultBranch}, got ${String(repository.default_branch)}`,
    );
  }
  for (const [setting, expected] of Object.entries(
    manifest.repository.settings,
  )) {
    if (repository[setting] !== expected) {
      drift.push(
        `repository setting ${setting}: expected ${String(expected)}, got ${String(repository[setting])}`,
      );
    }
  }

  const labelsByName = new Map(liveLabels.map((label) => [label.name, label]));
  for (const expected of manifest.labels) {
    const actual = labelsByName.get(expected.name);
    if (!actual) {
      drift.push(`missing label ${expected.name}`);
      continue;
    }
    if (actual.color.toLowerCase() !== expected.color.toLowerCase()) {
      drift.push(
        `label ${expected.name} has color ${actual.color}, expected ${expected.color}`,
      );
    }
    if (actual.description !== expected.description) {
      drift.push(`label ${expected.name} has a stale description`);
    }
  }
  for (const retired of manifest.retiredLabels) {
    if (labelsByName.has(retired))
      drift.push(`retired label still exists: ${retired}`);
  }
  return drift;
}

export function liveIdentityDrift(
  repository: Record<string, unknown>,
  app: Record<string, unknown>,
  bot: Record<string, unknown>,
  manifest = loadGovernanceManifest(),
): string[] {
  const drift: string[] = [];
  if (repository.id !== manifest.identity.maintainerRepositoryId) {
    drift.push(
      `maintainer repository ID: expected ${manifest.identity.maintainerRepositoryId}, got ${String(repository.id)}`,
    );
  }
  if (
    app.id !== manifest.identity.appId ||
    app.slug !== manifest.identity.appSlug
  ) {
    drift.push(
      `GitHub App identity: expected ${manifest.identity.appId}/${manifest.identity.appSlug}, got ${String(app.id)}/${String(app.slug)}`,
    );
  }
  if (
    bot.id !== manifest.identity.botUserId ||
    bot.login !== manifest.identity.botLogin ||
    bot.type !== "Bot"
  ) {
    drift.push(
      `GitHub bot identity: expected ${manifest.identity.botUserId}/${manifest.identity.botLogin}, got ${String(bot.id)}/${String(bot.login)}`,
    );
  }
  if (
    app.owner === null ||
    typeof app.owner !== "object" ||
    Array.isArray(app.owner) ||
    (app.owner as Record<string, unknown>).id !== manifest.identity.appOwnerId
  ) {
    drift.push("GitHub App owner identity changed");
  }
  if (
    app.permissions === null ||
    typeof app.permissions !== "object" ||
    Array.isArray(app.permissions)
  ) {
    drift.push("GitHub App permissions are unavailable");
  } else {
    const permissions = app.permissions as Record<string, unknown>;
    for (const [permission, expected] of Object.entries(
      manifest.identity.requiredRepositoryPermissions,
    )) {
      if (permissions[permission] !== expected) {
        drift.push(
          `GitHub App permission ${permission}: expected ${expected}, got ${String(permissions[permission])}`,
        );
      }
    }
  }
  return drift;
}

export function workflowContractErrors(source: string): string[] {
  const errors: string[] = [];
  const parsed = Bun.YAML.parse(source) as {
    on?: Record<string, unknown>;
    jobs?: Record<
      string,
      {
        steps?: Array<{
          uses?: string;
          run?: string;
          with?: Record<string, unknown>;
        }>;
      }
    >;
  };
  const triggers = Object.keys(parsed.on ?? {});
  if (triggers.length !== 1 || triggers[0] !== "workflow_dispatch")
    errors.push(
      "hosted verification must be manual-only; do not consume Actions allowance automatically",
    );
  const commands: string[] = [];
  for (const job of Object.values(parsed.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.run) commands.push(step.run.trim());
      const uses = step.uses;
      if (!uses || uses.startsWith("./")) continue;
      const separator = uses.lastIndexOf("@");
      const action = uses.slice(0, separator);
      const revision = uses.slice(separator + 1);
      if (separator <= 0 || !/^[0-9a-f]{40}$/i.test(revision))
        errors.push(`must pin ${uses} to a full commit SHA`);
      if (
        action === "actions/checkout" &&
        step.with?.["persist-credentials"] !== false
      )
        errors.push("must disable persisted checkout credentials");
    }
  }
  if (commands.length !== 1 || commands[0] !== "bun run verify")
    errors.push(
      "hosted verification must delegate to bun run verify, not a second checklist",
    );
  return errors;
}

async function checkLocalContract(manifest: GovernanceManifest): Promise<void> {
  const errors = validateGovernanceManifest(manifest);
  for (const file of requiredContractFiles) {
    if (!existsSync(resolve(repositoryRoot, file)))
      errors.push(`missing contract file: ${file}`);
  }

  const managedLabels = new Set(manifest.labels.map(({ name }) => name));
  for (const issueForm of issueForms) {
    const parsed = Bun.YAML.parse(
      readFileSync(resolve(repositoryRoot, issueForm), "utf8"),
    ) as {
      labels?: string[];
    };
    for (const label of parsed.labels ?? []) {
      if (!managedLabels.has(label))
        errors.push(`${issueForm} uses unknown label ${label}`);
    }
  }

  const issueConfig = Bun.YAML.parse(
    readFileSync(
      resolve(repositoryRoot, ".github/ISSUE_TEMPLATE/config.yml"),
      "utf8",
    ),
  ) as { blank_issues_enabled?: boolean };
  if (issueConfig.blank_issues_enabled !== true) {
    errors.push("blank Issues must remain available for lightweight tracking");
  }

  for (const workflowFile of workflowFiles) {
    const source = readFileSync(resolve(repositoryRoot, workflowFile), "utf8");
    errors.push(
      ...workflowContractErrors(source).map(
        (error) => `${workflowFile}: ${error}`,
      ),
    );
  }

  const pullRequestTemplate = markdownSections(
    readFileSync(
      resolve(repositoryRoot, ".github/pull_request_template.md"),
      "utf8",
    ),
  );
  for (const section of manifest.pullRequestTemplate.sections) {
    if (!pullRequestTemplate.has(section)) {
      errors.push(`pull request template is missing section ${section}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `GitHub governance contract is invalid:\n- ${errors.join("\n- ")}`,
    );
  }
  console.log("GitHub governance contract is valid.");
}

async function auditLiveGovernance(
  manifest: GovernanceManifest,
): Promise<void> {
  await checkLocalContract(manifest);
  const repository = await ghJSON<Record<string, unknown>>([
    "api",
    `repos/${manifest.repository.slug}`,
  ]);
  const liveLabels = await ghJSON<
    Array<{ name: string; color: string; description: string }>
  >([
    "label",
    "list",
    "--repo",
    manifest.repository.slug,
    "--limit",
    "200",
    "--json",
    "name,color,description",
  ]);
  const app = await ghJSON<Record<string, unknown>>([
    "api",
    `apps/${manifest.identity.appSlug}`,
  ]);
  const bot = await ghJSON<Record<string, unknown>>([
    "api",
    `users/${encodeURIComponent(manifest.identity.botLogin)}`,
  ]);
  const drift = [
    ...liveGovernanceDrift(repository, liveLabels, manifest),
    ...liveIdentityDrift(repository, app, bot, manifest),
  ];

  if (drift.length > 0)
    throw new Error(`Live GitHub governance drift:\n- ${drift.join("\n- ")}`);
  console.log(`Live GitHub governance matches ${manifest.repository.slug}.`);
}

async function applyLiveGovernance(
  manifest: GovernanceManifest,
): Promise<void> {
  await checkLocalContract(manifest);
  const fields = [
    "-F",
    `default_branch=${manifest.repository.defaultBranch}`,
    ...Object.entries(manifest.repository.settings).flatMap(([key, value]) => [
      "-F",
      `${key}=${String(value)}`,
    ]),
  ];
  await runGh([
    "api",
    "--method",
    "PATCH",
    `repos/${manifest.repository.slug}`,
    ...fields,
  ]);

  const liveLabels = await ghJSON<
    Array<{ name: string; color: string; description: string }>
  >([
    "label",
    "list",
    "--repo",
    manifest.repository.slug,
    "--limit",
    "200",
    "--json",
    "name,color,description",
  ]);
  const labelsByName = new Map(liveLabels.map((label) => [label.name, label]));
  for (const expected of manifest.labels) {
    const actual = labelsByName.get(expected.name);
    if (!actual) {
      await runGh([
        "label",
        "create",
        expected.name,
        "--repo",
        manifest.repository.slug,
        "--color",
        expected.color,
        "--description",
        expected.description,
      ]);
      continue;
    }
    if (
      actual.color.toLowerCase() !== expected.color.toLowerCase() ||
      actual.description !== expected.description
    ) {
      await runGh([
        "label",
        "edit",
        expected.name,
        "--repo",
        manifest.repository.slug,
        "--color",
        expected.color,
        "--description",
        expected.description,
      ]);
    }
  }
  console.log(
    `Applied managed GitHub governance to ${manifest.repository.slug}.`,
  );
}

async function retireUnusedLabels(manifest: GovernanceManifest): Promise<void> {
  for (const label of manifest.retiredLabels) {
    const usages = await ghJSON<Array<{ html_url: string }>>([
      "api",
      "--method",
      "GET",
      `repos/${manifest.repository.slug}/issues`,
      "-f",
      "state=all",
      "-f",
      `labels=${label}`,
      "-F",
      "per_page=1",
    ]);
    if (usages.length > 0) {
      throw new Error(
        `Cannot retire label ${label}; it is still used by ${usages[0]?.html_url}`,
      );
    }
  }
  for (const label of manifest.retiredLabels) {
    await runGh(
      ["label", "delete", label, "--repo", manifest.repository.slug, "--yes"],
      true,
    );
  }
  console.log("Retired unused legacy labels.");
}

async function ghJSON<T>(args: string[]): Promise<T> {
  const output = await runGh(args);
  return JSON.parse(output) as T;
}

async function runGh(args: string[], ignoreMissing = false): Promise<string> {
  const child = Bun.spawn(["gh", ...args], {
    cwd: repositoryRoot,
    env: processEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    if (ignoreMissing && /not found|could not find|404/i.test(stderr))
      return "";
    throw new Error(
      `gh ${args[0] ?? "command"} failed: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  return stdout.trim();
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

async function main(): Promise<void> {
  const manifest = loadGovernanceManifest();
  const command = process.argv[2] ?? "check";
  switch (command) {
    case "check":
      await checkLocalContract(manifest);
      break;
    case "audit":
      await auditLiveGovernance(manifest);
      break;
    case "apply":
      await applyLiveGovernance(manifest);
      break;
    case "retire-labels":
      await retireUnusedLabels(manifest);
      break;
    default:
      throw new Error(
        `Unknown governance command ${command}; use check, audit, apply, or retire-labels.`,
      );
  }
}

if (import.meta.main) {
  await main();
}
