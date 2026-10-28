import { expect, test } from "bun:test";
import { DesktopPresentation } from "../src/host/presentation.ts";
import { parseSettingsIntent } from "../src/shared/experience.ts";
import {
  EXPERIENCE_SCENES,
  experienceSceneIds,
  parseExperiencePreviewCommand,
  previewDestination,
} from "../src/shared/experiencePreview.ts";
import {
  type DesktopFrame,
  initialSnapshot,
  SETTINGS_INTENTS,
} from "../src/shared/model.ts";
import { planWindow } from "../src/shared/windowHandoff.ts";
import { experienceSample } from "../src/ui/experiencePreview.ts";
import { setupPresentation } from "../src/ui/setupPresentation.ts";

test("settings requests only accept the closed product sheet catalogue", () => {
  for (const sheet of [...SETTINGS_INTENTS, "settings", "diagnostics"])
    expect(sheet).toBe(parseSettingsIntent(sheet));
  for (const input of [null, "__proto__", "unknown", { sheet: "settings" }])
    expect(() => parseSettingsIntent(input)).toThrow();
});

test("preview inputs are closed and sample scenes all use existing product presenters", () => {
  for (const scene of experienceSceneIds) {
    expect(parseExperiencePreviewCommand(scene)).toBe(scene);
    const sample = experienceSample(scene);
    expect(sample.feishuVerificationQr).toBeNull();
    if (EXPERIENCE_SCENES[scene].surface === "setup")
      expect(setupPresentation(sample).title.length).toBeGreaterThan(0);
  }
  for (const input of [
    "unknown",
    { scene: "signIn" },
    "https://example.com",
    null,
  ])
    expect(() => parseExperiencePreviewCommand(input)).toThrow();
  expect(previewDestination("previous", "encounter")).toBe("encounter");
  expect(previewDestination("next", "companion")).toBe("companion");
});

test("every scene can be replayed from unavailable, incomplete or complete real setup without changing facts or progress", async () => {
  for (const setup of [null, "signIn", "ready", "initializing"] as const) {
    const snapshot = { ...initialSnapshot("real", true), setup };
    const original = structuredClone(snapshot);
    let meetings = 0;
    const presentation = new DesktopPresentation(() => snapshot, {
      hasMet: false,
      rememberMeeting() {
        meetings++;
      },
    });
    const frames: DesktopFrame[] = [];
    presentation.attach((frame) => frames.push(frame)).ready();
    const origin = presentation.surface;
    for (const scene of experienceSceneIds) {
      await presentation.previewExperience(scene);
      const nonce = frames.at(-1)!.experiencePreview!.nonce;
      await presentation.observe();
      expect(presentation.surface).toBe(EXPERIENCE_SCENES[scene].surface);
      expect(frames.at(-1)!.snapshot).toBe(snapshot);
      await presentation.previewExperience("replay");
      expect(frames.at(-1)!.experiencePreview!.nonce).not.toBe(nonce);
    }
    await presentation.present("beginSetup");
    expect(meetings).toBe(0);
    await presentation.present("finishSetup");
    expect(presentation.surface).toBe("companion");
    await presentation.setPreview(null);
    expect(presentation.surface).toBe(origin);
    expect(snapshot).toEqual(original);
    expect(frames.at(-1)!.experiencePreview).toBeUndefined();
    expect(meetings).toBe(0);
  }
});

test("preview survives renderer close and motion switches, retaining one return surface", async () => {
  const snapshot = {
    ...initialSnapshot("real", true),
    setup: "ready" as const,
  };
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: true,
    rememberMeeting() {
      throw new Error("Must not persist preview");
    },
  });
  const renderer = presentation.attach(() => {});
  renderer.ready();
  await presentation.previewExperience("intro");
  renderer.close();
  await presentation.previewExperience("projects");
  const frames: DesktopFrame[] = [];
  presentation.attach((frame) => frames.push(frame)).ready();
  expect(frames.at(-1)!.experiencePreview!.scene).toBe("projects");
  await presentation.setPreview({
    character: "mochi",
    preview: "idle-curious",
    nonce: "motion",
  });
  expect(frames.at(-1)!.experiencePreview).toBeUndefined();
  await presentation.previewExperience("companion");
  expect(frames.at(-1)!.preview).toBeNull();
  await presentation.setPreview(null);
  expect(presentation.surface).toBe("setup");
});

test("native staging and preview both block operational RPC; exiting reopens the live boundary", async () => {
  let calls = 0;
  const snapshot = initialSnapshot("real", true);
  const planned = Promise.withResolvers<void>();
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: true,
    rememberMeeting() {},
    window: {
      plan: async () => {
        await planned.promise;
        return {
          ...planWindow(
            { x: 0, y: 0, width: 520, height: 700 },
            { x: 0, y: 0, width: 960, height: 680 },
          ),
          visible: true,
        };
      },
      place: async () => {},
    },
  });
  presentation
    .attach((frame) => {
      if (frame.handoff)
        queueMicrotask(() => presentation.acknowledge(frame.handoff!));
    })
    .ready();
  const operation = async () => {
    calls++;
    return { ok: true as const, value: null };
  };
  const entry = presentation.previewExperience("signIn");
  expect((await presentation.live(operation)).ok).toBeFalse();
  planned.resolve();
  await entry;
  expect((await presentation.live(operation)).ok).toBeFalse();
  expect(calls).toBe(0);
  await presentation.setPreview(null);
  expect((await presentation.live(operation)).ok).toBeTrue();
  expect(calls).toBe(1);
});

test("real settings leave preview explicitly and cannot retain fake provider facts", async () => {
  const snapshot = initialSnapshot("real", true);
  const presentation = new DesktopPresentation(() => snapshot);
  const frames: DesktopFrame[] = [];
  presentation.attach((frame) => frames.push(frame)).ready();
  await presentation.previewExperience("projects");
  await presentation.prepareSettings();
  expect(frames.at(-1)).toEqual({
    snapshot,
    preview: null,
    surface: "companion",
  });
});

test("a recreated renderer owns every paint receipt when exiting preview", async () => {
  const snapshot = initialSnapshot("real", true);
  const frames: DesktopFrame[] = [];
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: true,
    rememberMeeting() {},
    window: {
      plan: async () => ({
        ...planWindow(
          { x: 0, y: 0, width: 520, height: 700 },
          { x: 0, y: 0, width: 960, height: 680 },
        ),
        visible: true,
      }),
      place: async () => {},
    },
  });
  const send = (frame: DesktopFrame) => {
    frames.push(frame);
    if (frame.handoff)
      queueMicrotask(() => presentation.acknowledge(frame.handoff!));
  };
  const first = presentation.attach(send);
  first.ready();
  await presentation.previewExperience("feishuScan");
  first.close();
  frames.length = 0;
  const replacement = presentation.attach(send);
  first.ready();
  expect(frames).toHaveLength(0);
  replacement.ready();
  await presentation.setPreview(null);
  expect(
    frames.filter((frame) => frame.handoff).map((frame) => frame.handoff!.step),
  ).toEqual(["stage", "animate", "land"]);
  expect(frames.at(-1)).toEqual({
    snapshot,
    preview: null,
    surface: "companion",
  });
});
