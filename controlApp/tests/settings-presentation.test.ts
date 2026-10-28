import { expect, test } from "bun:test";
import { settingsRendererURL } from "../src/host/renderer.ts";
import { SettingsPresentation } from "../src/host/settingsPresentation.ts";
import { initialSnapshot } from "../src/shared/model.ts";
import {
  parseSettingsCloseState,
  parseSettingsRoute,
  type SettingsFrame,
  settingsSection,
} from "../src/shared/settings.ts";

test("Settings coalesces native intents until readiness, delivers fresh facts, then preserves navigation", () => {
  let snapshot = initialSnapshot("first", true);
  const presentation = new SettingsPresentation(() => snapshot);
  const frames: SettingsFrame[] = [];
  presentation.open("model");
  const renderer = presentation.attach((frame) => frames.push(frame));
  presentation.open("projects");
  snapshot = initialSnapshot("latest", true);
  presentation.publish();
  expect(frames).toEqual([]);
  renderer.ready();
  expect(frames).toEqual([{ snapshot, navigation: { page: "projects" } }]);
  presentation.remember({ page: "document", id: "issue-authoring" });
  presentation.publish();
  expect(frames.at(-1)).toEqual({ snapshot });
  renderer.close();
  presentation.open("settings");
  const nextFrames: SettingsFrame[] = [];
  const next = presentation.attach((frame) => nextFrames.push(frame));
  renderer.ready();
  renderer.close();
  expect(nextFrames).toEqual([]);
  next.ready();
  expect(nextFrames).toEqual([
    { snapshot, navigation: { page: "document", id: "issue-authoring" } },
  ]);
});
test("Settings routes and live close replies are closed contracts", () => {
  for (const route of [
    null,
    { page: "document", id: "unknown" },
    { page: "document", id: "issue-authoring", section: "account" },
    { page: "projects", path: "/tmp" },
  ])
    expect(() => parseSettingsRoute(route)).toThrow();
  expect(settingsSection(parseSettingsRoute({ page: "projects" }))).toBe(
    "connectors",
  );
  expect(settingsSection(parseSettingsRoute({ page: "connectors" }))).toBe(
    "connectors",
  );
  expect(
    settingsSection(
      parseSettingsRoute({
        page: "document",
        id: "issue-authoring",
        section: "help",
      }),
    ),
  ).toBeNull();
  expect(
    settingsSection(
      parseSettingsRoute({
        page: "document",
        id: "issue-authoring",
        section: "groups",
      }),
    ),
  ).toBe("groups");
  for (const state of [
    null,
    { dirty: true },
    { dirty: false, busy: false, confirmed: true },
  ])
    expect(() => parseSettingsCloseState(state)).toThrow();
  expect(parseSettingsCloseState({ dirty: true, busy: false })).toEqual({
    dirty: true,
    busy: false,
  });
  expect(settingsRendererURL("views://main/index.html")).toBe(
    "views://main/settings.html",
  );
  expect(settingsRendererURL("http://127.0.0.1:12345/index.html")).toBe(
    "http://127.0.0.1:12345/settings.html",
  );
});
