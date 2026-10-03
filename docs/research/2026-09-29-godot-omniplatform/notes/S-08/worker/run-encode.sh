#!/usr/bin/env bash
# usage: run-encode.sh FROM TO LEVEL [clog hlog]  -> JSON line with outside wall time and workerd CPU delta
F=$1; T=$2; L=$3; C=${4:-0}; H=${5:-0}
PID=$(pgrep -f "workerd serve.*inspector-addr" | head -1)
cpu() { ps -o cputime= -p $PID | awk -F'[:.]' '{ if (NF==4) print ($1*3600+$2*60+$3)*1000+$4*10; else print ($1*60+$2)*1000+$3*10 }'; }
rss() { ps -o rss= -p $PID | tr -d ' '; }
c0=$(cpu); r0=$(rss); t0=$(python3 -c 'import time;print(time.time())')
OUT=$(curl -s -m 900 -X POST localhost:8799/encode -d "{\"from\":\"in/$F.bin\",\"to\":\"in/$T.bin\",\"level\":$L,\"clog\":$C,\"hlog\":$H,\"outKey\":\"out/$F-$T-$L-$C-$H.zst\"}")
t1=$(python3 -c 'import time;print(time.time())'); c1=$(cpu); r1=$(rss)
echo "{\"pair\":\"$F->$T\",\"level\":$L,\"clog\":$C,\"hlog\":$H,\"wallS\":$(python3 -c "print(round($t1-$t0,3))"),\"workerdCpuMs\":$((c1-c0)),\"rssKBbefore\":$r0,\"rssKBafter\":$r1,\"res\":$OUT}"
