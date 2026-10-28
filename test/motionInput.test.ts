import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function run(command: string[], env = process.env) {
  const result = Bun.spawnSync(command, { env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(referenceSize = 32) {
  const root = mkdtempSync(join(tmpdir(), "mochi-motion-input-test-"));
  directories.push(root);
  for (const name of ["script", "motion", "bin"]) mkdirSync(join(root, name));
  const script = join(root, "script/mochi_motion_pipeline.sh");
  cpSync(join(repository, "script/mochi_motion_pipeline.sh"), script);
  const anchor = join(root, "anchor.png");
  run(["magick", "-size", `${referenceSize}x${referenceSize}`, "xc:none", "-fill", "#cc8866", "-draw", "rectangle 8,8 23,23", anchor]);
  const manifest = JSON.parse(readFileSync(join(repository, "motion/manifest.json"), "utf8"));
  manifest.characters[0].generation.anchorSha256 = createHash("sha256").update(readFileSync(anchor)).digest("hex");
  const runtimeRoot = join(root, "root.png");
  run(["magick", "-size", "512x512", "xc:none", "-fill", "#779944", "-draw", "rectangle 4,6 26,27", runtimeRoot]);
  const rootAsset = manifest.characters[0].assets.find((asset: { id: string }) => asset.id === manifest.characters[0].rootAsset);
  rootAsset.source = "root.png";
  rootAsset.sha256 = createHash("sha256").update(readFileSync(runtimeRoot)).digest("hex");
  manifest.sequences.push({
    id: "test-input", character: "mochi", asset: "TestInput", kind: "loop",
    prompt: "motion/prompt.txt", acceptance: "candidate", generation: { inputBackground: "chroma" },
  });
  writeFileSync(join(root, "motion/manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "motion/prompt.txt"), "Keep the source character intact.\n");
  const curl = join(root, "bin/curl");
  writeFileSync(curl, '#!/bin/bash\nset -euo pipefail\ncp "$MOCHI_TEST_ANCHOR" "${@: -1}"\n');
  chmodSync(curl, 0o700);
  const cli = join(root, "bin/video-cli");
  writeFileSync(cli, '#!/bin/bash\nset -euo pipefail\n[[ "$1" == "--body-file" && "$3" == "--download" ]]\ncp "$2" "$MOCHI_TEST_PAYLOAD"\n');
  chmodSync(cli, 0o700);
  const payload = join(root, "request.json");
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, MOCHI_TEST_ANCHOR: anchor, MOCHI_TEST_PAYLOAD: payload, SEEDANCE_VIDEO_CLI: cli,
    // The maintainer's private asset hosts; the curl stub serves every URL.
    MOCHI_MOTION_OUTPUT_BASE: "https://example.test/outputs", MOCHI_MOTION_ANCHOR_BASE: "https://example.test/anchors" };
  const configure = (generation: Record<string, unknown>) => {
    manifest.sequences.find((sequence: { id: string }) => sequence.id === "test-input").generation = generation;
    writeFileSync(join(root, "motion/manifest.json"), JSON.stringify(manifest));
  };
  const event = () => {
    const sequence = manifest.sequences.find((s: { id: string }) => s.id === "test-input");
    Object.assign(sequence, { kind: "event", stage: { size: 768, start: { x: 128, y: 256 }, end: { x: 128, y: 16 } } });
    configure({ anchor: "root", inputBackground: "chroma" });
  };
  return { root, script, anchor, runtimeRoot, env, payload, configure, event };
}

describe("canonical video input", () => {
  test("sustained activity retains exact provider endpoints and original source duration", () => {
    const f = fixture();
    f.configure({ anchor: "root", inputBackground: "chroma", conditioning: "endpoints" });
    const path=join(f.root,"motion/manifest.json");
    const manifest=JSON.parse(readFileSync(path,"utf8"));
    Object.assign(manifest.sequences.find((s: {id:string})=>s.id==='test-input'),{kind:'sustained',sourceFrames:{start:2,end:35},cycle:{start:8,end:25}});
    writeFileSync(path,JSON.stringify(manifest));
    run([f.script,'generate','test-input',join(f.root,'source.mp4')],f.env);
    const request=JSON.parse(readFileSync(f.payload,'utf8'));
    expect(request.duration).toBe(4);
    expect(request.key_frames).toHaveLength(2);
    expect(request.key_frames[0]).toBe(request.key_frames[1]);
    expect(request.image_url).toBeUndefined();
  });
  test.each([
    {kind:'sustained'},
    {kind:'sustained',cycle:{start:0,end:20}},
    {kind:'sustained',cycle:{start:8,end:39}},
    {kind:'loop',cycle:{start:8,end:20}},
    {sourceFrames:null},
    {sourceFrames:{start:2,end:40}},
    {sourceFrames:{start:5,end:4}},
  ])('pipeline rejects invalid source/cycle ownership: %j',patch=>{
    const f=fixture();
    const path=join(f.root,'motion/manifest.json');
    const manifest=JSON.parse(readFileSync(path,'utf8'));
    Object.assign(manifest.sequences.find((s:{id:string})=>s.id==='test-input'),patch);
    writeFileSync(path,JSON.stringify(manifest));
    expect(()=>run([f.script,'validate'],f.env)).toThrow('motion manifest violates');
  });
  test("an explicitly endpoint-conditioned loop sends the same exact root at both ends", () => {
    const f = fixture();
    f.configure({ anchor: "root", inputBackground: "chroma", conditioning: "endpoints" });
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    const input = join(f.root, "prepared.png");
    run([f.script, "prepare-sequence-input", "test-input", input], f.env);
    expect(request.key_frames).toHaveLength(2);
    expect(request.key_frames[0]).toBe(request.key_frames[1]);
    expect(Buffer.from(request.key_frames[0].split(",")[1], "base64").equals(readFileSync(input))).toBeTrue();
    expect(request.image_url).toBeUndefined();
  });
  test("an acting guide cannot escape through a symlinked reference directory", () => {
    const f = fixture(768);
    f.event();
    mkdirSync(join(f.root, "guide"));
    cpSync(f.anchor, join(f.root, "guide/body.png"));
    symlinkSync(join(f.root, "guide"), join(f.root, "motion/references"));
    f.configure({ anchor: "root", actingReference: { source: "motion/references/body.png", sha256: createHash("sha256").update(readFileSync(f.anchor)).digest("hex") } });
    expect(() => run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env)).toThrow("acting reference directory must not be a symlink");
    expect(() => readFileSync(f.payload)).toThrow();
  });
  test("the pipeline rejects falsy or incomplete entrance bindings instead of treating them as absent", () => {
    const f = fixture();
    const path = join(f.root, "motion/manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const entrance of [null, false, 0, "", {}, []]) {
      manifest.characters[0].entrance = entrance;
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => run([f.script, "validate"], f.env)).toThrow();
    }
  });
  test("an acting guide is hash-pinned and cannot replace either canonical placement", () => {
    const f = fixture(768);
    f.event();
    mkdirSync(join(f.root, "motion/references"));
    cpSync(f.anchor, join(f.root, "motion/references/body.png"));
    const actingReference = { source: "motion/references/body.png", sha256: createHash("sha256").update(readFileSync(f.anchor)).digest("hex") };
    f.configure({ anchor: "root", inputBackground: "chroma", actingReference });
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    expect(request.key_frames).toBeUndefined();
    expect(request.image_url).toBeUndefined();
    expect(request.video_urls).toBeUndefined();
    expect(request.image_urls).toHaveLength(3);
    for (const [index, point] of ["start", "end"].entries()) {
      const input = join(f.root, `${point}.png`);
      run([f.script, "prepare-sequence-input", "test-input", input, point!], f.env);
      expect(Buffer.from(request.image_urls[index].split(",")[1], "base64").equals(readFileSync(input))).toBeTrue();
    }
    expect(Buffer.from(request.image_urls[2].split(",")[1], "base64").equals(readFileSync(f.anchor))).toBeTrue();
    f.configure({ anchor: "root", actingReference: { ...actingReference, sha256: "0".repeat(64) } });
    expect(() => run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env)).toThrow("acting reference hash mismatch");
    f.configure({ anchor: "root", conditioning: "first-frame", actingReference });
    expect(() => run([f.script, "validate"], f.env)).toThrow("motion manifest violates");
  });
  test("first-frame event conditioning sends the verified padded input without claiming a provider-controlled landing", () => {
    const f = fixture(768);
    f.event();
    f.configure({ anchor: "reference", inputBackground: "chroma", conditioning: "first-frame" });
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    const input = join(f.root, "single-input.png");
    run([f.script, "prepare-sequence-input", "test-input", input], f.env);
    expect(Buffer.from(request.image_url.split(",")[1], "base64").equals(readFileSync(input))).toBeTrue();
    expect(request.key_frames).toBeUndefined();
    expect(request.image_urls).toBeUndefined();
    expect(request.video_urls).toBeUndefined();
  });
  test("a sustained acting guide retains both roots in reference mode without changing source timing", () => {
    const f = fixture();
    mkdirSync(join(f.root, "motion/references"));
    cpSync(f.anchor, join(f.root, "motion/references/focused.png"));
    f.configure({ anchor: "root", inputBackground: "chroma", conditioning: "endpoints", actingReference: {
      source: "motion/references/focused.png", sha256: createHash("sha256").update(readFileSync(f.anchor)).digest("hex"),
    } });
    const path = join(f.root, "motion/manifest.json");
    const document = JSON.parse(readFileSync(path, "utf8"));
    const sequence = document.sequences.find((s: { id: string }) => s.id === "test-input");
    Object.assign(sequence, { kind: "sustained", cycle: { start: 8, end: 25 } });
    writeFileSync(path, JSON.stringify(document));
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    const prepared = join(f.root, "prepared.png");
    run([f.script, "prepare-sequence-input", "test-input", prepared], f.env);
    expect(request.duration).toBe(4);
    expect(request.key_frames).toBeUndefined();
    expect(request.image_url).toBeUndefined();
    expect(request.image_urls).toHaveLength(3);
    expect(request.image_urls[0]).toBe(request.image_urls[1]);
    expect(Buffer.from(request.image_urls[0].split(",")[1], "base64").equals(readFileSync(prepared))).toBeTrue();
    expect(Buffer.from(request.image_urls[2].split(",")[1], "base64").equals(readFileSync(f.anchor))).toBeTrue();
    delete sequence.generation.conditioning;
    writeFileSync(path, JSON.stringify(document));
    expect(() => run([f.script, "validate"], f.env)).toThrow("motion manifest violates");
  });
  test("failed rerenders cannot leave an older encoded asset looking accepted", () => {
    const f = fixture();
    const staging = join(f.root, "review");
    mkdirSync(staging);
    const existing = join(staging, "TestInput.webp");
    writeFileSync(existing, "previous encoded candidate");
    expect(() => run([f.script, "render", "test-input", f.anchor, staging], f.env))
      .toThrow("staging already contains an encoded asset");
    expect(readFileSync(existing, "utf8")).toBe("previous encoded candidate");
  });

  test("motion reference mode verifies its source and never mixes references with strict keyframes", () => {
    const f = fixture(768);
    f.event();
    const motionReference = { url: "https://example.test/motion.mp4", sha256: createHash("sha256").update(readFileSync(f.anchor)).digest("hex") };
    f.configure({ anchor: "reference", inputBackground: "chroma", motionReference });
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    expect(request.key_frames).toBeUndefined();
    expect(request.image_url).toBeUndefined();
    expect(request.video_urls).toEqual([motionReference.url]);
    expect(request.image_urls).toHaveLength(2);
    for (const [index, point] of ["start", "end"].entries()) {
      const input = join(f.root, `${point}-reference.png`);
      run([f.script, "prepare-sequence-input", "test-input", input, point!], f.env);
      expect(Buffer.from(request.image_urls[index].split(",")[1], "base64").equals(readFileSync(input))).toBeTrue();
    }
  });

  test("changed motion reference fails before provider submission", () => {
    const f = fixture(768);
    f.event();
    f.configure({ anchor: "reference", motionReference: { url: "https://example.test/motion.mp4", sha256: "0".repeat(64) } });
    expect(() => run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env)).toThrow("motion reference hash mismatch");
    expect(() => readFileSync(f.payload)).toThrow();
  });
  test("asset references resolve against the maintainer's asset hosts and fail closed without them", () => {
    const f = fixture(768);
    f.event();
    const sha256 = createHash("sha256").update(readFileSync(f.anchor)).digest("hex");
    f.configure({ anchor: "reference", inputBackground: "chroma", motionReference: { url: "asset://outputs/motion.mp4", sha256 } });
    const { MOCHI_MOTION_OUTPUT_BASE: _output, MOCHI_MOTION_ANCHOR_BASE: _anchor, ...unconfigured } = f.env;
    expect(() => run([f.script, "generate", "test-input", join(f.root, "source.mp4")], unconfigured)).toThrow("MOCHI_MOTION_OUTPUT_BASE");
    expect(() => readFileSync(f.payload)).toThrow();
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    expect(JSON.parse(readFileSync(f.payload, "utf8")).video_urls).toEqual(["https://example.test/outputs/motion.mp4"]);
  });
  test("one-shot keyframes are two lossless placements of the SAME root, never generated terminal art", () => {
    const f = fixture();
    f.event();
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    expect(request.image_url).toBeUndefined();
    expect(request.image_urls).toBeUndefined();
    expect(request.key_frames).toHaveLength(2);
    for (const [index, endpoint, y] of [[0, "start", 256], [1, "end", 16]] as const) {
      const expected = join(f.root, `${endpoint}.png`);
      run([f.script, "prepare-sequence-input", "test-input", expected, endpoint], f.env);
      expect(Buffer.from(request.key_frames[index].split(",")[1], "base64").equals(readFileSync(expected))).toBeTrue();
      expect(run(["magick", expected, "-format", "%wx%h", "info:"])).toBe("768x768");
      const crop = join(f.root, `${endpoint}-crop.png`);
      run(["magick", expected, "-crop", `512x512+128+${y}`, "+repage", crop]);
      const opaqueRoot = join(f.root, "opaque-root.png");
      run(["magick", f.runtimeRoot, "-background", "#0878CA", "-alpha", "remove", "-alpha", "off", opaqueRoot]);
      expect(run(["magick", "compare", "-metric", "AE", opaqueRoot, crop, "null:"])).toBe("");
    }
  });
  test("pinned reference keyframes preserve native pixels and stage density, not runtime endpoint ownership", () => {
    const f = fixture(768);
    f.event();
    f.configure({ anchor: "reference", inputBackground: "chroma" });
    run([f.script, "validate"], f.env);
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    for (const [index, y] of [[0, 384], [1, 24]] as const) {
      const input = join(f.root, `reference-${index}.png`);
      writeFileSync(input, Buffer.from(request.key_frames[index].split(",")[1], "base64"));
      expect(run(["magick", input, "-format", "%wx%h", "info:"])).toBe("1152x1152");
      const crop = join(f.root, "reference-crop.png");
      run(["magick", input, "-crop", `768x768+192+${y}`, "+repage", crop]);
      const expected = join(f.root, "opaque-reference.png");
      run(["magick", f.anchor, "-background", "#0878CA", "-alpha", "remove", "-alpha", "off", expected]);
      expect(run(["magick", "compare", "-metric", "AE", expected, crop, "null:"])).toBe("");
    }
  });
  test("opaque chroma is deterministic, exactly blue, and preserves opaque foreground pixels", () => {
    const f = fixture();
    const first = join(f.root, "first.png"), second = join(f.root, "second.png");
    run([f.script, "prepare-sequence-input", "test-input", first], f.env);
    run([f.script, "prepare-sequence-input", "test-input", second], f.env);
    expect(readFileSync(first).equals(readFileSync(second))).toBeTrue();
    expect(run(["magick", first, "-format", "%[pixel:p{0,0}] %[opaque]", "info:"])).toBe("srgb(8,120,202) True");
    expect(run(["magick", first, "-format", "%[pixel:p{16,16}]", "info:"])).toBe("srgb(204,136,102)");
    const legacy = join(f.root, "legacy.png");
    f.configure({ anchor: "reference", inputBackground: "transparent" });
    run([f.script, "prepare-sequence-input", "test-input", legacy], f.env);
    expect(readFileSync(legacy).equals(readFileSync(f.anchor))).toBeTrue();
  });

  test("a reference density requiring fractional coordinates fails before provider submission", () => {
    const f = fixture(767);
    f.event();
    f.configure({ anchor: "reference", inputBackground: "chroma" });
    expect(() => run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env)).toThrow("fractional generation stage placement");
    expect(() => readFileSync(f.payload)).toThrow();
  });

  test("transparent event references submit the padded pixels at both endpoints, not the unpadded reference URL", () => {
    const f = fixture(768);
    f.event();
    f.configure({ anchor: "reference", inputBackground: "transparent" });
    run([f.script, "validate"], f.env);
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    for (const [index, point] of ["start", "end"].entries()) {
      const input = join(f.root, `${point}-transparent.png`);
      run([f.script, "prepare-sequence-input", "test-input", input, point!], f.env);
      expect(request.key_frames[index].startsWith("data:image/png;base64,")).toBeTrue();
      expect(Buffer.from(request.key_frames[index].split(",")[1], "base64").equals(readFileSync(input))).toBeTrue();
      expect(run(["magick", input, "-format", "%wx%h %[opaque]", "info:"])).toBe("1152x1152 False");
    }
  });

  test("the exact prepared image and production contract reach the CLI without network access", () => {
    const f = fixture();
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    expect(request).toMatchObject({ provider: "byteplus-direct", model: "dreamina-seedance-2-0-fast-260128", duration: 4, aspect_ratio: "1:1", resolution: "720p", audio: false, use_character_assets: true, prompt: "Keep the source character intact.\n" });
    expect(request.image_url.startsWith("data:image/png;base64,")).toBeTrue();
    const expected = join(f.root, "expected.png");
    run([f.script, "prepare-sequence-input", "test-input", expected], f.env);
    expect(Buffer.from(request.image_url.split(",")[1], "base64").equals(readFileSync(expected))).toBeTrue();
    expect(request.image_urls).toBeUndefined();
    expect(request.key_frames).toBeUndefined();
  });

  test.each([
    ["transparent", "dreamina-seedance-2-0-260128"],
    ["chroma", "dreamina-seedance-2-0-260128"],
    ["chroma", "dreamina-seedance-2-5-260628"],
  ])("runtime root is the actual first frame for %s input with %s, never the reference URL", (inputBackground, model) => {
    const f = fixture();
    f.configure({ anchor: "root", inputBackground, model, resolution: "1080p" });
    run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env);
    const request = JSON.parse(readFileSync(f.payload, "utf8"));
    expect(request).toMatchObject({ model, resolution: "1080p" });
    const expected = join(f.root, "expected.png");
    run([f.script, "prepare-sequence-input", "test-input", expected], f.env);
    const firstFrame = Buffer.from(request.image_url.split(",")[1], "base64");
    expect(firstFrame.equals(readFileSync(expected))).toBeTrue();
    if (inputBackground === "transparent") expect(firstFrame.equals(readFileSync(f.runtimeRoot))).toBeTrue();
    expect(firstFrame.equals(readFileSync(f.anchor))).toBeFalse();
  });

  test("a changed runtime root fails before generation", () => {
    const f = fixture();
    f.configure({ anchor: "root" });
    cpSync(f.anchor, f.runtimeRoot);
    expect(() => run([f.script, "generate", "test-input", join(f.root, "source.mp4")], f.env)).toThrow("canonical root hash mismatch");
  });

  test.each([
    { anchor: "new-cat" }, { inputBackground: "white" }, { model: "latest" },
    { resolution: "1080p" }, { reference_images: [] },
    { motionReference: { url: "https://example.test/m.mp4", sha256: "0".repeat(64) } },
  ])("generation rejects unsupported contracts: %j", (generation) => {
    const f = fixture();
    f.configure(generation);
    expect(() => run([f.script, "validate"], f.env)).toThrow("motion manifest violates");
  });
});
