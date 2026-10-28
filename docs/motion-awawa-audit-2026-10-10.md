# Awawa motion family audit — 2026-10-10

## Local result and scope

Six genuine image-conditioned motions are integrated in the existing
`~/Applications/Mochi Development.app`. The gaze revision replaces idle, working
and organizing while preserving the user-approved root. Native review covered
all six performances, sustained cycles and retirement, and the intermittent
listening path. This is local implementation and visual-review evidence, not
user aesthetic acceptance or a published release.

The user authorized completing motion with the approved identity and confirmed
that the Mac was unlocked. Equal solid-black eyes, cream brows, whiskers, small
teeth, compact paws and short felt remain the identity contract. The former
briefs held the face and eyes frontal while the hands moved, producing a vacant
stare. The replacement brief gives attention a sequence: orient toward the
contact, act, inspect the result, then reconnect with the viewer. This is
pre-authored acting; it does not track the camera or pointer.

The checkout remains on `main` at `30b2a96`, with the ongoing character changes
uncommitted. No character PR, merge or release has been made, and the exact-commit
`bun run verify` integration gate has not run. Kiwi remains a separate static
family and is outside this Awawa motion completion.

## Selected family

The manifest is the authority for bindings, prompts, provenance and resource
hashes. All six selected sources use `dreamina-seedance-2-0-260128`, 1080p,
24 fps, the same canonical chroma input, and no retiming. The source files have
97 exposures at 1440 × 1440; ordinary four-second outputs use exposures 0–95.
Stable-state intervals only remove reviewed inactive holds.

| State | Canonical sequence | Selected source frames | Activity cycle | Provider task |
| --- | --- | --- | --- | --- |
| Listening | `awawa-idle` | 0–95 | — | `cgt-20261010190553-hx58j` |
| Sleep | `awawa-sleep` | 12–40 | — | `cgt-20261010171158-mf9tj` |
| Attention | `awawa-attention` | 22–72 | — | `cgt-20261010171520-4tltd` |
| Context full | `awawa-context-full` | 12–48 | — | `cgt-20261010171828-x7khq` |
| Working | `awawa-working` | 0–95 | [34, 71) | `cgt-20261010205212-965k6` |
| Organizing | `awawa-context-organizing` | 0–95 | [29, 65) | `cgt-20261010203738-4fc5b` |

The approved runtime root is unchanged:
`64bd1d9d6804861212454dd8821e79ff060d1f671ff909646a7a3f02af19cc91`.
The common prepared generation input is
`9a9223627a6686faf4da6e815471304c4201d9876169faa66ccd0f18664c487d`.

### Gaze replacements

- **Idle:** the head levels toward the viewer, holds direct contact, makes a
  symmetric double blink and returns to the root. Source SHA-256:
  `412325b1cce08b77dda71a5ff8061cdae996c912e25e82bf30dca3e1424843ec`.
  Asset SHA-256:
  `d2b168c2f4822fb6f61cc5e6a1371e6dbe14590232c80c340d952fbd8c8b2c44`.
- **Working:** the head lowers toward a small orange felt button between the
  paws. A deliberate press includes a short blink, followed by open-eyed
  inspection and release. The active pose and prop remain across repetitions;
  the last cycle retires the prop and restores viewer contact. Source SHA-256:
  `75eac12255ce92ad3fb157d2849acd2087cbfc70e94b18ac83f8d8f1355fd361`.
  Asset SHA-256:
  `5a7d3ff6e8d2756f46550295c5ecd410fc18d5d1ea45389706d820f2a5e65d23`.
- **Organizing:** a side-directed thoughtful nod with both paws planted. The
  head stays oriented across the complete interior cycle and returns to the
  viewer on retirement. Source SHA-256:
  `e42f1db5c131cdac47da58ca290c33a1d080212343d49da1cba99e45c6714574`.
  Asset SHA-256:
  `8847fcc29fa5c96439640f5da70277df3d5614f8b2070452278600b035f7d638`.

All indexed source exposures, including the unused final exposure, and all
compiled frames were reviewed. Suspicious anatomy and contacts were opened at
full source size. Each replacement has 96 compiled frames and zero flagged
interior transparency or exterior tint defects. Contact, seam and contrasting
edge diagnostics were inspected as well as the native application surface.

| Gate | Working | Organizing | Unchanged maximum |
| --- | --- | --- | --- |
| Root seam | 0.00951935 | 0.00986324 | 0.06 |
| Ending seam | 0.01055680 | 0.01027350 | 0.06 |
| Interior cycle seam | 0.00801756 | 0.00546937 | 0.01 |
| Relative edge spread | 0.9643–1.2162 | 0.9979–1.1959 | 2 |
| Relative contour roughness | 0.9971–1.0890 | 0.9902–1.0065 | Manifest contract |

No individual-frame painting, still morphing, seam duplication, threshold
relaxation or candidate-specific matte repair was used.

## Native observations

Only the existing development app was opened. Sequence and state routes under
`角色预览 → Awawa` use the actual catalog and timeline; these previews do not
send backend operations or pretend to run a model turn.

- **Listening:** a 26.5-second state-preview capture showed the quiet wait,
  the chosen eye-contact performance around seconds 18–21, then a root hold.
- **Working:** once-through playback showed the head lowering, paw contact,
  release, prop retirement and root handoff. Seven seconds of sustained native
  playback showed multiple complete cycles without repeated prop entry. Ending
  the preview returned to the root. An early exit followed by a new organizing
  target during retirement preserved the working exit before beginning the new
  gesture; samples showed the button retiring, a clean root handoff, and the
  organizing pose.
- **Organizing:** once-through playback and seven seconds of continuous state
  playback showed the complete nod. A mid-cycle exit finished forward and
  restored direct contact. Cancelling soon after entry also returned to the
  unchanged root; native sampling for that last check captured the endpoint,
  while exact interrupted-frame behavior is covered by the timeline tests.
- **Sleep:** samples through 4.2 seconds showed eye closure, held sleep, reopening
  and the root. **Attention:** samples through 5.6 seconds showed the raised paw,
  held request and reverse return. **Context full:** samples through 4.7 seconds
  showed the stacked felt shapes, hold, reverse and root.
- Complete paws remain visible above the dock. The working prop clears the text,
  the full-context stack clears the window header, and no edge halo or visible
  root flash was observed at display scale.

The final preview was ended. The real window showed the existing Chichi Bot,
Awawa, enabled duty and its original two groups. No Bot, account, permanent
Session, instruction or group participation setting was changed by review.
Native sampling is visual evidence, not a substitute for frame-exact tests;
reduced-motion and hidden-time pause policies were checked by automated timeline
coverage, without changing the user's macOS preferences.

## Automated evidence

- `bun test controlApp/tests/motion.test.ts test/motionInput.test.ts test/independentBots.test.ts`:
  **85 passed, 0 failed, 19,433 expectations** on the selected family. This includes
  multiple sustained cycles, interrupted entry/activity, target changes during
  retirement, geometry, alpha, exact static handoffs and isolated Bot selection.
- `bun run app:test:ui --grep 'awawa|角色选择'`: **20 passed** after canonical
  promotion and candidate-resource cleanup: ten Awawa routes, six per-frame
  WebKit GPU paths and four character-selection checks.
- `./script/mochi_motion_pipeline.sh verify-approved`: **14 approved sequences
  passed** (eight Mochi, six Awawa) without changing production gates.
- `bun run app:check`, `bun run quality:check`, native build and launcher readiness
  passed. Focused checks do not stand in for the pending exact-commit integration
  gate or a real model execution.

Task-local logs and diagnostics are under `controlApp/.build/`, including
`awawa-gaze-selected-tests.log`, `awawa-gaze-selected-webkit.log`,
`awawa-gaze-verify-approved.log`, `awawa-gaze-selected-native-build.log`,
`awawa-attentive-idle-audit/`, `awawa-organizing-responsive-v8-a-audit/` and
`awawa-working-contact-v10-c-audit/`. They are local evidence, not remotely
published artifacts.

## Rejected sources and cleanup

The manifest retains concrete rejection reasons and source hashes. Text-only
v2–v4 working/organizing candidates stayed frontal, acquired sleepy lids or
lacked a coherent complete cycle. Two image-to-image pose guides improved
open-eyed orientation in v5, but reference mode introduced props at frame zero
or root drift (working B seam 0.07737990; organizing C 0.09653950; maximum 0.06).
The guides remain hash-pinned experimental references, never runtime art.

Later candidates were rejected for obstructive props, elongated/duplicated
hands, or a face aimed away from the contact. Working v7 C failed the material
gate at frame 60 (2.0057 > 2); v10 B failed it at frame 8 (2.0587 > 2). Working
v10 C and organizing v8 A passed both the creative review and the unchanged
compiler gates before canonical promotion.

Sustained acting references now require explicit endpoint conditioning. The
provider receives both exact canonical images and the pinned guide in mutually
exclusive reference mode; it does not promise forced keyframes. The focused
input tests prove the payload, image bytes, four-second duration and rejection
of missing explicit conditioning. The selected production replacements use
canonical endpoint conditioning without those experimental guides.

Twelve unused candidate binaries were removed from `controlApp/Resources`
after proving they were referenced by no character asset, approved sequence or
bundled preview. They and replaced canonical resources remain recoverable in
task-local build evidence. The bundled manifest contains no candidate previews.

## Exact local app identity

The motion review used bundle manifest SHA-256
`3e2f4509947d86e166efe77be4ccb2c1198f27c7068de8a38ff0ec37d3801467`.
The three canonical replacement hashes were read back from that exact bundle.
The subsequent Settings polish changed the Mochi display name and selection
copy. The latest local bundle manifest SHA-256 is
`74252cc28e27323c2c1e1bb6104074d775c91099214646710a4d36fca968e151`,
matching the current source bytes. All 50 Awawa still/atlas files match the
verified build, with the selected motion bindings unchanged.

Replacing the development app invokes its normal quit path, which stops the
LaunchAgent. `bun run service:install` resumed the same compatible development
runtime and original fleet after replacement. This was an app lifecycle
transition, not a data migration. GitHub integration and formal distribution
remain separate from this local result.
