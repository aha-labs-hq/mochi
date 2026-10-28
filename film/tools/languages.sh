#!/bin/zsh -l
# Cuts the film in every other language of src/script.ts. Each language's
# picture is rendered without sound, and takes the mastered sound of the
# original cut, so every language plays the same mix. Run it after
# `bun run master`.
#   zsh tools/languages.sh [language ...]
#     out/master/mochi-film-<cut>.mp4 → out/master/mochi-film-<cut>.<language>.mp4
set -euo pipefail
cd "${0:A:h}/.."
languages=(${@:-$(bun -e 'import { languages } from "./src/script.ts"; console.log(languages.slice(1).join(" "))')})
mkdir -p out/languages
for language in $languages; do
  for id cut in Film 16x9 FilmTall 9x16; do
    sound=out/master/mochi-film-$cut.mp4
    [[ -f $sound ]] || { print -u2 "$sound is missing: run bun run master first"; exit 1; }
    picture=out/languages/mochi-film-$cut.$language.mp4
    bunx remotion render src/index.ts $id $picture --codec h264 --crf 16 --muted --props="{\"language\":\"$language\"}" --log=error
    ffmpeg -y -hide_banner -loglevel error -i $picture -i $sound -map 0:v -map 1:a -c copy -movflags +faststart out/master/mochi-film-$cut.$language.mp4
    print "$language $cut → out/master/mochi-film-$cut.$language.mp4"
  done
done
