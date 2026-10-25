#!/usr/bin/env bash
# UK-10.13: runs the sample's --smoke in the Flatpak sandbox against a mock desktop portal and checks that
#   - the link left through org.freedesktop.portal.OpenURI, and
#   - the Settings portal's ReadOne answered for color-scheme, accent-color and contrast.
# Run it under a display and a private session bus:  xvfb-run -a dbus-run-session -- portal-check.sh <app-id>
set -euo pipefail
app="${1:?usage: portal-check.sh <app-id>}"
here="$(cd "$(dirname "$0")" && pwd)"
log="$(mktemp)"
url="https://key.plrs.im/docs/"

python3 "$here/mock-portal.py" "$log" &
mock=$!
trap 'kill "$mock" 2>/dev/null || true' EXIT
# Wait (up to 10 s) for the mock to own the portal name.
for _ in $(seq 1 50); do
  grep -q '^ready$' "$log" && break
  sleep 0.2
done
grep -q '^ready$' "$log" || { echo "mock portal did not start" >&2; cat "$log" >&2; exit 1; }

timeout 120 flatpak run --user "$app" --smoke --open-link "$url" | tee "$log.out"
grep -q 'smoke: the gate let' "$log.out"

echo "--- portal calls ---"
cat "$log"
fail=0
for want in "OpenURI $url" "ReadOne org.freedesktop.appearance color-scheme" \
  "ReadOne org.freedesktop.appearance accent-color" "ReadOne org.freedesktop.appearance contrast"; do
  grep -qxF "$want" "$log" || { echo "MISSING portal call: $want" >&2; fail=1; }
done
exit "$fail"
