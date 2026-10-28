import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  liveGovernanceDrift,
  liveIdentityDrift,
  loadGovernanceManifest,
  markdownSections,
  validateGovernanceManifest,
  workflowContractErrors,
} from "../script/github_governance";

const root = resolve(import.meta.dir, "..");
const manifest = loadGovernanceManifest(
  resolve(root, ".github/governance.json"),
);

describe("GitHub governance", () => {
  test("the manifest owns only the small machine-enforced surface", () => {
    expect(validateGovernanceManifest(manifest)).toEqual([]);
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.identity).toMatchObject({
      appId: 5509147,
      appSlug: "mochi-maintainer",
      botLogin: "mochi-maintainer[bot]",
      writeActor: "app",
      mergeActor: "human",
    });
    expect(manifest.pullRequestTemplate.sections).toEqual([
      "Outcome",
      "Evidence",
    ]);

    const labels = manifest.labels.map(({ name }) => name);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain("state:needs-triage");
    expect(manifest.retiredLabels).toContain("state:needs-triage");
    expect(manifest).not.toHaveProperty("issueIntake");
    expect(manifest).not.toHaveProperty("labelAxes");
  });

  test("malformed machine configuration still fails closed", () => {
    const duplicateLabel = structuredClone(manifest);
    duplicateLabel.labels.push(structuredClone(duplicateLabel.labels[0]!));
    expect(validateGovernanceManifest(duplicateLabel)).toContain(
      `duplicate label: ${duplicateLabel.labels[0]!.name}`,
    );

    const overlappingRetirement = structuredClone(manifest);
    overlappingRetirement.retiredLabels.push(
      overlappingRetirement.labels[0]!.name,
    );
    expect(validateGovernanceManifest(overlappingRetirement)).toContain(
      `managed label ${overlappingRetirement.labels[0]!.name} cannot also be retired`,
    );

    const staleSchema = structuredClone(manifest);
    staleSchema.schemaVersion = 3;
    expect(validateGovernanceManifest(staleSchema)).toContain(
      "governance schemaVersion must be 4",
    );
  });

  test("live audit binds the repository and App actor without accepting weaker write permissions", () => {
    const repository = { id: manifest.identity.maintainerRepositoryId };
    const app = {
      id: manifest.identity.appId,
      slug: manifest.identity.appSlug,
      owner: { id: manifest.identity.appOwnerId },
      permissions: manifest.identity.requiredRepositoryPermissions,
    };
    const bot = {
      id: manifest.identity.botUserId,
      login: manifest.identity.botLogin,
      type: "Bot",
    };
    expect(liveIdentityDrift(repository, app, bot, manifest)).toEqual([]);
    expect(
      liveIdentityDrift(
        repository,
        {
          ...app,
          permissions: { ...app.permissions, issues: "write" },
        },
        bot,
        manifest,
      ),
    ).toContain("GitHub App permission issues: unexpected grant");
    expect(
      liveIdentityDrift(
        repository,
        {
          ...app,
          permissions: { ...app.permissions, pull_requests: "read" },
        },
        bot,
        manifest,
      ),
    ).toContain(
      "GitHub App permission pull_requests: expected write, got read",
    );
    expect(liveIdentityDrift({ id: 1 }, app, bot, manifest)).toContain(
      `maintainer repository ID: expected ${manifest.identity.maintainerRepositoryId}, got 1`,
    );
  });

  test("live audit protects declared state without policing personal labels", () => {
    const repository = {
      ...manifest.repository.settings,
      default_branch: manifest.repository.defaultBranch,
    };
    const labels = manifest.labels.map(({ name, color, description }) => ({
      name,
      color,
      description,
    }));
    expect(liveGovernanceDrift(repository, labels, manifest)).toEqual([]);
    expect(
      liveGovernanceDrift(
        repository,
        [
          ...labels,
          {
            name: "personal:useful",
            color: "ffffff",
            description: "Local aid",
          },
        ],
        manifest,
      ),
    ).toEqual([]);
    expect(
      liveGovernanceDrift(
        repository,
        [
          ...labels,
          {
            name: "state:needs-triage",
            color: "ededed",
            description: "Retired ceremony",
          },
        ],
        manifest,
      ),
    ).toContain("retired label still exists: state:needs-triage");

    expect(
      liveGovernanceDrift(
        { ...repository, default_branch: "develop" },
        labels,
        manifest,
      ),
    ).toContain("repository default branch: expected main, got develop");
  });

  test("Issue intake is optional and lightweight", () => {
    const config = Bun.YAML.parse(
      readFileSync(resolve(root, ".github/ISSUE_TEMPLATE/config.yml"), "utf8"),
    ) as { blank_issues_enabled?: boolean };
    expect(config.blank_issues_enabled).toBeTrue();

    const managedLabels = new Set(manifest.labels.map(({ name }) => name));
    for (const form of ["bug.yml", "change.yml", "maintenance.yml"]) {
      const source = readFileSync(
        resolve(root, `.github/ISSUE_TEMPLATE/${form}`),
        "utf8",
      );
      const parsed = Bun.YAML.parse(source) as { labels?: string[] };
      for (const label of parsed.labels ?? [])
        expect(managedLabels.has(label)).toBeTrue();
      expect(source).not.toContain("label: Primary area");
      expect(source).not.toContain("label: Priority");
    }
  });

  test("the PR template asks for useful facts without requiring an Issue", () => {
    const template = readFileSync(
      resolve(root, ".github/pull_request_template.md"),
      "utf8",
    );
    const sections = markdownSections(template);
    expect([...sections.keys()]).toEqual(["Outcome", "Evidence", "Context"]);
    expect(template).not.toContain("Closes #");
    expect(template).not.toContain("## Review");
    expect(template).toContain("Optional:");
  });

  test("hosted verification is opt-in and delegates to the local authority", () => {
    const source = readFileSync(
      resolve(root, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflowContractErrors(source)).toEqual([]);
    expect(
      workflowContractErrors(
        source.replace("workflow_dispatch:", "pull_request:"),
      ),
    ).toContain(
      "hosted verification must be manual-only; do not consume Actions allowance automatically",
    );
    expect(
      workflowContractErrors(
        source.replace("workflow_dispatch:", "workflow_dispatch:\n  push:"),
      ),
    ).toHaveLength(1);
    expect(
      workflowContractErrors(source.replace("bun run verify", "bun test")),
    ).toContain(
      "hosted verification must delegate to bun run verify, not a second checklist",
    );
    expect(
      workflowContractErrors(
        source.replace(
          "persist-credentials: false",
          "persist-credentials: true",
        ),
      ),
    ).toContain("must disable persisted checkout credentials");
    expect(
      workflowContractErrors(
        source.replace(
          /actions\/checkout@[0-9a-f]{40}/,
          "actions/checkout@main",
        ),
      ),
    ).toContain("must pin actions/checkout@main to a full commit SHA");
    expect(
      existsSync(resolve(root, ".github/workflows/issue-governance.yml")),
    ).toBeFalse();
    expect(
      existsSync(
        resolve(root, ".github/workflows/pull-request-governance.yml"),
      ),
    ).toBeFalse();
  });

  test("the Skill and repository instructions contain no obsolete mandatory chain", () => {
    const skill = readFileSync(
      resolve(root, ".agents/skills/govern-mochi-github/SKILL.md"),
      "utf8",
    );
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1];
    expect(Bun.YAML.parse(frontmatter ?? "")).toEqual({
      name: "govern-mochi-github",
      description: expect.any(String),
    });
    expect(skill).toContain("bun run governance:audit");
    expect(skill).toContain("bun run github:commit");
    expect(skill).toContain("bun run github:propose");
    expect(skill).toContain("mochi-maintainer[bot]");
    expect(skill).not.toContain("close one real Issue");
    expect(skill).not.toContain("post-merge CI is green");

    const agents = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    expect(agents).not.toContain(
      "Issue → 短分支 → PR → 绿色检查 → squash merge",
    );

    const packageJSON = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    expect(packageJSON.scripts["governance:triage"]).toBeUndefined();
    expect(packageJSON.scripts["governance:pr"]).toBeUndefined();
    expect(packageJSON.scripts["governance:pr-live"]).toBeUndefined();
    expect(packageJSON.scripts["github:commit"]).toContain(
      "github_identity.ts commit",
    );
    expect(packageJSON.scripts["github:propose"]).toContain(
      "github_identity.ts propose",
    );

    const customerCopy = ["setupPresentation.ts", "ProjectsSettings.tsx"]
      .map((file) =>
        readFileSync(resolve(root, `controlApp/src/ui/${file}`), "utf8"),
      )
      .join("\n");
    expect(customerCopy).toContain("Mochi Companion [bot]");
    expect(customerCopy).not.toContain("Issue 操作以你的 GitHub 身份");
  });
});
