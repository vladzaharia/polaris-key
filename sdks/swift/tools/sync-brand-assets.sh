#!/usr/bin/env bash
# Copy the launch-kit assets PolarisKeyUI bundles (the variable Rubik and JetBrains Mono with
# their notices, the bit-less Pinned K, and "Powered by" badges) byte-for-byte from the brand
# inputs. `BrandThemeTests` fails when a bundled copy differs from its source, so after a kit or
# font update run this and commit the result. The lists here and the test's `.fontCopies` /
# `.kitCopies` must match.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
kit="$here/../../packages/brand/kit"
fonts="$here/../../packages/brand/fonts"
out="$here/Sources/PolarisKeyUI/Resources/Brand"

copy() { mkdir -p "$(dirname "$out/$1")"; cp "$kit/$2" "$out/$1"; }
copy_font() { mkdir -p "$(dirname "$out/$1")"; cp "$fonts/$2" "$out/$1"; }

copy fonts/OFL.txt source/fonts/OFL.txt
copy_font fonts/Rubik-Variable.ttf ttf/Rubik-Variable.ttf
copy_font fonts/JetBrainsMono-Variable.ttf ttf/JetBrainsMono-Variable.ttf
copy_font fonts/OFL-JetBrainsMono.txt OFL-JetBrainsMono.txt
copy_font fonts/FONT-NOTICE-VARIABLE.txt FONT-NOTICE.txt
for theme in dark light; do
  copy "marks/key-$theme-192.png" "01-marks/key/png/$theme/key-192.png"
  for treatment in transparent outline sticker; do
    copy "powered-by/$treatment/compact-$theme.png" "03-powered-by/$treatment/powered-by-compact-$theme-696.png"
    copy "powered-by/$treatment/horizontal-$theme.png" "03-powered-by/$treatment/powered-by-horizontal-$theme-1128.png"
    copy "powered-by/$treatment/stacked-$theme.png" "03-powered-by/$treatment/powered-by-stacked-$theme-864.png"
  done
done
echo "synced brand assets into $out"
