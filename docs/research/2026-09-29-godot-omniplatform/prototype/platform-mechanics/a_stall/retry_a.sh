#!/bin/bash
# Re-run the (case, temp) pairs that failed in logs/a_matrix.txt once each (adb flakiness under load).
cd "$(dirname "$0")"
grep FAILED ../logs/a_matrix.txt | sort -u | while read -r _ name temp; do
  src=${name#m_}; src=${src%%_*}; p=${name#m_${src}_}
  case $name in
    m_*) plan="\"at_frame\":5,\"mounts\":[{\"path\":\"$src://packs/$p.pck\"}]";;
    seq6_user) plan='"at_frame":5,"mounts":[{"path":"user://packs/p5_few.pck"},{"path":"user://packs/p5_many.pck"},{"path":"user://packs/p50_few.pck"},{"path":"user://packs/p50_many.pck"},{"path":"user://packs/p200_few.pck"},{"path":"user://packs/p200_many.pck"}]';;
    *) continue;;
  esac
  ./run_a.sh case "$name" "$temp" "$plan" < /dev/null > /dev/null 2>&1 && echo "ok $name $temp" || echo "FAILED-AGAIN $name $temp"
done
