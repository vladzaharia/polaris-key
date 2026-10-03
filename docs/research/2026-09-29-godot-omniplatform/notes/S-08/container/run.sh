#!/usr/bin/env bash
# usage: run.sh NAME CPUS MEM IMAGE "pair:level:st ..."
NAME=$1; CPUS=$2; MEM=$3; IMG=$4; JOBS=$5
for i in 1 2 3; do
  docker rm -f s08c >/dev/null 2>&1
  t0=$(python3 -c 'import time;print(time.time())')
  docker run -d --name s08c --cpus=$CPUS --memory=$MEM --memory-swap=$MEM -p 18080:8080 $IMG >/dev/null
  n=0; until curl -s -o /dev/null localhost:18080/health || [ $n -gt 3000 ]; do sleep 0.01; n=$((n+1)); done
  t1=$(python3 -c 'import time;print(time.time())')
  echo "{\"profile\":\"$NAME\",\"image\":\"$IMG\",\"coldStartMs\":$(python3 -c "print(round(($t1-$t0)*1000))")}"
done
for j in $JOBS; do IFS=: read f t L ST <<< "$j"
  docker rm -f s08c >/dev/null 2>&1; docker run -d --name s08c --cpus=$CPUS --memory=$MEM --memory-swap=$MEM -p 18080:8080 $IMG >/dev/null; n=0; until curl -s -o /dev/null localhost:18080/health || [ $n -gt 3000 ]; do sleep 0.01; n=$((n+1)); done
  t0=$(python3 -c 'import time;print(time.time())')
  H=$(curl -s -m 900 -D - -o /tmp/claude-501/spikes/S-08/container/frame.bin -X POST "localhost:18080/delta?from=http://host.docker.internal:8777/$f.bin&to=http://host.docker.internal:8777/$t.bin&level=$L&st=$ST" | tr -d '\r')
  t1=$(python3 -c 'import time;print(time.time())')
  code=$(echo "$H" | head -1 | awk '{print $2}'); stats=$(echo "$H" | sed -n 's/^X-Stats: //p')
  peak=$(docker stats --no-stream --format '{{.MemUsage}}' s08c 2>/dev/null)
  oom=$(docker inspect -f '{{.State.OOMKilled}} {{.State.Status}}' s08c)
  echo "{\"profile\":\"$NAME\",\"pair\":\"$f->$t\",\"level\":$L,\"st\":$ST,\"http\":\"$code\",\"wallMs\":$(python3 -c "print(round(($t1-$t0)*1000))"),\"stats\":${stats:-null},\"state\":\"$oom\",\"memNow\":\"$peak\",\"body\":\"$( [ "$code" = 200 ] || head -c 200 /tmp/claude-501/spikes/S-08/container/frame.bin | tr -d '\"\n')\"}"
  if [ "$(docker inspect -f '{{.State.Status}}' s08c)" != running ]; then docker rm -f s08c >/dev/null; docker run -d --name s08c --cpus=$CPUS --memory=$MEM --memory-swap=$MEM -p 18080:8080 $IMG >/dev/null; n=0; until curl -s -o /dev/null localhost:18080/health || [ $n -gt 3000 ]; do sleep 0.01; n=$((n+1)); done; fi
done
docker rm -f s08c >/dev/null 2>&1
