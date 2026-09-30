#!/bin/bash
# Runs the browser matrix on Linux in the official Playwright image (Ubuntu 24.04, same Playwright
# version as ../../content/npm): WebKit there is the WPE/GTK Linux port, the stand-in for WebKitGTK
# (Tauri on Linux); Firefox and Chromium ride along. Server and browsers share the container's
# localhost, so the page is a secure context (WebCrypto, OPFS).
# usage: lowend/browser/linux-matrix.sh [engines...]   (default: webkit firefox chromium)
#        GODOT=1 runs the Godot web export instead of the JS matrix; LARGE, CPU, SKIP, EDMAX as in drive.mjs
set -euo pipefail
P=$(cd "$(dirname "$0")/../.." && pwd)
ENGINES=${*:-webkit firefox chromium}
IMG=${PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}
docker run --rm --ipc=host -v "$P:/p" -e ENGINES="$ENGINES" -e LARGE="${LARGE:-}" -e CPU="${CPU:-}" -e SKIP="${SKIP:-}" -e EDMAX="${EDMAX:-}" -e GODOT="${GODOT:-}" -e TIMEOUT_S="${TIMEOUT_S:-}" "$IMG" bash -c '
  set -e
  cd /p
  MOUNTS=/lowend=/p/lowend RESULTS_DIR=/tmp/posted node content/runners/browser/server.mjs /p/content 8431 &
  for i in $(seq 1 50); do curl -sf -o /dev/null http://127.0.0.1:8431/lowend/browser/index.html && break; sleep 0.2; done
  USER_EDMAX="$EDMAX"
  PFX=browser; [ -n "$GODOT" ] && PFX=godot-web
  for e in $ENGINES; do
    # WebKitGTK/WPE crash on Ed25519 over >= ~64 KiB (see the note); time only the small input there.
    E="$USER_EDMAX"
    if [ "$e" = webkit ] && [ -z "$E" ]; then E=65000; fi
    EDMAX="$E" node lowend/browser/drive.mjs "$e" http://127.0.0.1:8431 "$PFX-linux-$e${CPU:+-cpu$CPU}" || echo "driver failed for $e"
  done
  uname -a
'
