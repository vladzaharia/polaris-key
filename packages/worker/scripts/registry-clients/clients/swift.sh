#!/usr/bin/env bash
# The Swift registry client (F-06, plans/F-01.md §6.8): real SwiftPM against the local registry,
# with signing enforced. `swift.seed.mjs` published smoke.SmokeKit 1.0.0 (stable), 1.1.0 (yanked)
# and 2.0.0-beta.1 (beta), each signed by this run's throwaway CA.
#
# Every SwiftPM call uses its own cache, config and security directories under a temp dir, so
# nothing from (or into) the user's ~/.swiftpm or caches takes part: the TOFU fingerprints of one
# run never meet another's. Checks:
#   1. `from: "1.0.0"` resolves to 1.0.0 (the yanked 1.1.0 is unavailable; the prerelease is
#      not eligible), builds, and the built binary prints the archive's own version;
#   2. `exact: "1.1.0"` (yanked) fails to resolve;
#   3. `exact: "2.0.0-beta.1"` (the beta channel) resolves and builds;
#   4. with the throwaway root NOT trusted, resolution fails (`onUntrustedCertificate: error`);
#   5. a few protocol details over plain HTTP (Content-Version, the login, F-21).
# Against an authenticated feed (run.mjs --auth, F-21): SwiftPM sends registry credentials only
# over HTTPS (measured with SwiftPM 6.4: neither a token nor a basic credential, from a netrc or
# registries.json, is ever sent to an http:// registry), and the harness is plain HTTP on loopback.
# So steps 1 to 4 run against the public feed only, and the authenticated feed is checked here over
# HTTP: the login endpoint, and the release list with and without the token. SwiftPM's own token
# login is verified against pkg-staging over HTTPS (F-21's report). The configuration below is the
# one users write (`"type": "token"` and the token in netrc), ready for an HTTPS harness.
# Signing is always `onUnsigned: error`. REGISTRY, OWNER and STATE come from run.mjs.
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${STATE:?STATE is the harness state directory}"
SWIFT="${SWIFT:-swift}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$STATE/swift/fixture.json"
URL="$REGISTRY/swift/$OWNER"
ROOTS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).trustedRoots)' "$FIX")"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0
HOST="$(node -p "new URL('$REGISTRY').hostname")"
AUTH='{}'
NETRC=()
if [ -n "${PKEY_REGISTRY_TOKEN:-}" ]; then
  printf 'machine %s login token password %s\n' "$HOST" "$PKEY_REGISTRY_TOKEN" > "$T/netrc"
  AUTH="{ \"$HOST\": { \"type\": \"token\" } }"
  NETRC=(--netrc-file "$T/netrc" --disable-keychain)
fi
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# consumer <dir> <requirement> <trust: yes|no> — a consumer package configured for the registry.
consumer() {
  local dir="$T/$1" req="$2" trust="$3" empty="$T/empty-roots"
  mkdir -p "$empty"
  cp -R "$HERE/swift/consumer" "$dir"
  REQ="$req" perl -pi -e 's/REQUIREMENT/$ENV{REQ}/' "$dir/Package.swift"
  mkdir -p "$dir/.swiftpm/configuration"
  local roots="$ROOTS"
  [ "$trust" = yes ] || roots="$empty"
  cat > "$dir/.swiftpm/configuration/registries.json" <<EOF
{
  "authentication": $AUTH,
  "registries": {
    "smoke": { "supportsAvailability": false, "url": "$URL" }
  },
  "security": {
    "default": {
      "signing": {
        "onUnsigned": "error",
        "onUntrustedCertificate": "error",
        "trustedRootCertificatesPath": "$roots",
        "includeDefaultTrustedRootCertificates": false,
        "validationChecks": {
          "certificateExpiration": "enabled",
          "certificateRevocation": "disabled"
        }
      }
    }
  },
  "version": 1
}
EOF
}

# spm <dir> <subcommand…> — SwiftPM isolated from the user's state.
spm() {
  local dir="$T/$1"
  shift
  "$SWIFT" "$@" ${NETRC[@]+"${NETRC[@]}"} --package-path "$dir" --cache-path "$T/cache-$(basename "$dir")" \
    --config-path "$T/config" --security-path "$T/security-$(basename "$dir")" \
    --scratch-path "$dir/.build"
}

resolved_version() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const p = (r.pins || r.object?.pins || []).find((x) => (x.identity || "").toLowerCase() === "smoke.smokekit");
    console.log(p?.state?.version ?? "");
  ' "$T/$1/Package.resolved"
}

if [ -z "${REGISTRY_AUTH:-}" ]; then
# 1. The stable requirement.
consumer stable 'from: "1.0.0"' yes
if spm stable package resolve && [ "$(resolved_version stable)" = "1.0.0" ]; then
  ok "from: 1.0.0 resolves to 1.0.0 (yanked 1.1.0 and the prerelease skipped), signature verified"
else
  bad "from: 1.0.0 did not resolve to 1.0.0 (got '$(resolved_version stable 2>/dev/null || true)')"
fi
if spm stable build --product SmokeConsumer >/dev/null &&
  [ "$("$T/stable/.build/debug/SmokeConsumer")" = "hello from SmokeKit 1.0.0" ]; then
  ok "swift build from the registry archive; the binary prints 1.0.0"
else
  bad "swift build of the 1.0.0 consumer"
fi

# 2. The yanked version.
consumer yanked 'exact: "1.1.0"' yes
# refused <log> <pattern> — the failure names the expected cause (not, say, a dead registry).
refused() { grep -m1 -iE "error:" "$1" | sed 's/^/       /'; grep -qiE "$2" "$1"; }
if spm yanked package resolve >"$T/yanked.log" 2>&1; then
  bad "exact: 1.1.0 (yanked) resolved"
elif refused "$T/yanked.log" "1\.1\.0"; then
  ok "exact: 1.1.0 (yanked) is refused"
else
  bad "exact: 1.1.0 failed for another reason"
fi

# 3. The beta channel's prerelease.
consumer beta 'exact: "2.0.0-beta.1"' yes
if spm beta build --product SmokeConsumer >/dev/null &&
  [ "$("$T/beta/.build/debug/SmokeConsumer")" = "hello from SmokeKit 2.0.0-beta.1" ]; then
  ok "exact: 2.0.0-beta.1 (the beta channel) resolves and builds"
else
  bad "exact: 2.0.0-beta.1"
fi

# 4. The root not trusted: SwiftPM must refuse the signature.
consumer untrusted 'from: "1.0.0"' no
if spm untrusted package resolve >"$T/untrusted.log" 2>&1; then
  bad "an untrusted signing root was accepted (onUntrustedCertificate: error)"
elif refused "$T/untrusted.log" "certificate|trust|sign"; then
  ok "an untrusted signing root is refused (onUntrustedCertificate: error)"
else
  bad "the untrusted resolve failed for another reason"
fi

else
  echo "skip SwiftPM resolution against the authenticated feed: SwiftPM sends credentials only over HTTPS"
  code="$(curl -q -sS -o /dev/null -w '%{http_code}' -H 'Accept: application/vnd.swift.registry.v1+json' "$URL/smoke/SmokeKit")"
  [ "$code" = 401 ] && ok "release list without a token: 401" || bad "release list without a token: $code"
  code="$(curl -q -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PKEY_REGISTRY_TOKEN" -H 'Accept: application/vnd.swift.registry.v1+json' "$URL/smoke/SmokeKit")"
  [ "$code" = 200 ] && ok "release list with the token (Bearer, as SwiftPM sends it): 200" || bad "release list with the token: $code"
  code="$(curl -q -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PKEY_REGISTRY_TOKEN" "$URL/smoke/SmokeKit/1.0.0.zip")"
  [ "$code" = 200 ] && ok "source archive with the token: 200" || bad "source archive with the token: $code"
fi

# 5. Protocol details over plain HTTP.
h="$(curl -sS -D - -o /dev/null -H 'Accept: application/vnd.swift.registry.v1+json' "$URL/smoke/SmokeKit")"
if grep -qi '^content-version: 1' <<<"$h" && grep -qi 'rel="latest-version"' <<<"$h"; then
  ok "list: Content-Version: 1 and a latest-version link"
else
  bad "list headers"
fi
# F-21: login checks a registry token: 401 without one, 200 with a valid one (run.mjs --auth).
code="$(curl -q -sS -o /dev/null -w '%{http_code}' -X POST "$URL/login")"
[ "$code" = 401 ] && ok "POST /login without a token answers 401" || bad "POST /login answered $code"
if [ -n "${PKEY_REGISTRY_TOKEN:-}" ]; then
  code="$(curl -q -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $PKEY_REGISTRY_TOKEN" "$URL/login")"
  [ "$code" = 200 ] && ok "POST /login with the registry token answers 200" || bad "POST /login with the token answered $code"
fi
code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Accept: application/vnd.swift.registry.v2+json' "$URL/smoke/SmokeKit")"
[ "$code" = 415 ] && ok "Accept v2 answers 415" || bad "Accept v2 answered $code"

if [ "$fail" != 0 ]; then
  for f in "$T"/*.log; do
    [ -f "$f" ] && { echo "── $f"; tail -20 "$f"; }
  done
fi
exit "$fail"
