import { Composition } from "remotion";
import { FILM_SECONDS, Film } from "./Film.tsx";
import { FilmTall, TALL_SECONDS } from "./FilmTall.tsx";
import { FPS } from "./lib/time.ts";
import type { Language } from "./script.ts";

/** Each cut renders in the original Chinese unless given another language: --props='{"language":"en"}'. */
const original: { language: Language } = { language: "zh-hans" };

export function Root() {
  return (
    <>
      <Composition id="Film" component={Film} defaultProps={original} durationInFrames={FILM_SECONDS * FPS} fps={FPS} width={1920} height={1080} />
      <Composition id="FilmTall" component={FilmTall} defaultProps={original} durationInFrames={TALL_SECONDS * FPS} fps={FPS} width={1080} height={1920} />
    </>
  );
}
