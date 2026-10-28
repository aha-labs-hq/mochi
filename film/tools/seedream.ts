/**
 * One Seedream still for the film: references travel as data URLs, so no
 * reference image needs public hosting.
 *
 *   bun film/tools/seedream.ts <out.png> <prompt.txt> [ref.jpg ...]
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [out, promptFile, ...refs] = Bun.argv.slice(2);
if (!out || !promptFile) throw new Error("usage: seedream.ts <out.png> <prompt.txt> [ref.jpg ...]");
const prompt = (await readFile(promptFile, "utf8")).trim();
const images = await Promise.all(
  refs.map(async (file) => `data:image/jpeg;base64,${(await readFile(file)).toString("base64")}`),
);
const body = {
  model: "dola-seedream-5-0-pro-260628",
  prompt: `${prompt}\n\nUse a 16:9 aspect ratio.`,
  watermark: false,
  size: "2K",
  optimize_prompt_options: { thinking: "disabled" },
  ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
};
const dir = await mkdtemp(join(tmpdir(), "seedream-"));
try {
  const file = join(dir, "body.json");
  await writeFile(file, JSON.stringify(body));
  const run = Bun.spawnSync(
    ["bash", `${process.env.HOME}/Desktop/seed-media.sh`, "--type", "image", "--body-file", file, "--download", out],
    { stdout: "pipe", stderr: "pipe" },
  );
  const text = (run.stdout.toString() + run.stderr.toString()).replace(/(image_url=)\S+/g, "$1…");
  console.log(text.trim());
  if (run.exitCode !== 0) process.exit(run.exitCode ?? 1);
} finally {
  await rm(dir, { recursive: true, force: true });
}
