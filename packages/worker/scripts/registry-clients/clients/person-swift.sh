#!/usr/bin/env bash
# One personal token over two owners, with SwiftPM (F-33b.6, plans/F-33b-ST-30c-slices.md §2).
# `run.mjs --person` seeded acme.SmokeKit, bolt.SmokeKit and cove.SmokeKit (signed, 1.0.0; each
# owner's own throwaway CA), a `licensed` feed per owner, one account with a usable licence in acme
# and bolt and none in cove, and its `pkeyp_` token (PKEY_PERSON_TOKEN).
#
# SwiftPM keys its credential by HOST, so one registry login serves both owners' registry URLs (one
# scope each). SwiftPM sends credentials only over HTTPS (clients/swift.sh, F-21), and this harness
# is plain HTTP on loopback: the HTTP-level checks always run (the login endpoint, and the release
# list and source archive of each owner with the one token, and cove's 403), and the SwiftPM
# resolution runs too, passing when SwiftPM sends the token here and reporting the transport limit
# (a skip, never a pass) when it does not.
# The token goes to SwiftPM in a netrc file and to curl in a config file; it is never echoed.
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${STATE:?STATE is the harness state directory}"
: "${PKEY_PERSON_TOKEN:?PKEY_PERSON_TOKEN is the personal token (run.mjs --person)}"
SWIFT="${SWIFT:-swift}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
HOST="$(node -p "new URL('$REGISTRY').hostname")"
printf 'machine %s login token password %s\n' "$HOST" "$PKEY_PERSON_TOKEN" >"$T/netrc"
printf 'header = "Authorization: Bearer %s"\n' "$PKEY_PERSON_TOKEN" >"$T/curlrc"
code() { curl -q -sS -o /dev/null -w '%{http_code}' --config "$T/curlrc" "$@"; }
list="Accept: application/vnd.swift.registry.v1+json"

# ── HTTP level, always ────────────────────────────────────────────────────────────────────────
c="$(curl -q -sS -o /dev/null -w '%{http_code}' -X POST "$REGISTRY/swift/acme/login")"
[ "$c" = 401 ] && ok "login without a token: 401" || bad "login without a token: $c"
for o in acme bolt; do
  c="$(code -X POST "$REGISTRY/swift/$o/login")"
  [ "$c" = 200 ] && ok "$o: login with the personal token: 200" || bad "$o: login with the personal token: $c"
  c="$(code -H "$list" "$REGISTRY/swift/$o/$o/SmokeKit")"
  [ "$c" = 200 ] && ok "$o: release list with the one token: 200" || bad "$o: release list: $c"
  c="$(code "$REGISTRY/swift/$o/$o/SmokeKit/1.0.0.zip")"
  [ "$c" = 200 ] && ok "$o: source archive with the one token: 200" || bad "$o: source archive: $c"
done
c="$(code -H "$list" "$REGISTRY/swift/cove/cove/SmokeKit")"
[ "$c" = 403 ] && ok "cove: release list is 403 (no licence in cove)" || bad "cove: release list: $c, not 403"
c="$(code "$REGISTRY/swift/cove/cove/SmokeKit/1.0.0.zip")"
[ "$c" = 403 ] && ok "cove: source archive is 403" || bad "cove: source archive: $c, not 403"

# ── SwiftPM ───────────────────────────────────────────────────────────────────────────────────
# Both owners' signing roots in one directory: each owner's throwaway CA signed its own package.
mkdir -p "$T/roots"
for o in acme bolt; do
  d="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).trustedRoots' "$STATE/swift-$o/fixture.json")"
  cp "$d/root.der" "$T/roots/$o.der"
done
P="$T/consumer"
mkdir -p "$P/Sources/SmokeConsumer" "$P/.swiftpm/configuration"
cat >"$P/Package.swift" <<'SWIFT'
// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "SmokeConsumer",
    dependencies: [
        .package(id: "acme.SmokeKit", from: "1.0.0"),
        .package(id: "bolt.SmokeKit", from: "1.0.0"),
    ],
    targets: [.executableTarget(name: "SmokeConsumer")]
)
SWIFT
echo 'print("ok")' >"$P/Sources/SmokeConsumer/main.swift"
cat >"$P/.swiftpm/configuration/registries.json" <<JSON
{
  "authentication": { "$HOST": { "type": "token" } },
  "registries": {
    "acme": { "supportsAvailability": false, "url": "$REGISTRY/swift/acme" },
    "bolt": { "supportsAvailability": false, "url": "$REGISTRY/swift/bolt" }
  },
  "security": {
    "default": {
      "signing": {
        "onUnsigned": "error",
        "onUntrustedCertificate": "error",
        "trustedRootCertificatesPath": "$T/roots",
        "includeDefaultTrustedRootCertificates": false,
        "validationChecks": { "certificateExpiration": "enabled", "certificateRevocation": "disabled" }
      }
    }
  },
  "version": 1
}
JSON
if "$SWIFT" package resolve --netrc-file "$T/netrc" --disable-keychain --package-path "$P" \
  --cache-path "$T/cache" --config-path "$T/config" --security-path "$T/security" \
  --scratch-path "$P/.build" >"$T/resolve.log" 2>&1; then
  pins="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(((r.pins||r.object?.pins)||[]).map((p)=>p.identity).sort().join(" "))' "$P/Package.resolved")"
  [ "$pins" = "acme.smokekit bolt.smokekit" ] && ok "SwiftPM resolved acme.SmokeKit and bolt.SmokeKit with one token" || bad "SwiftPM pinned '$pins'"
elif grep -qiE "401|unauthori[sz]ed|authenticat|credential" "$T/resolve.log"; then
  echo "skip SwiftPM resolution: SwiftPM sends credentials only over HTTPS (clients/swift.sh, F-21)"
  grep -m1 -iE "error" "$T/resolve.log" | sed 's/^/       /' || true
else
  bad "SwiftPM resolution failed for another reason"
  tail -20 "$T/resolve.log"
fi
exit "$fail"
