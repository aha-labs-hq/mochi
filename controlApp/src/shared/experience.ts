import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { githubProjectsOf, githubStatusOf } from "./connectorView.ts";
import {
  type DesktopSnapshot,
  SETTINGS_INTENTS,
  type SettingsIntent,
} from "./model.ts";

/** Presentation only: no credentials, session creation, or caller-selected geometry. */
export type DesktopSurface = "encounter" | "intro" | "setup" | "companion";
const schema = Type.Enum(["meet", "beginSetup", "finishSetup", "replayIntro"]);
export type ExperienceIntent = Static<typeof schema>;
const validator = Compile(schema);
export function parseExperienceIntent(value: unknown): ExperienceIntent {
  if (!validator.Check(value)) throw new Error("Invalid experience intent");
  return value;
}

const settingsIntentValidator = Compile(Type.Enum(SETTINGS_INTENTS));
export function parseSettingsIntent(value: unknown): SettingsIntent {
  if (!settingsIntentValidator.Check(value))
    throw new Error("Invalid settings destination");
  return value as SettingsIntent;
}

/**
 * A proven GitHub connection with nothing selected still leaves the Bot without
 * projects, so first-run setup is not finished. The catalog is the only place
 * this is read from.
 */
function selectedBotHasNoProject(snapshot: DesktopSnapshot): boolean {
  const status = githubStatusOf(snapshot.connectorCatalog);
  return (
    status === "connected" &&
    githubProjectsOf(snapshot.connectorCatalog).every(
      (project) => !project.selected,
    )
  );
}

/** Unknown/offline is not signed out. Never restart onboarding from absent evidence. */
export function needsSetup(snapshot: DesktopSnapshot): boolean {
  // The selected Bot needs its own connected grant and chosen project.
  return (
    snapshot.setup !== null ||
    (snapshot.controlReady &&
      (snapshot.bots.length === 0 ||
        snapshot.feishu.active === null ||
        githubStatusOf(snapshot.connectorCatalog) === "disconnected" ||
        githubStatusOf(snapshot.connectorCatalog) ===
          "reauthorization_required" ||
        selectedBotHasNoProject(snapshot)))
  );
}
