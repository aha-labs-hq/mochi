---
name: produce-mochi-motion
description: Generate, audit, and integrate character animation in the Mochi macOS app through its canonical video pipeline. Use for motion assets, static-frame continuity, alpha defects, state-to-motion bindings, and new character artwork; character capabilities and account permissions belong to their product contracts.
---

# Produce Mochi Motion

Create production motion through Mochi's one canonical video pipeline. Keep the performance and prop choice open; keep identity, continuity, extraction, integration, and verification non-negotiable.

## Establish the live contract

1. Resolve the repository root and read its `AGENTS.md`.
2. Read `motion/README.md`, `motion/manifest.json`, the relevant file under `motion/prompts/`, and `script/mochi_motion_pipeline.sh` before changing or generating anything.
3. Read [references/quality-contract.md](references/quality-contract.md) completely.
4. When adding a state or character, changing state ownership, or refactoring integration, read [references/character-motion-protocol.md](references/character-motion-protocol.md) completely.
5. Inspect the current branch, dirty files, approved resources, state registration, runtime bounds, and macOS test menu. Preserve unrelated work.
6. Treat `motion/manifest.json` and the pipeline script as the live authority. Never copy their state maps, frame counts, thresholds, hashes, geometry, presentation, or timing into this Skill or application code.

Separate two concerns:

- The **creative brief** is open: state meaning, gesture, rhythm, prop, expression, gaze, humor, and staging can change.
- The **production contract** is fixed: canonical root identity, real video generation, temporal coherence, matte quality, endpoints, baseline, app composition, provenance, and acceptance evidence cannot drift per idea.

Reuse the quality bar of approved motion, not its gag or choreography.

For a binding-only task, reuse a compatible approved same-character sequence and verify the affected transitions; generation is needed only when the requested performance is missing or defective. Distinguish a new binding for an existing application state from a genuinely new observable product state. For a new character or root replacement, first follow the root-family workflow in the character-motion protocol. This skill owns appearance and playback, not character capabilities, authorization, memory or a character marketplace.

## Classify the motion

Choose one of the current ownership models before generation:

- **Loop**: an intermittent gesture such as idle curiosity. It returns to its exact canonical root before the next idle wait.
- **Sustained**: a continuous state such as working or organizing. One genuine source owns entry, a manifest-declared interior activity cycle, and exit. Repeat only that activity while the state persists, keeping props and the active pose present. Finish the current cycle and exit to the exact root only when the state ends. Inspect both pose and velocity at the interior seam; regenerate if the source has no coherent repeatable action. Read the character-motion protocol before changing cycle ownership.
- **State transition**: an entry into a stable state such as sleep or attention. It must start from the exact canonical root, settle convincingly, hold its own selected terminal exposure, and reverse the same video when the runtime exits that state. Review both interrupted entry and exit from the held target; a long inactive tail can make waking unresponsive.
- **Event**: a single physical performance between two lossless placements of the canonical root. It owns a padded acting stage, plays forward exactly once, and holds its landing. It never repeats or reverses a jump. Normally generate with first/last keyframes prepared from the same verified input, not a newly illustrated endpoint. A hash-pinned `generation.motionReference` may instead supply an existing video's choreography through the provider's mutually exclusive reference mode: the same endpoint images become visual references, **not guaranteed first/last frames**. Use this only when source review proves the referenced acting is coherent; a rejected matte does not disqualify its choreography or approve its pixels. Compilation always restores the exact runtime root at both endpoints and enforces the unchanged seam gates. Use either the exact runtime root or the character's already pinned high-resolution reference; preserve its native pixels and proportionally pad the stage.

If the brief genuinely needs another ownership model, stop before generation and extend the manifest schema, runtime state machine, preview menu, and tests as one explicit product change. Do not disguise new semantics as a loop or stable state.

An event may explicitly use `generation.conditioning: "first-frame"` to test single-image conditioning against strict endpoint conditioning. This is mutually exclusive with a motion reference, uses the same verified padded first image, and does not promise a model-controlled landing. The generated final pose must independently pass the unchanged canonical endpoint gate; this option never authorizes cutting away an unfinished action, morphing or a looser seam.

An optional `generation.actingReference: { source, sha256 }` may supply a repository-owned pose guide for an event or an explicitly endpoint-conditioned sustained sequence. Verify its exact PNG and provenance before use. It accompanies both canonical placements in the provider's reference-image mode; neither it nor a motion reference may replace the root, claim strict keyframe control or relax compiled seam/matte gates. It is incompatible with single-first-frame conditioning. A guide is not approved production character art.

For an autonomous arrival, promote the accepted event before adding `character.entrance` with ordered `peek/jump/land` frame cues. Spatial composition follows the player's actual fractional frame, never an independent animation timer. Explicit replay may start at a named cue and replaces the previous presentation event; explicit Skip/Escape cancels it to the root. Ordinary state changes still finish the physical event forward.

The manifest also owns which character performs the sequence and how each application state maps to `static`, `state`, `continuous`, or `intermittent` playback. Ordinary state or character additions must not create new TypeScript sequence enums, resource lists, player branches, or hard-coded menu entries.

## Register the candidate contract

The pipeline resolves every generation by sequence ID, so register the candidate before invoking `generate`:

- For a new motion, add a manifest entry with a distinct ID, asset name, kind, prompt path, state target when applicable, `acceptance: "candidate"`, and empty provenance.
- Set the owning character explicitly. A state candidate may become a production target only for that same character.
- Resolve the effective anchor, input background, model, resolution and cadence before submitting. Defaults may belong to a historical recipe or root family. Set candidate generation fields explicitly when retaining the current family requires overrides; do not copy an older sequence's references blindly.
- A sustained candidate needs valid planned `cycle` cues to register. Replace those provisional cues with source-reviewed action boundaries after generation. Select `sourceFrames` only after inspecting the source; neither planned cues nor a passing bound check prove continuity.
- For a replacement, keep the approved entry, prompt, resources, hashes, and provenance untouched. Add a separately named candidate entry and prompt until the replacement passes real-app review.
- Keep candidate and rejected entries out of production sequence lists and autonomous playback. Expose them only through an explicitly labelled system-menu test path when app review requires it.

Never rewrite an approved prompt or resource in place merely to generate an experiment. The accepted artifact and its recorded prompt must continue to describe each other until promotion.

## Write the candidate brief

Write or update one prompt in `motion/prompts/` with positive, physically observable direction:

1. Lock character identity, camera, framing, set, palette, and anchor-frame continuity.
2. Describe the state meaning in one sentence.
3. Describe the motion arc in chronological beats.
4. Specify expression, visible anatomy and contacts appropriate to that character; for Mochi, include gaze, ears, paws, body and any prop interaction.
5. Describe the ownership-specific ending: root return for an intermittent gesture; retained active pose across an interior cycle followed by forward retirement for sustained motion; settled video-owned target for a state; physical landing for an event.
6. Require the uniform generation plate declared by the production contract. Exclude cuts, zooms, camera motion, duplicate anatomy, geometric drift, breathing unless explicitly requested, lighting shifts and background replacement.

Describe what the owning character should visibly do instead of relying on negation such as “not angry.” Keep props subordinate to the state and preserve a readable body silhouette. Root, pose guides and generated video must already have the approved material and contour; extraction must not manufacture the art direction.

## Generate genuine video candidates

1. Prepare the owning character's canonical generation input through the repository command; do not hand-edit or substitute the root frame.
2. Generate multiple independent continuous-video candidates—three by default—unless the user requests a different exploration breadth.
3. Use the project-configured video-model CLI through `SEEDANCE_VIDEO_CLI` and the pipeline `generate` command. Keep downloaded sources and intermediate work outside tracked production assets.
4. Record model, provider task ID, prompt, source URL or file, and source hash for every candidate considered for promotion.

Do not manufacture animation from still-frame interpolation, morphing, procedural warps, or a separately generated terminal still. A state target must come from the accepted video's own final selected exposure. Optional inclusive `sourceFrames` may omit reviewed inactive lead/tail holds at the original cadence, never remove gesture frames or speed up the performance. Runtime indices and cycle/entrance cues refer to the selected interval.

## Reject bad source motion early

Review each raw source video at native resolution before extraction. Watch at intended speed and inspect every source frame in indexed sheets, opening suspicious frames at full size. Representative thumbnails alone miss brief holes, doubled anatomy and contour changes.

Reject a candidate when any of these are visible:

- identity, proportions, eye placement, fur language, camera, crop, or background drifts;
- the performance reads as the wrong emotion, becomes vacant or mechanical, or loses an intended interaction;
- facial features, limbs or props merge, duplicate, disappear or move through one another;
- the background becomes pale, desaturated, or patchy behind the fur;
- a root handoff jumps, a sustained cycle reverses direction or retires its prop, or a state is still moving at the selected terminal exposure;
- the action is semantically right but visually cheap, generic, or poorly staged.

Do not send a semantically or temporally bad source into alpha extraction hoping the compiler will rescue it.

When a registered candidate is rejected, set its acceptance to `rejected` and record the concrete visual or temporal reason. Remove its runtime resource and preview path unless retaining an explicitly labelled comparison is intentional; in that sole case set `bundledForPreview: true` so the manifest remains the build authority.

## Compile through the canonical pipeline

1. Run the pipeline `render` command for one candidate at a time.
2. Let the shared pipeline own sampling, endpoint enforcement, matte extraction, interior protection, decontamination, contact sheets, edge previews, and numeric gates.
   Verify the actual source cadence and retain it through the manifest where needed. Every kind displays one source exposure at a time; fractional timing must not dissolve adjacent frames into doubled eyes, limbs or props. Never use higher interpolation frequency as a substitute for missing source frames.
3. Never lower thresholds, loosen endpoint rules, paint individual frames, or add candidate-specific cleanup logic to make a failed candidate pass.
4. If a shared compiler defect is proven, fix it once in the canonical pipeline and `script/motion_matte.ts`, update documentation and ground-truth tests, and reverify every approved asset. Rebuild affected unpublished outputs; never overwrite a published hash-pinned artifact without a separately reviewed replacement, especially when its original source is unavailable.

When repeated sources lose fine fibers, run `bun run script/audit_motion_key.ts` before generating more variations. This known-alpha round trip distinguishes color-key information loss from source-video problems; its exit status reports successful measurement, not accepted motion. Review the pre-gate contact, seam and correctly alpha-composited edge diagnostics even when `render` rejects an extraction.

A compiler pass is necessary, not sufficient. Use `script/audit_motion_frames.ts` as described in `motion/README.md` for complete compiled-frame review. Inspect source, contact sheets, edge previews, neighboring exposures at every handoff, target image, baseline, paws, underarms and prop contacts. Read transparency flags against the original video: an intentional negative space is not a hole to fill.

## Review in the actual app

Install the staged asset under its review-only candidate resource name, set `bundledForPreview: true`, pin compiled hashes and add a labelled sequence preview. A state candidate needs its extracted target registered under a distinct asset ID with measured geometry. Build and launch that exact development bundle without adding the candidate to autonomous playback, then review:

1. canonical root to forward motion;
2. its active action and terminal hold;
3. reverse exit when applicable;
4. return to the exact root;
5. edge quality on the actual application surface and contrasting diagnostic backgrounds at display scale;
6. control-dock layering, paw visibility, body crop, prop clearance, and visual baseline.

The character layer must own complete visible extremities and contacts; for Mochi, the full paws sit above the dock while the body may be cropped by the composition. Do not hide an anatomy or matte defect beneath the control component. A candidate that passes isolated previews but fails in the real composition is rejected.

A sustained **sequence** preview plays the full clip once. It does not prove repeated activity. Inspect the chosen interior seam in source/compiled frames first, then complete the **state** preview checks immediately after local integration below; do not report a one-shot preview as sustained-state acceptance. Confirm the running bundle path and bundled manifest/resource hashes so stale app instances cannot stand in for the candidate build. Use previews without changing real Bridge connections or accepted work.

## Promote one accepted candidate

Promote only the selected asset:

1. Move the compiled sequence and target image from their review-only names into the final approved resource paths.
2. Update `motion/manifest.json` with the exact provenance, hashes, task ID, and acceptance data. Every new `approved` entry requires a source hash; never create a new `approved-reference` entry to bypass missing source provenance. For a replacement, transfer the selected contract, resource, target, cues and binding to the canonical entry together, preserving the previous accepted files until final integration review passes.
3. Update prompt documentation, runtime sequence registration, target bounds, body baseline, state ownership, system-menu preview, bundle resources, tests, and `motion/README.md` wherever the new state changes those surfaces.
   Runtime registration, ownership, geometry, presentation, and previews belong in the manifest; TypeScript consumes the validated catalog generically.
4. Measure the body's visual baseline from an unobstructed body column when a centered prop occupies the lower silhouette. Prop bottoms do not define the character's baseline.
5. In the rebuilt local bundle, exercise the actual state bindings: sustained activity over multiple full cycles, exit during entry and mid-cycle, a target change during retirement, held-state reverse exit, and arrival interrupted by a state change. Test reduced motion and pause/resume when timing or loading changed. Use the quality contract's ownership-specific checks.
6. Treat a failing integrated path as unfinished: restore the previous accepted contract or keep the new work explicitly pending; never ship it on the strength of source approval. Remove temporary resources/previews and obsolete generated assets only after references prove they are unused.

Do not add an asset without completing its runtime and test-menu path. Do not alter an existing accepted state's choreography unless it is in scope.

## Verify and ship

Use checks proportionate to what changed. For skill-only edits, validate skill metadata, links and the existing motion skill/catalog tests; rebuilding art or restarting the user's app is unnecessary. A binding change needs catalog/timeline tests and native transition review. Asset changes additionally require pipeline gates, full-frame diagnostics and GPU/static-handoff tests. Shared pipeline/player changes require verification of every affected approved asset.

Motion validation entry points from the Git root:

```bash
./script/mochi_motion_pipeline.sh validate
./script/mochi_motion_pipeline.sh verify-approved
bun script/audit_motion_frames.ts
```

Use `motion/README.md` for the current motion/UI/native commands and artifact locations; repository-wide integration verification belongs to `docs/github-governance.md` and its canonical `bun run verify`, not a second checklist here. Run native builds and UI fixture preparation sequentially because they share staging. Also run pipeline `status` and retain concise provenance/gate output. Re-open diagnostics when compiler, prompt or source changes.

Report:

- motion ownership and creative brief;
- candidates generated and why rejected or selected;
- source provenance and approved hashes;
- numeric gate results and visual observations;
- real-app transition, layering, and continuity result;
- tests run and any unverified boundary.

Commit and push only when authorized. Never claim acceptance from exit codes alone.
