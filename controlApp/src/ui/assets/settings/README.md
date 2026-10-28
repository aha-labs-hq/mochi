# Settings icons

Fourteen original static icons generated with the user-selected desktop `seed-media.sh`, alias `image-pro`, model `dola-seedream-5-0-pro-260628` (Seedream 5.0 Pro). These are UI resources, independent of the character motion manifest. The connector family was added on 2026-09-30 from a separate three-icon board so the connector directory, Feishu and GitHub identities share the existing Mochi felt language without reusing the model-connection chain icon.

| File | Meaning | Source |
| --- | --- | --- |
| general | Shared settings window | navigation |
| profile | Name and instructions, paper and pencil | navigation |
| model | Model, brain | model |
| groups | Group conversation and collaboration method | navigation |
| projects | Selected work projects, folder | navigation |
| account | Shared subscription connection, interlocking links | connections-and-methods |
| diagnostics | Runtime health, pulse panel | connections-and-methods |
| help | Help, open book | connections-and-methods |
| investigation | Project investigation, folder and magnifier | connections-and-methods |
| issue | Issue work, document and check seal | connections-and-methods |
| materials | Message materials, document and picture | connections-and-methods |
| connectors | Connector directory, stout adapter | connector-family |
| feishu | Feishu service identity, official three-wing mark | connector-family |
| github | GitHub identity, face-free felt cat silhouette | connector-family |

All generated JPEG outputs and complete prompts are retained in `originals/`. `originals/connector-family-final-prompt.txt` records the final brand constraints: Feishu follows the official three-wing geometry, while GitHub is a solid silhouette with no eyes, mouth, or other facial detail. The original navigation board also contains unused house and slider studies; those are not shipped as icons. The approved model revision replaces the slider with a brain.

Production extraction uses macOS Vision `VNGenerateForegroundInstanceMaskRequest` on each padded crop. Its full-resolution instance mask supplies alpha, with values below 8 made transparent and above 247 made opaque; RGB is preserved. Connector crops then receive one deterministic cleanup: opaque near-white background pixels are removed before the visible bounds are measured, because the connector board contains a white studio background and GitHub has no white material that needs preserving. The visible bounds are resized into 176 × 176 and padded by 8 pixels on each side to a 192 × 192 RGBA PNG using Sharp. Crop coordinates, the final prompt and the exact Vision mask source are retained alongside originals. Only final PNG files are imported by the UI; generation and mask processing never run during build or at runtime.

`SettingsIcon.tsx` owns the typed catalog and the 24 / 36 / 44 point sizes. Navigation is 24 point, connection/method rows 36, connector detail identity 44. Small action glyphs remain line symbols; real Bot, Feishu group and GitHub owner avatars retain their independent identity contract. Icon color is material, not connection or selection state.

Visual review covers 24-point legibility, light and graphite backgrounds, opaque interiors, clean transparent contours, and the actual Settings renderer. The asset test bounds dimensions and bytes, checks transparent corners and requires an opaque foreground majority.

The arrangement category adds `schedules.svg`, an original calendar/clock vector in the same indigo and ivory palette. It is a static UI asset with a transparent canvas and the same 24-point navigation footprint; it has no motion-manifest entry or generated raster provenance.
