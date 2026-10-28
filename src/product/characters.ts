import manifest from "../../motion/manifest.json";

/** Assets are shared immutable resources; the selected identity belongs to a Bot. */
export function defaultBotCharacter(): string { return manifest.defaultCharacter; }
export function requireBotCharacter(value: unknown): string {
  if (typeof value !== "string" || !manifest.characters.some((character) => character.id === value)) {
    throw new Error("Unknown Bot character");
  }
  return value;
}
