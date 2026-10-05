# @pkey-feature core.headers
"""Client metadata header values (WIRE-CONTRACT-V3 §5.2).

Runs ``conformance/corpus/v2/headers.json`` through :func:`polaris_key.canonical_platform` and
:func:`polaris_key.canonical_arch`. The Node (``conformance/runners/node/headers.test.ts``),
Swift (``HeadersTests.swift``) and Godot (``tests/suite_conformance.gd``) runners and the Worker
(``test/headersCorpus.test.ts``) run the same rows. The generated tables must equal the map
derived from the rows, and a captured request must carry the canonical values.
"""

from __future__ import annotations

import json
import platform
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest

from polaris_key import (
    ARCH_SPELLINGS,
    ARCH_VALUES,
    PLATFORM_SPELLINGS,
    PLATFORM_VALUES,
    SDK_NAME,
    SdkId,
    canonical_arch,
    canonical_platform,
)

from helpers import PRODUCT, make_client

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v2/headers.json
_CORPUS = json.loads(
    (
        Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "headers.json"
    ).read_text(encoding="utf-8")
)


def _fold(s: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def _derived(rows: List[Dict[str, Any]]) -> Dict[str, str]:
    return {_fold(r["raw"]): r["expect"] for r in rows if r["expect"] is not None}


_SECTIONS = [
    ("platformCases", canonical_platform, PLATFORM_SPELLINGS, PLATFORM_VALUES),
    ("archCases", canonical_arch, ARCH_SPELLINGS, ARCH_VALUES),
]


def _passes(fn: Callable[[str], Optional[str]], row: Dict[str, Any]) -> bool:
    return fn(row["raw"]) == row["expect"]


def test_headers_version_and_floors() -> None:
    assert _CORPUS["headersVersion"] == 2
    assert len(_CORPUS["platformCases"]) >= 31
    assert len(_CORPUS["archCases"]) >= 31


@pytest.mark.parametrize(
    "fn,row",
    [(canonical_platform, r) for r in _CORPUS["platformCases"]]
    + [(canonical_arch, r) for r in _CORPUS["archCases"]],
    ids=[f"platform-{r['id']}" for r in _CORPUS["platformCases"]]
    + [f"arch-{r['id']}" for r in _CORPUS["archCases"]],
)
def test_row(fn: Callable[[str], Optional[str]], row: Dict[str, Any]) -> None:
    assert fn(row["raw"]) == row["expect"]


@pytest.mark.parametrize("section,fn,table,values", _SECTIONS, ids=[s[0] for s in _SECTIONS])
def test_table_equals_the_rows(section: str, fn: Any, table: Any, values: Any) -> None:
    assert dict(table) == _derived(_CORPUS[section])
    for value in table.values():
        assert value in values


@pytest.mark.parametrize("section,fn,table,values", _SECTIONS, ids=[s[0] for s in _SECTIONS])
def test_a_doctored_row_fails(section: str, fn: Any, table: Any, values: Any) -> None:
    row = next(r for r in _CORPUS[section] if r["expect"] is not None)
    doctored = dict(row, expect="macos" if row["expect"] == "linux" else "linux")
    assert _passes(fn, row)
    assert not _passes(fn, doctored)


def test_a_captured_request_carries_the_canonical_values() -> None:
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/license/activate":
            seen["headers"] = dict(r.headers)
            return httpx.Response(200, json={"token": "pkeyt_x", "schemaVersion": 4})
        return httpx.Response(404)

    c = make_client(handler)
    c.license.activate_with_key("k")
    c.close()
    headers = seen["headers"]
    # Every CI host (linux-x86_64, macOS-arm64) maps both.
    assert canonical_platform(platform.system()) is not None
    assert canonical_arch(platform.machine()) is not None
    assert headers["x-pkey-platform"] == canonical_platform(platform.system())
    assert headers["x-pkey-arch"] == canonical_arch(platform.machine())
    assert headers["x-pkey-sdk"] == "python"
    assert SDK_NAME == SdkId.PYTHON == "python"


def test_update_platform_is_a_build_target_only() -> None:
    """WIRE-CONTRACT-V4 §5.2 rule 5 (SP-08): ``tvos``, ``visionos`` and ``watchos`` are header
    values only, so they give no update platform; the six build targets pass through."""
    from polaris_key.update.client import update_platform

    for value in ("macos", "ios", "android", "windows", "linux", "web"):
        assert update_platform(value) == value
    for value in ("tvos", "visionos", "watchos"):
        assert canonical_platform(value) == value
        assert update_platform(value) is None
    assert update_platform(None) is None
