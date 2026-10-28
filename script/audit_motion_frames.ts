import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { sequenceTiming } from "../controlApp/src/motion/timing.ts";

function exteriorDistance(rgba: Uint8Array, width: number, cutoff: number) {
  const count = rgba.length / 4;
  const exterior = new Uint8Array(count),
    queue = new Int32Array(count);
  let read = 0,
    write = 0;
  const visit = (i: number) => {
    if (exterior[i] || rgba[i * 4 + 3]! >= cutoff) return;
    exterior[i] = 1;
    queue[write++] = i;
  };
  const neighbours = (i: number, fn: (n: number) => void) => {
    if (i >= width) fn(i - width);
    if (i < count - width) fn(i + width);
    if (i % width) fn(i - 1);
    if (i % width < width - 1) fn(i + 1);
  };
  for (let i = 0; i < count; i++)
    if (
      i < width ||
      i >= count - width ||
      !(i % width) ||
      i % width === width - 1
    )
      visit(i);
  while (read < write) neighbours(queue[read++]!, visit);
  const distance = new Int32Array(count).fill(-1);
  read = write = 0;
  for (let i = 0; i < count; i++)
    if (exterior[i]) {
      distance[i] = 0;
      queue[write++] = i;
    }
  while (read < write) {
    const i = queue[read++]!;
    neighbours(i, (n) => {
      if (distance[n] !== -1) return;
      distance[n] = distance[i]! + 1;
      queue[write++] = n;
    });
  }
  return distance;
}

/** Flag transparency deep inside a solid silhouette. This is a review signal,
 * not automatic hole filling: an intentional enclosed opening needs review. */
export function interiorTransparency(rgba: Uint8Array, width: number) {
  const count = rgba.length / 4;
  if (!Number.isInteger(count) || width < 2 || count % width)
    throw new Error("Invalid frame geometry");
  const distance = exteriorDistance(rgba, width, 250);
  // Internal transparency and visible exterior colour are distinct questions.
  // Using the near-opaque mask for both mislabels covered prop/body shadows as
  // an external fringe. The visible boundary matches the finishing operation.
  const visibleDistance = exteriorDistance(rgba, width, 26);
  let pixels = 0,
    x0 = width,
    y0 = count / width,
    x1 = 0,
    y1 = 0;
  const depth = Math.max(4, Math.round(width / 64));
  let edgeTintPixels = 0;
  const tintedBounds = [width, count / width, 0, 0];
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    if (
      rgba[offset + 3]! > 20 &&
      visibleDistance[i]! >= 0 &&
      visibleDistance[i]! <= Math.max(2, Math.round((width * 16) / 512)) &&
      rgba[offset + 2]! > rgba[offset]! + 3 &&
      rgba[offset + 2]! > rgba[offset + 1]! - 12
    ) {
      edgeTintPixels++;
      tintedBounds[0] = Math.min(tintedBounds[0]!, i % width);
      tintedBounds[1] = Math.min(tintedBounds[1]!, Math.floor(i / width));
      tintedBounds[2] = Math.max(tintedBounds[2]!, i % width);
      tintedBounds[3] = Math.max(tintedBounds[3]!, Math.floor(i / width));
    }
    if (rgba[i * 4 + 3]! >= 250 || distance[i]! <= depth) continue;
    pixels++;
    const x = i % width,
      y = Math.floor(i / width);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return {
    pixels,
    bounds: pixels ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null,
    edgeTintPixels,
    edgeTintBounds: edgeTintPixels ? tintedBounds : null,
  };
}

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const [exit, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exit) throw new Error(`${args[0]}: ${error}`);
}

if (import.meta.main) {
  const output = resolve(process.argv[2] ?? "controlApp/.build/motion-audit");
  const resources = resolve(process.argv[3] ?? "controlApp/Resources");
  const manifest = JSON.parse(await readFile("motion/manifest.json", "utf8"));
  const selected = process.argv.slice(4);
  for (const id of selected)
    if (
      !manifest.sequences.some((sequence: { id: string }) => sequence.id === id)
    )
      throw new Error(`Unknown sequence: ${id}`);
  await mkdir(output, { recursive: true });
  const sequences = [];
  for (const sequence of manifest.sequences) {
    if (
      selected.length
        ? !selected.includes(sequence.id)
        : !["approved", "approved-reference"].includes(sequence.acceptance)
    )
      continue;
    const directory = join(output, sequence.id);
    await mkdir(directory, { recursive: true });
    const { frameCount, framesPerSecond } = sequenceTiming(
      manifest.production,
      sequence,
    );
    await command([
      "magick",
      join(resources, `${sequence.asset}.webp`),
      "-coalesce",
      join(directory, "%03d.png"),
    ]);
    const frames = [];
    let previous: Buffer | null = null;
    for (let index = 0; index < frameCount; index++) {
      const filename = `${String(index).padStart(3, "0")}.png`;
      const { data, info } = await sharp(join(directory, filename))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let squared = 0,
        visible = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! || previous?.[i + 3]) visible++;
        if (!previous) continue;
        for (let c = 0; c < 4; c++) {
          const a =
            c === 3 ? data[i + c]! : (data[i + c]! * data[i + 3]!) / 255;
          const b =
            c === 3
              ? previous[i + c]!
              : (previous[i + c]! * previous[i + 3]!) / 255;
          squared += (a - b) ** 2;
        }
      }
      frames.push({
        index,
        file: `${sequence.id}/${filename}`,
        ...interiorTransparency(data, info.width),
        previousDistance: previous
          ? Math.sqrt(squared / Math.max(1, visible * 4)) / 255
          : 0,
      });
      previous = data;
    }
    sequences.push({
      id: sequence.id,
      kind: sequence.kind,
      framesPerSecond,
      frames,
    });
    console.log(
      `${sequence.id}: ${frames.length} frames; ${frames.filter((f) => f.pixels).length} interior-transparency flags; ${frames.filter((f) => f.edgeTintPixels).length} edge-colour flags`,
    );
  }
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify(sequences, null, 2)}\n`,
  );
  // An offline review sheet: native pixels, every frame, explicit frame numbers,
  // Neutral app grey plus contrast plates, and forward/reverse source cadence.
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Mochi · 逐帧审片</title>
<style>body{margin:32px;background:#f5f3f0;color:#222;font:14px system-ui}header{position:sticky;top:0;background:#f5f3f0;padding:12px;z-index:2}button,select,input{font:inherit;margin-right:12px}section{margin:32px 0}.grid{display:grid;grid-template-columns:repeat(5,minmax(160px,1fr));gap:8px}figure{margin:0;background:var(--plate,#c03579)}img{display:block;width:100%;height:auto}figcaption{background:#fff;padding:8px}.player{width:512px;max-width:100%;background:var(--plate,#c03579)}.flag{color:#922400}input{width:420px;max-width:70vw}</style>
<header><b>每帧遮罩与衔接审片</b> <select id="plate"><option value="#e6e6e6">界面浅灰：脏边与衔接</option><option value="#c03579">洋红：透明洞</option><option value="#222222">深灰：毛边</option><option value="#0878ca">蓝色：源视频底色</option></select><span>数字为帧号；内部透明标记需要结合原视频判断。</span></header><main></main>
<script>const sequences=${JSON.stringify(sequences)};document.body.style.setProperty('--plate','#e6e6e6');document.querySelector('#plate').onchange=e=>document.body.style.setProperty('--plate',e.target.value);
for(const s of sequences){const section=document.createElement('section');section.innerHTML='<h2>'+s.id+' · '+s.frames.length+' 帧 / '+s.framesPerSecond+' fps</h2><img class="player" src="'+s.frames[0].file+'"><p><button>播放</button><button>倒放</button><input type="range" min="0" max="'+(s.frames.length-1)+'" value="0"><output>0</output></p><div class="grid">'+s.frames.map(f=>'<figure><img loading="lazy" src="'+f.file+'"><figcaption class="'+(f.pixels||f.edgeTintPixels?'flag':'')+'">帧 '+f.index+(f.pixels?' · 内部透明 '+f.pixels+' 像素':'')+(f.edgeTintPixels?' · 色边标记 '+f.edgeTintPixels+' 像素':'')+'</figcaption></figure>').join('')+'</div>';document.querySelector('main').append(section);const image=section.querySelector('.player'),slider=section.querySelector('input'),label=section.querySelector('output');let timer=null;function show(n){slider.value=n;image.src=s.frames[n].file;label.value=n}slider.oninput=()=>{clearInterval(timer);show(+slider.value)};[...section.querySelectorAll('button')].forEach((b,i)=>b.onclick=()=>{clearInterval(timer);let n=i?s.frames.length-1:0;show(n);timer=setInterval(()=>{n+=i?-1:1;if(n<0||n>=s.frames.length){clearInterval(timer);return}show(n)},1000/s.framesPerSecond)})}
</script>`,
  );
  console.log(`Review: ${join(output, "index.html")}`);
}
