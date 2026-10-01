"""Client metadata header values (WIRE-CONTRACT-V3 §5.2), pinned by ``headers.json``.

A host reads its runtime's own report (``platform.system()``, ``platform.machine()``) and maps
it here. The lookup folds ASCII A-Z only (never ``str.lower()``, which folds more than ASCII),
does not trim, and reads the generated table's own entries. A spelling with no value returns
``None``, and the host omits the header rather than inventing one.
"""

from __future__ import annotations

from typing import Mapping, Optional

from ..constants_generated import ARCH_SPELLINGS, PLATFORM_SPELLINGS

__all__ = ["canonical_platform", "canonical_arch"]


def _fold_ascii(raw: str) -> str:
    """A-Z become a-z; every other character is unchanged."""
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in raw)


def _lookup(table: Mapping[str, str], raw: str) -> Optional[str]:
    return table.get(_fold_ascii(raw))


def canonical_platform(raw: str) -> Optional[str]:
    """``Darwin`` → ``macos``, ``Windows`` → ``windows``, ``FreeBSD`` → ``None``."""
    return _lookup(PLATFORM_SPELLINGS, raw)


def canonical_arch(raw: str) -> Optional[str]:
    """``AMD64`` → ``x86_64``, ``aarch64`` → ``arm64``, ``i686`` → ``None``."""
    return _lookup(ARCH_SPELLINGS, raw)
