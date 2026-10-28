import { PHASES, type Phase } from "../shared/model.ts";
import {
  atlasLayout,
  MOTION_BITMAP_BUDGET,
  sequenceBitmapBudget,
} from "./resources.ts";
import { type ProductionTiming, sequenceTiming } from "./timing.ts";

export type MotionPolicy =
  | { type: "static" }
  | { type: "state"; sequence: string }
  | { type: "continuous"; sequence: string }
  | {
      type: "intermittent";
      sequences: string[];
      minimumDelaySeconds: number;
      maximumDelaySeconds: number;
    };
export interface Geometry {
  canvasWidth: number;
  canvasHeight: number;
  bodyBottom: number;
  visualBounds: { x: number; y: number; width: number; height: number };
}
export interface Asset {
  id: string;
  resource: string;
  source: string;
  sha256: string;
  geometry: Geometry;
}
export interface StateDefinition {
  id: Phase;
  asset: string;
  motion: MotionPolicy;
  presentation: {
    title: string;
    detail: string;
    accent: string;
  };
}
export interface Preview {
  id: string;
  title: string;
  group: string;
  type: "state" | "sequence";
  target: string;
}
export interface Character {
  id: string;
  displayName: string;
  /** Copy used only to explain the visual identity in the character picker. */
  selection: {
    tagline: string;
    detail: string;
  };
  rootAsset: string;
  backgroundTexture: { resource: string; source: string; sha256: string };
  assets: Asset[];
  states: StateDefinition[];
  previews: Preview[];
  /** Approved physical arrival, separate from background application states. */
  entrance?: Entrance;
}
export interface Entrance {
  sequence: string;
  /** Video frame cues: the world follows the actor, never a parallel timer. */
  peek: number;
  jump: number;
  land: number;
}
export interface Sequence {
  id: string;
  character: string;
  asset: string;
  kind: "loop" | "sustained" | "state" | "event";
  framesPerSecond?: number;
  /** Inclusive source exposures retained at their original cadence. */
  sourceFrames?: { start: number; end: number };
  /** Repeat [start, end); entry and exit remain in the same genuine video. */
  cycle?: { start: number; end: number };
  /** Lossless placement of the SAME canonical root on a larger acting stage. */
  stage?: EventStage;
  acceptance: "approved" | "approved-reference" | "candidate" | "rejected";
  bundledForPreview?: boolean;
  targetAsset?: string;
  assetSha256?: string;
}
export interface EventStage {
  size: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
}
export interface Manifest {
  schemaVersion: 4;
  defaultCharacter: string;
  applicationStates: Phase[];
  production: ProductionTiming;
  characters: Character[];
  sequences: Sequence[];
}

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid motion catalog: ${message}`);
}
function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}
function hash(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
export function approved(sequence: Sequence): boolean {
  return (
    sequence.acceptance === "approved" ||
    sequence.acceptance === "approved-reference"
  );
}
export function bundled(sequence: Sequence): boolean {
  return (
    approved(sequence) ||
    (sequence.bundledForPreview === true &&
      ["candidate", "rejected"].includes(sequence.acceptance))
  );
}

/** One manifest, decoded identically by the builder, native menu and renderer. */
export class MotionCatalog {
  readonly manifest: Manifest;
  readonly characters: readonly Character[];
  readonly defaultCharacter: Character;
  readonly sequences: readonly Sequence[];

  constructor(value: unknown) {
    // Field access can throw for malformed input; callers project one explicit resource failure.
    const m = value as Manifest;
    require_(
      m.schemaVersion === 4 &&
        JSON.stringify(m.applicationStates) === JSON.stringify(PHASES),
      "state registry",
    );
    require_(
      Array.isArray(m.characters) &&
        m.characters.length > 0 &&
        unique(m.characters.map((c) => c.id)),
      "characters",
    );
    require_(
      Array.isArray(m.sequences) && unique(m.sequences.map((s) => s.id)),
      "sequences",
    );
    require_(
      Number.isInteger(m.production.frameCount) &&
        m.production.frameCount > 1 &&
        m.production.frameCount <= 600 &&
        positive(m.production.framesPerSecond),
      "timing",
    );
    const resources: string[] = [];
    sequenceTiming(m.production, {});
    for (const sequence of m.sequences) {
      sequenceTiming(m.production, sequence);
      require_(
        identifier(sequence.id) && identifier(sequence.asset),
        "sequence identity",
      );
      require_(
        m.characters.some((c) => c.id === sequence.character),
        "sequence ownership",
      );
      require_(
        ["loop", "sustained", "state", "event"].includes(sequence.kind) &&
          ["approved", "approved-reference", "candidate", "rejected"].includes(
            sequence.acceptance,
          ),
        "sequence kind",
      );
      if (sequence.kind === "sustained") {
        const cycle = sequence.cycle;
        require_(
          cycle &&
            Object.keys(cycle).sort().join() === "end,start" &&
            Number.isSafeInteger(cycle.start) &&
            Number.isSafeInteger(cycle.end) &&
            cycle.start > 0 &&
            cycle.end > cycle.start + 1 &&
            cycle.end < sequenceTiming(m.production, sequence).frameCount - 1,
          "sustained entry, cycle and exit",
        );
      } else
        require_(
          sequence.cycle === undefined,
          "cycle belongs to sustained motion",
        );
      require_(
        sequence.bundledForPreview === undefined ||
          typeof sequence.bundledForPreview === "boolean",
        "preview flag",
      );
      require_(
        !sequence.bundledForPreview ||
          ["candidate", "rejected"].includes(sequence.acceptance),
        "preview acceptance",
      );
      if (bundled(sequence))
        require_(
          sequence.kind !== "state"
            ? sequence.targetAsset === undefined
            : m.characters
                .find((c) => c.id === sequence.character)!
                .assets.some((a) => a.id === sequence.targetAsset),
          "sequence target",
        );
      if (bundled(sequence)) {
        require_(hash(sequence.assetSha256), "sequence hash");
        resources.push(sequence.asset);
      }
    }
    for (const c of m.characters) {
      require_(identifier(c.id) && text(c.displayName), "character identity");
      require_(
        c.selection &&
          text(c.selection.tagline) &&
          text(c.selection.detail) &&
          !/[{}]/.test(c.selection.tagline) &&
          !/[{}]/.test(c.selection.detail),
        "character selection copy",
      );
      require_(
        identifier(c.backgroundTexture.resource) &&
          hash(c.backgroundTexture.sha256),
        "background",
      );
      resources.push(c.backgroundTexture.resource);
      require_(
        Array.isArray(c.assets) && unique(c.assets.map((a) => a.id)),
        "assets",
      );
      require_(
        c.assets.some((a) => a.id === c.rootAsset),
        "root",
      );
      const root = c.assets.find((a) => a.id === c.rootAsset)!;
      if (c.entrance !== undefined) {
        const entrance = c.entrance;
        require_(
          entrance !== null &&
            typeof entrance === "object" &&
            Object.keys(entrance).sort().join() === "jump,land,peek,sequence" &&
            [entrance.peek, entrance.jump, entrance.land].every(
              Number.isSafeInteger,
            ) &&
            entrance.peek > 0 &&
            entrance.jump > entrance.peek &&
            entrance.land > entrance.jump &&
            m.sequences.some(
              (s) =>
                s.id === entrance.sequence &&
                s.character === c.id &&
                s.kind === "event" &&
                s.acceptance === "approved" &&
                entrance.land < sequenceTiming(m.production, s).frameCount,
            ),
          "approved entrance and ordered frame cues",
        );
      }
      for (const a of c.assets) {
        require_(
          identifier(a.id) && identifier(a.resource) && hash(a.sha256),
          "asset identity",
        );
        resources.push(a.resource);
        const g = a.geometry,
          b = g.visualBounds;
        require_(
          Number.isSafeInteger(g.canvasWidth) &&
            Number.isSafeInteger(g.canvasHeight) &&
            g.canvasWidth === root.geometry.canvasWidth &&
            g.canvasHeight === root.geometry.canvasHeight &&
            g.bodyBottom === root.geometry.bodyBottom,
          "fixed root canvas and body baseline",
        );
        require_(
          [
            g.canvasWidth,
            g.canvasHeight,
            g.bodyBottom,
            b.width,
            b.height,
          ].every(positive) &&
            b.x >= 0 &&
            b.y >= 0 &&
            b.x + b.width <= g.canvasWidth &&
            b.y + b.height <= g.canvasHeight &&
            g.bodyBottom <= g.canvasHeight,
          "geometry",
        );
      }
      sequenceBitmapBudget(
        c.assets.map((asset) => asset.geometry),
        m.production.frameCount,
      );
      for (const sequence of m.sequences.filter((s) => s.character === c.id)) {
        if (sequence.kind !== "event") {
          require_(sequence.stage === undefined, "stage belongs to events");
          continue;
        }
        const stage = sequence.stage;
        require_(stage && Number.isSafeInteger(stage.size), "event stage");
        require_(
          Object.keys(stage).sort().join() === "end,size,start" &&
            stage.size >= root.geometry.canvasWidth &&
            stage.size >= root.geometry.canvasHeight,
          "event stage dimensions",
        );
        for (const origin of [stage.start, stage.end])
          require_(
            origin &&
              Object.keys(origin).sort().join() === "x,y" &&
              [origin.x, origin.y].every(
                (v) => Number.isSafeInteger(v) && v >= 0,
              ) &&
              origin.x + root.geometry.canvasWidth <= stage.size &&
              origin.y + root.geometry.canvasHeight <= stage.size,
            "lossless event endpoint",
          );
        const stableBytes = c.assets.reduce(
          (sum, a) =>
            sum + a.geometry.canvasWidth * a.geometry.canvasHeight * 4,
          0,
        );
        require_(
          atlasLayout(
            stage.size,
            stage.size,
            sequenceTiming(m.production, sequence).frameCount,
          ).bytes *
            2 +
            stableBytes <=
            MOTION_BITMAP_BUDGET,
          "event page bitmap budget",
        );
        require_(
          sequence.targetAsset === undefined,
          "event ends in canonical root",
        );
      }
      require_(
        JSON.stringify(c.states.map((s) => s.id)) ===
          JSON.stringify(m.applicationStates),
        "complete state map",
      );
      const targets = new Map<string, string>();
      for (const s of c.states) {
        require_(
          c.assets.some((a) => a.id === s.asset),
          "state asset",
        );
        for (const label of [s.presentation.title, s.presentation.detail])
          require_(
            text(label) && !/[{}]/.test(label.replaceAll("{character}", "")),
            "presentation",
          );
        require_(
          ["secondary", "green", "amber", "rose", "purple"].includes(
            s.presentation.accent,
          ),
          "accent",
        );
        const policy = s.motion;
        if (policy.type === "continuous")
          require_(
            Object.keys(policy).sort().join() === "sequence,type",
            "one continuous activity owner",
          );
        require_(
          ["static", "state", "continuous", "intermittent"].includes(
            policy.type,
          ),
          "playback policy",
        );
        const ids =
          policy.type === "state" || policy.type === "continuous"
            ? [policy.sequence]
            : policy.type === "static"
              ? []
              : policy.sequences;
        require_(
          Array.isArray(ids) &&
            unique(ids) &&
            (policy.type === "static" || ids.length > 0),
          "playback sequences",
        );
        for (const id of ids) {
          const sequence = m.sequences.find((entry) => entry.id === id);
          require_(
            sequence && sequence.character === c.id && approved(sequence),
            "approved same-character binding",
          );
          if (policy.type === "state") {
            require_(
              sequence.kind === "state" && sequence.targetAsset === s.asset,
              "video-owned target",
            );
            require_(
              !targets.has(s.asset) || targets.get(s.asset) === id,
              "unique reverse path",
            );
            targets.set(s.asset, id);
          } else if (policy.type === "continuous")
            require_(
              sequence.kind === "sustained" && s.asset === c.rootAsset,
              "sustained state",
            );
          else
            require_(
              sequence.kind === "loop" && s.asset === c.rootAsset,
              "root loop",
            );
        }
        if (policy.type === "intermittent")
          require_(
            Number.isFinite(policy.minimumDelaySeconds) &&
              policy.minimumDelaySeconds >= 0 &&
              Number.isFinite(policy.maximumDelaySeconds) &&
              policy.maximumDelaySeconds >= policy.minimumDelaySeconds,
            "idle delay",
          );
      }
      require_(
        Array.isArray(c.previews) && unique(c.previews.map((p) => p.id)),
        "preview registry",
      );
      for (const p of c.previews) {
        require_(
          identifier(p.id) && text(p.title) && text(p.group),
          "preview identity",
        );
        require_(
          p.type === "state"
            ? c.states.some((s) => s.id === p.target)
            : p.type === "sequence" &&
                m.sequences.some(
                  (s) =>
                    s.id === p.target && s.character === c.id && bundled(s),
                ),
          "preview reference",
        );
      }
    }
    require_(unique(resources), "bundle-global resource identity");
    const defaultCharacter = m.characters.find(
      (c) => c.id === m.defaultCharacter,
    );
    require_(defaultCharacter, "default character");
    this.manifest = m;
    this.characters = m.characters;
    this.defaultCharacter = defaultCharacter;
    this.sequences = m.sequences.filter(bundled);
  }
  character(id: string): Character {
    const value = this.characters.find((c) => c.id === id);
    require_(value, "missing character");
    return value;
  }
  timing(id: string) {
    return sequenceTiming(this.manifest.production, this.sequence(id));
  }
  sequence(id: string): Sequence {
    const value = this.sequences.find((s) => s.id === id);
    require_(value, "missing sequence");
    return value;
  }
  state(character: Character, phase: Phase): StateDefinition {
    const value = character.states.find((s) => s.id === phase);
    require_(value, "missing state");
    return value;
  }
  asset(character: Character, id: string): Asset {
    const value = character.assets.find((a) => a.id === id);
    require_(value, "missing asset");
    return value;
  }
  sequenceGeometry(sequence: Sequence) {
    const character = this.character(sequence.character);
    const root = this.asset(character, character.rootAsset).geometry;
    return sequence.stage
      ? { canvasWidth: sequence.stage.size, canvasHeight: sequence.stage.size }
      : root;
  }
}

export function label(template: string, character: Character): string {
  return template.replaceAll("{character}", character.displayName);
}
