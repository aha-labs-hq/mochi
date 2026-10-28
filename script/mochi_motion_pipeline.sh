#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT_DIR/motion/manifest.json"
RESOURCES="$ROOT_DIR/controlApp/Resources"

fail() {
  echo "Mochi motion pipeline: $*" >&2
  exit 1
}

# Manifests name private generation assets as asset://outputs/… (provider
# outputs) and asset://anchors/… (generation anchors); only the maintainer's
# environment knows their hosts. Other URLs pass through unchanged.
resolve_asset_url() {
  local value="$1" base
  case "$value" in
    asset://outputs/*) base="${MOCHI_MOTION_OUTPUT_BASE:-}"; value="${value#asset://outputs/}" ;;
    asset://anchors/*) base="${MOCHI_MOTION_ANCHOR_BASE:-}"; value="${value#asset://anchors/}" ;;
    *) printf '%s' "$value"; return ;;
  esac
  [[ "$base" == https://* ]] \
    || fail "set MOCHI_MOTION_OUTPUT_BASE and MOCHI_MOTION_ANCHOR_BASE to resolve asset:// references"
  printf '%s/%s' "${base%/}" "$value"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"
}

sequence_json() {
  local id="$1"
  jq -ce --arg id "$id" '.sequences[] | select(.id == $id)' "$MANIFEST" \
    || fail "unknown sequence: $id"
}

character_json() {
  local id="$1"
  jq -ce --arg id "$id" '.characters[] | select(.id == $id)' "$MANIFEST" \
    || fail "unknown character: $id"
}

sequence_character_json() {
  local sequence="$1"
  character_json "$(jq -er '.character' <<<"$sequence")"
}

character_asset_json() {
  local character="$1"
  local asset_id="$2"
  jq -ce --arg id "$asset_id" '.assets[] | select(.id == $id)' <<<"$character" \
    || fail "unknown character asset: $asset_id"
}

production_value() {
  jq -er ".production.$1" "$MANIFEST"
}

sequence_fps() {
  jq -er --argjson sequence "$1" '$sequence.framesPerSecond // .production.framesPerSecond' "$MANIFEST"
}

sequence_frame_count() {
  jq -er --argjson sequence "$1" 'if $sequence.sourceFrames != null then $sequence.sourceFrames.end - $sequence.sourceFrames.start + 1 else .production.durationSeconds * ($sequence.framesPerSecond // .production.framesPerSecond) end' "$MANIFEST"
}

canonical_root() {
  local character="$1"
  local root_id root path
  root_id="$(jq -er '.rootAsset' <<<"$character")"
  root="$(character_asset_json "$character" "$root_id")"
  path="$(jq -er '.source' <<<"$root")"
  printf '%s/%s\n' "$ROOT_DIR" "$path"
}

sequence_target_path() {
  local sequence="$1"
  local character="$2"
  local target_asset target
  target_asset="$(jq -r '.targetAsset // ""' <<<"$sequence")"
  if [[ -n "$target_asset" ]]; then
    target="$(character_asset_json "$character" "$target_asset")"
    jq -er '.source' <<<"$target"
  else
    jq -er '.target' <<<"$sequence"
  fi
}

validate_manifest() {
  jq -e '
    def unique_strings: length == (unique | length);
    . as $manifest
    | .schemaVersion == 4
      and (.production.frameCount == .production.durationSeconds * .production.framesPerSecond)
      and (.production.matting as $m |
        ($m | keys) == ["coreDistance", "erosionRadius", "noiseFloor", "perimeterAlphaThreshold", "supportRadius"]
        and $m.coreDistance > 0 and $m.coreDistance < 1
        and ($m.erosionRadius | floor == . and . >= 1)
        and ($m.supportRadius | floor == .) and $m.supportRadius > $m.erosionRadius
        and $m.noiseFloor > 0 and $m.noiseFloor < 1
        and $m.perimeterAlphaThreshold > 0 and $m.perimeterAlphaThreshold < 1)
      and (.production.material as $m |
        ($m | keys) == ["maximumContourRoughnessRatio", "maximumEdgeSpreadRatio", "minimumContourRoughnessRatio", "minimumEdgeSpreadRatio"]
        and $m.minimumEdgeSpreadRatio > 0 and $m.minimumEdgeSpreadRatio <= 1
        and $m.maximumEdgeSpreadRatio >= 1 and $m.maximumEdgeSpreadRatio <= 2
        and $m.minimumContourRoughnessRatio > 0 and $m.minimumContourRoughnessRatio <= 1
        and $m.maximumContourRoughnessRatio >= 1 and $m.maximumContourRoughnessRatio <= 2)
      and (.production | has("minimumAverageSoftAlphaRatio") | not)
      and (.production | has("minimumAveragePerimeterComplexity") | not)
      and (.defaultCharacter | type == "string" and length > 0)
      and (.applicationStates | type == "array" and length > 0)
      and (all(.applicationStates[]; type == "string" and length > 0))
      and (.applicationStates | unique_strings)
      and (.characters | type == "array" and length > 0)
      and (.sequences | type == "array" and length > 0)
      and ([.characters[].id] | unique_strings)
      and ([.sequences[].id] | unique_strings)
      and ([
        (.characters[].backgroundTexture.resource),
        (.characters[].assets[].resource),
        (.sequences[]
          | select(
            .acceptance == "approved"
            or .acceptance == "approved-reference"
            or ((.acceptance == "rejected" or .acceptance == "candidate") and .bundledForPreview == true)
          )
          | .asset)
      ] | unique_strings)
      and any(.characters[]; .id == $manifest.defaultCharacter)
      and all(.characters[]; . as $character |
        ($character.id | type == "string" and length > 0)
        and ($character.displayName | type == "string" and length > 0)
        and ($character.selection | type == "object")
        and ($character.selection.tagline | type == "string" and length > 0 and (test("[{}]") | not))
        and ($character.selection.detail | type == "string" and length > 0 and (test("[{}]") | not))
        and ($character.assets | type == "array" and length > 0)
        and ($character.states | type == "array" and length > 0)
        and ($character.previews | type == "array")
        and ([$character.assets[].id] | unique_strings)
        and ([$character.states[].id] | unique_strings)
        and ([$character.previews[].id] | unique_strings)
        and ([$character.states[].id] == $manifest.applicationStates)
        and any($character.assets[]; .id == $character.rootAsset)
        and (if $character | has("entrance") then
          ($character.entrance as $e |
            ($e | keys) == ["jump", "land", "peek", "sequence"]
            and all([$e.peek, $e.jump, $e.land][]; type == "number" and floor == .)
            and $e.peek > 0 and $e.jump > $e.peek and $e.land > $e.jump
            and any($manifest.sequences[];
              .id == $e.sequence and .character == $character.id and .kind == "event"
              and .acceptance == "approved"
              and $e.land < $manifest.production.durationSeconds * (.framesPerSecond // $manifest.production.framesPerSecond)))
        else true end)
        and ($character.backgroundTexture.resource | type == "string" and length > 0)
        and ($character.backgroundTexture.source | type == "string" and length > 0)
        and ($character.backgroundTexture.sha256 | type == "string" and length == 64)
        and ($character.generation.anchorUrl | type == "string" and length > 0)
        and ($character.generation.anchorSha256 | type == "string" and length == 64)
        and all($character.assets[];
          (.id | type == "string" and length > 0)
          and (.resource | type == "string" and length > 0)
          and (.source | type == "string" and length > 0)
          and (.sha256 | type == "string" and length == 64)
          and (.geometry.canvasWidth > 0)
          and (.geometry.canvasHeight > 0)
          and (.geometry.bodyBottom > 0 and .geometry.bodyBottom <= .geometry.canvasHeight)
          and (.geometry.visualBounds.x >= 0 and .geometry.visualBounds.y >= 0)
          and (.geometry.visualBounds.width > 0 and .geometry.visualBounds.height > 0)
          and (.geometry.visualBounds.x + .geometry.visualBounds.width <= .geometry.canvasWidth)
          and (.geometry.visualBounds.y + .geometry.visualBounds.height <= .geometry.canvasHeight)
        )
        and ([
          $character.states[]
          | select(.motion.type == "state")
          | { asset: .asset, sequence: .motion.sequence }
        ] | group_by(.asset) | all(.[]; ([.[].sequence] | unique | length) == 1))
        and all($character.states[]; . as $state |
          ($state.id | type == "string" and length > 0)
          and any($character.assets[]; .id == $state.asset)
          and ($state.presentation.title | type == "string" and length > 0)
          and ($state.presentation.detail | type == "string" and length > 0)
          and ($state.presentation.accent | IN("secondary", "green", "amber", "rose", "purple"))
          and (
            if $state.motion.type == "static" then true
            elif $state.motion.type == "state" then
              any($manifest.sequences[];
                .id == $state.motion.sequence
                and .character == $character.id
                and .kind == "state"
                and (.acceptance == "approved" or .acceptance == "approved-reference")
                and .targetAsset == $state.asset
              )
            elif $state.motion.type == "continuous" then
              ($state.motion | keys) == ["sequence", "type"]
              and $state.asset == $character.rootAsset
              and any($manifest.sequences[];
                .id == $state.motion.sequence and .character == $character.id
                and .kind == "sustained" and .acceptance == "approved")
            elif $state.motion.type == "intermittent" then
              ($state.motion.sequences | type == "array" and length > 0)
              and ($state.motion.sequences | unique_strings)
              and all($state.motion.sequences[]; . as $sequence_id |
                any($manifest.sequences[];
                  .id == $sequence_id
                  and .character == $character.id
                  and .kind == "loop"
                  and (.acceptance == "approved" or .acceptance == "approved-reference")
                )
              )
              and (
                if $state.motion.type == "intermittent" then
                  ($state.motion.minimumDelaySeconds >= 0)
                  and ($state.motion.maximumDelaySeconds >= $state.motion.minimumDelaySeconds)
                else true end
              )
            else false end
          )
        )
        and all($character.previews[]; . as $preview |
          ($preview.id | type == "string" and length > 0)
          and ($preview.title | type == "string" and length > 0)
          and ($preview.group | type == "string" and length > 0)
          and (
            if $preview.type == "sequence" then
              any($manifest.sequences[];
                .id == $preview.target
                and .character == $character.id
                and (
                  .acceptance == "approved"
                  or .acceptance == "approved-reference"
                  or ((.acceptance == "rejected" or .acceptance == "candidate") and .bundledForPreview == true)
                )
              )
            elif $preview.type == "state" then
              any($character.states[]; .id == $preview.target)
            else false end
          )
        )
      )
      and all(.sequences[]; . as $sequence |
        ($sequence.id | type == "string" and length > 0)
        and (if has("framesPerSecond") then .framesPerSecond | type == "number" else true end)
        and ((.framesPerSecond // $manifest.production.framesPerSecond) as $fps |
          ($fps | floor == . and . >= 1 and . <= 60)
          and ($fps * $manifest.production.durationSeconds | floor == . and . >= 2 and . <= 600))
        and (if has("sourceFrames") then .sourceFrames as $r |
          ($r | type == "object" and keys == ["end", "start"])
          and ($r.start | type == "number" and floor == . and . >= 0)
          and ($r.end | type == "number" and floor == .) and $r.end > $r.start
          and $r.end < ($manifest.production.durationSeconds * ($sequence.framesPerSecond // $manifest.production.framesPerSecond))
          else true end)
        and ($sequence.asset | type == "string" and length > 0)
        and ($sequence.prompt | type == "string" and length > 0)
        and ($sequence.acceptance | IN("candidate", "rejected", "approved", "approved-reference"))
        and (($sequence.generation.inputBackground // "transparent") | IN("transparent", "chroma"))
        and ((($sequence.generation // {}) | keys) - ["anchor", "inputBackground", "model", "resolution", "motionReference", "conditioning", "actingReference"] | length == 0)
        and (($sequence.generation.conditioning // "endpoints") | IN("endpoints", "first-frame"))
        and (if $sequence.generation.conditioning == "first-frame" then
          $sequence.kind == "event" and $sequence.generation.motionReference == null and $sequence.generation.actingReference == null
        else true end)
        and (if $sequence.generation.actingReference != null then
          ($sequence.kind == "event" or ($sequence.kind == "sustained" and $sequence.generation.conditioning == "endpoints"))
          and ($sequence.generation.actingReference | keys) == ["sha256", "source"]
          and ($sequence.generation.actingReference.source | type == "string" and test("^motion/references/[A-Za-z0-9_-]+\\.png$"))
          and ($sequence.generation.actingReference.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
        else true end)
        and (if $sequence.generation.motionReference != null then
          $sequence.kind == "event"
          and ($sequence.generation.motionReference | keys) == ["sha256", "url"]
          and ($sequence.generation.motionReference.url | type == "string" and test("^(https|asset)://[^[:space:]]+$"))
          and ($sequence.generation.motionReference.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
        else true end)
        and (($sequence.generation.anchor // "reference") | IN("reference", "root"))
        and (($sequence.generation.model // $manifest.production.model) | IN("dreamina-seedance-2-0-fast-260128", "dreamina-seedance-2-0-260128", "dreamina-seedance-2-5-260628"))
        and (($sequence.generation.resolution // $manifest.production.resolution) | IN("720p", "1080p"))
        and (if ($sequence.generation.model // $manifest.production.model) == "dreamina-seedance-2-0-fast-260128" then ($sequence.generation.resolution // $manifest.production.resolution) == "720p" else true end)
        and (
          if $sequence.bundledForPreview == true then
            ($sequence.acceptance == "rejected" or $sequence.acceptance == "candidate")
          else true end
        )
        and any($manifest.characters[]; .id == $sequence.character)
        and ($sequence.kind | IN("loop", "sustained", "state", "event"))
        and (if $sequence.kind == "sustained" then .cycle as $c |
          ($c | type == "object" and keys == ["end", "start"])
          and ($c.start | type == "number" and floor == . and . > 0)
          and ($c.end | type == "number" and floor == .) and $c.end > $c.start + 1
          and $c.end < (if $sequence.sourceFrames != null then $sequence.sourceFrames.end - $sequence.sourceFrames.start else $manifest.production.durationSeconds * ($sequence.framesPerSecond // $manifest.production.framesPerSecond) - 1 end)
          else (has("cycle") | not) end)
        and (if $sequence.kind == "event" then
          ($sequence.stage as $s |
            ($s | keys) == ["end", "size", "start"]
            and ($s.size | type == "number" and floor == . and . > 0)
            and all([$s.start, $s.end][];
              (keys == ["x", "y"])
              and (.x | type == "number" and floor == . and . >= 0)
              and (.y | type == "number" and floor == . and . >= 0))
            and any($manifest.characters[]; . as $c | .id == $sequence.character
              and any(.assets[]; . as $a | .id == $c.rootAsset
                and all([$s.start, $s.end][];
                  .x + $a.geometry.canvasWidth <= $s.size
                  and .y + $a.geometry.canvasHeight <= $s.size)))
          )
          and $sequence.targetAsset == null
        else $sequence.stage == null end)
        and (
          if ($sequence.acceptance == "approved" or $sequence.acceptance == "approved-reference" or $sequence.bundledForPreview == true) then
            ($sequence.assetSha256 | type == "string" and length == 64)
          else true end
        )
        and (
          if $sequence.acceptance == "approved" then
            ($sequence.generationTaskId | type == "string" and length > 0)
            and ($sequence.sourceSha256 | type == "string" and length == 64)
          elif $sequence.acceptance == "approved-reference" then
            ($sequence.generationTaskId | type == "string" and length > 0)
          else true end
        )
        and (
          if $sequence.kind == "state" and ($sequence.acceptance == "approved" or $sequence.acceptance == "approved-reference") then
            ($sequence.targetAsset | type == "string" and length > 0)
            and any($manifest.characters[];
              .id == $sequence.character
              and any(.assets[]; .id == $sequence.targetAsset)
            )
          else true end
        )
      )
  ' "$MANIFEST" >/dev/null || fail "motion manifest violates the character-motion protocol"
}

compare_exact() {
  local expected="$1"
  local actual="$2"
  local difference
  difference="$(magick compare -metric AE "$expected" "$actual" null: 2>&1 || true)"
  [[ "$difference" == "0" || "$difference" == "0 (0)" ]]
}

normalized_image_distance() {
  local first="$1"
  local second="$2"
  magick compare -metric RMSE "$first" "$second" null: 2>&1 \
    | sed -n 's/.*(\([0-9.]*\)).*/\1/p' || true
}

assert_maximum_image_distance() {
  local label="$1"
  local first="$2"
  local second="$3"
  local maximum="$4"
  local normalization="${5:-1}"
  local actual
  actual="$(normalized_image_distance "$first" "$second")"
  [[ -n "$actual" ]] || fail "could not measure $label image distance"
  actual="$(awk -v value="$actual" -v scale="$normalization" 'BEGIN { printf "%.8f", value * scale }')"
  awk -v actual="$actual" -v maximum="$maximum" \
    'BEGIN { exit !(actual <= maximum) }' \
    || fail "$label image distance $actual exceeds the approved maximum $maximum"
  printf '%s\n' "$actual"
}

verify_matte() {
  bun "$ROOT_DIR/script/motion_matte.ts" verify "$1" "$2"
}

prepare_input() {
  local character_id="${1:-}"
  local output="${2:-}"
  [[ -n "$character_id" && -n "$output" ]] \
    || fail "usage: $0 prepare-input <character-id> <output.png>"
  require_tool magick
  local character anchor_url anchor_sha actual_sha downloaded local_source
  character="$(character_json "$character_id")"
  anchor_url="$(jq -er '.generation.anchorUrl' <<<"$character")"
  anchor_url="$(resolve_asset_url "$anchor_url")"
  anchor_sha="$(jq -er '.generation.anchorSha256' <<<"$character")"
  mkdir -p "$(dirname "$output")"
  if [[ "$anchor_url" == local://* ]]; then
    local_source="${anchor_url#local://}"
    [[ "$local_source" != /* && "$local_source" != *..* ]] \
      || fail "local generation anchor must stay inside the repository"
    downloaded="$ROOT_DIR/$local_source"
    [[ -f "$downloaded" ]] || fail "missing local generation anchor: $local_source"
  else
    require_tool curl
    downloaded="$(mktemp "${TMPDIR:-/tmp}/mochi-generation-anchor.XXXXXX")"
    curl -fsSL "$anchor_url" -o "$downloaded"
  fi
  actual_sha="$(shasum -a 256 "$downloaded" | awk '{print $1}')"
  [[ "$actual_sha" == "$anchor_sha" ]] || fail \
    "generation anchor hash mismatch: expected $anchor_sha, got $actual_sha"
  cp "$downloaded" "$output"
  [[ "$anchor_url" == local://* ]] || rm -f "$downloaded"
  echo "Prepared pinned high-resolution transparent generation anchor: $output"
}

prepare_sequence_input() {
  local id="${1:-}" output="${2:-}"
  local endpoint="${3:-start}"
  [[ "$endpoint" == "start" || "$endpoint" == "end" ]] || fail "invalid event endpoint"
  [[ -n "$id" && -n "$output" ]] || fail "usage: $0 prepare-sequence-input <sequence-id> <output.png>"
  local sequence character character_id input_background scratch root asset
  sequence="$(sequence_json "$id")"
  character_id="$(jq -er '.character' <<<"$sequence")"
  character="$(character_json "$character_id")"
  input_background="$(jq -r '.generation.inputBackground // "transparent"' <<<"$sequence")"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/mochi-motion-input.XXXXXX")"
  if [[ "$(jq -r '.generation.anchor // "reference"' <<<"$sequence")" == "root" ]]; then
    root="$(canonical_root "$character")"
    asset="$(character_asset_json "$character" "$(jq -r '.rootAsset' <<<"$character")")"
    [[ "$(shasum -a 256 "$root" | awk '{print $1}')" == "$(jq -r '.sha256' <<<"$asset")" ]] \
      || fail "canonical root hash mismatch"
    cp "$root" "$scratch/anchor.png"
  else
    prepare_input "$character_id" "$scratch/anchor.png" >/dev/null
  fi
  if [[ "$(jq -r '.kind' <<<"$sequence")" == "event" ]]; then
    event_input "$sequence" "$character" "$endpoint" "$scratch/anchor.png" "$scratch/stage.png"
    mv "$scratch/stage.png" "$scratch/anchor.png"
  fi
  mkdir -p "$(dirname "$output")"
  if [[ "$input_background" == "chroma" ]]; then
    magick -regard-warnings "$scratch/anchor.png" \
      -background "#$(production_value chromaBackground)" -alpha remove -alpha off \
      -strip -define png:exclude-chunks=date,time "$output"
  else
    cp "$scratch/anchor.png" "$output"
  fi
  rm -rf "$scratch"
  echo "Prepared $input_background generation input: $output"
}

# Preserve the pinned source pixels at their native density. Stage coordinates
# remain in runtime-root units; only the empty generation canvas is denser.
# Compilation below ALWAYS uses event_root and the exact runtime PNG instead.
event_input() {
  local sequence="$1" character="$2" endpoint="$3" input="$4" output="$5"
  local geometry width height size x y
  geometry="$(character_asset_json "$character" "$(jq -r '.rootAsset' <<<"$character")")"
  read -r width height <<<"$(magick identify -format '%w %h' "$input")"
  read -r size x y <<<"$(jq -ern --argjson s "$sequence" --argjson a "$geometry" \
    --argjson w "$width" --argjson h "$height" --arg point "$endpoint" '
      ($w / $a.geometry.canvasWidth) as $density |
      if $density != ($h / $a.geometry.canvasHeight) then error("generation anchor aspect mismatch") else
        [$s.stage.size, $s.stage[$point].x, $s.stage[$point].y] | map(. * $density) |
        if all(.[]; floor == .) then @tsv else error("fractional generation stage placement") end
      end')" || fail "invalid generation stage density"
  [[ -n "$size" && -n "$x" && -n "$y" ]] || fail "invalid generation stage placement"
  magick -size "${size}x${size}" xc:none "$input" -geometry "+$x+$y" \
    -define compose:outside-overlay=false -compose Src -composite -strip \
    -define png:exclude-chunks=date,time "$output"
}

event_root() {
  local sequence="$1" character="$2" endpoint="$3" output="$4"
  local size x y root
  size="$(jq -r '.stage.size' <<<"$sequence")"
  x="$(jq -r --arg point "$endpoint" '.stage[$point].x' <<<"$sequence")"
  y="$(jq -r --arg point "$endpoint" '.stage[$point].y' <<<"$sequence")"
  root="$(canonical_root "$character")"
  magick -size "${size}x${size}" xc:none "$root" -geometry "+$x+$y" \
    -define compose:outside-overlay=false -compose Src -composite -strip \
    -define png:exclude-chunks=date,time "$output"
}

generate() {
  local id="${1:-}"
  local output="${2:-}"
  [[ -n "$id" && -n "$output" ]] || fail "usage: $0 generate <sequence-id> <output.mp4>"
  local sequence character prompt_path cli scratch input anchor input_background
  sequence="$(sequence_json "$id")"
  character="$(sequence_character_json "$sequence")"
  prompt_path="$ROOT_DIR/$(jq -er '.prompt' <<<"$sequence")"
  [[ -f "$prompt_path" ]] || fail "prompt is missing: $prompt_path"
  cli="${SEEDANCE_VIDEO_CLI:-seedance-video.sh}"
  [[ -x "$cli" ]] || command -v "$cli" >/dev/null 2>&1 || fail \
    "set SEEDANCE_VIDEO_CLI to an executable seedance-video.sh"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/mochi-motion-generate.XXXXXX")"
  input="$scratch/generation-anchor.png"
  prepare_sequence_input "$id" "$input" >/dev/null
  anchor="$(jq -r '.generation.anchor // "reference"' <<<"$sequence")"
  input_background="$(jq -r '.generation.inputBackground // "transparent"' <<<"$sequence")"
  mkdir -p "$(dirname "$output")"
  if [[ "$anchor" == "reference" && "$input_background" == "transparent" && "$(jq -r '.kind' <<<"$sequence")" != "event" ]]; then
    resolve_asset_url "$(jq -er '.generation.anchorUrl' <<<"$character")" > "$scratch/image-url"
  else
    # The body file keeps the exact prepared pixels out of the caller's command.
    printf 'data:image/png;base64,' > "$scratch/image-url"
    base64 < "$input" | tr -d '\r\n' >> "$scratch/image-url"
  fi
  local final_input="$scratch/final.png"
  touch "$scratch/final-url"
  if [[ "$(jq -r '.kind' <<<"$sequence")" == "event" ]] ||
     [[ "$(jq -r '.kind | IN("loop", "sustained")' <<<"$sequence")" == "true" && "$(jq -r '.generation.conditioning // ""' <<<"$sequence")" == "endpoints" ]]; then
    prepare_sequence_input "$id" "$final_input" end >/dev/null
    printf 'data:image/png;base64,' > "$scratch/final-url"
    base64 < "$final_input" | tr -d '\r\n' >> "$scratch/final-url"
  fi
  local motion_reference reference_sha
  motion_reference="$(jq -r '.generation.motionReference.url // ""' <<<"$sequence")"
  [[ -z "$motion_reference" ]] || motion_reference="$(resolve_asset_url "$motion_reference")"
  if [[ -n "$motion_reference" ]]; then
    # Reference mode is not first/last-frame mode. Verify the exact motion source
    # before sending its public URL; compilation still enforces both root seams.
    curl -fsSL --max-time 60 "$motion_reference" -o "$scratch/reference.mp4"
    reference_sha="$(shasum -a 256 "$scratch/reference.mp4" | awk '{print $1}')"
    [[ "$reference_sha" == "$(jq -r '.generation.motionReference.sha256' <<<"$sequence")" ]] \
      || fail "motion reference hash mismatch"
    echo "Motion reference verified: sha256=$reference_sha"
  fi
  local acting_source acting_sha
  acting_source="$(jq -r '.generation.actingReference.source // ""' <<<"$sequence")"
  touch "$scratch/acting-url"
  if [[ -n "$acting_source" ]]; then
    [[ ! -L "$ROOT_DIR/motion" && ! -L "$ROOT_DIR/motion/references" ]] || fail "acting reference directory must not be a symlink"
    [[ -f "$ROOT_DIR/$acting_source" && ! -L "$ROOT_DIR/$acting_source" ]] || fail "acting reference must be a real project image"
    acting_sha="$(shasum -a 256 "$ROOT_DIR/$acting_source" | awk '{print $1}')"
    [[ "$acting_sha" == "$(jq -r '.generation.actingReference.sha256' <<<"$sequence")" ]] || fail "acting reference hash mismatch"
    printf 'data:image/png;base64,' > "$scratch/acting-url"
    base64 < "$ROOT_DIR/$acting_source" | tr -d '\r\n' >> "$scratch/acting-url"
    echo "Acting reference verified: sha256=$acting_sha"
  fi
  jq -n --slurpfile manifest "$MANIFEST" --argjson sequence "$sequence" --rawfile prompt "$prompt_path" \
    --arg motion_reference "$motion_reference" \
    --rawfile acting "$scratch/acting-url" \
    --rawfile final "$scratch/final-url" \
    --rawfile image "$scratch/image-url" '
    ($manifest[0].production + ($sequence.generation // {})) as $p | {
      provider: "byteplus-direct", model: $p.model, prompt: $prompt, image_url: $image,
      resolution: $p.resolution, aspect_ratio: $p.ratio,
      duration: $p.durationSeconds, audio: $p.audio,
      use_character_assets: $p.useCharacterAssets
    } | if $motion_reference != "" or $acting != "" then
      del(.image_url) + {image_urls: ([$image, $final] + (if $acting != "" then [$acting] else [] end))}
      + (if $motion_reference != "" then {video_urls: [$motion_reference]} else {} end)
    elif ($sequence.kind == "event" and $sequence.generation.conditioning != "first-frame")
      or (($sequence.kind | IN("loop", "sustained")) and $sequence.generation.conditioning == "endpoints")
      then del(.image_url) + {key_frames: [$image, $final]} else . end' > "$scratch/request.json"
  echo "Generation input: anchor=$anchor; background=$input_background; first-frame=$(shasum -a 256 "$input" | awk '{print $1}'); model=$(jq -r '.model' "$scratch/request.json"); resolution=$(jq -r '.resolution' "$scratch/request.json")"
  "$cli" --body-file "$scratch/request.json" --download "$output"
  rm -rf "$scratch"
  echo "Generated source video: $output"
}

render() {
  local id="${1:-}"
  local source="${2:-}"
  local staging="${3:-}"
  [[ -n "$id" && -n "$source" && -n "$staging" ]] \
    || fail "usage: $0 render <sequence-id> <source.mp4> <staging-directory>"
  [[ -f "$source" ]] || fail "source video is missing: $source"
  require_tool ffmpeg
  require_tool ffprobe
  require_tool magick
  require_tool cwebp
  require_tool webpmux

  local sequence character asset kind frame_count fps duration plate_color root
  sequence="$(sequence_json "$id")"
  character="$(sequence_character_json "$sequence")"
  asset="$(jq -er '.asset' <<<"$sequence")"
  [[ ! -e "$staging/$asset.webp" ]] \
    || fail "staging already contains an encoded asset; use a fresh review directory"
  kind="$(jq -er '.kind' <<<"$sequence")"
  frame_count="$(sequence_frame_count "$sequence")"
  fps="$(sequence_fps "$sequence")"
  duration="$(production_value durationSeconds)"
  plate_color="$(production_value chromaBackground)"
  root="$(canonical_root "$character")"

  local dimensions source_duration canvas_size normalization=1
  canvas_size="$(jq -r --arg root "$(jq -r '.rootAsset' <<<"$character")" '.assets[] | select(.id == $root) | .geometry.canvasWidth' <<<"$character")"
  if [[ "$kind" == "event" ]]; then
    normalization="$(awk -v stage="$(jq -r '.stage.size' <<<"$sequence")" -v root="$canvas_size" 'BEGIN { print stage / root }')"
    canvas_size="$(jq -r '.stage.size' <<<"$sequence")"
  fi
  dimensions="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
    -of csv=s=x:p=0 "$source")"
  [[ "${dimensions%x*}" == "${dimensions#*x}" ]] \
    || fail "source must be square, got $dimensions"
  source_duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$source")"
  awk -v actual="$source_duration" -v expected="$duration" \
    'BEGIN { exit !(actual >= expected - 0.15 && actual <= expected + 0.35) }' \
    || fail "source duration must remain approximately ${duration}s, got ${source_duration}s"

  local work frames source_frames matte_frames output_webp last_index key_sample key_color
  work="$(mktemp -d "${TMPDIR:-/tmp}/mochi-motion-render.XXXXXX")"
  frames="$work/frames"
  source_frames="$work/source-frames"
  matte_frames="$work/matte-frames"
  mkdir -p "$frames" "$source_frames" "$matte_frames" "$staging"
  key_sample="$work/key-sample.png"
  ffmpeg -y -hide_banner -loglevel error -ss 2 -i "$source" -frames:v 1 "$key_sample"
  key_color="$(magick "$key_sample" -crop 32x32+8+8 +repage -resize 1x1! -depth 8 \
    -format '%[hex:p{0,0}]' info:)"
  [[ "$key_color" =~ ^[[:xdigit:]]{6}$ ]] \
    || fail "could not sample a stable six-digit background color from the source"
  local chroma_hue chroma_saturation minimum_chroma_hue maximum_chroma_hue
  local minimum_chroma_saturation
  chroma_hue="$(magick "xc:#$key_color" -colorspace HSB -format '%[fx:u.r]' info:)"
  chroma_saturation="$(magick "xc:#$key_color" -colorspace HSB -format '%[fx:u.g]' info:)"
  minimum_chroma_hue="$(production_value minimumChromaHue)"
  maximum_chroma_hue="$(production_value maximumChromaHue)"
  minimum_chroma_saturation="$(production_value minimumChromaSaturation)"
  awk \
    -v hue="$chroma_hue" \
    -v minimum_hue="$minimum_chroma_hue" \
    -v maximum_hue="$maximum_chroma_hue" \
    -v saturation="$chroma_saturation" \
    -v minimum_saturation="$minimum_chroma_saturation" \
    'BEGIN { exit !(hue >= minimum_hue && hue <= maximum_hue && saturation >= minimum_saturation) }' \
    || fail "source chroma background #$key_color is not a saturated blue plate (hue $chroma_hue, saturation $chroma_saturation)"
  # Recover source coverage before any resampling. The same deep module owns
  # foreground protection, color decontamination and material measurements.
  local source_start
  source_start="$(jq -r '.sourceFrames.start // 0' <<<"$sequence")"
  ffmpeg -y -hide_banner -loglevel error -i "$source" \
    -vf "fps=$fps,trim=start_frame=$source_start:end_frame=$((source_start + frame_count)),setpts=PTS-STARTPTS,format=rgb24" -frames:v "$frame_count" \
    -start_number 0 "$source_frames/frame-%02d.png"
  bun "$ROOT_DIR/script/motion_matte.ts" extract "$id" "$source_frames" "$matte_frames"
  local index
  for ((index=0; index<frame_count; index++)); do
    local frame
    frame="$(printf '%s/frame-%02d.png' "$matte_frames" "$index")"
    magick "$frame" -filter Lanczos -resize "${canvas_size}x${canvas_size}!" \
      "$frames/$(basename "$frame")"
    # One finishing boundary owns palette calibration followed by edge repair.
    # No later colour offset may put a blue cast back into clean fibres.
    bun "$ROOT_DIR/script/motion_matte.ts" finish \
      "$frames/$(basename "$frame")" "$root" \
      "$frames/$(basename "$frame").locked.png"
    mv "$frames/$(basename "$frame").locked.png" "$frames/$(basename "$frame")"
  done

  last_index="$((frame_count - 1))"
  cp "$root" "$frames/frame-00.png"
  if [[ "$kind" == "event" ]]; then
    event_root "$sequence" "$character" start "$frames/frame-00.png"
    event_root "$sequence" "$character" end "$(printf '%s/frame-%02d.png' "$frames" "$last_index")"
  elif [[ "$kind" == "loop" || "$kind" == "sustained" ]]; then
    cp "$root" "$(printf '%s/frame-%02d.png' "$frames" "$last_index")"
  else
    local target_name target_path target_output last_frame
    target_path="$(sequence_target_path "$sequence" "$character")"
    target_name="$(basename "$target_path")"
    target_output="$staging/$target_name"
    last_frame="$(printf '%s/frame-%02d.png' "$frames" "$last_index")"
    cp "$last_frame" "$target_output"
  fi

  # Review evidence belongs to failed extractions too. Never require a passing
  # gate just to see which fibers or seam pixels the compiler discarded.
  local indices=() sample
  for sample in {0..8}; do
    indices+=( "$(printf '%02d' "$((sample * last_index / 8))")" )
  done
  magick \
    "$frames/frame-${indices[0]}.png" "$frames/frame-${indices[1]}.png" \
    "$frames/frame-${indices[2]}.png" "$frames/frame-${indices[3]}.png" \
    "$frames/frame-${indices[4]}.png" "$frames/frame-${indices[5]}.png" \
    "$frames/frame-${indices[6]}.png" "$frames/frame-${indices[7]}.png" \
    "$frames/frame-${indices[8]}.png" \
    -thumbnail 220x220 -background "#$plate_color" -gravity center -extent 228x228 +append \
    "$staging/$asset-contact.png"
  local review_frame
  review_frame="$(printf '%s/frame-%02d.png' "$frames" "$((frame_count / 2))")"
  magick "$review_frame" -background "#$plate_color" -alpha remove -alpha off \
    "$work/edge-app-blue.png"
  magick "$review_frame" -background '#C03579' -alpha remove -alpha off \
    "$work/edge-magenta.png"
  magick "$review_frame" -background '#222222' -alpha remove -alpha off \
    "$work/edge-dark.png"
  magick "$work/edge-app-blue.png" "$work/edge-magenta.png" "$work/edge-dark.png" \
    -thumbnail 360x360 -background white -gravity center -extent 368x368 +append \
    "$staging/$asset-edge-review.png"
  magick "$frames/frame-00.png" "$frames/frame-01.png" \
    "$(printf '%s/frame-%02d.png' "$frames" "$((last_index - 1))")" \
    "$(printf '%s/frame-%02d.png' "$frames" "$last_index")" \
    -background '#222222' -alpha remove -alpha off -thumbnail 360x360 +append \
    "$staging/$asset-seams.png"

  local root_seam_distance ending_seam_distance ending_seam_maximum
  root_seam_distance="$(assert_maximum_image_distance \
    "$id root seam" "$frames/frame-00.png" "$frames/frame-01.png" \
    "$(production_value maximumRootSeamDistance)" "$normalization")"
  if [[ "$kind" != "state" ]]; then
    ending_seam_maximum="$(production_value maximumLoopSeamDistance)"
  else
    ending_seam_maximum="$(production_value maximumStateSettleDistance)"
  fi
  ending_seam_distance="$(assert_maximum_image_distance \
    "$id ending seam" \
    "$(printf '%s/frame-%02d.png' "$frames" "$((last_index - 1))")" \
    "$(printf '%s/frame-%02d.png' "$frames" "$last_index")" \
    "$ending_seam_maximum" "$normalization")"

  local cycle_seam_distance="none"
  if [[ "$kind" == "sustained" ]]; then
    cycle_seam_distance="$(verify_cycle "$id" "$sequence" "$frames")"
  fi

  local matte_metrics soft_alpha_ratio perimeter_complexity
  matte_metrics="$(verify_matte "$id" "$frames")"
  soft_alpha_ratio="${matte_metrics%% *}"
  perimeter_complexity="${matte_metrics##* }"

  output_webp="$staging/$asset.webp"
  local encoded_frames="$work/encoded"
  local mux_arguments=()
  local encode_jobs=()
  mkdir -p "$encoded_frames"
  for ((index=0; index<frame_count; index++)); do
    frame="$(printf '%s/frame-%02d.png' "$frames" "$index")"
    local encoded="$encoded_frames/$(basename "${frame%.png}.webp")"
    cwebp -quiet -lossless -m 6 -exact "$frame" -o "$encoded" &
    encode_jobs+=( "$!" )
    mux_arguments+=( -frame "$encoded" "+$(((index + 1) * 1000 / fps - index * 1000 / fps))+0+0+0-b" )
    # Lossless frame encodes are independent. Bound their concurrency while
    # retaining the original frame order and exact codec settings in the mux.
    if [[ ${#encode_jobs[@]} -eq 4 || $index -eq $((frame_count - 1)) ]]; then
      local encode_failed=false encode_pid
      for encode_pid in "${encode_jobs[@]}"; do
        if ! wait "$encode_pid"; then encode_failed=true; fi
      done
      [[ "$encode_failed" == false ]] || fail "frame encoding failed"
      encode_jobs=()
    fi
  done
  webpmux "${mux_arguments[@]}" -loop 1 -bgcolor 0,0,0,0 -o "$output_webp" >/dev/null

  {
    echo "sequence=$id"
    echo "source_sha256=$(shasum -a 256 "$source" | awk '{print $1}')"
    echo "asset_sha256=$(shasum -a 256 "$output_webp" | awk '{print $1}')"
    if [[ "$kind" == "state" ]]; then
      echo "target_sha256=$(shasum -a 256 "$target_output" | awk '{print $1}')"
    fi
    echo "source_duration_seconds=$source_duration"
    echo "sampled_chroma_key=$key_color"
    echo "sampled_chroma_hue=$chroma_hue"
    echo "sampled_chroma_saturation=$chroma_saturation"
    echo "matte_plate_calibration=per-frame-four-corner"
    echo "perimeter_alpha_threshold=$(production_value matting.perimeterAlphaThreshold)"
    echo "root_seam_distance=$root_seam_distance"
    echo "ending_seam_distance=$ending_seam_distance"
    echo "cycle_seam_distance=$cycle_seam_distance"
    echo "source_first_frame=$source_start"
    echo "source_last_frame=$((source_start + frame_count - 1))"
    echo "average_soft_alpha_ratio=$soft_alpha_ratio"
    echo "average_perimeter_complexity=$perimeter_complexity"
    echo "frames=$frame_count"
    echo "frames_per_second=$fps"
    echo "duration_ms=$((frame_count * 1000 / fps))"
    echo "approval=pending-real-app-review"
  } > "$staging/$asset-report.txt"
  rm -rf "$work"
  echo "Staged motion for review: $output_webp"
}

verify_cycle() {
  local id="$1" sequence="$2" frames="$3" start end
  start="$(jq -r '.cycle.start' <<<"$sequence")"
  end="$(jq -r '.cycle.end' <<<"$sequence")"
  # A sustained seam is inside the activity, never the canonical neutral root.
  # Use the strict existing stable-state gate, not the looser root-loop bound.
  assert_maximum_image_distance "$id activity seam" \
    "$(printf '%s/frame-%02d.png' "$frames" "$((end - 1))")" \
    "$(printf '%s/frame-%02d.png' "$frames" "$start")" \
    "$(production_value maximumStateSettleDistance)" 1
}

verify_sequence() {
  local sequence="$1"
  local character id asset kind target root webp frame_count info actual_frames loop_count
  local acceptance task_id source_sha expected_asset_sha actual_asset_sha expected_target_sha actual_target_sha target_asset
  id="$(jq -er '.id' <<<"$sequence")"
  character="$(sequence_character_json "$sequence")"
  asset="$(jq -er '.asset' <<<"$sequence")"
  kind="$(jq -er '.kind' <<<"$sequence")"
  acceptance="$(jq -er '.acceptance' <<<"$sequence")"
  task_id="$(jq -r '.generationTaskId // ""' <<<"$sequence")"
  source_sha="$(jq -r '.sourceSha256 // ""' <<<"$sequence")"
  [[ -n "$task_id" ]] || fail "$id is approved without a generation task ID"
  if [[ "$acceptance" == "approved" ]]; then
    [[ -n "$source_sha" ]] || fail "$id is approved without a source video hash"
  fi
  root="$(canonical_root "$character")"
  webp="$RESOURCES/$asset.webp"
  frame_count="$(sequence_frame_count "$sequence")"
  local fps
  fps="$(sequence_fps "$sequence")"
  [[ -f "$webp" ]] || fail "$id asset is missing: $webp"
  expected_asset_sha="$(jq -r '.assetSha256 // ""' <<<"$sequence")"
  [[ -n "$expected_asset_sha" ]] || fail "$id is approved without a compiled asset hash"
  actual_asset_sha="$(shasum -a 256 "$webp" | awk '{print $1}')"
  [[ "$actual_asset_sha" == "$expected_asset_sha" ]] || fail \
    "$id asset hash mismatch: expected $expected_asset_sha, got $actual_asset_sha"
  info="$(webpmux -info "$webp")"
  actual_frames="$(sed -n 's/Number of frames: //p' <<<"$info")"
  loop_count="$(sed -n 's/Background color.*Loop Count : //p' <<<"$info")"
  [[ "$actual_frames" == "$frame_count" ]] || fail \
    "$id has $actual_frames frames; approved production requires $frame_count"
  [[ "$loop_count" == "1" ]] || fail "$id WebP loop count must be 1"
  awk -v fps="$fps" \
    '/^[[:space:]]+[0-9]+:/ { if ($7 != int((i+1)*1000/fps)-int(i*1000/fps)) bad = 1; i++ } END { exit bad }' <<<"$info" \
    || fail "$id frame timestamps do not match ${fps}fps"

  local work first last normalization=1
  work="$(mktemp -d "${TMPDIR:-/tmp}/mochi-motion-verify.XXXXXX")"
  magick "$webp" -coalesce "$work/frame-%02d.png"
  first="$work/frame-00.png"
  last="$(printf '%s/frame-%02d.png' "$work" "$((frame_count - 1))")"
  if [[ "$kind" == "event" ]]; then
    local root_width
    root_width="$(magick identify -format '%w' "$root")"
    normalization="$(awk -v stage="$(jq -r '.stage.size' <<<"$sequence")" -v root="$root_width" 'BEGIN { print stage / root }')"
    event_root "$sequence" "$character" start "$work/start.png"
    event_root "$sequence" "$character" end "$work/end.png"
    root="$work/start.png"
  fi
  compare_exact "$root" "$first" || fail "$id does not begin at the exact canonical root"
  if [[ "$kind" == "event" ]]; then
    compare_exact "$work/end.png" "$last" || fail "$id does not land at its lossless canonical root"
  elif [[ "$kind" == "loop" || "$kind" == "sustained" ]]; then
    compare_exact "$root" "$last" || fail "$id does not end at the exact canonical root"
  else
    target="$ROOT_DIR/$(sequence_target_path "$sequence" "$character")"
    target_asset="$(jq -r '.targetAsset // ""' <<<"$sequence")"
    if [[ -n "$target_asset" ]]; then
      expected_target_sha="$(character_asset_json "$character" "$target_asset" | jq -er '.sha256')"
    else
      expected_target_sha="$(jq -r '.targetSha256 // ""' <<<"$sequence")"
    fi
    [[ -n "$expected_target_sha" ]] || fail "$id is an approved state without a target hash"
    actual_target_sha="$(shasum -a 256 "$target" | awk '{print $1}')"
    [[ "$actual_target_sha" == "$expected_target_sha" ]] || fail \
      "$id target hash mismatch: expected $expected_target_sha, got $actual_target_sha"
    compare_exact "$target" "$last" || fail "$id does not end at its exact target frame"
  fi
  assert_maximum_image_distance \
    "$id root seam" "$first" "$work/frame-01.png" \
    "$(production_value maximumRootSeamDistance)" "$normalization" >/dev/null
  if [[ "$kind" != "state" ]]; then
    assert_maximum_image_distance \
      "$id ending seam" "$(printf '%s/frame-%02d.png' "$work" "$((frame_count - 2))")" "$last" \
      "$(production_value maximumLoopSeamDistance)" "$normalization" >/dev/null
  else
    assert_maximum_image_distance \
      "$id ending seam" "$(printf '%s/frame-%02d.png' "$work" "$((frame_count - 2))")" "$last" \
      "$(production_value maximumStateSettleDistance)" >/dev/null
  fi
  if [[ "$kind" == "sustained" ]]; then
    verify_cycle "$id" "$sequence" "$work" >/dev/null
  fi
  verify_matte "$id" "$work" >/dev/null
  rm -rf "$work"
  echo "verified $id"
}

verify_approved() {
  require_tool jq
  require_tool magick
  require_tool webpmux
  local count=0 sequence approved_sequences character asset path expected_sha actual_sha
  while IFS= read -r character; do
    while IFS= read -r asset; do
      path="$ROOT_DIR/$(jq -er '.source' <<<"$asset")"
      expected_sha="$(jq -er '.sha256' <<<"$asset")"
      actual_sha="$(shasum -a 256 "$path" | awk '{print $1}')"
      [[ "$actual_sha" == "$expected_sha" ]] || fail \
        "character asset hash mismatch: expected $expected_sha, got $actual_sha for $path"
    done < <(jq -c '.assets[]' <<<"$character")
    path="$ROOT_DIR/$(jq -er '.backgroundTexture.source' <<<"$character")"
    expected_sha="$(jq -er '.backgroundTexture.sha256' <<<"$character")"
    actual_sha="$(shasum -a 256 "$path" | awk '{print $1}')"
    [[ "$actual_sha" == "$expected_sha" ]] || fail \
      "background texture hash mismatch: expected $expected_sha, got $actual_sha for $path"
  done < <(jq -c '.characters[]' "$MANIFEST")
  approved_sequences="$(jq -c '.sequences[] | select(.acceptance == "approved-reference" or .acceptance == "approved")' "$MANIFEST")"
  [[ -n "$approved_sequences" ]] || fail "manifest contains no approved motion"
  while IFS= read -r sequence; do
    verify_sequence "$sequence"
    count="$((count + 1))"
  done <<<"$approved_sequences"
  [[ "$count" -gt 0 ]] || fail "manifest contains no approved motion"
  echo "Verified $count approved Mochi motions. Rejected assets were intentionally not promoted."
}

status() {
  jq -r '["CHARACTER", "ID", "ACCEPTANCE", "REASON"], (.sequences[] | [.character, .id, .acceptance, (.rejectionReason // "-")]) | @tsv' "$MANIFEST"
}

require_tool jq
validate_manifest

case "${1:-}" in
validate)
  echo "Character-motion protocol is valid."
  ;;
prepare-input)
  shift
  prepare_input "$@"
  ;;
prepare-sequence-input)
  shift
  prepare_sequence_input "$@"
  ;;
generate)
  shift
  generate "$@"
  ;;
render)
  shift
  render "$@"
  ;;
verify-approved)
  verify_approved
  ;;
status)
  status
  ;;
*)
  fail "usage: $0 {validate|status|prepare-input|prepare-sequence-input|generate|render|verify-approved} ..."
  ;;
esac
