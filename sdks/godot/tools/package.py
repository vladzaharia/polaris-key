#!/usr/bin/env python3
"""Package the Polaris Key Godot addon as release zips, reproducibly (P1-12).

    python3 sdks/godot/tools/package.py [--tag godot-vX.Y.Z] [--out DIR] [--allow-dirty]
    python3 sdks/godot/tools/package.py --check-version [--tag godot-vX.Y.Z]
    python3 sdks/godot/tools/package.py --notes VERSION      # that version's CHANGELOG section

Writes, into DIR (default sdks/godot/build/release):

    polaris-key-godot-vX.Y.Z.zip           the canonical artefact: addons/polaris_key/** only
    polaris-key-godot-vX.Y.Z-assetlib.zip  the same files under one wrapper directory, for the
                                           legacy Asset Library (see below)
    SHA256SUMS                             both zips' SHA-256, `sha256sum -c` format

The version is one value in four places: plugin.cfg's `version`, `PolarisKey.SDK_VERSION`
(polaris_key.gd, also sent as `X-PKey-SDK-Version`), the tag `godot-vX.Y.Z` and the zip names. The
script fails, writing nothing, unless plugin.cfg and SDK_VERSION agree, the version is SemVer, and
(with --tag) the tag names the same version.

The file list is `git ls-files addons/polaris_key`: committed files only, so build products (the
iOS xcframework, the Android AARs) and anything git-ignored never ship. Every `.gd` must travel
with its `.gd.uid` (Godot 4.4+ references scripts by UID), and the addon folder must hold
plugin.cfg, LICENSE and README.md (the Asset Store wants the licence and a readme inside the
plugin folder). A tracked file with uncommitted changes refuses the build unless --allow-dirty.

Reproducible: entries in byte order of their paths, every timestamp 1980-01-01 00:00 (the ZIP
epoch), files 0644 and directories 0755, no extra fields, deflate level 9. Two runs over one
commit give byte-identical zips on the same zlib; SHA256SUMS records them.

Why two zips: Godot's asset installer drops a zip's single top-level directory by default when
it installs from the Asset Library. 4.7 exempts a top-level `addons/` (editor_asset_installer.cpp,
"Don't skip "addons" by default"); 4.4, 4.5 and 4.6, the only editors the legacy Asset Library
reaches, do not, and would install an `addons/`-rooted zip at res://polaris_key/. The assetlib
zip wraps the same tree in `polaris-key-godot-vX.Y.Z/`, which those editors drop, so the files
land at res://addons/polaris_key/ there too. The canonical zip is the one to unzip by hand, to
upload to the Asset Store and to attach to the GitHub Release.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import re
import subprocess
import sys
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent  # sdks/godot
ADDON = "addons/polaris_key"
SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
TAG = re.compile(r"^godot-v(.+)$")
EPOCH = (1980, 1, 1, 0, 0, 0)
REQUIRED = ("plugin.cfg", "plugin.gd", "polaris_key.gd", "LICENSE", "README.md")
# Never inside a release, even if someone commits it under the addon.
FORBIDDEN = re.compile(r"(^|/)(\.godot|tests|build)(/|$)|\.xcframework(/|$)|(^|/)native/android/bin(/|$)")


class PackageError(Exception):
    pass


def read_versions() -> tuple[str, str]:
    cfg = (PROJECT / ADDON / "plugin.cfg").read_text(encoding="utf-8")
    m = re.search(r'^version="([^"]*)"\s*$', cfg, re.M)
    if not m:
        raise PackageError("plugin.cfg has no version=\"…\" line")
    root = (PROJECT / ADDON / "polaris_key.gd").read_text(encoding="utf-8")
    n = re.search(r'^const SDK_VERSION := "([^"]*)"\s*$', root, re.M)
    if not n:
        raise PackageError('polaris_key.gd has no `const SDK_VERSION := "…"` line')
    return m.group(1), n.group(1)


def check_version(tag: str | None) -> str:
    cfg, sdk = read_versions()
    problems = []
    if cfg != sdk:
        problems.append(f"plugin.cfg version {cfg!r} != PolarisKey.SDK_VERSION {sdk!r}")
    if not SEMVER.match(cfg):
        problems.append(f"plugin.cfg version {cfg!r} is not SemVer 2.0")
    if tag is not None:
        t = TAG.match(tag)
        if not t or not SEMVER.match(t.group(1)):
            problems.append(f"tag {tag!r} is not godot-vMAJOR.MINOR.PATCH[-pre][+build]")
        elif t.group(1) != cfg:
            problems.append(f"tag {tag!r} names {t.group(1)!r}, plugin.cfg says {cfg!r}")
        if t and t.group(1) != sdk:
            problems.append(f"tag {tag!r} names {t.group(1)!r}, SDK_VERSION says {sdk!r}")
    if problems:
        raise PackageError("version check failed:\n  " + "\n  ".join(dict.fromkeys(problems)))
    return cfg


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=PROJECT, check=True, capture_output=True).stdout


def addon_files(allow_dirty: bool) -> list[str]:
    files = sorted(p for p in git("ls-files", "-z", "--", ADDON).decode("utf-8").split("\0") if p)
    if not files:
        raise PackageError(f"git ls-files found nothing under {ADDON}")
    if not allow_dirty:
        dirty = git("status", "--porcelain", "--untracked-files=no", "--", ADDON).decode("utf-8")
        if dirty.strip():
            raise PackageError("tracked addon files have uncommitted changes:\n" + dirty.rstrip())
    rel = [f[len(ADDON) + 1 :] for f in files]
    problems = []
    for need in REQUIRED:
        if need not in rel:
            problems.append(f"{ADDON}/{need} is missing")
    present = set(rel)
    for f in rel:
        if FORBIDDEN.search(f):
            problems.append(f"{ADDON}/{f} must not ship")
        if f.endswith(".gd") and f + ".uid" not in present:
            problems.append(f"{ADDON}/{f} has no committed .uid")
        if f.endswith(".gd.uid") and f[: -len(".uid")] not in present:
            problems.append(f"{ADDON}/{f} has no script")
        if not (PROJECT / ADDON / f).is_file():
            problems.append(f"{ADDON}/{f} is tracked but missing from the working tree")
    if problems:
        raise PackageError("addon check failed:\n  " + "\n  ".join(problems))
    return files


def build_zip(files: list[str], prefix: str) -> bytes:
    """A deterministic zip of `files` (paths relative to sdks/godot) under `prefix`."""
    dirs: set[str] = set()
    for f in files:
        parts = (prefix + f).split("/")[:-1]
        for i in range(1, len(parts) + 1):
            dirs.add("/".join(parts[:i]) + "/")
    entries = sorted([(d, None) for d in dirs] + [(prefix + f, f) for f in files], key=lambda e: e[0].encode("utf-8"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, src in entries:
            info = zipfile.ZipInfo(name, date_time=EPOCH)
            info.create_system = 3  # Unix, so external_attr carries the mode
            if src is None:
                info.external_attr = (0o40755 << 16) | 0x10
                info.compress_type = zipfile.ZIP_STORED
                z.writestr(info, b"")
            else:
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, (PROJECT / src).read_bytes(), compresslevel=9)
    return buf.getvalue()


def changelog_notes(version: str) -> str:
    text = (PROJECT / "CHANGELOG.md").read_text(encoding="utf-8")
    m = re.search(rf"^## \[?{re.escape(version)}\]?[^\n]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not m or not m.group(1).strip():
        raise PackageError(f"CHANGELOG.md has no section for {version}")
    return m.group(1).strip() + "\n"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tag", help="the release tag, godot-vX.Y.Z; must match plugin.cfg and SDK_VERSION")
    ap.add_argument("--out", default=str(PROJECT / "build" / "release"), help="output directory")
    ap.add_argument("--allow-dirty", action="store_true", help="package uncommitted changes to tracked files")
    ap.add_argument("--check-version", action="store_true", help="only check the version agreement")
    ap.add_argument("--notes", metavar="VERSION", help="print VERSION's CHANGELOG.md section and exit")
    a = ap.parse_args(argv)
    try:
        if a.notes:
            sys.stdout.write(changelog_notes(a.notes))
            return 0
        version = check_version(a.tag)
        if a.check_version:
            print(f"package: version {version} agrees (plugin.cfg, SDK_VERSION{', ' + a.tag if a.tag else ''})")
            return 0
        changelog_notes(version)  # a release without notes is refused before anything is written
        files = addon_files(a.allow_dirty)
        base = f"polaris-key-godot-v{version}"
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        sums = []
        for name, prefix in ((f"{base}.zip", ""), (f"{base}-assetlib.zip", f"{base}/")):
            data = build_zip(files, prefix)
            (out / name).write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            sums.append(f"{digest}  {name}\n")
            print(f"package: {out / name} ({len(data)} bytes, {len(files)} files) sha256 {digest}")
        (out / "SHA256SUMS").write_text("".join(sums), encoding="utf-8")
        return 0
    except PackageError as e:
        print(f"package: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
