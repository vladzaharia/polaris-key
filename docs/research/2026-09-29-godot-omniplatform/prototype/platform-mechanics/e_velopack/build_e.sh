#!/bin/bash
# S-05 (e): build S05Game.app (official 4.7.2 macOS release template + pack + launcher) and a
# Velopack release of it.  usage: build_e.sh <version> <marker> <launcher|godot> [vpk extra args]
#   launcher: CFBundleExecutable / --mainExe = s05launcher (the shim), Godot beside it as s05game
#   godot:    CFBundleExecutable / --mainExe = s05game (the Godot template itself)
# Env: GODOT, GODOT_TEMPLATES, DOTNET_ROOT (for vpk), VPK (default ../tpl/vpk/vpk).
set -e
cd "$(dirname "$0")"
V=$1; MARK=$2; MODE=$3; shift 3
GODOT=${GODOT:-godot}
GODOT_TEMPLATES=${GODOT_TEMPLATES:-"$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable"}
export DOTNET_ROOT=${DOTNET_ROOT:-/opt/homebrew/Cellar/dotnet@8/8.0.128/libexec}
VPK=${VPK:-../tpl/vpk/vpk}
W=../tpl/e/build-$MODE; APP=$W/S05Game.app
rm -rf "$W"; mkdir -p "$W" ../logs
unzip -q -o "$GODOT_TEMPLATES/macos.zip" -d "$W"
mv "$W/macos_template.app" "$APP"
mv "$APP/Contents/MacOS/godot_macos_release.universal" "$APP/Contents/MacOS/s05game"
rm -f "$APP/Contents/MacOS/godot_macos_debug.universal"
MAIN=s05game
if [ "$MODE" = launcher ]; then
  cp launcher/target/release/s05launcher "$APP/Contents/MacOS/s05launcher"; MAIN=s05launcher
fi
sed -i '' -e "s/\$binary/$MAIN/g; s/\$name/S05Game/g; s/\$bundle_identifier/org.polariskey.s05game/g" \
  -e "s/\$short_version/$V/g; s/\$version/$V/g; s/\$min_version_arm64/11.0/g; s/\$min_version_x86_64/10.13/g; s/\$highres/<true\/>/g" \
  -e 's/\$[a-z_]*//g' "$APP/Contents/Info.plist"
sed -i '' "s/^config\/version=.*/config\/version=\"$V\"/" game/project.godot
echo "$MARK" > game/marker.txt
"$GODOT" --headless --path game --export-pack macOS "$PWD/$APP/Contents/Resources/s05game.pck" > ../logs/e_export_$V.txt 2>&1
codesign --force --deep -s - "$APP" 2>/dev/null || true
"$VPK" pack --packId S05Game$MODE --packVersion "$V" --packDir "$APP" --mainExe "$MAIN" \
  --outputDir "releases/$MODE" --channel osx --noInst --yes "$@" > ../logs/e_vpk_${MODE}_$V.txt 2>&1 || { tail -20 ../logs/e_vpk_${MODE}_$V.txt; exit 1; }
ls releases/$MODE
