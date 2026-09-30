#!/bin/bash
# usage: build.sh <projdir>   -> imports with retries (headless import is occasionally flaky)
# Run from prototype/patching. GODOT = the Godot 4.7.2-stable editor binary (default: godot on PATH).
GODOT=${GODOT:-godot}
P=$1
mkdir -p logs
for i in 1 2 3 4 5; do
  "$GODOT" --headless --path $P --import > logs/import_$(basename $P)_$i.txt 2>&1; rc=$?
  if [ $rc = 0 ]; then echo "import $P ok (attempt $i)"; exit 0; fi
  echo "import $P rc=$rc attempt $i"
done
exit 1
