/**
 * The film's score: a short piece for upright piano, written against the cut.
 *
 *   bun tools/score.ts   → public/audio/score.wav, score-tall.wav (48 kHz stereo)
 *
 * 60 bpm in 4/4, so every bar is exactly four seconds and each section lands
 * on a cut. In the wide film, bar 1 is 0:36 (back to Nora's desk; Mochi
 * peeks 1.2 s in), bar 4 is 0:48 (the answer), bar 7 is 1:00 (the next day),
 * bar 10 is 1:12 (night again) and bar 12 is 1:20 (the last note, ringing
 * under the end card). The tall cut keeps two bars of each section and the
 * ending; FilmTall.tsx says where it starts.
 *
 * Sound: Upright Piano KW (FreePats), CC0 1.0. vendor/ holds it, not Git.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const libfluidsynth = require("js-synthesizer/libfluidsynth");
const JSSynth = require("js-synthesizer");

const root = resolve(import.meta.dir, "..");
const RATE = 48_000;
const BAR = 4; // seconds
/** Which written bars each rendering plays, in order. */
const cuts: Record<string, number[]> = {
  "score.wav": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  "score-tall.wav": [1, 2, 4, 5, 7, 8, 10, 11, 12],
};

type Note = [bar: number, beat: number, keys: number[], beats: number, velocity: number];

/* Left hand: one broken chord per half or whole bar, eighth notes. */
const chords: [bar: number, beat: number, beats: number, keys: number[], velocity: number][] = [
  [4, 0, 4, [41, 48, 57, 60], 34], // F
  [5, 0, 4, [38, 45, 53, 57], 33], // Dm
  [6, 0, 4, [34, 46, 50, 53], 33], // Bb
  [7, 0, 4, [36, 43, 52, 55], 38], // C — the day begins, fuller
  [8, 0, 4, [33, 45, 53, 57], 40], // F/A
  [9, 0, 2, [31, 43, 53, 58], 38], // Gm7
  [9, 2, 2, [36, 43, 52, 55], 36], // C
  [10, 0, 4, [38, 45, 53, 60], 32], // Dm7 — night again
  [11, 0, 2, [34, 46, 57, 62], 30], // Bbmaj7
  [11, 2, 2, [36, 43, 53, 58], 28], // C7sus
];

/* Right hand, and the few bare notes before the melody arrives. */
const melody: Note[] = [
  [1, 1.2, [84], 2.3, 50], // a single high C as the ears appear
  [2, 0, [81], 2, 44],
  [2, 2, [77], 2, 40],
  [3, 0, [79], 1.5, 42],
  [3, 1.5, [81], 1.5, 46],
  [3, 3, [84], 1, 48],
  [3, 0, [41, 53], 4, 38], // the first low F under them
  [4, 0, [69], 1, 56], // the answer, word by word
  [4, 1, [72], 1, 58],
  [4, 2, [77], 2, 64],
  [5, 0, [76], 1, 60],
  [5, 1, [74], 1, 56],
  [5, 2, [72], 2, 54],
  [6, 0, [74], 1.5, 58],
  [6, 1.5, [72], 0.5, 52],
  [6, 2, [70], 1, 50],
  [6, 3, [69], 1, 48],
  [7, 0, [67, 64], 2, 56],
  [7, 2, [69], 1, 58],
  [7, 3, [72], 1, 62],
  [8, 0, [77, 69], 1.5, 68],
  [8, 1.5, [76], 0.5, 58],
  [8, 2, [74, 65], 1, 62],
  [8, 3, [72, 69], 1, 60],
  [9, 0, [74, 70], 2, 62],
  [9, 2, [70, 67], 1, 56],
  [9, 3, [72, 64], 1, 58],
  [10, 0, [77, 74], 2, 58],
  [10, 2, [76, 72], 1, 52],
  [10, 3, [74, 69], 1, 48],
  [11, 0, [72, 69], 2, 50],
  [11, 2, [72, 65], 1, 44],
  [11, 3, [70, 64], 1, 40],
  [12, 0, [29, 41], 7, 42], // the last note: low F, left to ring
  [12, 0.04, [65, 69, 72], 7, 40], // rolled softly upward
  [12, 0.09, [77], 7, 44],
  [12, 1.5, [84], 5.5, 30], // and the high C from the first bar, once more
];

JSSynth.Synthesizer.initializeWithFluidSynthModule(libfluidsynth);
await JSSynth.waitForReady();
const font = await readFile(
  join(root, "vendor/UprightPianoKW-SF2-20220221/UprightPianoKW-20220221.sf2"),
);

/** Plays the written bars in `bars`, in that order, and writes them to `file`. */
async function render(file: string, bars: number[]) {
  /* A seeded wobble: the same take on every render. */
  let seed = 7;
  const wobble = (range: number) => {
    seed = (seed * 16807) % 2147483647;
    return ((seed / 2147483647) * 2 - 1) * range;
  };

  type Event = { at: number; apply(synth: typeof JSSynth.Synthesizer.prototype): void };
  const events: Event[] = [];
  /** Where a written bar and beat sound in this rendering, or null if the bar is cut. */
  const time = (bar: number, beat: number) => {
    const position = bars.indexOf(bar);
    return position < 0 ? null : position * BAR + beat;
  };
  const play = (at: number, keys: number[], seconds: number, velocity: number) => {
    for (const key of keys) {
      const start = Math.max(0, at + wobble(0.012));
      const loud = Math.max(1, Math.min(127, Math.round(velocity + wobble(4))));
      events.push({ at: start, apply: (s) => s.midiNoteOn(0, key, loud) });
      events.push({ at: start + seconds, apply: (s) => s.midiNoteOff(0, key) });
    }
  };

  for (const [bar, beat, keys, beats, velocity] of melody) {
    const at = time(bar, beat);
    if (at !== null) play(at, keys, beats, velocity);
  }
  for (const [bar, beat, beats, keys, velocity] of chords) {
    const at = time(bar, beat);
    if (at === null) continue;
    const order = [0, 1, 2, 3, 2, 1, 2, 1];
    for (let step = 0; step < beats * 2; step++) {
      const key = keys[order[step % order.length]!]!;
      const accent = step % 4 === 0 ? 6 : 0;
      play(at + step * 0.5, [key], 0.9, velocity + accent);
    }
  }
  /* Legato pedalling: lift just before each change, catch just after. */
  const changes = [
    ...new Set(
      [...chords.map(([bar, beat]) => time(bar, beat)), time(3, 0), time(12, 0)].filter((at): at is number => at !== null),
    ),
  ];
  for (const at of changes) {
    events.push({ at: Math.max(0, at - 0.06), apply: (s) => s.midiControl(0, 64, 0) });
    events.push({ at: at + 0.05, apply: (s) => s.midiControl(0, 64, 127) });
  }
  events.push({ at: 0.02, apply: (s) => s.midiControl(0, 64, 127) });
  events.sort((a, b) => a.at - b.at);

  const synth = new JSSynth.Synthesizer();
  synth.init(RATE);
  const fontId = await synth.loadSFont(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
  synth.midiProgramSelect(0, fontId, 0, 0);
  synth.setGain(0.55);
  synth.setReverb(0.72, 0.38, 0.9, 0.42);
  synth.setReverbOn(true);
  synth.setChorusOn(false);

  // Through the last bar, plus the last chord's ring and the room's decay.
  const frames = Math.ceil(((bars.length + 1) * BAR + 3) * RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const BLOCK = 128;
  let next = 0;
  for (let offset = 0; offset < frames; offset += BLOCK) {
    const now = offset / RATE;
    while (next < events.length && events[next]!.at <= now) events[next++]!.apply(synth);
    const size = Math.min(BLOCK, frames - offset);
    const l = new Float32Array(size);
    const r = new Float32Array(size);
    synth.render([l, r]);
    left.set(l, offset);
    right.set(r, offset);
  }
  synth.close();

  /* Normalise to -4 dBFS peak, the level the foley is set against, and fade the last two seconds to silence. */
  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  const gain = peak > 0 ? 0.63 / peak : 1;
  const fade = 2 * RATE;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + frames * 4, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const tail = Math.min(1, (frames - i) / fade);
    const sample = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value * gain * tail * 32767)));
    wav.writeInt16LE(sample(left[i]!), 44 + i * 4);
    wav.writeInt16LE(sample(right[i]!), 46 + i * 4);
  }
  const out = join(root, "public/audio", file);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, wav);
  console.log(`${file}: ${(frames / RATE).toFixed(1)} s, peak gain ${gain.toFixed(2)}`);
}

for (const [file, bars] of Object.entries(cuts)) await render(file, bars);
