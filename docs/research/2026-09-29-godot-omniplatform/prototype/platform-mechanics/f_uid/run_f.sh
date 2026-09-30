#!/bin/bash
# S-05 (f): build main + three independently imported data packs, then run the mount cases on the
# official macOS release template. Run from anywhere; writes ../out/f/ and ../logs/f_*.txt.
set -e
cd "$(dirname "$0")"
GODOT=${GODOT:-godot}
OUT=$(cd .. && pwd)/out/f; LOG=$(cd .. && pwd)/logs; mkdir -p "$OUT" "$LOG"
for p in main dataA dataB classpack; do
  "$GODOT" --headless --path $p --import > "$LOG/f_import_$p.txt" 2>&1 || true
done
for p in dataA dataB classpack; do
  "$GODOT" --headless --path $p --export-pack macOS "$OUT/$p.pck" > "$LOG/f_export_$p.txt" 2>&1
  echo "== $p.pck"; python3 ../../patching/tools/pck.py "$OUT/$p.pck" 0 50 | sed 's/^/   /'
done
case_() { local name=$1; shift; echo "== case $name: $*"; ../tplrun_mac.sh main release "$@" 2>&1 | grep -E "S05F|ERROR|WARNING|failed" | tee "$LOG/f_case_$name.txt"; }
case_ none
case_ A_rep_B_rep "$OUT/dataA.pck" "$OUT/dataB.pck"
case_ A_rep_B_norep "$OUT/dataA.pck" "$OUT/dataB.pck:noreplace"
case_ A_norep_B_rep "$OUT/dataA.pck:noreplace" "$OUT/dataB.pck"
case_ A_rep_B_rep_C_rep "$OUT/dataA.pck" "$OUT/dataB.pck" "$OUT/classpack.pck"
case_ C_rep "$OUT/classpack.pck"
case_ C_norep "$OUT/classpack.pck:noreplace"
# Same data packs without the two entries --export-pack always adds (project.binary, class cache).
for p in dataA dataB; do python3 ../tools/strip_pack.py "$OUT/$p.pck" "$OUT/${p}_stripped.pck"; done
case_ AB_stripped "$OUT/dataA_stripped.pck" "$OUT/dataB_stripped.pck"
