#!/usr/bin/env bash
# usage: native.sh FROM TO LEVEL [extra zstd args...]  -> one JSON line
set -euo pipefail
F=$1; T=$2; L=$3; shift 3
O=$(mktemp /tmp/claude-501/spikes/S-08/native/o.XXXX)
/usr/bin/time -l zstd -q -f -$L --ultra "$@" --patch-from="$F" "$T" -o "$O" 2> "$O.time"
rss=$(awk '/maximum resident set size/ {print $1}' "$O.time"); real=$(awk '/ real / {print $1}' "$O.time"); user=$(awk '/ real / {print $3}' "$O.time"); sys=$(awk '/ real / {print $5}' "$O.time")
size=$(stat -f %z "$O")
D=$(mktemp /tmp/claude-501/spikes/S-08/native/d.XXXX)
/usr/bin/time -l zstd -q -f -d --long=31 --patch-from="$F" "$O" -o "$D" 2> "$D.time"
drss=$(awk '/maximum resident set size/ {print $1}' "$D.time"); dreal=$(awk '/ real / {print $1}' "$D.time")
cmp -s "$D" "$T" && ok=true || ok=false
echo "{\"from\":\"$(basename $F)\",\"to\":\"$(basename $T)\",\"level\":$L,\"args\":\"$*\",\"bytes\":$size,\"encRealS\":$real,\"encUserS\":$user,\"encSysS\":$sys,\"encMaxRss\":$rss,\"decRealS\":$dreal,\"decMaxRss\":$drss,\"verified\":$ok}"
rm -f "$O" "$O.time" "$D" "$D.time"
