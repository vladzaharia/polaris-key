#!/usr/bin/env bash
# Run the exported Linux probe in a container under emulated Flatpak / Snap / AppImage / Steam
# (Linux + Proton-style) environments. EMULATED: the variables and /.flatpak-info are the ones the
# real launchers write (flatpak common/flatpak-run.c, snapd snap/snapenv/snapenv.go, AppImage
# type2-runtime), injected by hand; this proves what the Godot Linux template reads, not that a
# given launcher sets them.
# Prerequisite: LINUX_ARCH=arm64 ./export.sh linux (or x86_64 on an x86 host), docker.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out"
EMU="$OUT/emu-linux"
mkdir -p "$EMU"
cat >"$EMU/flatpak-info" <<'EOF'
[Application]
name=org.example.OutletProbe
runtime=runtime/org.freedesktop.Platform/aarch64/25.08

[Instance]
instance-id=1234567890
branch=stable
arch=aarch64
flatpak-version=1.16.1
EOF
IMG=debian:bookworm-slim
run() { # <label> [docker args...]
	local label="$1"
	shift
	echo "== $label"
	docker run --rm -v "$OUT/linux:/app:ro" "$@" "$IMG" /app/outletprobe.x86_64 --headless -- outlet 2>&1 |
		sed -n 's/^OUTLET_PROBE_JSON //p' >"$EMU/$label.json"
	python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ('os','distribution','executable','env','linux','steam')}))" "$EMU/$label.json"
}
run plain
run flatpak -v "$EMU/flatpak-info:/.flatpak-info:ro" -e FLATPAK_ID=org.example.OutletProbe -e container=flatpak
run snap -e SNAP=/snap/outletprobe/42 -e SNAP_NAME=outletprobe -e SNAP_INSTANCE_NAME=outletprobe -e SNAP_REVISION=42
run snap-local -e SNAP=/snap/outletprobe/x1 -e SNAP_NAME=outletprobe -e SNAP_INSTANCE_NAME=outletprobe_dev -e SNAP_REVISION=x1
run appimage -e APPIMAGE=/home/u/Apps/OutletProbe.AppImage -e APPDIR=/tmp/.mount_Outlet -e OWD=/home/u -e ARGV0=./OutletProbe.AppImage
run steam-env -e SteamAppId=480 -e SteamGameId=480 -e STEAM_COMPAT_APP_ID=480
