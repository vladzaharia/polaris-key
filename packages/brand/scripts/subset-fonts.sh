#!/usr/bin/env bash
# Subset the variable Rubik and JetBrains Mono for the Apple kit (SP-52b.4, D-19).
#
# Reads fonts/ttf/{Rubik,JetBrainsMono}-Variable.ttf (unmodified, SIL OFL 1.1) and writes the
# committed inputs
#   fonts/ttf/Rubik-Variable-kit.ttf          wght 400-600 (DL12); Basic Latin, Latin-1, Latin
#                                             Extended-A, General Punctuation, currency, arrows
#   fonts/ttf/JetBrainsMono-Variable-kit.ttf  wght 400-600; Basic Latin plus the code separators
# CJK is not covered: the kit falls back to the system font for it (KitStyle.swift).
# The named instances Regular, Medium and SemiBold stay in fvar (CoreText finds the faces by them).
#
# Pinned tool: fonttools 4.66.1 (PyPI, uploaded 2026-09-29), installed in a throwaway venv, never
# the system Python. Run: packages/brand/scripts/subset-fonts.sh
#
# Output SHA-256 (reproducible: SOURCE_DATE_EPOCH is fixed; BrandThemeTests compares the bundled
# copies byte for byte and checks locale-pack glyph coverage):
#   Rubik-Variable-kit.ttf          cf222d1aafc8b6c1cb7e46e4d3b13ed7cff4d6efbdb56677bac9c9cf92ecd75f
#   JetBrainsMono-Variable-kit.ttf  da092738f7120a0c22269a9228b7e83c863c06542bc327f089aafe3f370e6770
set -euo pipefail

pin="4.66.1"
here="$(cd "$(dirname "$0")/.." && pwd)"
fonts="$here/fonts/ttf"
work="$(mktemp -d)"
trap '/bin/rm -rf "$work"' EXIT

uv venv -q "$work/venv"
uv pip install -q --python "$work/venv/bin/python" "fonttools==$pin"
py="$work/venv/bin/python"
export SOURCE_DATE_EPOCH=1790000000 # fixed head.modified: the output is byte-reproducible

latin="U+0020-007E,U+00A0-00FF,U+0100-017F,U+2000-206F,U+20A0-20C0,U+2190-2199,U+2212,U+2215"
mono="U+0020-007E,U+00A0,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2022,U+2026,U+2190-2193,U+2212"
features="kern,liga,calt,ccmp,case,tnum,frac,numr,dnom,sups,subs,mark,mkmk,zero"

make() { # <source> <unicodes> <out>
  "$py" -I -m fontTools.varLib.instancer "$fonts/$1" wght=400:600 -q -o "$work/inst.ttf"
  "$py" -I -m fontTools.subset "$work/inst.ttf" --unicodes="$2" --layout-features="$features" \
    --glyph-names --notdef-outline --no-hinting --desubroutinize --name-IDs='*' \
    --output-file="$fonts/$3"
}
make Rubik-Variable.ttf "$latin" Rubik-Variable-kit.ttf
# Rubik's default instance is Light (300). With the axis starting at 400 the default is Regular,
# so rename it: CoreText lists the default face by these names and the kit looks up "regular".
"$py" -I - "$fonts/Rubik-Variable-kit.ttf" <<'PY'
import sys
from fontTools.ttLib import TTFont
f = TTFont(sys.argv[1])
renames = {1: ("Rubik Light", "Rubik"), 3: ("Rubik-Light", "Rubik-Regular"), 4: ("Rubik Light", "Rubik Regular"),
           6: ("Rubik-Light", "Rubik-Regular"), 17: ("Light", "Regular")}
for rec in f["name"].names:
    old, new = renames.get(rec.nameID, (None, None))
    if old and old in rec.toUnicode():
        rec.string = rec.toUnicode().replace(old, new)
f.save(sys.argv[1])
PY
make JetBrainsMono-Variable.ttf "$mono" JetBrainsMono-Variable-kit.ttf
shasum -a 256 "$fonts/Rubik-Variable-kit.ttf" "$fonts/JetBrainsMono-Variable-kit.ttf"
