# Mochi motion quality contract

Use this reference as the invariant review contract. Obtain all current numbers, paths, and asset identities from the live manifest and pipeline.

## Contents

- [Fixed identity and geometry](#fixed-identity-and-geometry)
- [Open creative space](#open-creative-space)
- [Prompt structure](#prompt-structure)
- [Candidate lifecycle](#candidate-lifecycle)
- [Source-video rejection checklist](#source-video-rejection-checklist)
- [Compiled-asset review](#compiled-asset-review)
- [Runtime ownership](#runtime-ownership)
- [Integration surfaces](#integration-surfaces)
- [Failure response](#failure-response)
- [Approval record](#approval-record)

## Fixed identity and geometry

- Start from the exact canonical root supplied by the pipeline.
- Preserve the owning character's facial geometry, palette, material, proportions, camera and crop from its approved root. For Mochi this means green eyes, a pink nose and compact groomed short felt; another character owns its own identity. Obtain the current generation plate from the production contract; it is separate from the character's application background.
- Keep the camera locked. A camera-contract change is an explicit product and runtime change, not part of an ordinary creative brief.
- Keep the character's body baseline, scale, and control-dock relationship stable across the first handoff.
- Keep visible anatomy complete. For Mochi, the body may continue beyond the visible crop, but the dock must not erase a paw that should sit above it. Apply the same ownership to another character's intended visible extremities and contacts.

## Open creative space

The following may change per state and should not be fossilized into the pipeline:

- prop and how it supports the state;
- gaze, expression, ear motion, head motion, paw action, and small body motion;
- comedic beat, rhythm, intensity, and emotional tone;
- gesture, sustained activity, state-settling and event choreography;
- whether the state is quiet, energetic, awkward, elegant, fuzzy, or funny.

Breathing is off by default because the product does not need a generic breathing layer. Add breathing only when the user explicitly makes it part of the performance.

## Prompt structure

Write prompts in this order:

1. Anchor identity and immovable scene constraints.
2. State meaning and the intended emotional read.
3. Chronological action beats with concrete body mechanics.
4. Prop mechanics and contacts, if any.
5. Ownership-specific handoffs: root return, interior activity plus final retirement, stable target, or event landing.
6. Exclusions that protect continuity and anatomy.

Prefer “Mochi glances toward the active control, taps once, then watches for feedback” over abstract labels such as “Mochi looks productive.” Prefer a desired expression and behavior over negative emotion instructions.

## Candidate lifecycle

- Register every new or replacement experiment as a distinct manifest candidate before generation; the pipeline cannot operate on an unregistered sequence ID.
- Preserve an approved entry, prompt, resource, hashes, and provenance unchanged while replacement candidates are explored.
- Keep candidates out of autonomous playback. Install them only under review-specific resource names and expose them through clearly labelled system-menu tests.
- Select for local integration only after source review, compiler gates and candidate app playback/layering pass. Final acceptance also requires the actual bound-state path in the rebuilt app; sustained sequence preview alone cannot prove repeat behavior. Retain the previous accepted contract until this passes. Follow any explicit user review requirement without inventing an additional approval checkpoint for ordinary authorized work.
- Mark a registered rejection with a concrete reason. Keep its binary and menu preview only when the comparison remains intentionally useful.

## Source-video rejection checklist

Reject before compilation if any answer is no:

- Does the first moment still look like the owning character's canonical root and composition?
- Is this one continuous video shot rather than a disguised still transition?
- Does the state read correctly without a label?
- Does the character's acting convey the brief, with coherent responses where it interacts with a prop, event or counterpart?
- Are its visible anatomy, negative spaces and prop contacts physically coherent throughout, including Mochi's paws, underarms, ears and eyes where applicable?
- Does the blue background remain saturated and texturally compatible at fur boundaries?
- Is motion temporally coherent without cuts, bursts, warps, frozen jumps, or lighting flicker?
- For a loop, can the end flow into the beginning without a reset?
- For sustained activity, does the selected cycle include the complete intended action and keep its prop/active pose through repeated seams, with matching movement direction and contacts?
- For a state, is the terminal section truly settled and usable as the runtime target?
- Does reversing that state respond promptly, without replaying a long inactive tail before anything visibly changes?
- For an event, is the landing physically complete and consistent with the canonical root placement?

Watch at source speed and inspect every indexed frame. Short-lived color shifts, contour fragments, disappearing prop details and unwanted openings are rejection evidence even when representative thumbnails look clean.

## Compiled-asset review

Review the pipeline's diagnostics at full size and at actual app scale:

- edge preview for halo, crunchy fur, black or white contamination, and temporal matte chatter, compared against the pinned root and approved references on the same diagnostic plates;
- early-frame comparison for a flash at the root handoff;
- neighboring exposures for final root handoff, selected state settle and sustained interior seam;
- complete frame sheets for color, geometry, lighting and scale drift, with full-size inspection of flagged frames;
- target image for a clean, representative stable state with exact endpoint RGBA ownership;
- app composition for dock occlusion, paw ownership, crop, baseline, and prop clearance.

Do not tune a gate around a candidate. A threshold describes the product contract; a source either satisfies it or is rejected. Fix shared pipeline logic when a reproducible source-to-output comparison or known-alpha test proves the defect, then reverify affected assets. Multiple failing sources can help diagnose it but are not required before fixing a proven bug.

Compare the original RGB source, extracted RGBA, atlas and actual app on identical backgrounds and scales to locate the failing boundary. Internal transparency flags are review signals: preserve intentional space between a prop and a paw; reject or fix unintended removal of solid anatomy. A clean static root, low whole-image difference or exact substituted endpoint does not prove its neighboring motion frames are coherent.

The material check compares every frame with its owning root. The manifest owns the permitted partial-coverage width and fine-contour roughness ratios. Roughness compares the visible contour with a box-coverage coarsening of the same anatomy, so additional legs or props are not mistaken for loose fringe. Historical minimum soft-alpha and perimeter scores rewarded ragged outlines and cannot express the explicitly approved short-nap material. Raw scores remain diagnostics; the root-relative bounds check both excess fringe/halo and lost edge coverage. Known-alpha tests must distinguish a clean antialiased edge, broad halo, ragged fragments and smooth articulated shapes. Any measurement-definition change needs an explicit explanation and re-verification of every asset. Historical scores using different definitions are not acceptance evidence.

The intended material and silhouette must exist in the generated root, acting references and every source-video frame. For Mochi, never turn long fur into short nap with erosion, contour trimming, blurring or painted masks. Matte extraction removes only the generation plate and its contamination; it does not redesign the sculpture. For a new material, test compatibility as described in the character protocol instead of assuming the neutral-felt compiler supports it.

## Runtime ownership

Every sequence belongs to one manifest-declared character. Every application state resolves through that character's manifest state map; TypeScript must not maintain a parallel character, asset, sequence, geometry, or preview registry. Read [character-motion-protocol.md](character-motion-protocol.md) when changing those relationships.

### Loop

- Frame zero and the final loop frame follow the manifest's exact canonical-root contract.
- This is an intermittent root-to-root gesture, followed by the declared idle wait. It does not own indefinite active-state repetition.
- Entry and return must preserve identity, color and silhouette without a reset flash; state interruption finishes forward to root.

### State transition

- Entry begins at the exact root.
- The video's own final selected stable exposure becomes the state target.
- The runtime holds that target without a second visual jump.
- Exit uses the established reverse sequence unless the runtime contract explicitly defines another validated path.
- Review root → entry, last moving exposures → target, target → reverse and reverse → exact root. Also interrupt entry before it settles and verify reversal from the displayed frame.
- Optional inclusive `sourceFrames` may remove reviewed inactive lead/tail holds only. Keep original cadence and gesture exposures, derive all runtime cues from that interval, and rerun boundary gates. Check visible wake-up response after the target has been held, not only automatic preview reversal.

### Sustained activity

- One source owns entry, an interior repeatable action, and exit. The manifest owns the cycle's inclusive start and exclusive end.
- While the state persists, neither the neutral root nor prop retirement is replayed. The active pose and all props remain present at the seam.
- Check matched motion direction, pose, gaze, contact and prop position across repeated cycles. Small whole-image error is insufficient.
- Inspect at least several full cycles at display speed, including every sub-action (for example all elements of a prop wave). A similar pair of frames can accidentally select an incomplete gesture.
- On state exit, finish the current activity cycle and the source's real forward retirement. Render its exact final root before the next state.
- Request exit during entry and during activity; change the target again during retirement. Once exit is underway, it finishes before another entry, even when the original state returns. Do not reverse a physical prop action or dissolve it to root.
- Sequence preview is once-through evidence. State preview after local integration verifies repeated activity and interruption; record those results separately.

### Presentation event

- First and last images are lossless placements of the same canonical root in a padded acting stage.
- Generation may use a hash-pinned high-resolution reference only after confirming it belongs to the current character/root family. Scale only the empty stage coordinates, never the image; reject fractional placement or aspect drift. Compiled endpoints still use the exact runtime root and the same normalized seam gates.
- Generate a real continuous performance between those endpoints. Padding creates clearance, not permission to crop, rescale or change identity.
- An explicitly hash-pinned motion reference can guide coherent acting in a new generated source. Reference mode cannot promise exact provider endpoints and cannot be mixed with first/last-frame mode. Both compiled seams, anatomy and matte still pass the same gates; the reference itself is not promoted.
- Play once forward and hold the landing. Never loop or reverse a physical jump.
- Large stages are projected into bounded atlas pages. A missing next page pauses the single video clock; the presentation must not run ahead.
- Presentation placement and text follow actual frame progress. They do not manufacture body motion or hide anatomy and matte failures.

If a future status needs another ownership model, extend the manifest, runtime, menu, and tests together before generation. Never force it into one of these models merely to reuse code.

## Integration surfaces

Inspect and update only the surfaces the state owns:

- `motion/manifest.json`;
- character identity, visual assets, complete state map, playback policy, presentation, and preview entries in that manifest;
- `motion/prompts/`;
- approved assets and explicitly `bundledForPreview` comparison assets in `controlApp/Resources/`;
- sequence registration and frame loading;
- state target bounds and body baseline;
- `controlApp/src/motion/timeline.ts` playback and `controlApp/src/ui/Character.tsx` composition when their behavior changes;
- macOS system-menu test options;
- Electrobun resource bundling and pixel-identical atlas projection;
- motion/runtime tests;
- `motion/README.md`.

When a prop occupies the body's lower center, measure the body baseline at an unobstructed body column. The prop's bottom edge is not the character's baseline.

## Failure response

| Failure | Response |
| --- | --- |
| Wrong or vacant emotional read | Reject and rewrite the brief with positive physical behavior and interaction. |
| Pale or damaged background plate | Reject the source. |
| Matte or fur-edge gate fails | Reject the source or fix a proven shared compiler defect; never lower the gate. |
| Root or loop seam jumps | Compare raw source, compiled neighbors and runtime handoff. Regenerate source drift or fix a proven compiler/player defect; never hide it with still interpolation. |
| Sustained state returns to neutral each round | Check kind, binding and cycle ownership; retain the interior action and retire only on exit. Regenerate if the source has no coherent cycle. |
| Wake-up appears unresponsive | Inspect inactive source tail and reverse timing; select only a valid inactive-trim interval or regenerate, preserving real motion cadence. |
| State target is still moving | Reject or simplify the source motion. |
| Solid rectangle or colored block appears | Fix the shared layer/compositor or extraction path; do not paint frames. |
| Halo or color spill appears | Diagnose shared decontamination and matte behavior; do not recolor frames manually. |
| Unexpected transparent hole | Compare the original source and matte; preserve genuine negative space and fix proven extraction loss at the shared owner. Never fill all enclosed gaps. |
| New root changes back to old material during motion | Inspect every generation anchor and acting guide, then rebuild the affected root family coherently. |
| Prop changes baseline | Measure the body independently from the prop. |
| Isolated preview works but app composition fails | Reject until the actual app path is correct. |

## Approval record

For every promoted motion, retain enough evidence to reproduce and audit it:

- exact prompt, owning character/root identity and effective input/conditioning settings;
- provider/model and task ID;
- source location and source hash for every new promotion; the frozen `approved-reference` class is only for legacy references whose original source was not retained and must still pin task ID plus compiled asset hash;
- compiled asset hashes;
- source cadence, selected exposure interval and reviewed cycle/entrance cues when present;
- manifest gate results;
- visual source and diagnostic review notes;
- exact app bundle/manifest identity and applicable forward, multi-cycle repeat, final-cycle exit, reverse, root and layering observations.

Passing automated gates does not replace visual acceptance. Visual approval does not replace provenance or deterministic verification.
