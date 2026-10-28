#!/bin/zsh -l
# Masters the rendered cuts for delivery. The mix is brought to -16 LUFS
# integrated, and one limiter at the end of the chain holds its peaks at
# -1.9 dBFS, so the true peak after AAC encoding stays under -1.5 dBFS; the
# picture is copied untouched. The limiter costs loudness on the piano's
# attacks, and more the harder it is driven, so the result is measured
# again and the gain corrected until it is within 0.2 LU of the target; a
# cut that does not get there in six passes fails.
#   zsh tools/master.sh   out/mochi-film-*.mp4 → out/master/mochi-film-*.mp4
set -euo pipefail
cd "${0:A:h}/../out"
mkdir -p master
TARGET=-16.0
loudness() { ffmpeg -hide_banner -nostats -i $1 -af ebur128=peak=true -f null - 2>&1 | awk '/I:/{i=$2} /Peak:/{p=$2} END{print i, p}'; }
for cut in 16x9 9x16; do
  in=mochi-film-$cut.mp4
  read measured _ <<< "$(loudness $in)"
  gain=$(( TARGET - measured ))
  for pass in 1 2 3 4 5 6; do
    ffmpeg -y -hide_banner -loglevel error -i $in -map 0 -c:v copy \
      -af "volume=${gain}dB,alimiter=limit=0.804:attack=4:release=80:level=false" \
      -c:a aac -b:a 320k -movflags +faststart master/$in
    read integrated peak <<< "$(loudness master/$in)"
    miss=$(( TARGET - integrated ))
    (( miss > -0.2 && miss < 0.2 )) && break
    gain=$(( gain + miss ))
  done
  (( miss > -0.2 && miss < 0.2 )) || { print -u2 "$cut: $integrated LUFS after six passes, not $TARGET"; exit 1; }
  (( peak < -1.5 )) || { print -u2 "$cut: true peak $peak dBFS, not under -1.5"; exit 1; }
  printf '%s: %.1f LUFS → %s LUFS, true peak %s dBFS, %s passes\n' $cut $measured $integrated $peak $pass
done
