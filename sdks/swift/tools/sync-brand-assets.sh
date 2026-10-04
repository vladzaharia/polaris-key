#!/usr/bin/env bash
# Copy the launch-kit files PolarisKeyUI bundles (Rubik + its OFL, the bit-less Pinned K, the
# "Powered by Polaris Key" badges) from packages/brand/kit/ into the target's resources, byte for
# byte. `BrandThemeTests` fails when a bundled copy differs from the kit, so after a kit update run
# this and commit the result. The list here and `BrandThemeTests.kitCopies` must match.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
kit="$here/../../packages/brand/kit"
out="$here/Sources/PolarisKeyUI/Resources/Brand"

copy() { mkdir -p "$(dirname "$out/$1")"; cp "$kit/$2" "$out/$1"; }

copy fonts/Rubik-Regular.ttf source/fonts/Rubik-Regular.ttf
copy fonts/Rubik-Bold.ttf source/fonts/Rubik-Bold.ttf
copy fonts/OFL.txt source/fonts/OFL.txt
copy fonts/FONT-NOTICE.txt source/fonts/FONT-NOTICE.txt
for theme in dark light; do
  copy "marks/key-$theme-192.png" "01-marks/key/png/$theme/key-192.png"
  for treatment in transparent outline sticker; do
    copy "powered-by/$treatment/compact-$theme.png" "03-powered-by/$treatment/powered-by-compact-$theme-696.png"
    copy "powered-by/$treatment/horizontal-$theme.png" "03-powered-by/$treatment/powered-by-horizontal-$theme-1128.png"
    copy "powered-by/$treatment/stacked-$theme.png" "03-powered-by/$treatment/powered-by-stacked-$theme-864.png"
  done
done
echo "synced brand assets into $out"
