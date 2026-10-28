// Renders review stills of the film at the given seconds, from one bundle,
// in the original Chinese or in another of script.ts's languages.
//   node tools/stills.mjs Film 4 11 16.5 ...            → out/review/<id>-<seconds>.png
//   node tools/stills.mjs Film --language=en 4 11 ...   → out/review/<id>-en-<seconds>.png
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const language = args.find((a) => a.startsWith("--language="))?.slice("--language=".length);
const [id, ...seconds] = args.filter((a) => !a.startsWith("--"));
const root = path.resolve(import.meta.dirname, "..");
const serveUrl = await bundle({ entryPoint: path.join(root, "src/index.ts"), publicDir: path.join(root, "public") });
const inputProps = language ? { language } : {};
const composition = await selectComposition({ serveUrl, id, inputProps });
await mkdir(path.join(root, "out/review"), { recursive: true });
for (const second of seconds) {
  const frame = Math.round(Number(second) * composition.fps);
  const output = path.join(root, `out/review/${id}${language ? `-${language}` : ""}-${String(second).padStart(5, "0")}.png`);
  await renderStill({ serveUrl, composition, frame, output, inputProps });
  console.log(`${second}s → ${path.relative(root, output)}`);
}
