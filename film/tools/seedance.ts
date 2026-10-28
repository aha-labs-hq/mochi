/**
 * One Seedance take for the film: from a first frame, and to a last frame
 * when the shot must end somewhere exact.
 *
 *   bun tools/seedance.ts [--model 2.0|2.5] <out.mp4> <prompt.txt> <seconds> <ratio> <first.png> [last.png]
 *
 * Mochi's takes use 2.0, the model every approved app motion used; the
 * world's takes may use either.
 *
 * Beside the take it writes <out>.json: the provider task, the model and the
 * SHA-256 of the prompt, the frames and the result. clips.json records the
 * chosen takes from these, so a fresh checkout fetches and verifies them.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODELS = { "2.0": "dreamina-seedance-2-0-260128", "2.5": "dreamina-seedance-2-5-260628" } as const;
const args = Bun.argv.slice(2);
const flag = args[0] === "--model" ? (args.splice(0, 2)[1] ?? "") : "2.0";
if (!(flag in MODELS)) throw new Error(`--model must be one of ${Object.keys(MODELS).join(", ")}`);
const MODEL = MODELS[flag as keyof typeof MODELS];
const [out, promptFile, seconds, ratio, first, last, ...extra] = args;
if (!out || !promptFile || !seconds || !ratio || !first || extra.length)
  throw new Error("usage: seedance.ts [--model 2.0|2.5] <out.mp4> <prompt.txt> <seconds> <ratio> <first.png> [last.png]");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const prompt = await readFile(promptFile, "utf8");
const files = last ? [first, last] : [first];
const frames = await Promise.all(files.map((file) => readFile(file)));
const mime = (bytes: Uint8Array) => (bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png");
const body = {
  provider: "byteplus-direct",
  model: MODEL,
  prompt: prompt.trim(),
  aspect_ratio: ratio,
  duration: Number(seconds),
  audio: false,
  resolution: "1080p",
  key_frames: frames.map((bytes) => `data:${mime(bytes)};base64,${bytes.toString("base64")}`),
};

const dir = await mkdtemp(join(tmpdir(), "seedance-"));
try {
  const file = join(dir, "body.json");
  await writeFile(file, JSON.stringify(body));
  const run = Bun.spawnSync(
    ["bash", `${process.env.HOME}/Desktop/seed-media.sh`, "--type", "video", "--body-file", file, "--download", out, "--max-checks", "360"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const text = run.stdout.toString() + run.stderr.toString();
  const task = text.match(/task_id=(\S+)/)?.[1];
  console.log(text.split("\n").filter((line) => /task_id|status=(?!.*progress=unknown)|downloaded|Error/.test(line)).slice(-4).join("\n"));
  if (run.exitCode !== 0 || !task) process.exit(run.exitCode || 1);
  await writeFile(
    `${out}.json`,
    `${JSON.stringify(
      {
        task,
        model: MODEL,
        resolution: body.resolution,
        ratio,
        seconds: body.duration,
        prompt: { file: promptFile, sha256: sha256(new TextEncoder().encode(prompt)) },
        first: { file: first, sha256: sha256(frames[0]!) },
        ...(last ? { last: { file: last, sha256: sha256(frames[1]!) } } : {}),
        sha256: sha256(await readFile(out)),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
