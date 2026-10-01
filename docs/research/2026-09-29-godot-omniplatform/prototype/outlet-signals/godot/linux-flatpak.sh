#!/usr/bin/env bash
# Run the exported Linux probe as a REAL Flatpak app inside a privileged container: flatpak and
# bubblewrap from Debian, the org.freedesktop.Platform runtime from Flathub, and a one-file app
# built with `flatpak build-init/build-finish/build-export` (no flatpak-builder manifest). This
# measures what the real `flatpak run` launcher gives the Godot template: /.flatpak-info,
# FLATPAK_ID, `container`, the sandbox HOME and OS.is_sandboxed().
# Prerequisite: LINUX_ARCH=arm64 ./export.sh linux (or x86_64 on an x86 host), docker.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out"
mkdir -p "$OUT/flatpak-real"
RT_BRANCH="${RT_BRANCH:-24.08}"
docker run --rm --privileged -v "$OUT/linux:/probe:ro" -v "$OUT/flatpak-real:/result" -e RT_BRANCH="$RT_BRANCH" debian:trixie-slim bash -euo pipefail -c '
apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq flatpak ca-certificates dbus >/dev/null
# flatpak install asks malcontent (parental controls) over the system bus; without one it fails
# with "Could not connect: No such file or directory".
mkdir -p /run/dbus && dbus-daemon --system --fork
flatpak --version | tee /result/flatpak-version.txt
useradd -m u
su u -c "
set -e
flatpak --user remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak --user install -y --noninteractive flathub org.freedesktop.Platform//\$RT_BRANCH >/dev/null
cd ~ && flatpak build-init app org.example.OutletProbe org.freedesktop.Platform org.freedesktop.Platform \$RT_BRANCH
mkdir -p app/files/bin && cp /probe/outletprobe.x86_64 app/files/bin/outletprobe && cp /probe/outletprobe.pck app/files/bin/outletprobe.pck
flatpak build-finish app --command=outletprobe >/dev/null
flatpak build-export repo app >/dev/null
flatpak --user remote-add --no-gpg-verify local repo
flatpak --user install -y --noninteractive local org.example.OutletProbe >/dev/null
flatpak run org.example.OutletProbe --headless -- outlet 2>&1 | sed -n \"s/^OUTLET_PROBE_JSON //p\" > /tmp/probe.json
flatpak run --command=cat org.example.OutletProbe /.flatpak-info | grep -vE \"instance-id|app-path|runtime-path|session-bus|system-bus\" > /tmp/flatpak-info.txt
flatpak run --command=sh org.example.OutletProbe -c \"env | grep -E ^FLATPAK_\\|^container= | sort\" > /tmp/flatpak-env.txt
"
cp /tmp/probe.json /tmp/flatpak-info.txt /tmp/flatpak-env.txt /result/
'
python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ('os','distribution','executable','is_sandboxed','user_data_dir','env','linux')}))" "$OUT/flatpak-real/probe.json"
cat "$OUT/flatpak-real/flatpak-env.txt"
