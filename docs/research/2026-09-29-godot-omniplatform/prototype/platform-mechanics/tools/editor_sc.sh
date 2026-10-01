#!/bin/bash
# Sets up a self-contained Godot editor under tpl/editor/bin (git-ignored) so the Android export can
# use its own editor settings (Java SDK path) without touching the user's global Godot config.
# The binary is a hard link to the installed editor (a copied .app is re-assessed by Gatekeeper and
# hangs), with a ._sc_ marker beside it. Prints the editor path.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC=${GODOT_APP_BIN:-/Applications/Godot.app/Contents/MacOS/Godot}
JBR=${JAVA_HOME:-"/Applications/Android Studio.app/Contents/jbr/Contents/Home"}
SDK=${ANDROID_HOME:-$HOME/Library/Android/sdk}
TPL=${GODOT_TEMPLATES:-"$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable"}
B="$HERE/tpl/editor/bin"
mkdir -p "$B"
[ -e "$B/godot" ] || ln "$SRC" "$B/godot"
touch "$B/._sc_"
ED="$B/editor_data"
if [ ! -f "$ED/editor_settings-4.7.tres" ]; then
  "$B/godot" --headless --path "$HERE/f_uid/main" --quit >/dev/null 2>&1 || true
fi
mkdir -p "$ED/export_templates"
[ -e "$ED/export_templates/4.7.2.stable" ] || ln -s "$TPL" "$ED/export_templates/4.7.2.stable"
sed -i '' -e "s|^export/android/java_sdk_path = .*|export/android/java_sdk_path = \"$JBR\"|" \
  -e "s|^export/android/android_sdk_path = .*|export/android/android_sdk_path = \"$SDK\"|" "$ED/editor_settings-4.7.tres"
echo "$B/godot"
