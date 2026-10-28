# Mochi launch film

Mochi's launch film: an 88-second 16:9 cut and a 48-second 9:16 cut, made
in Remotion from generated stills, generated takes wherever someone or
something moves, an original piano score and synthesised foley. Each cut
is made in Chinese, the original, and in Traditional Chinese, English,
Japanese and Korean: the verse, the chat and the end card are written in
the language, and the picture and sound are the same.

## Layout

- `treatment.md` is the film's treatment, in Chinese: its story, structure,
  look, sound and production.
- `src/Film.tsx` and `src/FilmTall.tsx` are the two cuts. Each owns its
  timeline: every shot, line and sound, in seconds of its own clock.
- `src/script.ts` holds the words both cuts share, in every language.
  `src/lib/Language.tsx` sets each language on screen: the verse's book
  face, the interface face, where lines break, and whether Mochi's words
  arrive a character or a word at a time. A cut renders in Chinese unless
  given another language (`--props='{"language":"en"}'`).
- `src/lib/` holds the parts: `Shot` (a still or a take, filmed with a 2.5D
  camera), `Desk` (Nora's desk), `Chat`, `Clock`, `Look`, `Cut` and
  `EndCard` (Mochi's app icon and name, then the Aha Labs lockup, its ring
  turning as the brand's own page turns it).
- `brand/` is the Aha Labs lockup in its celadon colourway, as two layers,
  ring and wordmark, with their layout and colours. `tools/brand.py`
  exports it from the Aha Labs brand source, which is not published:
  `python tools/brand.py <branding checkout>`, with skia-pathops.
- `frames/` holds the generated stills the cuts show, the source of every
  plate; `requests/` holds the prompts that made every still and take.
- `clips.json` names the chosen Seedance take for each moving shot, with its
  provider task and SHA-256, and why the other takes were rejected.

Git holds only what rebuilds the film. The delivered masters and what only
generation used live outside Git, in the maintainer's media archive
(`mochi.media/launch-film/` beside the checkout): `masters/`, `refs/`
(reference images), `frames/inputs/` (the style frames, key frames and
9:16 crops the takes were generated from and between), `frames/candidates/`
(every unchosen candidate) and `clips/` (the chosen takes and their
provenance, with every other take in `clips/rejected/`). Its README says
how to link them into a checkout before generating again.

Mochi is generated inside the scene, so its perspective, contact and light
belong to the set. Its identity comes from the app: every brief that shows
Mochi uses `refs/mochi-companion.jpg` (the runtime root) and
`refs/mochi-short-felt-body.jpg` (the short-felt acting guide).

## Build

```sh
bun install
# The piano is FreePats' Upright Piano KW (CC0), unpacked into
# vendor/UprightPianoKW-SF2-20220221/.
bun run assets         # palette, public/ pictures and takes, score, foley
bun run render:wide    # out/mochi-film-16x9.mp4
bun run render:tall    # out/mochi-film-9x16.mp4
bun run master         # out/master/: -16 LUFS, peaks under -1.5 dBFS
bun run languages      # out/master/mochi-film-<cut>.<language>.mp4
```

`tools/languages.sh` renders every other language's picture without sound
and gives it the original cut's mastered sound, so every language plays
the same mix.

`public/`, `src/palette.gen.ts` and `src/clips.gen.ts` are build outputs.
`tools/assets.sh` derives the pictures, fetches any missing take by its task
and verifies its hash; `tools/score.ts` and `tools/foley.ts` write the audio;
`tools/palette.ts` reads the app's theme.

To review frames without a full render:
`node tools/stills.mjs Film 46 78` writes `out/review/Film-*.png`, and
`node tools/stills.mjs Film --language=en 46 78` the English ones.

## Generating

Each call costs money and no two results match, so `frames/`,
`frames/inputs/` and `clips.json` are the record.

- `tools/batch.sh` generates any still in `requests/batch.txt` that
  `frames/` lacks; `tools/seedream.ts` makes one still or key frame.
- `tools/seedance.ts` makes one take at 1080p from a first frame, and to a
  last frame when the shot must end somewhere exact. Mochi's takes use
  Seedance 2.0, the model every approved app motion used; the world's takes
  may use 2.0 or 2.5 (`--model`). It writes the take's provenance beside it.

Generate a character that touches the set, by sitting on it, gripping it or
being lit by it, inside the scene: key frames with the character already
placed, then image-to-video between them. Compositing the app's own artwork
onto a plate failed on perspective, contact and occlusion. Pass the
product's root and acting guide as identity references, make two takes a
shot, and generate 9:16 takes natively rather than cropping 16:9 ones.
Theo, a person with a black cat's head, must be prompted to stand and walk
upright like the others, or the models animate a cat on all fours.

Review every exposure the film will show (every other source frame) for
identity, anatomy, contact, flicker and the set's stability before a take
goes into `clips.json`; the others move to `clips/rejected/`, and
clips.json records why. The film plays takes at twelve exposures a second,
like the rest of its stop-motion.

## Checking sound against picture

Sync is measured, not judged by ear or eye; contact sheets were off by up to
0.17 s.

- **Picture events** come from the takes at twelve exposures a second,
  mapped to film time by each Shot's `at`: fingertip depth by colour mask,
  hand motion energy and screen or room luma in a tight region, and change
  from the first exposure for Mochi's ears.
- **Cues** come from importing `Film` or `FilmTall` in Bun and walking the
  element tree for `Sound` props. Score onsets come from `tools/score.ts`:
  bar n starts at `SCORE_AT + 4(n − 1)`.
- **Mix:** rebuild each cue as a stem, K-weight it (BS.1770), and compare its
  0.2 s loudness with everything else, then its strongest third-octave band;
  a cue masked across the spectrum can still read in its own band.
- **Master:** detect onsets in the rendered audio (the detector lags about
  0.05 s; calibrate with the chime), check per-frame luma for flicker, and
  read loudness, range and true peak with ffmpeg `ebur128`.

Remotion `Sound` volumes stay at or below 1; raise a sound's level in
`tools/foley.ts` instead.

Remotion is free for individuals and teams of up to three; a larger team
needs a company licence.
