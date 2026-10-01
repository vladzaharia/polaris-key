#!/bin/bash
# S-05 (c): export the web probe (single-threaded, no extensions) into c_web/export/ and generate the
# pack sets w1 (1 x 50 MB), w3 (3 x 33 MB) and w6 (6 x 25 MB), 64 entries each, into ../out/c/packs/ (git-ignored).
set -e
cd "$(dirname "$0")"
GODOT=${GODOT:-godot}
PM=$(cd .. && pwd); mkdir -p export "$PM/out/c/packs" "$PM/logs"
"$GODOT" --headless --path probe --import > "$PM/logs/c_import.txt" 2>&1 || true
"$GODOT" --headless --path probe --export-release Web "$PWD/export/index.html" > "$PM/logs/c_export.txt" 2>&1
for spec in "w1 1 50000000" "w3 3 33333333" "w6 6 25000000"; do
  set -- $spec
  for i in $(seq 0 $(($2 - 1))); do
    f="$PM/out/c/packs/$1_$i.pck"
    [ -f "$f" ] || python3 "$PM/tools/gen_packs.py" "$f" $3 64 "data/$1_$i" > /dev/null
  done
done
ls -l export "$PM/out/c/packs"
