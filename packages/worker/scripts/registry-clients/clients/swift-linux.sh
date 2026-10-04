#!/usr/bin/env bash
# The Swift registry client on Linux (F-06, plans/F-01.md §6.8): SwiftPM in the official Swift
# container builds against the local registry with signing enforced (`onUnsigned: error`,
# `onUntrustedCertificate: error`, this run's throwaway root trusted). The container shares the
# host's network so it reaches the harness Worker at REGISTRY (127.0.0.1); on Docker Desktop
# that needs host networking enabled. Checks:
#   1. `from: "1.0.0"` resolves to 1.0.0, builds, and the binary prints 1.0.0;
#   2. `exact: "1.1.0"` (yanked) is refused;
#   3. `exact: "2.0.0-beta.1"` (the beta channel) builds.
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${STATE:?STATE is the harness state directory}"
IMAGE="${SWIFT_LINUX_IMAGE:-swift:6.2}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
URL="$REGISTRY/swift/$OWNER"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
cp -R "$STATE/swift/ca/trusted" "$T/roots"

consumer() {
  local dir="$T/$1" req="$2"
  cp -R "$HERE/swift/consumer" "$dir"
  REQ="$req" perl -pi -e 's/REQUIREMENT/$ENV{REQ}/' "$dir/Package.swift"
  mkdir -p "$dir/.swiftpm/configuration"
  cat > "$dir/.swiftpm/configuration/registries.json" <<EOF
{
  "authentication": {},
  "registries": { "smoke": { "supportsAvailability": false, "url": "$URL" } },
  "security": {
    "default": {
      "signing": {
        "onUnsigned": "error",
        "onUntrustedCertificate": "error",
        "trustedRootCertificatesPath": "/work/roots",
        "includeDefaultTrustedRootCertificates": false,
        "validationChecks": { "certificateExpiration": "enabled", "certificateRevocation": "disabled" }
      }
    }
  },
  "version": 1
}
EOF
}
consumer stable 'from: "1.0.0"'
consumer yanked 'exact: "1.1.0"'
consumer beta 'exact: "2.0.0-beta.1"'

cat > "$T/run.sh" <<'EOF'
set -u
fail=0
spm() { local d="/work/$1"; shift; swift "$@" --package-path "$d" --cache-path "/work/cache-$(basename "$d")" --security-path "/work/security-$(basename "$d")" --scratch-path "$d/.build"; }
if spm stable build --product SmokeConsumer >/work/stable.log 2>&1 &&
  [ "$(/work/stable/.build/debug/SmokeConsumer)" = "hello from SmokeKit 1.0.0" ]; then
  echo "ok   linux: from: 1.0.0 resolves to 1.0.0, signature verified, builds"
else
  echo "FAIL linux: from: 1.0.0"; tail -20 /work/stable.log; fail=1
fi
if spm yanked package resolve >/work/yanked.log 2>&1; then
  echo "FAIL linux: exact: 1.1.0 (yanked) resolved"; fail=1
elif grep -q "1\.1\.0" /work/yanked.log; then
  echo "ok   linux: exact: 1.1.0 (yanked) is refused"
else
  echo "FAIL linux: exact: 1.1.0 failed for another reason"; tail -20 /work/yanked.log; fail=1
fi
if spm beta build --product SmokeConsumer >/work/beta.log 2>&1 &&
  [ "$(/work/beta/.build/debug/SmokeConsumer)" = "hello from SmokeKit 2.0.0-beta.1" ]; then
  echo "ok   linux: exact: 2.0.0-beta.1 (the beta channel) builds"
else
  echo "FAIL linux: exact: 2.0.0-beta.1"; tail -20 /work/beta.log; fail=1
fi
exit $fail
EOF

# As the invoking user (so the temp dir stays removable), with HOME inside the mount.
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/work \
  -v "$T:/work" -w /work "$IMAGE" bash /work/run.sh
