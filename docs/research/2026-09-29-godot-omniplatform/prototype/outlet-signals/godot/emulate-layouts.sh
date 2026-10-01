#!/usr/bin/env bash
# Run the exported macOS probe inside emulated install layouts (Steam library, itch cave,
# steam_appid.txt dev mode, a sandbox-like env). These are EMULATED observations: they prove the
# probe's parsing and Godot's reach, not what a real client writes or sets.
# Prerequisite: ./export.sh macos
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out"
APP="$OUT/macos/OutletProbe.app"
EMU="$OUT/emu"
rm -rf "$EMU" && mkdir -p "$EMU"
run() { # <label> <app dir> [env...]
	local label="$1" app="$2"
	shift 2
	echo "== $label"
	env "$@" "$app/Contents/MacOS/pkey-ed25519-lab" --headless -- outlet 2>&1 | sed -n 's/^OUTLET_PROBE_JSON //p' >"$EMU/$label.json"
	python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ('env','steam','itch','probe_usec')}))" "$EMU/$label.json"
}

# 1. Steam library layout with an appmanifest (field names copied from a real macOS client manifest).
LIB="$EMU/SteamLibrary/steamapps"
mkdir -p "$LIB/common/OutletProbe"
cp -R "$APP" "$LIB/common/OutletProbe/"
cat >"$LIB/appmanifest_480.acf" <<'EOF'
"AppState"
{
	"appid"		"480"
	"Universe"		"1"
	"name"		"OutletProbe"
	"StateFlags"		"4"
	"installdir"		"OutletProbe"
	"buildid"		"123456"
	"TargetBuildID"		"123456"
	"UserConfig"
	{
		"BetaKey"		"public-test"
	}
	"MountedConfig"
	{
		"BetaKey"		"public-test"
	}
}
EOF
run steam-layout "$LIB/common/OutletProbe/OutletProbe.app" SteamAppId=480 SteamGameId=480

# 2. steam_appid.txt next to the executable (the Steamworks dev-mode file), outside any library.
mkdir -p "$EMU/devmode" && cp -R "$APP" "$EMU/devmode/"
echo 480 >"$EMU/devmode/OutletProbe.app/Contents/MacOS/steam_appid.txt"
run steam-appid-txt "$EMU/devmode/OutletProbe.app"

# 3. itch cave: <install location>/<slug>/.itch/receipt.json.gz, receipt shape from butlerd's spec.
CAVE="$EMU/itch-apps/outletprobe"
mkdir -p "$CAVE/.itch" && cp -R "$APP" "$CAVE/"
printf '%s' '{"game":{"id":1001,"title":"OutletProbe"},"upload":{"id":2002},"build":{"id":3003},"files":["OutletProbe.app/Contents/Info.plist"],"installerName":"archive"}' |
	gzip -9 >"$CAVE/.itch/receipt.json.gz"
run itch-cave "$CAVE/OutletProbe.app" ITCHIO_APP=1

# 4. Inherited environment: a non-Steam process started from a Steam-launched shell.
run inherited-env "$APP" SteamAppId=480 SteamGameId=480 SteamClientLaunch=1
