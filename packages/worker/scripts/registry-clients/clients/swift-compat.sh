#!/usr/bin/env bash
# The swiftlang registry compatibility suite against the local Swift registry (F-06, plans/F-01.md
# §6.8): swiftlang/swift-package-registry-compatibility-test-suite's `package-registry-compatibility`
# tool, pinned, built from source with the trimmed manifest in swift/compat-Package.swift (upstream's
# own no longer resolves). Runs every read sub-command against smoke.SmokeKit as `swift.seed.mjs`
# published it; `create-package-release` is out of scope (publishing is F-22's). Any test case
# with an error fails the run; warnings (SHOULDs we do not do: package URLs in the list, the
# Digest header, pagination) are printed.
#
# The build is cached under SWIFT_COMPAT_CACHE (default: the OS temp dir), keyed by the commit.
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${STATE:?STATE is the harness state directory}"
SWIFT="${SWIFT:-swift}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT=5d873abb62ac543237a1918db804de83bd1fd0aa
CACHE="${SWIFT_COMPAT_CACHE:-${TMPDIR:-/tmp}/pkey-swift-compat}/$COMMIT"
URL="$REGISTRY/swift/$OWNER"
FIX="$STATE/swift/fixture.json"

if [ ! -x "$CACHE/.build/release/package-registry-compatibility" ]; then
  rm -rf "$CACHE"
  mkdir -p "$CACHE"
  git -C "$CACHE" init -q
  git -C "$CACHE" fetch -q --depth 1 \
    https://github.com/swiftlang/swift-package-registry-compatibility-test-suite.git "$COMMIT"
  git -C "$CACHE" checkout -q FETCH_HEAD
  cp "$HERE/swift/compat-Package.swift" "$CACHE/Package.swift"
  rm -f "$CACHE/Package.resolved"
  "$SWIFT" build -c release --package-path "$CACHE" --product package-registry-compatibility
fi
TOOL="$CACHE/.build/release/package-registry-compatibility"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
node - "$FIX" "$T/config.json" <<'EOF'
const fs = require("fs");
const [fixPath, out] = process.argv.slice(2);
const fix = JSON.parse(fs.readFileSync(fixPath, "utf8"));
const pkg = { scope: fix.scope, name: fix.name };
const unknown = { scope: fix.scope, name: "NoSuchPackage" };
const rel = (version) => ({ package: pkg, version });
const unknownRel = [{ package: pkg, version: "9.9.9" }, { package: unknown, version: "1.0.0" }];
const config = {
  listPackageReleases: {
    packages: [
      {
        package: pkg,
        numberOfReleases: fix.releases.length,
        versions: fix.releases.map((r) => r.version),
        unavailableVersions: fix.releases.filter((r) => r.state === "yanked").map((r) => r.version),
        linkRelations: ["latest-version"],
      },
    ],
    unknownPackages: [unknown],
    packageURLProvided: false,
    problemProvided: true,
    paginationSupported: false,
  },
  fetchPackageReleaseInfo: {
    packageReleases: fix.releases.map((r) => ({
      packageRelease: rel(r.version),
      resources: [{ name: "source-archive", type: "application/zip", checksum: r.archive }],
      linkRelations: ["latest-version"],
    })),
    unknownPackageReleases: unknownRel,
  },
  fetchPackageReleaseManifest: {
    packageReleases: fix.releases.map((r) => ({
      packageRelease: rel(r.version),
      swiftVersions: r.toolsVersions,
      noSwiftVersions: ["4.2"],
    })),
    unknownPackageReleases: unknownRel,
    contentLengthHeaderIsSet: true,
    contentDispositionHeaderIsSet: true,
  },
  downloadSourceArchive: {
    sourceArchives: fix.releases.map((r) => ({ packageRelease: rel(r.version), hasDuplicateLinks: false })),
    unknownSourceArchives: unknownRel,
    contentDispositionHeaderIsSet: true,
    digestHeaderIsSet: false,
  },
  lookupPackageIdentifiers: {
    urls: [{ url: fix.repository, packageIdentifiers: [fix.id] }],
    unknownURLs: ["https://github.com/example/NoSuchRepository"],
  },
};
fs.writeFileSync(out, JSON.stringify(config, null, 2));
EOF

fail=0
for sub in list-package-releases fetch-package-release-info fetch-package-release-manifest \
  download-source-archive lookup-package-identifiers; do
  echo "── $sub"
  if ! "$TOOL" "$sub" "$URL" "$T/config.json" --allow-http >"$T/$sub.log" 2>&1; then
    fail=1
  fi
  cat "$T/$sub.log"
  # The tool prints a summary per sub-command; any failed test case fails the client.
  if grep -qE "[1-9][0-9]* test cases failed" "$T/$sub.log"; then fail=1; fi
done
exit "$fail"
