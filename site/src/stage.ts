import type { Entrance } from "../../controlApp/src/motion/catalog.ts";

/* Shared by the hero (in the browser) and the build. It carries no manifest:
   `motion.ts` reads that on the server and fills these numbers in. */

/** The entrance cues plus the landed root pose, in stage pixels. */
export interface EntranceStage extends Entrance {
  framesPerSecond: number;
  frameCount: number;
  size: number;
  /** Where the root canvas sits on the stage once landed. */
  rootX: number;
  rootY: number;
  rootSize: number;
  visualLeft: number;
  visualTop: number;
  visualWidth: number;
  /** The body's flat cut. A surface edge belongs exactly here: the body
   *  continues behind it and only the paws, which hang lower, rest on top. */
  bodyBottom: number;
}
