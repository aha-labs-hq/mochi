#!/bin/zsh -l
# Generates every still listed in requests/batch.txt that is in neither
# frames/ nor frames/inputs/.
cd "${0:A:h}/.."
while IFS='|' read -r name refs; do
  [[ -f frames/$name.png || -f frames/inputs/$name.png ]] && continue
  echo "[$(date +%T)] $name"
  bun tools/seedream.ts frames/$name.png requests/$name.txt ${=refs} 2>&1 | tail -1
done < requests/batch.txt
echo "[$(date +%T)] done"
