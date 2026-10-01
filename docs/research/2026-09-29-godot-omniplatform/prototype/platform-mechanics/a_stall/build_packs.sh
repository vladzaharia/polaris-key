#!/bin/bash
# S-05 (a): generate the data-only test packs into probe/packs/ (git-ignored) and FILLER small files
# into probe/filler/ (main-project file count; 0 removes them).
set -e
cd "$(dirname "$0")"
G=../tools/gen_packs.py
mkdir -p probe/packs
MB=1000000
[ -f probe/packs/empty.pck ]    || python3 $G probe/packs/empty.pck 1 1
[ -f probe/packs/p5_few.pck ]   || python3 $G probe/packs/p5_few.pck $((5*MB)) 8
[ -f probe/packs/p5_many.pck ]  || python3 $G probe/packs/p5_many.pck $((5*MB)) 320
[ -f probe/packs/p50_few.pck ]  || python3 $G probe/packs/p50_few.pck $((50*MB)) 8
[ -f probe/packs/p50_many.pck ] || python3 $G probe/packs/p50_many.pck $((50*MB)) 3200
[ -f probe/packs/p200_few.pck ] || python3 $G probe/packs/p200_few.pck $((200*MB)) 8
[ -f probe/packs/p200_many.pck ] || python3 $G probe/packs/p200_many.pck $((200*MB)) 12800
[ -f probe/packs/c20k.pck ]     || python3 $G probe/packs/c20k.pck $((5*MB)) 20000
rm -rf probe/filler
if [ "${FILLER:-0}" -gt 0 ]; then
  mkdir -p probe/filler
  python3 - "$FILLER" <<'PY'
import sys
n = int(sys.argv[1])
for i in range(n):
    d = f"probe/filler/d{i // 250:03d}"
    if i % 250 == 0:
        import os; os.makedirs(d, exist_ok=True)
    open(f"{d}/f{i:05d}.txt", "w").write(f"filler {i}\n")
PY
  # include filter must reach the subdirectories
fi
ls -l probe/packs
