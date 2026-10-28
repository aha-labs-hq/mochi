/**
 * The film's sounds, synthesised: the office at night and by day, a felt
 * keyboard, a message sent and arriving, the clock, Jules's paper slips, a
 * marker on Riley's whiteboard, a finger on a felt shoulder, felt shoes
 * leaving, Mochi's rustle and soft landing, and the chime that wakes it.
 *
 *   bun tools/foley.ts → public/audio/sfx/<name>.wav (48 kHz stereo)
 *
 * This file owns how each sound sounds and its level against the score
 * (the score peaks at -4 dBFS); the cuts own where each one plays, and tools/master.sh
 * brings the finished mix to delivery loudness. Every sound is seeded,
 * so a rerun writes the same bytes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const RATE = 48_000;
const root = resolve(import.meta.dir, "..");
const out = join(root, "public/audio/sfx");

type Sound = { left: Float32Array; right: Float32Array };
const sound = (seconds: number): Sound => {
  const length = Math.round(seconds * RATE);
  return { left: new Float32Array(length), right: new Float32Array(length) };
};

/** mulberry32: a small seeded generator in [0, 1). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An RBJ biquad, one sample at a time. */
function biquad(kind: "lowpass" | "highpass" | "bandpass", freq: number, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * freq) / RATE;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const [b0, b1, b2] =
    kind === "lowpass"
      ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
      : kind === "highpass"
        ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
        : [alpha, 0, -alpha];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x: number) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** A state-variable band-pass (Zavalishin's TPT form) whose centre may glide sample by sample. */
function glidingBand(q: number) {
  let ic1 = 0;
  let ic2 = 0;
  return (x: number, freq: number) => {
    const g = Math.tan((Math.PI * freq) / RATE);
    const a1 = 1 / (1 + g * (g + 1 / q));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    return v1;
  };
}

/** Pink noise (Paul Kellet's refined filter) from a white source. */
function pink(white: () => number) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = white() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return y * 0.11;
  };
}

/** Brown noise: white, integrated with a leak. */
function brown(white: () => number) {
  let y = 0;
  return () => {
    y = 0.996 * y + (white() * 2 - 1) * 0.05;
    return y;
  };
}

const decay = (t: number, tau: number) => (t < 0 ? 0 : Math.exp(-t / tau));
const db = (value: number) => 10 ** (value / 20);

/** Adds a mono event into a sound at `at` seconds, panned (-1 left … 1 right). */
function place(target: Sound, at: number, pan: number, length: number, sample: (t: number) => number) {
  const start = Math.round(at * RATE);
  const l = Math.cos(((pan + 1) * Math.PI) / 4);
  const r = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < Math.round(length * RATE); i++) {
    const n = start + i;
    if (n >= target.left.length) break;
    const value = sample(i / RATE);
    target.left[n]! += value * l;
    target.right[n]! += value * r;
  }
}

/** Scales a sound so its peak or its RMS sits at the given level. */
function level(target: Sound, dbfs: number, by: "peak" | "rms") {
  let peak = 0;
  let sum = 0;
  for (const channel of [target.left, target.right])
    for (const value of channel) {
      peak = Math.max(peak, Math.abs(value));
      sum += value * value;
    }
  const measured = by === "peak" ? peak : Math.sqrt(sum / (target.left.length * 2));
  const gain = db(dbfs) / measured;
  for (const channel of [target.left, target.right]) for (let i = 0; i < channel.length; i++) channel[i]! *= gain;
  return target;
}

/** Fades the ends so nothing clicks where a sound starts or stops. */
function edges(target: Sound, fade = 0.02) {
  const n = Math.round(fade * RATE);
  const length = target.left.length;
  for (let i = 0; i < n; i++) {
    const g = i / n;
    for (const channel of [target.left, target.right]) {
      channel[i]! *= g;
      channel[length - 1 - i]! *= g;
    }
  }
  return target;
}

function wav(target: Sound) {
  const length = target.left.length;
  const buffer = Buffer.alloc(44 + length * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + length * 4, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(length * 4, 40);
  const clip = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  for (let i = 0; i < length; i++) {
    buffer.writeInt16LE(clip(target.left[i]!), 44 + i * 4);
    buffer.writeInt16LE(clip(target.right[i]!), 46 + i * 4);
  }
  return buffer;
}

/* ── The rooms ─────────────────────────────────────────────────────────── */

/** The office at night: a low building hum, the air, and the city passing far below. */
function roomNight() {
  const target = sound(30);
  const rand = random(11);
  for (const [channel, seed] of [[target.left, 1], [target.right, 2]] as const) {
    const white = random(seed);
    const hum = brown(white);
    const air = pink(random(seed + 10));
    const low = biquad("lowpass", 220);
    const high = biquad("highpass", 35);
    const airBand = biquad("bandpass", 1600, 0.5);
    for (let i = 0; i < channel.length; i++) channel[i] = high(low(hum())) * 1.0 + airBand(air()) * 0.05;
  }
  // Cars far below: a band of noise that swells and drifts across.
  for (let at = 1.5; at < 28; at += 5 + rand() * 6) {
    const white = random(Math.floor(rand() * 1e9));
    const band = biquad("bandpass", 260 + rand() * 160, 0.8);
    const length = 6 + rand() * 3;
    const from = rand() < 0.5 ? -0.8 : 0.8;
    const start = Math.round(at * RATE);
    for (let i = 0; i < Math.round(length * RATE) && start + i < target.left.length; i++) {
      const t = i / RATE;
      const swell = Math.sin((Math.PI * t) / length) ** 2;
      const pan = from * (1 - (2 * t) / length);
      const value = band(white() * 2 - 1) * swell * 0.5;
      target.left[start + i]! += value * Math.cos(((pan + 1) * Math.PI) / 4);
      target.right[start + i]! += value * Math.sin(((pan + 1) * Math.PI) / 4);
    }
  }
  return edges(level(target, -37, "rms"), 0.5);
}

/** The office by day: brighter air and the city's daytime murmur through the glass. */
function roomDay() {
  const target = sound(16);
  for (const [channel, seed] of [[target.left, 21], [target.right, 22]] as const) {
    const air = pink(random(seed));
    const city = brown(random(seed + 10));
    const airBand = biquad("bandpass", 900, 0.4);
    const cityLow = biquad("lowpass", 320);
    for (let i = 0; i < channel.length; i++) channel[i] = airBand(air()) * 0.5 + cityLow(city()) * 0.8;
  }
  return edges(level(target, -39, "rms"), 0.5);
}

/* ── One-shots ─────────────────────────────────────────────────────────── */

/** Nora types the question on a felt laptop: soft keys, the odd space bar. */
function typing() {
  const target = sound(2.5);
  const rand = random(31);
  let key = 0;
  for (let at = 0.05; at < 2.25; at += 0.065 + rand() * 0.07 + (rand() < 0.1 ? 0.12 : 0)) {
    const space = ++key % 7 === 0;
    const white = random(Math.floor(rand() * 1e9));
    const click = biquad("bandpass", space ? 1700 : 2300 + rand() * 900, 1.2);
    const pitch = space ? 120 : 170 + rand() * 60;
    const strength = 0.6 + rand() * 0.4;
    const pan = -0.1 + rand() * 0.2;
    place(target, at, pan, 0.08, (t) => strength * (click(white() * 2 - 1) * decay(t, 0.004) * 1.4 + Math.sin(2 * Math.PI * pitch * t) * decay(t, space ? 0.02 : 0.012) * 0.5));
    const release = biquad("bandpass", 3400, 1.5);
    place(target, at + 0.06 + rand() * 0.03, pan, 0.03, (t) => strength * 0.3 * release(white() * 2 - 1) * decay(t, 0.003));
  }
  const muffle = [biquad("lowpass", 4200), biquad("lowpass", 4200)] as const;
  for (let i = 0; i < target.left.length; i++) {
    target.left[i] = muffle[0](target.left[i]!);
    target.right[i] = muffle[1](target.right[i]!);
  }
  return edges(level(target, -11, "peak"), 0.01);
}

/** A message leaves: a short breath of air rising into a soft tick. */
function send() {
  const target = sound(0.5);
  const white = random(41);
  const band = glidingBand(2);
  place(target, 0, 0, 0.3, (t) => band(white() * 2 - 1, 700 + 2200 * Math.min(1, t / 0.14)) * Math.min(1, t / 0.03) * decay(t - 0.03, 0.06));
  place(target, 0.15, 0, 0.12, (t) => Math.sin(2 * Math.PI * 1568 * t) * decay(t, 0.025) * 0.35);
  return edges(level(target, -15, "peak"), 0.005);
}

/** The clock's escapement, tick and tock. */
function clock(tock: boolean) {
  const target = sound(0.2);
  const white = random(tock ? 52 : 51);
  const click = biquad("bandpass", tock ? 2600 : 3200, 4);
  const ring = tock ? 1500 : 1850;
  place(target, 0.005, 0, 0.18, (t) => click(white() * 2 - 1) * decay(t, 0.0018) * 2 + Math.sin(2 * Math.PI * ring * t) * decay(t, 0.02) * 0.25);
  return edges(level(target, -12, "peak"), 0.003);
}

/** A message arrives: a small wooden tok, a little lower as it fades. */
function pop() {
  const target = sound(0.4);
  let phase = 0;
  let overtone = 0;
  place(target, 0, 0, 0.4, (t) => {
    const f = 1046.5 * (1 + 0.02 * decay(t, 0.01));
    phase += (2 * Math.PI * f) / RATE;
    overtone += (2 * Math.PI * f * 3.98) / RATE;
    return Math.sin(phase) * decay(t, 0.07) + Math.sin(overtone) * decay(t, 0.015) * 0.25;
  });
  return edges(level(target, -18, "peak"), 0.003);
}

/** A fingertip on a felt shoulder: a muffled tup, with a little wool in it. */
function tap() {
  const target = sound(0.25);
  const white = random(81);
  const low = biquad("lowpass", 520);
  const wool = biquad("bandpass", 1100, 0.9);
  place(target, 0.004, 0, 0.22, (t) => low(white() * 2 - 1) * decay(t, 0.014) * 2 + Math.sin(2 * Math.PI * 150 * t) * decay(t, 0.03) * 0.7 + wool(white() * 2 - 1) * decay(t, 0.02) * 0.3);
  return edges(level(target, -17, "peak"), 0.003);
}

/** One felt shoe on carpet: a soft heel, and the wool of the sole brushing. */
function footfall(target: Sound, at: number, pan: number, strength: number, tone: number, seed: number) {
  const white = random(seed);
  const sole = biquad("lowpass", tone);
  const brush = biquad("bandpass", 1300, 0.8);
  place(target, at, pan, 0.2, (t) => strength * (sole(white() * 2 - 1) * decay(t, 0.03) * 2 + brush(white() * 2 - 1) * decay(t, 0.025) * 0.7));
}

/** Four colleagues in felt shoes walk off to the right, each at their own pace. */
function steps() {
  const target = sound(2.6);
  const rand = random(91);
  for (let walker = 0; walker < 4; walker++) {
    const pace = 0.42 + rand() * 0.12;
    const tone = 260 + rand() * 120;
    for (let at = 0.05 + rand() * 0.3; at < 2.3; at += pace * (0.92 + rand() * 0.16)) {
      const away = at / 2.3;
      footfall(target, at, Math.min(0.95, -0.2 + away * 1.1), (1 - away * 0.7) * (0.6 + rand() * 0.4), tone, Math.floor(rand() * 1e9));
    }
  }
  return edges(level(target, -13, "peak"), 0.05);
}

/** Theo follows them out alone: three steps, at the right of the room. */
function stepsTheo() {
  const target = sound(1.1);
  for (const [i, at] of [0.02, 0.38, 0.73].entries()) footfall(target, at, 0.6 + i * 0.15, 1 - i * 0.25, 300, 101 + i);
  return edges(level(target, -12, "peak"), 0.02);
}

/** Jules digs through the slips: paper crinkling in handfuls, a slip slid free. */
function paper() {
  const target = sound(3.4);
  const rand = random(111);
  for (let handful = 0.05; handful < 3.1; handful += 0.32 + rand() * 0.3) {
    const pan = -0.3 + rand() * 0.3;
    for (let k = 0; k < 6 + rand() * 10; k++) {
      const white = random(Math.floor(rand() * 1e9));
      const crinkle = biquad("bandpass", 2500 + rand() * 4500, 1.4);
      const strength = 0.3 + rand() * 0.7;
      const tau = 0.002 + rand() * 0.003;
      place(target, handful + rand() * 0.22, pan, 0.03, (t) => strength * crinkle(white() * 2 - 1) * decay(t, tau));
    }
    if (rand() < 0.45) {
      const white = random(Math.floor(rand() * 1e9));
      const slide = biquad("bandpass", 1800 + rand() * 1200, 0.7);
      const length = 0.18 + rand() * 0.2;
      place(target, handful + 0.1, pan, length, (t) => slide(white() * 2 - 1) * Math.sin((Math.PI * t) / length) * 0.35);
    }
  }
  return edges(level(target, -22, "peak"), 0.05);
}

/** Riley's plan, drawn again: short marker strokes squeaking on a whiteboard. */
function marker() {
  const target = sound(3.2);
  const rand = random(121);
  for (let at = 0.15; at < 2.9; at += 0.18 + rand() * 0.32) {
    const length = 0.08 + rand() * 0.22;
    const from = 2200 + rand() * 900;
    const to = from * (0.8 + rand() * 0.45);
    const white = random(Math.floor(rand() * 1e9));
    const squeak = glidingBand(9);
    const strength = 0.5 + rand() * 0.5;
    place(target, at, 0.15 + rand() * 0.2, length, (t) => {
      const p = t / length;
      const stick = 0.6 + 0.4 * Math.sin(2 * Math.PI * (55 + 30 * p) * t);
      return strength * squeak(white() * 2 - 1, from + (to - from) * p) * stick * Math.sin(Math.PI * p) ** 0.6;
    });
  }
  return edges(level(target, -24, "peak"), 0.03);
}

/** Felt brushing felt: Mochi rising behind the screen, or pushing off. */
function rustle() {
  const target = sound(1.2);
  const rand = random(61);
  for (let at = 0.02; at < 0.95; at += 0.01 + rand() * 0.03) {
    const white = random(Math.floor(rand() * 1e9));
    const band = biquad("bandpass", 1800 + rand() * 2600, 0.9);
    const shape = Math.sin((Math.PI * at) / 1.0) ** 1.5;
    const strength = shape * (0.3 + rand() * 0.7);
    const tau = 0.008 + rand() * 0.01;
    place(target, at, -0.2 + rand() * 0.4, 0.05, (t) => band(white() * 2 - 1) * decay(t, tau) * strength);
  }
  return edges(level(target, -18, "peak"), 0.01);
}

/** Mochi lands: a soft felt thump with a breath of fabric. */
function land() {
  const target = sound(0.5);
  const white = random(71);
  const low = biquad("lowpass", 380);
  const fabric = biquad("bandpass", 1400, 0.8);
  place(target, 0.005, 0, 0.45, (t) => low(white() * 2 - 1) * decay(t, 0.03) * 2.2 + Math.sin(2 * Math.PI * 82 * t) * decay(t, 0.05) * 0.8 + fabric(white() * 2 - 1) * decay(t, 0.05) * 0.25);
  return edges(level(target, -15, "peak"), 0.003);
}

/**
 * The chime as the screen lights: two bell notes, C6 then F6, both tones of
 * the D minor seventh the score is playing at that moment in either cut.
 */
function chime() {
  // Long enough that the bells have decayed 40 dB before the file ends.
  const target = sound(4.2);
  for (const [at, f, pan] of [[0, 1046.5, -0.15], [0.14, 1396.9, 0.15]] as const) {
    let carrier = 0;
    let modulator = 0;
    place(target, at, pan, 4, (t) => {
      modulator += (2 * Math.PI * f * 1.4) / RATE;
      const index = 1.8 * decay(t, 0.18);
      carrier += (2 * Math.PI * f) / RATE;
      const attack = Math.min(1, t / 0.003);
      return Math.sin(carrier + index * Math.sin(modulator)) * attack * decay(t, 0.85);
    });
  }
  return edges(level(target, -11, "peak"), 0.005);
}

const sounds: Record<string, () => Sound> = {
  "room-night": roomNight,
  "room-day": roomDay,
  typing,
  send,
  tick: () => clock(false),
  tock: () => clock(true),
  pop,
  paper,
  marker,
  tap,
  steps,
  "steps-theo": stepsTheo,
  rustle,
  land,
  chime,
};

await mkdir(out, { recursive: true });
for (const [name, make] of Object.entries(sounds)) {
  const made = make();
  await writeFile(join(out, `${name}.wav`), wav(made));
  console.log(`${name}: ${(made.left.length / RATE).toFixed(2)} s`);
}
