#!/usr/bin/env python3
"""check_16k_alignment.py: every Android native library is 16 KB page aligned (P6-08).

Android 15+ devices may run with 16 KB memory pages, and Google Play requires every 64-bit native
library an app ships (arm64-v8a, x86_64) to have each ELF PT_LOAD segment aligned to at least
16 KB (p_align >= 0x4000). The Kotlin SDK's only native code is zstd-jni's libzstd-jni (:packs'
zstd port, notes/E9); this check reads the .so files inside each archive given (an AAR, APK or
JAR, or a bare .so) and fails on any 64-bit library with a PT_LOAD segment aligned below 16 KB.
32-bit libraries (armeabi-v7a, x86) are reported but never fail: 16 KB pages exist only on 64-bit.

    python3 tools/check_16k_alignment.py <archive-or-so> [...]

With no argument it resolves the zstd-jni Android AAR the version catalog pins from the Gradle
cache (~/.gradle) or Maven Central, so the `kotlin` CI job can run it with a JDK and Python only.
Exits 0 when every 64-bit library passes, 1 on a violation, 2 when nothing was checked.
"""

import io
import os
import re
import struct
import sys
import urllib.request
import zipfile

PAGE = 0x4000
PT_LOAD = 1
SIXTY_FOUR = ("arm64-v8a", "x86_64")
HERE = os.path.dirname(os.path.abspath(__file__))


def load_aligns(data):
    """The p_align of every PT_LOAD segment of an ELF image, and whether it is 64-bit."""
    if data[:4] != b"\x7fELF":
        raise ValueError("not an ELF file")
    is64 = data[4] == 2
    endian = "<" if data[5] == 1 else ">"
    if is64:
        phoff, = struct.unpack_from(endian + "Q", data, 0x20)
        phentsize, phnum = struct.unpack_from(endian + "HH", data, 0x36)
    else:
        phoff, = struct.unpack_from(endian + "I", data, 0x1C)
        phentsize, phnum = struct.unpack_from(endian + "HH", data, 0x2A)
    aligns = []
    for i in range(phnum):
        off = phoff + i * phentsize
        p_type, = struct.unpack_from(endian + "I", data, off)
        if p_type != PT_LOAD:
            continue
        if is64:
            p_align, = struct.unpack_from(endian + "Q", data, off + 0x30)
        else:
            p_align, = struct.unpack_from(endian + "I", data, off + 0x1C)
        aligns.append(p_align)
    return is64, aligns


def check_library(name, data):
    """One line per library; True when it passes."""
    is64, aligns = load_aligns(data)
    low = min(aligns) if aligns else 0
    abi = next((a for a in SIXTY_FOUR if f"/{a}/" in f"/{name}"), None)
    must = is64 and (abi is not None or "/lib/" not in name)
    ok = low >= PAGE
    verdict = "ok" if ok else ("FAIL" if must else "info (32-bit, not required)")
    print(f"  {verdict}: {name} PT_LOAD p_align min 0x{low:x} over {len(aligns)} segment(s)")
    return ok or not must


def check_path(path):
    """Every .so in an archive (or the file itself). Returns (checked, failures)."""
    checked = failures = 0
    if path.endswith(".so"):
        with open(path, "rb") as f:
            checked, failures = 1, 0 if check_library(os.path.basename(path), f.read()) else 1
        return checked, failures
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if not info.filename.endswith(".so"):
                continue
            if "android" not in path.lower() and not info.filename.startswith(("jni/", "lib/")):
                continue
            checked += 1
            if not check_library(info.filename, z.read(info)):
                failures += 1
    return checked, failures


def pinned_version():
    with open(os.path.join(HERE, "..", "gradle", "libs.versions.toml")) as f:
        m = re.search(r'^zstdJni\s*=\s*"([^"]+)"', f.read(), re.M)
    if not m:
        raise SystemExit("check_16k_alignment: no zstdJni version in libs.versions.toml")
    return m.group(1)


def default_archive():
    version = pinned_version()
    name = f"zstd-jni-{version}.aar"
    cache = os.path.expanduser("~/.gradle/caches/modules-2/files-2.1/com.github.luben/zstd-jni")
    for root, _dirs, files in os.walk(cache):
        if name in files:
            return os.path.join(root, name)
    out = os.path.join(os.environ.get("TMPDIR", "/tmp"), name)
    if not os.path.exists(out):
        url = f"https://repo1.maven.org/maven2/com/github/luben/zstd-jni/{version}/{name}"
        print(f"check_16k_alignment: fetching {url}")
        with urllib.request.urlopen(url, timeout=60) as r, open(out, "wb") as f:
            f.write(r.read())
    return out


def main(argv):
    paths = argv or [default_archive()]
    total = bad = 0
    for p in paths:
        print(f"{p}:")
        c, f = check_path(p)
        total += c
        bad += f
    if total == 0:
        print("check_16k_alignment: no native library checked")
        return 2
    print(f"check_16k_alignment: {total} librar{'y' if total == 1 else 'ies'}, {bad} violation(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
