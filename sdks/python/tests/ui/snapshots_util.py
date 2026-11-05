"""Lossless baselines for the Qt kit. ``PKEY_UPDATE_SNAPSHOTS=1`` re-records (say why in the commit);
a missing or changed baseline fails otherwise. Text antialiasing differs by a few levels between
machines, so a pixel counts as changed only above ``CHANNEL`` and the image as changed above ``SHARE``.
Where the system fonts change a screen's layout by more than that, its Linux baseline sits beside the
others in ``linux/`` and wins on Linux; ``PKEY_UPDATE_SNAPSHOTS=linux`` records into it (Linux only)."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Tuple

CHANNEL = 40
SHARE = 0.004


def _bytes(image: Any) -> Tuple[int, int, bytes]:
    from PySide6.QtGui import QImage

    rgba = image.convertToFormat(QImage.Format.Format_RGBA8888)
    return rgba.width(), rgba.height(), bytes(rgba.constBits())


def check(image: Any, path: Path) -> None:
    from PySide6.QtGui import QImage

    linux = path.parent / "linux" / path.name
    if os.environ.get("PKEY_UPDATE_SNAPSHOTS") == "linux":
        assert sys.platform == "linux", "Linux baselines are recorded on Linux"
        linux.parent.mkdir(parents=True, exist_ok=True)
        assert image.save(str(linux), "PNG")
        return
    if sys.platform == "linux" and linux.exists():
        path = linux
    if os.environ.get("PKEY_UPDATE_SNAPSHOTS") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        assert image.save(str(path), "PNG")
        return
    assert path.exists(), f"no baseline {path.name}: record it with PKEY_UPDATE_SNAPSHOTS=1"
    base = QImage(str(path))
    bw, bh, bb = _bytes(base)
    w, h, nb = _bytes(image)
    assert (w, h) == (bw, bh), f"{path.name}: {w}x{h}, baseline {bw}x{bh}"
    if nb == bb:
        return
    changed = sum(
        1 for i in range(0, len(nb), 4) if max(abs(nb[i + c] - bb[i + c]) for c in range(3)) > CHANNEL
    )
    assert changed / (w * h) <= SHARE, f"{path.name}: {changed} of {w * h} pixels changed"
