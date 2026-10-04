#!/usr/bin/env bash
# sign_and_notarize.sh --app Game.app --identity ID [--entitlements FILE] [--zip OUT.zip]
#                      [--notary-profile NAME | --api-key KEY.p8 --api-key-id ID --api-issuer UUID]
#
# Signs an exported Godot macOS app that ships the Sparkle bridge INSIDE-OUT, notarises it,
# staples the ticket and packages the Sparkle archive (notes/E1 §C2, notes/S-11 §7 rows 1-4, §8
# steps 3-4). The release job of a game runs it after `--export-release` to a `.app`:
#
#   1. chmod 0755 Sparkle's five Mach-O files (Godot's [dependencies] copy drops the bit);
#   2. sign, innermost first, each with the hardened runtime: Installer.xpc, Downloader.xpc
#      (keeping its entitlements), Autoupdate, Updater.app, Sparkle.framework; then every other
#      dylib and framework in Contents/Frameworks (the GDExtension); then the app with its
#      entitlements (default: the ones it carries, which the export gave it: Disable Library
#      Validation among them, which a GDExtension in a hardened-runtime app needs);
#   3. `codesign --verify --deep --strict`;
#   4. notarise the zip with notarytool (a keychain profile, or an App Store Connect API key) and
#      staple the app; then
#   5. `ditto -c -k --sequesterRsrc --keepParent` the stapled app into --zip, the archive
#      `sign_update` signs and the Worker lists.
#
# --identity "-" signs ad hoc and skips notarisation: the local and CI end-to-end runs use it,
# and so may a developer. A Developer ID identity needs a timestamp (network) and, for step 4,
# notarisation credentials; both are the owner's (notes/S-11 §7). Never export with
# codesign/codesign=0 and skip this script: the template's own signature on a modified bundle
# makes Sparkle reject every update.

set -eu

APP=""
IDENTITY="${PKEY_MACOS_IDENTITY:-}"
ENTITLEMENTS=""
ZIP=""
PROFILE="${PKEY_NOTARY_PROFILE:-}"
API_KEY="${PKEY_NOTARY_API_KEY:-}"
API_KEY_ID="${PKEY_NOTARY_API_KEY_ID:-}"
API_ISSUER="${PKEY_NOTARY_API_ISSUER:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --entitlements) ENTITLEMENTS="$2"; shift 2 ;;
    --zip) ZIP="$2"; shift 2 ;;
    --notary-profile) PROFILE="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --api-key-id) API_KEY_ID="$2"; shift 2 ;;
    --api-issuer) API_ISSUER="$2"; shift 2 ;;
    *) echo "sign_and_notarize.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -d "$APP" ] && [ "${APP%.app}" != "$APP" ] || { echo "sign_and_notarize.sh: --app must be an exported .app" >&2; exit 2; }
[ -n "$IDENTITY" ] || { echo "sign_and_notarize.sh: --identity (or PKEY_MACOS_IDENTITY) is required; \"-\" signs ad hoc" >&2; exit 2; }

ADHOC=0
[ "$IDENTITY" = "-" ] && ADHOC=1
TS="--timestamp"
[ "$ADHOC" = 1 ] && TS="--timestamp=none"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pkey-sign.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

sign() { codesign --force --sign "$IDENTITY" --options runtime "$TS" "$@"; }

FW="$APP/Contents/Frameworks"
SP="$FW/Sparkle.framework/Versions/B"

# 1. The executable bits.
if [ -d "$SP" ]; then
  for f in Sparkle Autoupdate Updater.app/Contents/MacOS/Updater XPCServices/Downloader.xpc/Contents/MacOS/Downloader XPCServices/Installer.xpc/Contents/MacOS/Installer; do
    chmod 0755 "$SP/$f"
  done
fi

# The app's entitlements before anything is re-signed.
if [ -z "$ENTITLEMENTS" ]; then
  ENTITLEMENTS="$WORK/app.entitlements"
  codesign -d --entitlements - --xml "$APP" >"$ENTITLEMENTS" 2>/dev/null || true
  if [ ! -s "$ENTITLEMENTS" ]; then
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>\n' >"$ENTITLEMENTS"
  fi
fi
# Disable Library Validation lets the app load a library signed by anyone; together with
# allow-dyld-environment-variables, DYLD_INSERT_LIBRARIES would inject arbitrary code into a
# notarised build. Never ship the pair.
if grep -q "com.apple.security.cs.allow-dyld-environment-variables" "$ENTITLEMENTS" && grep -q "com.apple.security.cs.disable-library-validation" "$ENTITLEMENTS"; then
  echo "sign_and_notarize.sh: $ENTITLEMENTS grants both disable-library-validation and allow-dyld-environment-variables; remove the latter" >&2
  exit 1
fi
grep -q "com.apple.security.cs.disable-library-validation" "$ENTITLEMENTS" || echo "sign_and_notarize.sh: warning: $ENTITLEMENTS lacks com.apple.security.cs.disable-library-validation; the GDExtension will not load under the hardened runtime" >&2

# 2. Inside out.
if [ -d "$SP" ]; then
  sign "$SP/XPCServices/Installer.xpc"
  sign --preserve-metadata=entitlements "$SP/XPCServices/Downloader.xpc"
  sign "$SP/Autoupdate"
  sign "$SP/Updater.app"
  sign "$FW/Sparkle.framework"
fi
if [ -d "$FW" ]; then
  for f in "$FW"/*; do
    case "$f" in
      */Sparkle.framework) ;;
      *.dylib | *.framework | *.so) sign "$f" ;;
    esac
  done
fi
sign --entitlements "$ENTITLEMENTS" "$APP"

# 3. Verify.
codesign --verify --deep --strict --verbose=2 "$APP"

# 4. Notarise and staple.
if [ "$ADHOC" = 1 ]; then
  echo "sign_and_notarize.sh: ad-hoc identity, notarisation skipped"
elif [ -n "$PROFILE" ] || [ -n "$API_KEY" ]; then
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$WORK/notarize.zip"
  if [ -n "$PROFILE" ]; then
    xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$PROFILE" --wait
  else
    xcrun notarytool submit "$WORK/notarize.zip" --key "$API_KEY" --key-id "$API_KEY_ID" --issuer "$API_ISSUER" --wait
  fi
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
else
  echo "sign_and_notarize.sh: Developer ID signature without notarisation credentials: Gatekeeper will refuse a quarantined download" >&2
fi

# 5. The Sparkle archive.
if [ -n "$ZIP" ]; then
  rm -f "$ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  echo "sign_and_notarize.sh: $ZIP"
fi
