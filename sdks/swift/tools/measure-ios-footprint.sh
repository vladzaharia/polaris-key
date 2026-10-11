#!/usr/bin/env bash
# SP-52: a Release arm64 iOS app that links the kit (PolarisKey + PolarisKeyUI) and calls
# `client.update.decide()` must be at least 25% smaller than the same app over the 0.8.33 SDK.
#
#   measure-ios-footprint.sh [baseline-tag]        (default v0.8.33)
#
# Both builds use this toolchain and the one app source (tools/size-app), so the comparison needs
# no recorded number. Size is the compressed .ipa payload of the archived, stripped app, which is
# what a download costs. Needs Xcode (macos CI jobs) and XcodeGen (XCODEGEN, default: on PATH).
set -euo pipefail

tag="${1:-v0.8.33}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
xcodegen="${XCODEGEN:-xcodegen}"
work="$(mktemp -d "${TMPDIR:-/tmp}/pkey-ios-footprint.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if ! git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  git -C "$root" fetch --depth=1 origin "refs/tags/$tag:refs/tags/$tag"
fi
mkdir -p "$work/baseline-sdk"
git -C "$root" archive "$tag" sdks/swift | tar -x -C "$work/baseline-sdk"

measure() { # <label> <package path> -> prints the ipa size in bytes
  local label="$1" pkg="$2" dir="$work/$1"
  mkdir -p "$dir"
  cp -R "$here/tools/size-app/App" "$dir/App"
  sed "s|PKPATH|$pkg|" "$here/tools/size-app/project.yml" >"$dir/project.yml"
  (cd "$dir" && "$xcodegen" generate --quiet)
  (cd "$dir" && xcodebuild -project SizeApp.xcodeproj -scheme SizeApp -configuration Release \
    -destination 'generic/platform=iOS' -archivePath app.xcarchive ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
    CODE_SIGNING_ALLOWED=NO -derivedDataPath derived archive >"$dir/build.log" 2>&1) || {
    tail -40 "$dir/build.log" >&2
    echo "::error::the $label size app did not build." >&2
    exit 1
  }
  mkdir -p "$dir/ipa"
  cp -R "$dir/app.xcarchive/Products/Applications" "$dir/ipa/Payload"
  (cd "$dir/ipa" && zip -qr -9 ../app.ipa Payload)
  stat -f %z "$dir/app.ipa"
}

before="$(measure baseline "$work/baseline-sdk/sdks/swift")"
after="$(measure current "$here")"
echo "0.8.33 baseline ($tag): $before bytes; this tree: $after bytes"
# At least 25% smaller: after <= 75% of before.
if [ $((after * 100)) -gt $((before * 75)) ]; then
  echo "::error::the iOS app is only $((100 - after * 100 / before))% smaller than $tag; SP-52 needs at least 25%." >&2
  exit 1
fi
echo "iOS app footprint: $((100 - after * 100 / before))% smaller than $tag."
