# Shared-project illustration

The user approved this welcome composition on September 16, 2026, with every
word of the heading and supporting copy preserved. This folio is an editorial
metaphor for shared project context, not a live UI, connection state, new
product capability or alteration to Mochi's character.

`project-folio.webp` is the renderer asset (768 × 462, lossless WebP with alpha).
The four portraits around it are the existing approved Jules, Theo, Nora and
Evan images. They were neither regenerated nor submitted to the image provider.

The folio was generated and edited through the
user-authorized desktop `seed-media.sh`, BytePlus Ark image mode, model
`dola-seedream-5-0-pro-260628`, size `1536x1024`, `watermark: false`,
`response_format: b64_json`, `optimize_prompt_options.thinking: disabled`.
This was the user's selected CLI path, not Codex's built-in image tool.
[The complete prompt](prompt.txt) is retained verbatim. The sole input reference
was the repository's original `../../skills/issue.png` felt icon, used only for
material quality. No reference image or third-party artwork was uploaded.

The first edit removed a thin blue connection across the fold that looked like
a loose thread. It changed only the page marks using the initial generation as
its sole input and the same CLI, model and generation settings.
[The complete edit prompt](edit-prompt.txt) is retained verbatim. The loose
thread and ambiguous branch lines are removed; a checkmark seal, two short note
bars and broad code chevrons complement the existing speech bubble and progress
dots. The book, material and overall composition are preserved.

The retained RGB source, `originals/project-folio-board.jpg`, follows the user's
request to show code and a work board together on the right page. It used the
first edit as its sole target with the same generation settings.
[The board edit prompt](board-edit-prompt.txt) preserves the left page
and book while reducing the code mark above a simple three-column arrangement
of task cards, replacing the progress dots. These are illustrative page marks,
not a new product interface or a prescribed workflow. The GitHub label sits at
the page edge so it does not cover either symbol in compact layouts.

The current source's alpha was obtained locally with macOS Vision's
`VNGenerateForegroundInstanceMaskRequest` and `generateMaskedImage` for all
foreground instances, without cropping the source. Sharp then trimmed the
transparent margin with threshold 16, resized to width 768 with its default
Lanczos3 kernel, padded one transparent bottom row to retain the renderer's
768 × 462 geometry, and encoded lossless WebP. No color retouching or local
redrawing was applied. Alpha, edges and appearance on the existing warm surface
were visually reviewed; the image is not a fabricated transparent checkerboard.
Only the approved source and renderer asset are retained alongside the three
original prompts. Superseded source images, generation requests, intermediate
mattes and trial screenshots were removed. There is no build-time generation
or extraction, and no credential or signed download URL is included.

`ProjectIllustration.tsx` owns only the composition and a short non-looping
arrival of the still objects. It neither animates character anatomy nor touches
the character motion manifest. The heading, explanation, action and links
remain real text, outside the bitmap. The approved composition uses the simple
page board and a PR marker beside Evan. The later expanded Issue/PR card and
overlaid board glyphs were withdrawn before integration.
