# Mochi motion

`manifest.json` schema 4 is the sole authority for character roots, geometry, state bindings, playback, previews, production settings and source provenance. The builder validates it and bundles the same document for the native menu and renderer. Invoke `$produce-mochi-motion` from `.agents/skills/produce-mochi-motion/SKILL.md` and its quality reference for production and review. Entrance composition has a separate contract in `docs/entrance.md`.

For an existing-state binding, new observable product state, new character or root-family replacement, follow the skill's [character-motion protocol](../.agents/skills/produce-mochi-motion/references/character-motion-protocol.md). Each character owns its visual identity and complete current state map. The manifest does not own its capabilities, authorization or memory. Catalog support for multiple characters is not proof that a new material fits the current extraction pipeline; verify that before producing a full family.

Awawa and Kiwi have independent root families. Their roots are
close companion portraits, deliberately composed like Mochi rather than as
full-body wildlife plates: the same transparent square, optical scale, matte
short-nap pressed felt, and quiet diffuse light, with each animal retaining its
own anatomy. Selecting either character therefore
changes the visual identity immediately without borrowing Mochi's choreography.
Their local `generation.anchorUrl` records the repository-owned source used for
future motion work; the pipeline accepts the `local://` form and verifies its
hash before preparing an input.

Awawa has six locally integrated motion bindings covering idle, sleep, attention,
working, context organization and a full context. The revised idle, working and
organizing performances make attention legible through head orientation,
contact and a return to the viewer. Selected sources passed full-frame and
native sequence/state-path review. This local result is not a published release
or user aesthetic acceptance. Kiwi still has explicit static state bindings.
Source selection, gate results, native observations and integration status are in
[the Awawa motion audit](../docs/motion-awawa-audit-2026-10-10.md).

## Playback ownership

- An intermittent loop starts and ends on the canonical root, separated by the manifest's idle delay.
- A sustained video owns entry, an interior activity cycle, and exit. `continuous.sequence` references one same-character `sustained` sequence. Its `cycle: { start, end }` repeats the native exposures in `[start, end)` while the state remains active. Props and the active pose stay present across this seam. On exit the current cycle finishes forward, continues through the remaining source to the exact root, and only then hands over. An exit already in progress finishes even if that state returns. Sequence preview plays the full performance once; state preview exercises indefinite repeat and interruption.
- A state transition starts on the root, settles into its own final video frame, and uses that exact frame as its static target. Exiting reverses the same source to the root. An independently illustrated target cannot replace the video's endpoint.
- An event plays once forward on its declared acting stage. Both endpoints are lossless placements of the same root. Its fractional clock also drives the desktop entrance geometry. It never plays backwards.

Duration and cadence derive from the production recipe and optional native sequence cadence. Integer WebP timestamps distribute rounding without drift: 24 fps uses 41/42 ms exposures totaling four seconds. The player displays one generated exposure at a time. Adjacent-frame dissolves created two translucent consoles, eyes or limbs, including in slow daily motion. The clock remains fractional while the image follows its source cadence. Reverse exit renders the exact sequence root before handing ownership to the static asset.

`MotionCanvas` owns lossless atlases and a bounded bitmap budget. Larger clips stream rows with prefetch in the current playback direction, including reverse state exits. `StickerSurface` owns premultiplied texture sampling and optional paper/curl presentation. It does not key, fill, recolour or repair the cat. Compiled pixels are the colour and coverage authority on every surface.

Optional `sourceFrames: { start, end }` selects an inclusive contiguous interval of the generated source at the original cadence. It removes reviewed inactive lead/tail holds, not motion frames, and never speeds up, interpolates or paints the performance. Runtime frame indices and cycle cues are relative to that selected interval; production duration still describes the original provider video. A state's static target comes from the selected final video exposure. Both selected boundaries must pass the original seam/settle gates and visual review. Review wake-up responsiveness as well as sleep entry: reversing several seconds of a generated closed-eye hold delays the visible response.

## Root and extraction

`controlApp/Resources/MochiCompanion.png` is Mochi's runtime root. On September 14 the user explicitly chose a compact, groomed short-nap contour and required that material to exist in generation itself. `motion/references/mochi-clean-root-source.png` preserves the new generated RGBA source; `motion/prompts/root-short-felt.txt` preserves its exact image-generation brief. The runtime root is only a proportional Lanczos resize to 512 pixels. Its alpha was not eroded, trimmed, blurred or filled. Geometry uses the established alpha > 128 bounds and an exclusive body-bottom coordinate, measured independently of props. Awawa and Kiwi have their own roots, geometry, colors and source prompts; no root or sequence is shared across characters. Their current roots were regenerated through image-to-image passes anchored to Mochi's approved root so their material and composition stay in one visual family. This material match does not imply that Mochi's motion sequences can be reused.

The full-body acting guide was regenerated from this root alone and is pinned by the encounter generation contract. The earlier guide reintroduced long curled wool during jumps and was rejected. All eight production clips and their three video-owned state targets were replaced together. The old root and the earlier solid-interior repair are historical evidence, not the current generation path.

The shared compiler in `script/motion_matte.ts` owns the following sequence:

1. Measure the saturated blue plate in every frame from four corners. Nonuniform or out-of-contract plates fail.
2. Combine colour evidence with connectivity from the image border. Strict measured-plate samples also seed genuine enclosed negative spaces. Small plate-coloured pockets enclosed by exterior curls are released only within a bounded exterior neighbourhood. Green irises, deep enclosed blue controls and props remain protected. Protected colour is not automatically a valid foreground sample for exterior decontamination.
3. Recover uncertain fibre coverage before downscaling. Preserve opaque source texture; do not invent fibres or anatomy.
4. After downscaling, calibrate neutral felt against the canonical root with bounded channel corrections. Saturated eyes, nose and props retain their source colour.
5. Finish by removing blue/cyan contamination only in a bounded exterior band, using nearby opaque foreground colour. Cyan-contaminated pixels cannot themselves supply that colour. The exterior distance uses visible coverage so nearly invisible codec haze cannot conceal contaminated fibres. Coverage and deep interior colours are unchanged. `finishMatteRgba` owns this order: grading after cleanup reintroduced cold opaque fibres. Runtime performs no second correction.
6. Substitute the exact canonical endpoints, extract video-owned state targets, and enforce the unchanged seam and settling gates. Every frame's edge-spread and contour-roughness ratios are checked against its owning root. Roughness normalizes the fine perimeter against a coarsening of the same anatomy, so extra legs or props do not count as ragged fringe. Historical minimum soft-alpha/perimeter floors rewarded loose fuzz and were replaced to express the explicitly changed material; their raw scores remain diagnostics.

Connectivity cannot distinguish a legitimate blue object from an equally coloured plate when they join at an exposed edge. Reject or regenerate such source art with a distinguishable prop colour. Filling that opening after extraction would also fill real negative space. Review work-console emergence and departure frame by frame.

There is no per-candidate scale correction, baseline rolling, painted-frame repair, target morph, duplicate-frame seam patch or speed change. A sustained cycle uses only the source's real repeated action; a numeric similarity score alone does not establish matching motion direction or anatomy. Its interior seam passes the existing strict state-settle distance gate and full-speed visual review. Investigate source, compiler and player defects separately.

## Production and review

Register a separate candidate ID, resource, prompt, kind, cadence and optional target before generation. Preserve previous provenance. Generate three candidates by default and reject identity, anatomy, prop-count, colour, background or temporal failures before compilation.

```sh
./script/mochi_motion_pipeline.sh prepare-sequence-input <id> <input.png>
SEEDANCE_VIDEO_CLI=/path/to/seedance-video.sh ./script/mochi_motion_pipeline.sh generate <id> <source.mp4>
./script/mochi_motion_pipeline.sh render <id> <source.mp4> <staging-directory>
```

Generation may use the exact root or a hash-pinned reference visually confirmed to belong to the current root family. New candidates must explicitly resolve their anchor and effective recipe; a valid historical reference hash does not prove current material continuity. Explicit loop or sustained `generation.conditioning: "endpoints"` supplies the same prepared input as both keyframes. A sustained brief must additionally choreograph a repeatable interior action with its props retained; first/last keyframes do not guarantee that interior seam. State transitions use the first frame and own their generated endpoint. A hash-pinned `generation.actingReference` can guide an explicitly endpoint-conditioned sustained action when text failed to establish a readable pose. The provider receives two canonical root references plus the guide; this is reference-image mode, not guaranteed first/last keyframes. The guide is never a runtime target, and source timing, complete-cycle and endpoint gates still apply. Event reference modes and padded placements retain their existing manifest contract. Input conditioning never relaxes a compiled seam.

Retain source MP4, task ID, source SHA-256, prompt and generation contract. Provider outputs are recorded as `asset://outputs/<generationTaskId>.mp4` and generation anchors as `asset://anchors/<path>`. The pipeline resolves them against `MOCHI_MOTION_OUTPUT_BASE` and `MOCHI_MOTION_ANCHOR_BASE`, which only the maintainer's environment sets, and fails before any provider request when they are missing; verify the recorded hash. The original idle sources were recovered during this audit. New replacements require full provenance and use `approved`, never the historical `approved-reference` exception.

Inspect every source frame, not only evenly spaced thumbnails. Review contact, edge and seam sheets even after a failed gate. Inspect partly visible props, eyelids, ears, paws, mouth, negative gaps, first/last exposures and settled targets. Compare static and motion images on identical diagnostic backgrounds at identical scales.

Install staged files under candidate names with `bundledForPreview: true` and explicitly labelled menu previews. Review the actual development app: root → motion → hold → reverse when applicable → root, background edges, full paws, baseline and control-dock occlusion. A sustained sequence preview plays once; after integrating the selected candidate locally, use its state preview to verify multiple interior cycles and final-cycle forward exit, including target changes during retirement. Keep the previous accepted contract until this bound-state review passes. Confirm the exact running bundle and bundled manifest hashes, then remove temporary resources/previews; retain rejected provenance and concrete reasons. Rejected keyboard and stamp binaries have been removed from `controlApp/Resources`; their manifest entries and prompts remain as rejection records, with no production or preview binding.

## Verification

```sh
./script/mochi_motion_pipeline.sh validate
./script/mochi_motion_pipeline.sh verify-approved
bun script/audit_motion_frames.ts
bun run app:check
bun run app:test
bun run check
bun test
bun run script/test_desktop_ui.ts controlApp/tests/motion-fidelity.pw.ts controlApp/tests/sticker.pw.ts controlApp/tests/entrance.pw.ts --workers=1
./script/check_repository.sh
./script/build_and_run.sh --verify
git diff --check
```

The frame audit writes full-resolution PNGs, per-frame JSON and an offline forward/reverse review page under `controlApp/.build/motion-audit`. Optional arguments are `<output-directory> <resource-directory> [sequence-id ...]` for explicit candidate audits. Internal-transparency and exterior blue/cyan flags require interpretation against the raw source. GPU tests exercise every approved atlas exposure, fractional timestamps and exact static handoffs with colour and alpha readback. The UI test runner first prepares current resources through the same native resource builder; it must not reuse the previous build's public atlases under unchanged canonical names. Run native builds and UI fixture preparation sequentially because they own the same staging directory. Tests do not replace native visual review.

`bun script/audit_motion_key.ts` is a known-alpha diagnostic that separates coverage information loss from model output problems. Its exit code reports measurement, not acceptance. A build, gate, small colour distance or clean root alone cannot prove that the entire animation is good.

The current cycle ownership and sleep timing are recorded in [the sustained-motion audit](../docs/motion-sustained-audit-2026-09-14.md). The [short-felt audit](../docs/motion-short-felt-audit-2026-09-14.md) retains the preceding source-family review and its verification boundaries. The [earlier September 14 audit](../docs/motion-quality-audit-2026-09-14.md) records a user-rejected version and is not current acceptance evidence.
