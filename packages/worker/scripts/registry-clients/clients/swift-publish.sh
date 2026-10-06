#!/usr/bin/env bash
# `swift package-registry publish` into the Swift feed (F-22), then the release resolved back with
# real SwiftPM, signing enforced.
#
# SwiftPM sends registry credentials only over HTTPS (swift.sh's note: measured with SwiftPM 6.4,
# no token reaches an http:// registry), and the harness is plain HTTP on loopback. So the publish
# request is SwiftPM's own output sent the way SwiftPM sends it: `swift package-registry publish
# --dry-run` signs and archives the fixture with this run's throwaway CA (swift.seed.mjs), and the
# archive and its CMS signature go up as SwiftPM's `PUT` (multipart `source-archive` and
# `source-archive-signature`, `X-Swift-Package-Signature-Format: cms-1.0.0`) with the publish token.
# SwiftPM's own HTTPS publish is checked against pkg-staging (recorded on the PR). Checks:
#   1. the PUT answers 201 with Location and Content-Version: 1;
#   2. publishing the same version again is 409;
#   3. an unsigned PUT is refused (the feed requires signing);
#   4. (public feed) SwiftPM resolves `smoke.PublishedKit` from: "1.0.0" with onUnsigned: error
#      and the throwaway root trusted, and builds it — the manifests the feed read out of the
#      archive verify.
# REGISTRY, OWNER, STATE and PKEY_REGISTRY_PUBLISH_TOKEN come from run.mjs.
set -euo pipefail
: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${STATE:?STATE is the harness state directory}"
: "${PKEY_REGISTRY_PUBLISH_TOKEN:?run.mjs mints the publish token}"
SWIFT="${SWIFT:-swift}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CA="$STATE/swift/ca"
URL="$REGISTRY/swift/$OWNER"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

pkg="$T/pkg"
cp -R "$HERE/swift/fixture" "$pkg"
printf 'let smokeVersion = "1.0.0"\n' > "$pkg/Sources/SmokeKit/Version.swift"
mkdir -p "$T/scratch"
(cd "$pkg" && "$SWIFT" package-registry publish smoke.PublishedKit 1.0.0 \
  --url https://registry.invalid/swift/unused --dry-run --scratch-directory "$T/scratch" \
  --private-key-path "$CA/leaf.p8.der" --cert-chain-paths "$CA/leaf.der" "$CA/root.der" >/dev/null)
zip="$(ls "$T"/scratch/*.zip | head -1)"
sig="$(ls "$T"/scratch/*.sig | head -1)"

put() { # put <with signature: yes|no> → the status; headers in $T/h, body in $T/b
  local extra=()
  [ "$1" = yes ] && extra=(-F "source-archive-signature=@$sig;type=application/octet-stream"
    -H "X-Swift-Package-Signature-Format: cms-1.0.0")
  curl -sS -o "$T/b" -D "$T/h" -w '%{http_code}' -X PUT \
    -H "Accept: application/vnd.swift.registry.v1+json" \
    -H "Authorization: Bearer $PKEY_REGISTRY_PUBLISH_TOKEN" \
    -F "source-archive=@$zip;type=application/zip" "${extra[@]}" \
    "$URL/smoke/PublishedKit/${2:-1.0.0}"
}
status="$(put yes)"
if [ "$status" = 201 ] && grep -qi '^content-version: 1' "$T/h" && grep -qi '^location: ' "$T/h"; then
  ok "publish answers 201 with Location and Content-Version"
else cat "$T/h" "$T/b"; bad "publish answered $status"; fi
status="$(put yes)"
[ "$status" = 409 ] && ok "the same version again is 409" || bad "republish answered $status"
status="$(put no 1.0.1)"
[ "$status" = 422 ] && grep -q swift-unsigned "$T/b" && ok "an unsigned release is refused" ||
  { cat "$T/b"; bad "unsigned publish answered $status"; }

if [ -z "${REGISTRY_AUTH:-}" ]; then
  c="$T/consumer"
  cp -R "$HERE/swift/consumer" "$c"
  perl -pi -e 's/smoke\.SmokeKit/smoke.PublishedKit/g; s/REQUIREMENT/from: "1.0.0"/' "$c/Package.swift"
  mkdir -p "$c/.swiftpm/configuration"
  cat > "$c/.swiftpm/configuration/registries.json" <<JSON
{
  "authentication": {},
  "registries": { "smoke": { "supportsAvailability": false, "url": "$URL" } },
  "security": { "default": { "signing": {
    "onUnsigned": "error", "onUntrustedCertificate": "error",
    "trustedRootCertificatesPath": "$CA/trusted",
    "includeDefaultTrustedRootCertificates": false,
    "validationChecks": { "certificateExpiration": "enabled", "certificateRevocation": "disabled" }
  } } },
  "version": 1
}
JSON
  if (cd "$c" && "$SWIFT" build --cache-path "$T/cache" --config-path "$T/config" \
      --security-path "$T/security" >"$T/build.log" 2>&1); then
    ok "SwiftPM resolves and builds the published release (signature verified)"
  else tail -30 "$T/build.log"; bad "SwiftPM could not resolve the published release"; fi
fi
exit "$fail"
