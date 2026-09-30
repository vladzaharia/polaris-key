#!/bin/bash
# usage: tplrun.sh <release|debug> <MainLoopClass> [user args...]  -> runs the runner project on the official export template
# Run from prototype/patching. GODOT = the Godot 4.7.2-stable editor binary (default: godot on PATH);
# GODOT_TEMPLATES = the directory holding the official linux_release.x86_64 / linux_debug.x86_64 templates.
# Note: rewrites runner/project.godot so that run/main_loop_type names the test class.
GODOT=${GODOT:-godot}
GODOT_TEMPLATES=${GODOT_TEMPLATES:-$HOME/.local/share/godot/export_templates/4.7.2.stable}
KIND=$1; CLS=$2; shift 2
cat > runner/project.godot <<EOP
config_version=5

[application]

config/name="patchrunner"
run/main_scene="res://main.tscn"
run/main_loop_type="$CLS"
EOP
mkdir -p tpl logs
"$GODOT" --headless --path runner --export-pack Linux $PWD/tpl/runner.pck > logs/tpl_export.txt 2>&1 || { echo export failed; exit 1; }
cp -f "$GODOT_TEMPLATES/linux_${KIND}.x86_64" tpl/runner.x86_64
./tpl/runner.x86_64 --headless -- "$@"
