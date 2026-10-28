import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { clips, entranceStage } from "../src/motion.ts";
import { evidence, stories, threads } from "../src/threads.ts";

const media = join(import.meta.dir, "../src/media");
const sha256 = async (file: string) =>
  createHash("sha256")
    .update(await readFile(join(media, file)))
    .digest("hex");

describe("website motion", () => {
  test("every video is encoded from the companion's approved clip", async () => {
    const record = JSON.parse(
      await readFile(join(media, "motion.json"), "utf8"),
    );
    expect(Object.keys(record).sort()).toEqual(Object.keys(clips).sort());
    for (const [name, clip] of Object.entries(clips)) {
      // A changed companion clip needs `bun run site:motion`.
      expect(record[name].sequence).toBe(clip.sequence);
      expect(record[name].reverse).toBe(clip.reverse);
      expect(record[name].sourceAssetSha256).toBe(clip.assetSha256);
      expect(await sha256(`${name}.webm`)).toBe(record[name].webmSha256);
      expect(await sha256(`${name}.mov`)).toBe(record[name].movSha256);
    }
  });

  test("the entrance lands inside its stage after the jump", () => {
    const { peek, jump, land, frameCount, size, bodyBottom, visualTop } =
      entranceStage;
    expect(0 < peek && peek < jump && jump < land && land < frameCount).toBe(
      true,
    );
    expect(visualTop).toBeGreaterThan(0);
    expect(bodyBottom).toBeLessThanOrEqual(size);
  });
});

describe("website conversations", () => {
  test("tell the introduction's five stories", () => {
    expect(stories.map((story) => story.role)).toEqual([
      "产品",
      "运营",
      "设计",
      "研发",
      "负责人",
    ]);
  });

  test("cite only the introduction's records", () => {
    for (const thread of [...stories, ...Object.values(threads)])
      for (const line of thread.lines)
        if ("text" in line)
          for (const [, id] of line.text.matchAll(/\]\(#([^)]+)\)/g))
            expect(evidence[id!]).toBeDefined();
  });
});

describe("website documents", () => {
  test("the privacy notice says when it last changed", async () => {
    const notice = await readFile(
      join(import.meta.dir, "../../release/public/privacy.md"),
      "utf8",
    );
    expect(notice).toMatch(/^更新于 \d{4} 年 \d{1,2} 月 \d{1,2} 日。$/m);
  });
});
