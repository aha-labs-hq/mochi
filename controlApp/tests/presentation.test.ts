import { expect, test } from "bun:test";
import { DesktopPresentation } from "../src/host/presentation.ts";
import { TransitionInterrupted } from "../src/host/windowHandoff.ts";
import type { DesktopSurface } from "../src/shared/experience.ts";
import { type DesktopFrame, initialSnapshot } from "../src/shared/model.ts";
import { planWindow } from "../src/shared/windowHandoff.ts";

test("Settings preserves the companion scene and never advances onboarding", async () => {
  const snapshot = {
    ...initialSnapshot("0.2.0", true),
    setup: "signIn" as const,
  };
  let plans = 0;
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: false,
    rememberMeeting() {
      throw new Error("must not dismiss introduction");
    },
    window: {
      plan: async () => {
        plans++;
        throw new Error("must not resize companion");
      },
      place: async () => {},
    },
  });
  const frames: DesktopFrame[] = [];
  presentation.attach((frame) => frames.push(frame)).ready();
  await presentation.prepareSettings();
  expect(presentation.surface).toBe("encounter");
  expect(plans).toBe(0);
  expect(frames).toHaveLength(1);
});

function previewFixture() {
  const frames: DesktopFrame[] = [],
    plans: DesktopSurface[] = [];
  let meetings = 0;
  const snapshot = {
    ...initialSnapshot("0.2.0", true),
    setup: "signIn" as const,
  };
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: false,
    rememberMeeting() {
      meetings++;
    },
    window: {
      plan: async (surface) => {
        plans.push(surface);
        return {
          ...planWindow(
            { x: 800, y: 20, width: 360, height: 380 },
            { x: 100, y: 100, width: 520, height: 700 },
          ),
          visible: true,
        };
      },
      place: async () => {},
    },
  });
  presentation
    .attach((frame) => {
      frames.push(frame);
      if (frame.handoff)
        queueMicrotask(() => presentation.acknowledge(frame.handoff!));
    })
    .ready();
  return { presentation, frames, plans, meetings: () => meetings };
}

const preview = {
  character: "mochi",
  preview: "idle-curious",
  nonce: "test-1",
};

test("landing and introduction share one native desktop without a spatial handoff", async () => {
  const { presentation, frames, plans, meetings } = previewFixture();
  await presentation.present("meet");
  expect(presentation.surface).toBe("intro");
  await presentation.present("replayIntro");
  expect(presentation.surface).toBe("encounter");
  expect(plans).toEqual([]);
  expect(frames.every((frame) => !frame.handoff)).toBe(true);
  expect(meetings()).toBe(0);
  // Leaving the desktop still uses the existing paint-gated native owner.
  await presentation.present("beginSetup");
  expect(plans).toEqual(["setup"]);
});

test("preview expands the native encounter and restores it without dismissing onboarding", async () => {
  const { presentation, frames, plans, meetings } = previewFixture();
  await presentation.setPreview(preview);
  expect(plans).toEqual(["companion"]);
  expect(
    frames
      .filter((frame) => frame.handoff)
      .map((frame) => ({
        surface: frame.surface,
        preview: frame.preview,
        step: frame.handoff?.step,
      })),
  ).toEqual([
    { surface: "encounter", preview: null, step: "stage" },
    { surface: "companion", preview, step: "animate" },
    { surface: "companion", preview, step: "land" },
  ]);
  await presentation.observe();
  expect(presentation.surface).toBe("companion");
  expect(plans).toHaveLength(1);
  await presentation.setPreview(null);
  expect(plans).toEqual(["companion", "encounter"]);
  expect(frames.at(-1)).toMatchObject({ surface: "encounter", preview: null });
  expect(meetings()).toBe(0);
});

test("rapid preview dismissal waits for entry and restores its original scene", async () => {
  const { presentation, frames, plans } = previewFixture();
  await Promise.all([
    presentation.setPreview(preview),
    presentation.setPreview(null),
  ]);
  expect(plans).toEqual(["companion", "encounter"]);
  expect(frames.at(-1)).toMatchObject({ surface: "encounter", preview: null });
});

test("changing a preview does not resize or lose the return scene", async () => {
  const { presentation, plans, meetings } = previewFixture();
  await presentation.present("meet");
  await presentation.setPreview(preview);
  await presentation.setPreview({ ...preview, nonce: "test-2" });
  expect(plans).toEqual(["companion"]);
  await presentation.setPreview(null);
  expect(presentation.surface).toBe("intro");
  expect(meetings()).toBe(0);
});

test("an explicit setup action supersedes preview without retaining a stale return scene", async () => {
  const { presentation, plans, meetings } = previewFixture();
  const entering = presentation.setPreview(preview);
  const setup = presentation.present("beginSetup");
  await Promise.all([entering, setup]);
  expect(presentation.surface).toBe("setup");
  await presentation.setPreview(null);
  expect(plans).toEqual(["companion", "setup"]);
  expect(presentation.surface).toBe("setup");
  // The explicit setup action, not the temporary preview, dismisses the intro.
  expect(meetings()).toBe(1);
});

test("preview cannot bypass the explicit setup completion gate", async () => {
  const { presentation } = previewFixture();
  const entering = presentation.setPreview(preview);
  const finishing = presentation.present("finishSetup");
  await entering;
  await expect(finishing).rejects.toThrow("Setup is not complete");
  await presentation.setPreview(null);
  expect(presentation.surface).toBe("encounter");
});

test("a closed window or a stale intent interrupts a transition without failing the App", async () => {
  const snapshot = {
    ...initialSnapshot("0.2.0", true),
    setup: "signIn" as const,
  };
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: false,
    rememberMeeting() {},
    window: {
      plan: async () => ({
        ...planWindow(
          { x: 800, y: 20, width: 360, height: 380 },
          { x: 100, y: 100, width: 520, height: 700 },
        ),
        visible: true,
      }),
      place: async () => {},
    },
  });
  // The customer closes the window while setup is being staged.
  const attachment = presentation.attach((frame) => {
    if (frame.handoff) queueMicrotask(() => attachment.close());
  });
  attachment.ready();
  const setup = presentation.present("beginSetup").catch((error) => error);
  // Settings waits for the window to settle, not for the move to succeed.
  await presentation.prepareSettings();
  const closed = await setup;
  expect(closed).toBeInstanceOf(TransitionInterrupted);
  expect(closed.reason).toBe("closed");
  expect(presentation.surface).toBe("encounter");
  // "完成设置" raced a status change that reopened setup.
  const stale = await presentation
    .present("finishSetup")
    .catch((error) => error);
  expect(stale).toBeInstanceOf(TransitionInterrupted);
  expect(stale.reason).toBe("stale");
});

test("opening the DMG goes directly to installation without consuming the first encounter", async () => {
  const snapshot = {
    ...initialSnapshot("0.2.0", false),
    locationReady: false,
    setup: "install" as const,
  };
  let meetings = 0;
  const experience = {
    hasMet: false,
    rememberMeeting: () => {
      meetings++;
    },
  };
  const presentation = new DesktopPresentation(() => snapshot, experience);
  expect(presentation.surface).toBe("setup");
  await expect(presentation.present("replayIntro")).rejects.toThrow(
    "Install Mochi",
  );
  await presentation.present("beginSetup");
  expect(meetings).toBe(0);
  const installed = new DesktopPresentation(
    () => ({ ...snapshot, locationReady: true }),
    experience,
  );
  expect(installed.surface).toBe("encounter");
});

test("completed onboarding stays completed after a Bot loses its account", () => {
  const snapshot = {
    ...initialSnapshot("0.2.0", true),
    setup: "signIn" as const,
  };
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: true,
    hasFinishedSetup: true,
    rememberMeeting() {},
  });
  expect(presentation.surface).toBe("companion");
});

test("an empty new deployment begins with the existing introduction", () => {
  const snapshot = {
    ...initialSnapshot("0.2.0", true),
    setup: "signIn" as const,
    bots: [],
  };
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: false,
    hasFinishedSetup: false,
    rememberMeeting() {},
  });
  expect(presentation.surface).toBe("encounter");
});

test("a confirmed empty roster requires setup even when completion was remembered", async () => {
  const snapshot = {
    ...initialSnapshot("0.3.0", false),
    locationReady: true,
    installed: true,
    loaded: true,
    controlReady: true,
  };
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: true,
    hasFinishedSetup: true,
    rememberMeeting() {},
  });
  expect(presentation.surface).toBe("setup");
  await expect(presentation.present("finishSetup")).rejects.toThrow(
    "Setup is not complete",
  );
});

test("an unreadable roster keeps recovery until live evidence confirms it is empty", async () => {
  const snapshot = {
    ...initialSnapshot("0.3.0", false),
    locationReady: true,
    installed: true,
  };
  let meetings = 0;
  const presentation = new DesktopPresentation(() => snapshot, {
    hasMet: true,
    hasFinishedSetup: true,
    rememberMeeting() {
      meetings++;
    },
  });
  expect(presentation.surface).toBe("companion");
  await presentation.observe();
  expect(presentation.surface).toBe("companion");
  await expect(presentation.present("finishSetup")).rejects.toThrow(
    "Setup is not complete",
  );
  snapshot.loaded = true;
  snapshot.controlReady = true;
  await presentation.observe();
  expect(presentation.surface).toBe("setup");
  expect(meetings).toBe(0);
});

test("an existing activated Bot does not replay onboarding when the preference predates this version", () => {
  const snapshot = {
    ...initialSnapshot("0.2.0", true),
    setup: null,
    bots: [
      {
        botId: "11111111-1111-4111-8111-111111111111",
        label: "麻薯",
        characterId: "mochi",
        enabled: true,
        lifecycle: "awaitingLogin" as const,
        phase: "attention" as const,
        groupCount: null,
        projectCount: null,
        problemCode: null,
      },
    ],
  };
  let remembered = false;
  const p = new DesktopPresentation(() => snapshot, {
    hasMet: true,
    rememberMeeting() {},
    rememberFinishedSetup() {
      remembered = true;
    },
  });
  expect(p.surface).toBe("companion");
  expect(remembered).toBe(true);
});
