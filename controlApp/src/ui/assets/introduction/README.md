# Conversation avatars

Approved September 15, 2026 with the five-profession introduction. All five human
portraits use the first felt generation, including Evan's and Riley's original
eyes. The later eye refinements were rejected and are not imported.

| Person | Chat function | Renderer asset |
| --- | --- | --- |
| Jules | 产品 | `jules.png` |
| Nora | 运营 | `nora.png` |
| Theo | 设计 | `theo.png` |
| Evan | 工程 | `evan.png` |
| Riley | 团队负责人 | `riley.png` |
| 麻薯 | | `mochi.png` |

Human images are 192 × 192 PNGs, resized without cropping from the corresponding
1024 × 1024 `felt-originals/*-original.jpg`. The choice uses 56-point portraits,
chat uses 32-point portraits, and the selected image node travels between them.
The six imported PNGs match the approved v16 assets byte for byte.

`mochi.png` is the user's explicitly supplied 240 × 240 blue-background image,
unchanged. It is only the chat avatar. The canonical transparent character,
window-edge appearance and motion manifest are independent and unchanged.

Generation used the user-authorized desktop `seed-media.sh`, model
`dola-seedream-5-0-pro-260628`, with five independent requests submitted in
parallel. Each edited its own previously approved original illustration, using
the supplied Mochi image as the fine needle-felt material reference. The
`medium` and matching `subject` in
[felt-originals/prompts.json](felt-originals/prompts.json) are the exact selected
prompts. The `corrections` section records rejected eye studies only.

Earlier reference research informed the original illustration direction;
reference images were never reused or uploaded. Earlier originals and [generation.md](generation.md) are
historical provenance, not current renderer selections. Names and dialogue are
fictional. No provider credentials, signed URLs or third-party references are
bundled.
