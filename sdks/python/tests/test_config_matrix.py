# @pkey-feature config.resolve config.list
"""Config resolution conformance (WIRE-CONTRACT-V3 §2.2.1).

Runs ``conformance/corpus/v2/config-matrix.json`` through :func:`resolve_value`,
:func:`resolve_source` and :func:`list_user_entries`. Python has an environment layer, so every
row is checked against ``expect``. The Node runner (``conformance/runners/node/configMatrix
.test.ts``), React, Swift and Godot run the same rows.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from polaris_key.config.resolve import (
    UNSET,
    ResolveContext,
    list_user_entries,
    resolve_source,
    resolve_value,
)
from polaris_key.core.models import ManagedEntry

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v2/config-matrix.json
_MATRIX = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "conformance"
        / "corpus"
        / "v2"
        / "config-matrix.json"
    ).read_text(encoding="utf-8")
)


def _canonical_equal(a: Any, b: Any) -> bool:
    """Keys unordered, arrays ordered, numbers by value (an integral float equals its integer,
    -0 equals 0); a bool is not a number."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_canonical_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_canonical_equal(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


def _remote(raw: Optional[Dict[str, Any]]) -> Optional[Dict[str, ManagedEntry]]:
    if raw is None:
        return None
    return {k: ManagedEntry.from_any(v) for k, v in raw.items()}


def _ctx(case: Dict[str, Any]) -> ResolveContext:
    return ResolveContext(
        remote=_remote(case["remote"]),
        local_overrides=case["localOverrides"],
        env=case["env"],
        env_prefix=case["envPrefix"],
    )


def _resolve(case: Dict[str, Any]) -> Dict[str, Any]:
    ctx = _ctx(case)
    value = resolve_value(ctx, case["key"], UNSET)
    return {
        "value": case["fallback"] if value is UNSET else value,
        "source": resolve_source(ctx, case["key"]),
    }


def _passes(got: Dict[str, Any], want: Dict[str, Any]) -> bool:
    return got["source"] == want["source"] and _canonical_equal(got["value"], want["value"])


def _expand(case: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "remote": None,
        "localOverrides": {},
        "env": {"PKEY_CONFIG_value": case["raw"]},
        "envPrefix": "PKEY_CONFIG_",
        "key": "value",
        "fallback": "(fallback)",
    }


def _list(case: Dict[str, Any]) -> List[Dict[str, Any]]:
    return sorted(list_user_entries(_ctx(case)), key=lambda e: e["key"])


def _list_passes(got: List[Dict[str, Any]], want: List[Dict[str, Any]]) -> bool:
    return len(got) == len(want) and all(
        g["key"] == w["key"]
        and g["enforced"] == w["enforced"]
        and _canonical_equal(g["value"], w["value"])
        for g, w in zip(got, want)
    )


def test_version_and_floors() -> None:
    assert _MATRIX["configMatrixVersion"] == 1
    assert len(_MATRIX["resolveCases"]) >= 24
    assert len(_MATRIX["envValueCases"]) >= 82
    assert len(_MATRIX["listCases"]) >= 8


@pytest.mark.parametrize("case", _MATRIX["resolveCases"], ids=lambda c: c["id"])
def test_resolve_case(case: Dict[str, Any]) -> None:
    got = _resolve(case)
    assert got["source"] == case["expect"]["source"]
    assert _canonical_equal(got["value"], case["expect"]["value"]), got


@pytest.mark.parametrize("case", _MATRIX["envValueCases"], ids=lambda c: c["id"])
def test_env_value_case(case: Dict[str, Any]) -> None:
    got = _resolve(_expand(case))
    assert got["source"] == "env"
    if case.get("anyNumber"):
        value = got["value"]
        assert isinstance(value, (int, float)) and not isinstance(value, bool)
        assert math.isfinite(value)
    else:
        assert _canonical_equal(got["value"], case["value"]), got["value"]


@pytest.mark.parametrize("case", _MATRIX["listCases"], ids=lambda c: c["id"])
def test_list_case(case: Dict[str, Any]) -> None:
    assert _list_passes(_list(case), case["expect"])


def test_a_doctored_row_fails() -> None:
    row = _MATRIX["resolveCases"][0]
    assert _passes(_resolve(row), row["expect"])
    assert not _passes(_resolve(row), dict(row["expect"], value="doctored"))
    env_row = next(c for c in _MATRIX["envValueCases"] if c["id"] == "env-value-integer")
    assert _passes(_resolve(_expand(env_row)), {"value": env_row["value"], "source": "env"})
    assert not _passes(_resolve(_expand(env_row)), {"value": 43, "source": "env"})
    list_row = _MATRIX["listCases"][0]
    assert _list_passes(_list(list_row), list_row["expect"])
    assert not _list_passes(_list(list_row), list_row["expect"][1:])


def test_a_raw_lone_surrogate_stays_raw() -> None:
    """``os.environ`` holds a lone surrogate for each byte it cannot decode: the bytes
    ``["``, FF, ``"]`` read as ``'["\\udcff"]'``, which ``json.loads`` alone parses. No corpus row
    can carry one, because Swift's ``JSONDecoder`` would refuse the file."""
    raw = '["\udcff"]'
    case = {
        "remote": None,
        "localOverrides": {},
        "env": {"PKEY_CONFIG_value": raw},
        "envPrefix": "PKEY_CONFIG_",
        "key": "value",
        "fallback": "(fallback)",
    }
    assert _resolve(case) == {"value": raw, "source": "env"}
    # The same byte in a member name.
    case["env"] = {"PKEY_CONFIG_value": '{"\udcff":1}'}
    assert _resolve(case) == {"value": '{"\udcff":1}', "source": "env"}
