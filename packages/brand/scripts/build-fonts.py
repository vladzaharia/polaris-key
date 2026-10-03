#!/usr/bin/env python3
"""Subset the launch kit's Rubik binaries to WOFF2 (one-off; the outputs are committed).

    python3 -m venv .venv && .venv/bin/pip install fonttools==4.* brotli
    .venv/bin/python scripts/build-fonts.py

Reads kit/source/fonts/Rubik-{Regular,Bold}.ttf (the kit's unmodified binaries, SIL OFL 1.1)
and writes fonts/rubik-{latin,latin-ext}-{400,700}.woff2. The unicode ranges are the ones Google
Fonts serves for its `latin` and `latin-ext` subsets, so the @font-face blocks in fonts/fonts.css
let a browser fetch only the file a page needs. The ranges are kept in one place (RANGES below),
and test/fonts.test.ts checks that fonts.css declares exactly these ranges and that each WOFF2
file exists.

Subsetting and format conversion make these Modified Versions under the OFL (section 1). Rubik
declares no Reserved Font Name, so the family name stays "Rubik". The OFL and the kit's
FONT-NOTICE travel with the files (fonts/OFL.txt, fonts/FONT-NOTICE.txt).

Layout features kept: kern, liga, calt, ccmp, case, tnum, frac, numr, dnom, sups, subs, mark,
mkmk. Hinting is kept (the TTFs are hinted; dropping it would visibly change small sizes on
Windows).
"""

from __future__ import annotations

import pathlib

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "kit" / "source" / "fonts"
OUT = ROOT / "fonts"

# Google Fonts' latin and latin-ext subset ranges.
RANGES = {
    "latin": "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,"
    "U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,"
    "U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,"
    "U+2C60-2C7F,U+A720-A7FF",
}

WEIGHTS = {"400": "Rubik-Regular.ttf", "700": "Rubik-Bold.ttf"}

FEATURES = "kern,liga,calt,ccmp,case,tnum,frac,numr,dnom,sups,subs,mark,mkmk"


def unicodes(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip().removeprefix("U+")
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a, 16), int(b, 16) + 1))
        else:
            out.append(int(part, 16))
    return out


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for weight, filename in WEIGHTS.items():
        for name, spec in RANGES.items():
            font = TTFont(SRC / filename)
            options = subset.Options()
            options.flavor = "woff2"
            options.layout_features = FEATURES.split(",")
            options.hinting = True
            options.name_IDs = ["*"]
            options.name_legacy = True
            options.name_languages = ["*"]
            options.notdef_outline = True
            options.recalc_timestamp = False
            sub = subset.Subsetter(options)
            sub.populate(unicodes=unicodes(spec))
            sub.subset(font)
            target = OUT / f"rubik-{name}-{weight}.woff2"
            font.flavor = "woff2"
            font.save(target)
            print(f"wrote {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
