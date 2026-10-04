#!/usr/bin/env python3
"""Build the PyPI client fixture (F-05): reproducible wheels and an sdist of `polaris-smoke`.

    python3 build_pypi.py <out-dir>

Writes, for each version, `polaris_smoke-<v>-py3-none-any.whl`, the wheel's
`*.dist-info/METADATA` beside it as `<wheel>.metadata` (what the CLI extracts for PEP 658), and,
for 1.0.0, `polaris_smoke-1.0.0.tar.gz`. Every timestamp is fixed, so two builds are byte-identical
and the seed can run more than once. Standard library only: no build backend is needed.
"""

import base64
import hashlib
import io
import os
import sys
import tarfile
import zipfile

NAME = "polaris-smoke"
DIST = "polaris_smoke"
VERSIONS = ["0.8.0", "0.9.0", "1.0.0", "1.1.0b1"]
EPOCH = (2026, 1, 1, 0, 0, 0)


def metadata(version: str) -> str:
    return (
        "Metadata-Version: 2.1\n"
        f"Name: {NAME}\n"
        f"Version: {version}\n"
        "Summary: The registry-clients smoke package\n"
        "Requires-Python: >=3.8\n"
        "\n"
    )


def record_line(path: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(data)}"


def wheel(out: str, version: str) -> str:
    info = f"{DIST}-{version}.dist-info"
    files = {
        f"{DIST}/__init__.py": f'__version__ = "{version}"\n'.encode(),
        f"{info}/METADATA": metadata(version).encode(),
        f"{info}/WHEEL": (
            "Wheel-Version: 1.0\nGenerator: polaris-key-registry-clients\n"
            "Root-Is-Purelib: true\nTag: py3-none-any\n"
        ).encode(),
    }
    lines = [record_line(p, d) for p, d in files.items()] + [f"{info}/RECORD,,"]
    files[f"{info}/RECORD"] = ("\n".join(lines) + "\n").encode()
    name = f"{DIST}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(os.path.join(out, name), "w", zipfile.ZIP_DEFLATED) as z:
        for path, data in files.items():
            zi = zipfile.ZipInfo(path, EPOCH)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data)
    with open(os.path.join(out, f"{name}.metadata"), "wb") as f:
        f.write(files[f"{info}/METADATA"])
    return name


def sdist(out: str, version: str) -> str:
    root = f"{DIST}-{version}"
    files = {
        f"{root}/PKG-INFO": metadata(version).encode(),
        f"{root}/pyproject.toml": (
            '[build-system]\nrequires = []\nbuild-backend = "none"\n'
        ).encode(),
        f"{root}/{DIST}/__init__.py": f'__version__ = "{version}"\n'.encode(),
    }
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as t:
        for path, data in files.items():
            ti = tarfile.TarInfo(path)
            ti.size = len(data)
            ti.mtime = 1767225600
            ti.mode = 0o644
            t.addfile(ti, io.BytesIO(data))
    name = f"{root}.tar.gz"
    import gzip

    with open(os.path.join(out, name), "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", mtime=1767225600, filename="") as g:
            g.write(raw.getvalue())
    return name


def main() -> None:
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for v in VERSIONS:
        wheel(out, v)
    sdist(out, "1.0.0")


if __name__ == "__main__":
    main()
