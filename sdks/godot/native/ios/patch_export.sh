#!/usr/bin/env bash
# patch_export.sh <exported Xcode project dir | <name>.xcodeproj>
#
# The post-export step for an iOS preset exported with "Export Project Only" (P5-05). It reads the
# mark the Polaris Key export plugin put in the exported Info.plist (PKeyAppleExport):
#
#   PKeyAppleBackgroundAssets = true   →  run S-01's patch_ba.rb (beside this script, byte for
#   PKeyAppleAppGroup = group.<id>        byte the prototype's) with that App Group: it adds the
#                                         Background Download extension target
#                                         (<app id>.BackgroundDownload, iOS max(app floor, 26.0)),
#                                         the App Group on both targets and the BAAppGroupID /
#                                         BAHasManagedAssetPacks / BAUsesAppleHosting keys
#   false, or no mark                  →  change nothing (a sideload IPA ships no extension)
#
# Idempotent: a second run on a patched project changes nothing. Needs the xcodeproj gem 1.27
# (`gem install xcodeproj -v 1.27.0`; GEM_HOME is honoured). Signing (two provisioning profiles,
# both with the App Group) is the archive step's job and needs the owner's Apple account.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
arg="${1:-}"
[ -n "$arg" ] || { echo "usage: patch_export.sh <export dir | name.xcodeproj>" >&2; exit 2; }

case "$arg" in
  *.xcodeproj) proj="$arg" ;;
  *)
    proj="$(find "$arg" -maxdepth 1 -name '*.xcodeproj' -type d | head -n 1)"
    ;;
esac
[ -n "$proj" ] && [ -d "$proj" ] || { echo "patch_export.sh: no .xcodeproj in $arg" >&2; exit 2; }

root="$(cd "$(dirname "$proj")" && pwd)"
name="$(basename "$proj" .xcodeproj)"
plist="$root/$name/$name-Info.plist"
[ -f "$plist" ] || { echo "patch_export.sh: no $plist (not a Godot iOS export?)" >&2; exit 2; }

mark="$(/usr/libexec/PlistBuddy -c "Print :PKeyAppleBackgroundAssets" "$plist" 2>/dev/null || echo "")"
if [ "$mark" != "true" ]; then
  echo "patch_export.sh: $name: Background Assets off for this preset (PKeyAppleBackgroundAssets=${mark:-absent}); no extension added"
  exit 0
fi
group="$(/usr/libexec/PlistBuddy -c "Print :PKeyAppleAppGroup" "$plist" 2>/dev/null || echo "")"
[ -n "$group" ] || { echo "patch_export.sh: PKeyAppleBackgroundAssets is true but PKeyAppleAppGroup is missing" >&2; exit 1; }

ruby "$HERE/patch_ba.rb" "$proj" --app-group "$group"
