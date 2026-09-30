#!/bin/bash
# Runs every runner against one vector set. usage: run-all.sh <small|large>
# Every toolchain location is an env var; see README.md for what each one must point at.
X=$(cd "$(dirname "$0")" && pwd); V=${VECTORS_DIR:-$X/vectors}/$1
PY314=${PY314:-$X/py314/bin/python}                      # Python 3.14 (stdlib compression.zstd)
PY39=${PY39:-$X/py39/bin/python}                         # Python 3.9 + zstandard 0.25.0
PY311=${PY311:-$X/../patching/venv/bin/python}           # Python 3.11 + zstandard 0.25.0 (the patching venv)
NODE=${NODE:-node}                                       # Node 22.22 (the default runtime)
NODES_DIR=${NODES_DIR:-$X/nodes}                         # extra Node builds: node-v<version>-linux-x64/
DOTNET10_ROOT=${DOTNET10_ROOT:-$X/dotnet/sdk10}          # .NET SDK 10.0.401
DOTNET11_ROOT=${DOTNET11_ROOT:-$X/dotnet/sdk11}          # .NET SDK 11.0.100-rc.1
GODOT=${GODOT:-godot}                                    # Godot 4.7.2-stable editor binary
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1; unset JAVA_TOOL_OPTIONS
$PY314 $X/runners/python/runcases.py $V stdlib 2>&1 | grep -v RuntimeWarning
$PY39 $X/runners/python/runcases.py $V zstandard
$PY311 $X/runners/python/runcases.py $V zstandard
$NODE $X/runners/node/run.mjs $V zlib
NAPI_PATH=$X/npm/node_modules/zstd-napi/dist/index.js $NODE $X/runners/node/run.mjs $V zstd-napi
$NODE $X/runners/node/run-wasm.mjs $V
for v in 22.19.0 24.6.0; do $NODES_DIR/node-v$v-linux-x64/bin/node $X/runners/node/run.mjs $V zlib; done
$NODES_DIR/node-v22.18.0-linux-x64/bin/node $X/runners/node/run.mjs $V zlib | tail -1
java -Xmx4g -cp "$X/jvm/lib/*:$X/jvm/out" Runner $V | tail -1
DOTNET_ROOT=$DOTNET11_ROOT $DOTNET11_ROOT/dotnet $X/dotnet/runner/bin11/runner.dll $V | tail -1
ZSTD=sharp DOTNET_ROOT=$DOTNET11_ROOT $DOTNET11_ROOT/dotnet $X/dotnet/runner/bin11/runner.dll $V | tail -1
DOTNET_ROOT=$DOTNET10_ROOT $DOTNET10_ROOT/dotnet $X/dotnet/runner/bin10/runner.dll $V | tail -1
$GODOT --headless --path $X/runners/godot --script res://content_runner.gd -- $V 2>&1 | grep 'cases match' | sed 's/^/[editor] /'
$X/runners/godot/tpl/runner.x86_64 --headless -- $V 2>&1 | grep 'cases match' | sed 's/^/[release template] /'
