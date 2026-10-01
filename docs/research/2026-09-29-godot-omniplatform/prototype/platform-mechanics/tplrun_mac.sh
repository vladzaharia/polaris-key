#!/bin/bash
# usage: tplrun_mac.sh <projdir> <release|debug> [runner args...]
#   Exports <projdir> as a pack (preset "macOS") and runs it on the official 4.7.2 macOS template,
#   as <projdir>'s own main scene / run/main_loop_type. Official 4.6+ templates ignore --path,
#   --script and --main-pack (godot#111909), so the pack sits in the .app's Resources as <name>.pck.
#   Env: GODOT (editor binary, default godot), GODOT_TEMPLATES (default the macOS per-user templates),
#        TPL_NAME (bundle/executable name, default "run"), HEADLESS=0 to open a window.
set -e
GODOT=${GODOT:-godot}
GODOT_TEMPLATES=${GODOT_TEMPLATES:-"$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable"}
P=$1; KIND=$2; shift 2
N=${TPL_NAME:-run}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HERE/tpl" "$HERE/logs"
APP="$HERE/tpl/$N.app"
if [ ! -x "$APP/Contents/MacOS/$N" ] || [ "$(cat "$APP/.kind" 2>/dev/null)" != "$KIND" ]; then
  rm -rf "$APP" "$HERE/tpl/macos_template.app"
  unzip -q -o "$GODOT_TEMPLATES/macos.zip" -d "$HERE/tpl"
  mv "$HERE/tpl/macos_template.app" "$APP"
  mv "$APP/Contents/MacOS/godot_macos_${KIND}.universal" "$APP/Contents/MacOS/$N"
  rm -f "$APP/Contents/MacOS/godot_macos_"*.universal
  # Fill the template's $placeholders the way the exporter would (only what the runner needs).
  sed -i '' -e "s/\$binary/$N/g; s/\$name/$N/g; s/\$bundle_identifier/org.polariskey.s05.$N/g" \
    -e 's/\$short_version/1.0/g; s/\$version/1.0/g; s/\$min_version_arm64/11.0/g; s/\$min_version_x86_64/10.13/g; s/\$highres/<true\/>/g' \
    -e 's/\$[a-z_]*//g' "$APP/Contents/Info.plist"
  echo "$KIND" > "$APP/.kind"
fi
"$GODOT" --headless --path "$P" --export-pack macOS "$APP/Contents/Resources/$N.pck" > "$HERE/logs/export_$(basename "$P").txt" 2>&1 || { echo "export failed (logs/export_$(basename "$P").txt)"; exit 1; }
if [ "${HEADLESS:-1}" = 1 ]; then H=--headless; else H=; fi
exec "$APP/Contents/MacOS/$N" $H -- "$@"
