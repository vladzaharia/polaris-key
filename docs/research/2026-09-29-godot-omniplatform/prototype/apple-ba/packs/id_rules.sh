#!/usr/bin/env bash
# Which asset-pack ids does `xcrun ba-package` accept? Local tool check only; App Store Connect
# may apply stricter rules at upload (unmeasured, see the S-01 note).
# usage: id_rules.sh [workdir]
set -uo pipefail
w="${1:-$(mktemp -d)}"
mkdir -p "$w/d" && echo hi > "$w/d/x.txt"
L64=$(printf 'a%.0s' $(seq 1 64)); L128=$(printf 'a%.0s' $(seq 1 128)); L256=$(printf 'a%.0s' $(seq 1 256))
ids=("foes.c3" "foes-c3" "foes_c3" "Foes.C3" "3foes" ".foes" "foes." "foes..c3" "foes c3" "foes/c3"
     "foes:c3" "foes+c3" "fóes" "a" "$L64" "$L128" "$L256" "")
for id in "${ids[@]}"; do
  printf '{"assetPackID":"%s","downloadPolicy":{"onDemand":{}},"fileSelectors":[{"directory":"d"}],"platforms":["iOS"]}' "$id" > "$w/m.json"
  rm -f "$w/o.aar"; out=$( cd "$w" && xcrun ba-package package m.json -o "$w/o.aar" -q 2>&1 ); rc=$?
  label="$id"; [ ${#id} -gt 20 ] && label="<${#id} x a>"; [ -z "$id" ] && label="<empty>"
  printf '%-14s rc=%d %s\n' "$label" "$rc" "$(echo "$out" | tr '\n' ' ' | sed "s|$w|<w>|g" | cut -c1-160)"
done
