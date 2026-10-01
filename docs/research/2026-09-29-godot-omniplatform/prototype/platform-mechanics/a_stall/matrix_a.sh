#!/bin/bash
# S-05 (a): the measured matrix (3 repetitions each). Needs `run_a.sh install` and the prep case.
cd "$(dirname "$0")"
ADB=${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}; DEV=${DEV:-emulator-5556}
EXT=/sdcard/Android/data/org.polariskey.s05stall/files
R=${REPS:-3}
PACKS="p5_few p5_many p50_few p50_many p200_few p200_many c20k"
one() { ./run_a.sh case "$1" "$2" "$3" > /dev/null 2>&1 || echo "FAILED $1 $2"; }
for rep in $(seq 1 $R); do
  for src in user res; do
    for p in $PACKS; do
      for t in cold warm; do
        one "m_${src}_${p}" $t "\"at_frame\":5,\"mounts\":[{\"path\":\"$src://packs/$p.pck\"}]"
      done
    done
  done
  one first_empty_then_p200_many cold '"at_frame":5,"mounts":[{"path":"user://packs/empty.pck"},{"path":"user://packs/p200_many.pck"}]'
  one ready_p200_many warm '"at_frame":0,"mounts":[{"path":"user://packs/p200_many.pck"}]'
  for t in cold warm; do
    one thread_p200_many $t '"at_frame":5,"mounts":[{"path":"user://packs/p200_many.pck","thread":true}]'
    one thread_c20k $t '"at_frame":5,"mounts":[{"path":"user://packs/c20k.pck","thread":true}]'
    one seq6_user $t '"at_frame":5,"mounts":[{"path":"user://packs/p5_few.pck"},{"path":"user://packs/p5_many.pck"},{"path":"user://packs/p50_few.pck"},{"path":"user://packs/p50_many.pck"},{"path":"user://packs/p200_few.pck"},{"path":"user://packs/p200_many.pck"}]'
  done
  "$ADB" -s "$DEV" shell "[ -f $EXT/packs/p50_many.pck ]" || { "$ADB" -s "$DEV" shell mkdir -p $EXT/packs; "$ADB" -s "$DEV" push ../out/../a_stall/probe/packs/p50_many.pck $EXT/packs/ >/dev/null; }
  one abs_ext_p50_many warm "\"at_frame\":5,\"mounts\":[{\"path\":\"$EXT/packs/p50_many.pck\"}]"
  one abs_storage_p50_many warm '"at_frame":5,"mounts":[{"path":"/storage/emulated/0/Android/data/org.polariskey.s05stall/files/packs/p50_many.pck"}]'
done
echo matrix done
