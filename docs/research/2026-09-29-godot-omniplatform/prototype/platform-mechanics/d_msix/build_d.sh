#!/bin/bash
# S-05 (d): build the two MSIX layouts run_d.ps1 packs, signs, installs and updates on Windows.
# Runs on any host with Godot 4.7.2 and its export templates (the Windows templates are exported
# from macOS or Linux as well). usage: build_d.sh [publisher]   (default "CN=S05 Test"; must equal
# the subject of the certificate run_d.ps1 signs with)
# Output (git-ignored): ../build/d/layout-1.0.0.0/ and ../build/d/layout-1.0.1.0/, each holding
#   s05msix.exe (official windows_release_x86_64 template), s05msix.pck (the probe; the sidecar
#   the P3-10 swap would replace), AppxManifest.xml and Assets/*.png.
set -e
cd "$(dirname "$0")"
PUBLISHER=${1:-"CN=S05 Test"}
GODOT=${GODOT:-godot}
OUT=../build/d
mkdir -p "$OUT" ../logs
for pair in "1.0.0 v1" "1.0.1 v2"; do
  set -- $pair; V=$1; MARK=$2; V4=$V.0
  SRC=$OUT/src-$V; L=$OUT/layout-$V4
  rm -rf "$SRC" "$L"; mkdir -p "$L/Assets"
  cp -R game "$SRC"; rm -rf "$SRC/.godot"
  sed -i.bak "s/^config\/version=.*/config\/version=\"$V\"/" "$SRC/project.godot" && rm "$SRC/project.godot.bak"
  echo "$MARK" > "$SRC/marker.txt"
  "$GODOT" --headless --path "$SRC" --import > "../logs/d_import_$V.txt" 2>&1 || true
  "$GODOT" --headless --path "$SRC" --export-release "Windows Desktop" "$PWD/$L/s05msix.exe" > "../logs/d_export_$V.txt" 2>&1
  sed -e "s/@VERSION@/$V4/g" -e "s/@PUBLISHER@/$PUBLISHER/g" AppxManifest.xml.in > "$L/AppxManifest.xml"
  python3 - "$L/Assets" <<'PY'
import struct, sys, zlib, os
def png(path, n):
    raw = b"".join(b"\x00" + b"\x33\x66\x99" * n for _ in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
for name, n in (("StoreLogo.png", 50), ("Square150x150Logo.png", 150), ("Square44x44Logo.png", 44)):
    png(os.path.join(sys.argv[1], name), n)
PY
  echo "$L: $(ls "$L" | tr '\n' ' ')"
done
