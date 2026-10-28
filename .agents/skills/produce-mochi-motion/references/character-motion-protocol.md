# Character-motion protocol

Use this reference when adding an application state, introducing a character, changing state-to-motion ownership, or refactoring runtime integration. Read the quality contract as well whenever an asset is generated, replaced, or promoted.

## One authority, two consumers

The Electrobun resource builder (`controlApp/build/resources.ts`) validates declared bundled-resource hashes and decodes accepted or explicitly preview-bundled video frames into lossless PNG atlases. It does not retrieve and verify every original source video; production provenance is a separate pipeline check. The renderer imports the same manifest at build time; the host reads its exact bundled copy. This is a mechanical resource projection, not image generation or a second motion registry. Tests compare decoded RGBA pixels, timing and root/target endpoints with the WebP sources. Use the native image decoder for packaged `views://` assets, not HTTP response semantics. `controlApp/src/motion/resources.ts` owns the retained-bitmap budget, atlas layout and pre-decode eviction that pins displayed pages. This does not bound browser decode intermediates or total GPU memory. Respect catalog budget/dimension checks; a character's stable poses share its own root canvas and body baseline. Do not introduce a second Motion/CSS animation clock for the character.

`motion/manifest.json` is the sole character-motion authority. It is consumed directly by:

- the production pipeline, which owns generation inputs, compilation, provenance, hashes, and quality gates;
- the macOS runtime, which owns character selection, state mapping, static targets, playback policy, presentation metadata, and the system preview menu.

The app bundle contains the exact validated manifest as `CharacterMotionManifest.json`. It is a copy of the authority for runtime consumption, not a separately maintained projection. TypeScript may decode and validate the fields it needs, but must not recreate sequence lists, asset geometry, state mappings, preview entries, titles, timing policy, or character identity in enums and switches.

## Protocol layers

Keep the model small and explicit:

1. **Application state registry** is the ordered `applicationStates` list. It names the product-domain states such as `listening` or `working`; Bridge logic still decides the real current state, and runtime decoding rejects drift between this registry and `BotPhase`.
2. **Character** owns one display identity, canonical root, background texture, pinned generation reference, visual asset geometry, complete application-state map, and preview menu. This is visual identity only; capability, authorization and memory ownership stay in the product contracts.
3. **Visual asset** is a stable PNG target with resource identity and layout geometry. The root and video-owned state targets use the same shape.
4. **Sequence** is one generated video artifact owned by one character: an intermittent loop, sustained activity, state transition, or one-shot event, retaining acceptance plus provenance. A sustained activity declares interior `cycle.start/end` cues. An event declares a square `stage.size` and integer `start/end` root origins; its endpoints contain the unchanged canonical root at 1:1 pixel scale. No new stable asset or second root is created.
5. **State binding** maps one application state to one stable asset and exactly one playback policy.
6. **Preview** references a state or a bundled sequence. It never creates separate runtime motion semantics.

The allowed playback policies are:

- `static`: hold the declared asset; this is an explicit product choice, not a silent fallback for missing motion;
- `state`: play one approved state sequence forward to its declared target and reverse it on exit;
- `continuous`: one approved `sustained` video owns entry, a repeatable interior activity, and exit. `cycle.start` is inclusive and `cycle.end` exclusive. Repeat only that range while active; finish the current cycle and continue forward to the root only on exit. Its prop and active pose remain present at the interior seam. Once exit starts it finishes, even if the same state returns during retirement;
- `intermittent`: hold the stable asset, wait inside the configured range, then play one approved root-to-root loop.

Events are explicit presentation performances, not application-state policies. They are excluded from continuous/intermittent/state bindings. Event sequence preview plays once forward and holds the landing. Sustained sequence preview also plays once; its state preview repeats the activity. Reduced motion directly displays the bound stable asset (the root for sustained motion), or the canonical landing for an event, without decoding the video. A target change finishes the current jump before leaving; it never rewinds a physical leap. Ownership beyond the existing single-source entry/cycle/exit or a character-to-character transform requires an explicit protocol change.

The recipe owns source duration and default cadence. Optional `sequence.framesPerSecond` retains the native source cadence. Optional inclusive `sourceFrames: { start, end }` selects a contiguous interval to omit visually reviewed inactive lead/tail holds; it never retimes or synthesizes exposures. Runtime frame counts and cycle cues are relative to that selection. A selected state endpoint becomes its exact static target and passes the same settle gate. Integer container timestamps follow cumulative frame time without rounding drift. The builder and renderer resolve identical timing, endpoints, cues and atlas bounds. Every clip displays single source exposures, never an adjacent-frame dissolve that duplicates anatomy. The fractional clock still drives spatial placement.

Atlas paging follows the shared layout function for any clip whose full atlas is too large, not only events. Decode ahead in the current playback direction, including the sustained cycle wrap and reverse state exit; pin the displayed page and evict unused pages before another decode. If a required page is late, pause the video clock without catching up or skipping frames. Small clips retain one atlas. Paging never changes source RGBA pixels or increases the retained-bitmap budget.

Generation inputs and runtime endpoints are separate: sequence `generation.anchor` selects `root` or the character's pinned `reference`. A hash proves which reference was used, not that it belongs to the current root family. Inspect it before reuse, especially after a root replacement; declare `anchor: "root"` when generating from the current root. Event inputs preserve the selected image's native pixels and multiply stage coordinates by its density relative to the runtime root; nonintegral placement or aspect drift fails. Compilation still restores the runtime root at 1:1 in the declared stage and enforces the same normalized seam gates. The reference is not a second runtime root.

An event may declare `generation.motionReference: { url, sha256 }` for an already reviewed source's choreography. Before submission, the pipeline downloads and verifies those exact bytes. It sends the prepared endpoint images as `image_urls` and the video as `video_urls`, with no `image_url` or `key_frames`: these provider modes are mutually exclusive. Endpoint composition is then a prompt constraint, not a provider guarantee, so unchanged compiled seam gates remain mandatory. This is a production-input option only; it adds no runtime asset, playback policy or second clock.

## Hard invariants

An optional `generation.actingReference: { source, sha256 }` is a hash-verified PNG under `motion/references/` for an event or an explicitly endpoint-conditioned sustained sequence. Neither the file nor its fixed parent directories may be symlinks. The two prepared canonical placements remain the first two reference images; the acting guide follows them. This is a provider reference mode, not strict keyframes, and cannot combine with first-frame-only conditioning. A sustained guide can establish object-directed head/gaze anatomy that text conditioning failed to produce. The guide is never a runtime root or a stable asset; the genuine video still owns entry, the complete interior cycle and retirement, with all original seam and material gates.

Optional `character.entrance: { sequence, peek, jump, land }` must reference an `approved` same-character event. Cues are strictly increasing positive integer frame indices inside that sequence's resolved frame count. Absence is allowed; null, false, incomplete objects and legacy `approved-reference` events are not. One explicit event request owns a nonce and an optional bounded starting frame. A new replay replaces that event clock; explicit Skip cancels it and paints the root even while a window handoff is paused. Normal state changes still finish the event forward. Presentation position and felt reveal consume the actual fractional frame, so decode waits do not desynchronize the scene.

For an event, explicit `generation.conditioning: "first-frame"` sends only the verified padded first image, with no motion reference or keyframe pair. It compares single-image conditioning to endpoint conditioning without changing playback or acceptance. Both runtime endpoints remain exact and the final generated pose must pass the same seam gate; it is not a guaranteed provider endpoint.

- Every character maps every current application state exactly once. Missing and unknown states fail closed.
- Production state bindings may reference only approved sequences owned by the same character.
- A `state` binding's stable asset must equal the sequence's declared `targetAsset`.
- A stable target has one video-owned reverse path. Multiple application states may deliberately reuse a compatible same-character sequence; two different state videos must not claim the same target with conflicting exit paths.
- `continuous.sequence` references one same-character approved `sustained` video; `intermittent.sequences` references only root loops. A sustained video requires bounded ordered interior cycle cues, leaves room for entry and exit, and passes the existing strict state-settle gate at its activity seam as well as the normal canonical endpoint gates. Other sequence kinds cannot declare cycle cues.
- Rejected assets never enter production bindings. They may appear only when `bundledForPreview` is explicit and a preview entry references them.
- Character, asset, state, sequence, and preview identifiers are stable and unique within their declared scope.
- Runtime resource names are bundle-global identifiers and must be unique across backgrounds, visual assets, approved sequences, and explicitly bundled comparisons.
- Every asset carries its own resource name and geometry; TypeScript has no built-in Mochi geometry.
- Presentation strings may use only the `{character}` placeholder. This keeps copy character-aware without introducing a template language.
- The default character is explicit. Adding another character must not change the existing character's state map or approved artifacts.
- Manifest validation runs before generation, rendering, verification, and app packaging.

## Add an application state

First distinguish a new visual binding from a new domain state. Binding an existing state to another compatible approved sequence is a manifest edit; it must not expand `BotPhase` or add a player branch. If the requested action is unavailable, produce a candidate through the normal lifecycle before completing that binding.

For a genuinely new observable product state:

1. Define its meaning, real trigger and exit at the existing Bridge/companion state owner. Update that domain contract and the matching ordered `applicationStates` registry together; menu previews do not prove the state can occur.
2. Add a binding in registry order for every character, with an explicit stable asset, policy and truthful presentation. Reuse a compatible same-character performance where appropriate; never borrow another character's sequence to fill a gap.
3. Produce missing assets through candidate review, then integrate the state bindings together. Do not commit a partially covered catalog or silently choose a generic fallback.
4. Add state previews for the affected bindings and sequence previews for any performance that needs isolated review. Exercise incoming and outgoing transitions, not just direct selection of the new state.
5. Verify domain-state projection, complete catalog coverage and rejection of missing/unknown states, foreign-character references and incompatible kinds. Run native state review after integration; a synthetic state preview alone does not prove the real trigger.

The state-to-motion relationship belongs in the manifest. `controlApp/src/motion/timeline.ts` consumes the policy; `controlApp/src/ui/Character.tsx` presents it. Neither owns a parallel state-to-sequence switch.

## Establish or replace a root family

1. Define the requested character's identity and material from its own brief: anatomy, palette, surface, contour, pose and composition. Mochi's green eyes, pink nose and groomed short felt belong to Mochi, not every future character. The current cropped root is a pose, not a full-body anatomy guide.
2. Generate or edit the root with the configured image-generation tool. Inspect native pixels and intended app scale, including contrasting backgrounds, negative spaces, extremities and baseline. Keep the exact prompt and original output. The intended contour must exist in the generated artwork; do not redesign it with matte erosion or painted repairs.
3. Register a distinct runtime root resource and measured geometry. Pin any generation reference to that family; make the anchor choice explicit on new sequences. Generate optional full-body guides from that same identity and inspect them independently. A historical high-resolution reference can reintroduce discarded material despite having a valid hash.
4. Check actual production compatibility before ordering a full video family. The current compiler assumes a square blue-plate source and calibrates neutral felt against the root. A blue-edged, translucent, glossy or non-neutral character is not proven compatible by manifest validation. Test its known-alpha root and representative raw source through the shared pipeline; if the material defeats extraction, extend and verify that production contract explicitly instead of changing the character's intended design to hide the limitation.
5. For a root replacement, inventory every dependent approved clip, static target, guide, cue and geometry. Review the replacement family under separate candidate names or an isolated local review checkout. Integrate a coherent family together; never attach old-family motion to a new root and rely on endpoint substitution to hide the mismatch. Preserve the old accepted family until final app review passes.

## Add a character

1. Establish its root family, then add one character record with a new stable ID, display name, root asset, application background, pinned generation reference and visual asset geometry. Do not invent fields such as a per-character protected-interior mask; inspect the current schema and extraction owner.
2. Add a complete state map. A character may reuse a playback shape but never another character's sequence identity. During isolated art review, explicit root-static bindings can keep the draft catalog valid; they are not completed requested animations or silent production fallbacks.
3. Register character-owned sequences with distinct IDs and produce them from that character's own canonical generation input.
4. Add character-owned previews. The macOS menu groups them automatically when more than one character exists.
5. Keep `defaultCharacter` and existing characters' accepted art/bindings unchanged unless a switch is requested. Check unique bundle resource names and the new character's own canvas/baseline, then verify its generated inputs, assets, state transitions and menu discovery at production scale.

No new TypeScript enum, player branch, resource list, or menu branch should be required for an ordinary compatible character addition. Code changes are justified for a demonstrated production limitation, new real product state or new playback semantic. The existing multi-character catalog fixture proves data ownership/decoding, not that another character's material or complete product experience has passed visual acceptance. Roles with different capabilities or setup flows need their own product work; do not prebuild that system in the motion manifest.

## Runtime behavior

The runtime decodes the bundled manifest once and validates the whole catalog before displaying a character. Invalid catalogs produce an explicit unavailable surface; there is no hard-coded Mochi fallback. The player receives a character and state definition, resolves the declared stable asset, returns through a video-owned state transition when needed, then executes the declared playback policy. If product state changes halfway through a loop, the player finishes that video to its exact root; a sustained activity finishes its current cycle and forward exit; an interrupted state entry reverses from the currently displayed generated frame. Ordinary transitions do not snap an interrupted performance to root. Explicit reduced motion and event cancellation have their declared stable-pose behavior.

Switching character identity is not implicitly animated. A future live character switch must either occur at a stable boundary or introduce an explicit, video-owned character-transition semantic. Never disguise a character change as a generic cross-fade.

## Acceptance evidence

For protocol changes, retain:

- manifest validation output;
- tests proving complete ordered state coverage, approved-only same-character production references, single target/exit ownership and multi-character decoding;
- normal motion quality gates for every affected approved artifact;
- build evidence proving the exact manifest and only declared resources were bundled;
- exact running bundle/manifest identity and real-app evidence for state entry, repeated activity, final-cycle exit, state reverse, dock layering, background and preview discovery; distinguish sequence preview, state preview and the real product trigger.
