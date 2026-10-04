#!/usr/bin/env bash
# Sign a Swift registry release of polaris-key.PolarisKey (F-10, plans/F-01.md §5.3).
#
#   sdks/swift/tools/sign-registry-release.sh <version> <scratch-dir> <key-dir>
#
# Swift registry releases are signed (owner decision 2026-10-04) and this never falls back to
# unsigned. With the three secrets in the environment it:
#
#   1. checks all three are set, else stops with the error plans/F-01.md §5.3 fixes;
#   2. decodes them into <key-dir> (the runner's temp directory; the workflow deletes it in an
#      always() step, and this script's own trap deletes it on any exit):
#        SWIFT_REGISTRY_SIGNING_KEY   base64 of the PEM private key (converted to the PKCS#8 DER
#                                     SwiftPM's --private-key-path reads)
#        SWIFT_REGISTRY_SIGNING_CERT  base64 of the DER leaf certificate
#        SWIFT_REGISTRY_CERT_CHAIN    base64 DER intermediates and root, separated by commas
#   3. runs `swift package-registry publish --dry-run` in sdks/swift, which writes the source
#      archive, its cms-1.0.0 signature and the signed Package.swift into <scratch-dir> and
#      contacts no registry. `pkey release publish --deliverable swift.polariskey --dir
#      <scratch-dir>` then publishes those files to the Swift feed on pkg.plrs.im.
#
# No secret value is ever echoed: each is decoded from the environment straight into a file.
set -euo pipefail

version="${1:?usage: sign-registry-release.sh <version> <scratch-dir> <key-dir>}"
scratch="${2:?usage: sign-registry-release.sh <version> <scratch-dir> <key-dir>}"
keydir="${3:?usage: sign-registry-release.sh <version> <scratch-dir> <key-dir>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "$here/.." && pwd)"
identity="polaris-key.PolarisKey"
feed_url="${SWIFT_REGISTRY_URL:-https://pkg.plrs.im/swift/polaris-key}"

if [ -z "${SWIFT_REGISTRY_SIGNING_KEY:-}" ] || [ -z "${SWIFT_REGISTRY_SIGNING_CERT:-}" ] ||
  [ -z "${SWIFT_REGISTRY_CERT_CHAIN:-}" ]; then
  echo "::error::Swift registry releases are signed (owner decision 2026-10-04). Set SWIFT_REGISTRY_SIGNING_KEY, SWIFT_REGISTRY_SIGNING_CERT and SWIFT_REGISTRY_CERT_CHAIN."
  exit 1
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::$version is not a semantic version (MAJOR.MINOR.PATCH[-prerelease])." >&2
  exit 1
fi

cleanup() { rm -rf "$keydir"; }
trap cleanup EXIT

umask 077
mkdir -p "$keydir" "$scratch"
decode() { printf '%s' "$1" | tr -d '\r\n ' | openssl base64 -d -A; }
decode "$SWIFT_REGISTRY_SIGNING_KEY" >"$keydir/key.pem"
openssl pkcs8 -topk8 -nocrypt -in "$keydir/key.pem" -outform DER -out "$keydir/key.p8.der" 2>/dev/null || {
  echo "::error::SWIFT_REGISTRY_SIGNING_KEY is not a base64-encoded PEM private key." >&2
  exit 1
}
rm -f "$keydir/key.pem"
decode "$SWIFT_REGISTRY_SIGNING_CERT" >"$keydir/leaf.der"
openssl x509 -inform DER -in "$keydir/leaf.der" -noout 2>/dev/null || {
  echo "::error::SWIFT_REGISTRY_SIGNING_CERT is not a base64-encoded DER certificate." >&2
  exit 1
}
chain=("$keydir/leaf.der")
i=0
IFS=',' read -r -a parts <<<"$SWIFT_REGISTRY_CERT_CHAIN"
for part in "${parts[@]}"; do
  [ -n "${part//[[:space:]]/}" ] || continue
  i=$((i + 1))
  decode "$part" >"$keydir/chain-$i.der"
  openssl x509 -inform DER -in "$keydir/chain-$i.der" -noout 2>/dev/null || {
    echo "::error::SWIFT_REGISTRY_CERT_CHAIN entry $i is not a base64-encoded DER certificate." >&2
    exit 1
  }
  chain+=("$keydir/chain-$i.der")
done
if [ "$i" -eq 0 ]; then
  echo "::error::SWIFT_REGISTRY_CERT_CHAIN names no certificate." >&2
  exit 1
fi

cd "$package_dir"
swift package-registry publish "$identity" "$version" \
  --url "$feed_url" \
  --dry-run \
  --scratch-directory "$scratch" \
  --private-key-path "$keydir/key.p8.der" \
  --cert-chain-paths "${chain[@]}"

# SwiftPM's working copy of the package; the archive already holds it, and nothing publishes it.
rm -rf "$scratch/source"
zip_count="$(find "$scratch" -maxdepth 1 -name '*.zip' | wc -l | tr -d ' ')"
sig_count="$(find "$scratch" -maxdepth 1 -name '*.sig' | wc -l | tr -d ' ')"
if [ "$zip_count" != 1 ] || [ "$sig_count" != 1 ] || [ ! -f "$scratch/Package.swift" ]; then
  echo "::error::the dry run did not leave one signed archive, its signature and Package.swift in $scratch." >&2
  ls -la "$scratch" >&2
  exit 1
fi
echo "Signed $identity $version into $scratch:"
(cd "$scratch" && find . -maxdepth 1 -type f | sort)
