#!/usr/bin/env bash
# check_apks.sh: the consumer app's APKs hold what the artifacts promise (SP-50). Run after
#
#   ../../gradlew -p samples/android-consumer assembleDebug assembleRelease
#
#   lean   (sdk + android-direct + ui + billing): no zstd-jni native library at all
#   packs  (the same + polaris-key-zstd): zstd-jni's Android natives (the AAR variant, never the
#          desktop JAR's), every 64-bit one 16 KB page aligned (tools/check_16k_alignment.py)
# for both the debug and the minified release build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/app/build/outputs/apk"
FAILED=0
fail() { echo "  FAIL: $*"; FAILED=1; }
ok() { echo "  ok: $*"; }

for build in debug release; do
  lean="$OUT/lean/$build/app-lean-$build.apk"
  packs="$OUT/packs/$build/app-packs-$build.apk"
  for apk in "$lean" "$packs"; do [ -f "$apk" ] || { echo "check_apks: $apk missing; build it first" >&2; exit 2; }; done
  echo "── $build"
  # Captured first: `unzip | grep -q` under pipefail fails when grep exits early.
  lean_libs="$(unzip -Z1 "$lean" | grep -E '\.so$' || true)"
  packs_libs="$(unzip -Z1 "$packs" | grep -E '\.so$' || true)"
  if grep -q 'zstd' <<<"$lean_libs"; then fail "the lean APK carries zstd-jni: $(grep zstd <<<"$lean_libs" | tr '\n' ' ')"; else ok "the lean APK carries no libzstd-jni"; fi
  zstd="$(grep -E '^lib/[^/]+/libzstd-jni-[0-9.-]+\.so$' <<<"$packs_libs" || true)"
  if [ -z "$zstd" ]; then
    fail "the packs APK carries no zstd-jni natives"
  else
    ok "the packs APK carries $(wc -l <<<"$zstd" | tr -d ' ') zstd-jni natives"
    # The desktop JAR keeps its natives under the OS name (darwin/, linux/, win/), never lib/<abi>/.
    if unzip -Z1 "$packs" | grep -qE '^(darwin|linux|win|freebsd|aix)/'; then fail "the packs APK holds the desktop JAR's natives"; else ok "no desktop natives"; fi
    if python3 "$HERE/../../tools/check_16k_alignment.py" "$packs" >/dev/null; then ok "zstd-jni's natives are 16 KB page aligned"; else fail "a native library is not 16 KB page aligned"; fi
  fi
done

if [ "$FAILED" != 0 ]; then
  echo "check_apks: FAILED"
  exit 1
fi
echo "check_apks: the artifact set holds"
