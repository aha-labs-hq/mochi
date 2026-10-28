import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const skill = readFileSync(
  resolve(root, ".agents/skills/produce-mochi-motion/SKILL.md"),
  "utf8",
);
const qualityContract = readFileSync(
  resolve(root, ".agents/skills/produce-mochi-motion/references/quality-contract.md"),
  "utf8",
);
const characterMotionProtocol = readFileSync(
  resolve(
    root,
    ".agents/skills/produce-mochi-motion/references/character-motion-protocol.md",
  ),
  "utf8",
);
const openAIYAML = readFileSync(
  resolve(root, ".agents/skills/produce-mochi-motion/agents/openai.yaml"),
  "utf8",
);
const motionReadme = readFileSync(resolve(root, "motion/README.md"), "utf8");
const repositoryGuide = readFileSync(resolve(root, "AGENTS.md"), "utf8");
const buildScript = readFileSync(resolve(root, "script/build_desktop.ts"), "utf8");
const resourceBuilder = readFileSync(resolve(root, "controlApp/build/resources.ts"), "utf8");
const motionManifest = JSON.parse(
  readFileSync(resolve(root, "motion/manifest.json"), "utf8"),
) as {
  schemaVersion: number;
  defaultCharacter: string;
  applicationStates: string[];
  characters: Array<{
    id: string;
    rootAsset: string;
    backgroundTexture: { resource: string; source: string; sha256: string };
    assets: Array<{ id: string; resource: string; source: string; sha256: string }>;
    states: Array<{ id: string }>;
    previews: Array<{ id: string }>;
  }>;
  sequences: Array<{
    id: string;
    character: string;
    acceptance: string;
    asset: string;
    assetSha256?: string;
    sourceSha256?: string;
    generationTaskId?: string | null;
    kind: string;
    targetAsset?: string;
    bundledForPreview?: boolean;
  }>;
};

function parseSkillFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatter = match?.[1];
  if (!frontmatter) throw new Error("Mochi motion Skill frontmatter is missing");
  return Bun.YAML.parse(frontmatter) as Record<string, unknown>;
}

describe("Mochi motion production Skill", () => {
  test("routes every motion task through the live canonical pipeline", () => {
    expect(parseSkillFrontmatter(skill)).toEqual({
      name: "produce-mochi-motion",
      description: expect.any(String),
    });
    expect(skill).toContain("motion/manifest.json");
    expect(skill).toContain("script/mochi_motion_pipeline.sh");
    expect(skill).toContain("references/character-motion-protocol.md");
    expect(skill).toContain("SEEDANCE_VIDEO_CLI");
    expect(skill).toContain(
      "Never copy their state maps, frame counts, thresholds, hashes, geometry, presentation, or timing",
    );
    expect(motionReadme).toContain("$produce-mochi-motion");
    expect(repositoryGuide).toContain("$produce-mochi-motion");
  });

  test("keeps creative content open while making acceptance non-negotiable", () => {
    expect(skill).toContain("The **creative brief** is open");
    expect(skill).toContain("The **production contract** is fixed");
    expect(skill).toContain('`acceptance: "candidate"`');
    expect(skill).toContain("Do not manufacture animation from still-frame interpolation");
    expect(skill).toContain("Never claim acceptance from exit codes alone");
    expect(qualityContract).toContain("## Contents");
    expect(qualityContract).toContain("## Open creative space");
    expect(qualityContract).toContain("## Candidate lifecycle");
    expect(qualityContract).toContain("## Failure response");
    expect(characterMotionProtocol).toContain("## One authority, two consumers");
    expect(characterMotionProtocol).toContain("## Add an application state");
    expect(characterMotionProtocol).toContain("## Add a character");
  });

  test("keeps UI metadata broad enough for creation and audit", () => {
    const metadata = Bun.YAML.parse(openAIYAML) as {
      interface: {
        display_name: string;
        short_description: string;
        default_prompt: string;
      };
    };

    expect(metadata.interface.display_name).toBe("Produce Mochi Motion");
    expect(metadata.interface.short_description.length).toBeGreaterThanOrEqual(25);
    expect(metadata.interface.short_description.length).toBeLessThanOrEqual(64);
    expect(metadata.interface.default_prompt).toContain("$produce-mochi-motion");
    expect(metadata.interface.default_prompt).toContain("create or audit");
  });

  test("pins approved provenance and derives runtime resources from the manifest", () => {
    expect(motionManifest.schemaVersion).toBe(4);
    expect(
      motionManifest.characters.some(({ id }) => id === motionManifest.defaultCharacter),
    ).toBeTrue();
    expect(new Set(motionManifest.applicationStates).size).toBe(
      motionManifest.applicationStates.length,
    );
    const bundledResourceNames: string[] = [];
    for (const character of motionManifest.characters) {
      expect(character.assets.some(({ id }) => id === character.rootAsset)).toBeTrue();
      bundledResourceNames.push(character.backgroundTexture.resource);
      expect(sha256(resolve(root, character.backgroundTexture.source))).toBe(
        character.backgroundTexture.sha256,
      );
      for (const asset of character.assets) {
        bundledResourceNames.push(asset.resource);
        expect(sha256(resolve(root, asset.source))).toBe(asset.sha256);
      }
      expect(character.states.map(({ id }) => id)).toEqual(motionManifest.applicationStates);
      expect(new Set(character.states.map(({ id }) => id)).size).toBe(
        character.states.length,
      );
      expect(new Set(character.previews.map(({ id }) => id)).size).toBe(
        character.previews.length,
      );
    }
    for (const sequence of motionManifest.sequences.filter(
      ({ acceptance }) => acceptance === "approved" || acceptance === "approved-reference",
    )) {
      expect(sequence.generationTaskId).toBeTruthy();
      const assetSha256 = sequence.assetSha256;
      if (!assetSha256) throw new Error(`Approved motion ${sequence.asset} has no asset hash`);
      bundledResourceNames.push(sequence.asset);
      expect(sha256(resolve(root, `controlApp/Resources/${sequence.asset}.webp`))).toBe(
        assetSha256,
      );
      if (sequence.acceptance === "approved") expect(sequence.sourceSha256).toBeTruthy();
      if (sequence.kind === "state") {
        const character = motionManifest.characters.find(
          ({ id }) => id === sequence.character,
        );
        expect(character).toBeTruthy();
        expect(
          character?.assets.some(({ id }) => id === sequence.targetAsset),
        ).toBeTrue();
      }
    }
    for (const sequence of motionManifest.sequences.filter(
      ({ acceptance, bundledForPreview }) => acceptance === "rejected" && bundledForPreview,
    )) {
      const assetSha256 = sequence.assetSha256;
      if (!assetSha256) throw new Error(`Bundled preview ${sequence.asset} has no asset hash`);
      bundledResourceNames.push(sequence.asset);
      expect(sha256(resolve(root, `controlApp/Resources/${sequence.asset}.webp`))).toBe(
        assetSha256,
      );
    }
    expect(new Set(bundledResourceNames).size).toBe(bundledResourceNames.length);
    expect(buildScript).toContain("await prepareResources(root, build, command)");
    expect(resourceBuilder).toContain("new MotionCatalog(");
    expect(resourceBuilder).toContain("catalog.sequences");
    expect(resourceBuilder).toContain("character.assets");
    expect(resourceBuilder).toContain("CharacterMotionManifest.json");
    expect(resourceBuilder).not.toContain('cp "$RESOURCE_DIRECTORY"/*');
  });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
