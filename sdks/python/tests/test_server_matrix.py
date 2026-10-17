# @pkey-feature server.license server.signin
"""Replays ``backend-matrix.json``'s ``verdict`` and ``problem`` sections (WIRE-CONTRACT-V4 §14,
plans/SP-53.md §4) through the server core. The client section is the client half's (SP-58)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.server import backend_problem, backend_verdict
from polaris_key.server._verdict import entitlement, signin

_PATH = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "backend-matrix.json"
_MATRIX: Dict[str, Any] = json.loads(_PATH.read_text(encoding="utf-8"))
_VERDICT: List[Dict[str, Any]] = _MATRIX["verdict"]
_PROBLEM: List[Dict[str, Any]] = _MATRIX["problem"]


def _require(raw: List[Dict[str, Any]]) -> list:
    return [entitlement(r["name"]) if r["kind"] == "entitlement" else signin() for r in raw]


@pytest.mark.parametrize("row", _VERDICT, ids=[r["id"] for r in _VERDICT])
def test_verdict_row(row: Dict[str, Any]) -> None:
    inp = row["input"]
    opts = inp["options"]
    v = backend_verdict(
        [tuple(h) for h in inp["headers"]],
        inp["now"],
        opts["products"],
        inp["trust"],
        max_age_seconds=opts.get("maxAgeSeconds"),
        require=_require(opts.get("require", [])),
    )
    expect = row["expect"]
    assert (v.status, v.code) == (expect["status"], expect["code"])
    assert v.context() == expect["context"]


def test_matrix_constants_match() -> None:
    from polaris_key.server import AUTH_SCHEME, HEADER_LICENSE, LICENSE_MAX_BYTES, REFUSAL_STATUS

    c = _MATRIX["constants"]
    assert (HEADER_LICENSE, AUTH_SCHEME, LICENSE_MAX_BYTES) == (
        c["headerLicense"],
        c["authScheme"],
        c["licenseMaxBytes"],
    )
    assert dict(REFUSAL_STATUS) == c["statuses"]


@pytest.mark.parametrize("row", _PROBLEM, ids=[r["id"] for r in _PROBLEM])
def test_problem_row(row: Dict[str, Any]) -> None:
    inp = row["input"]
    p = backend_problem(inp["code"], inp["realm"], inp["acceptLanguage"])
    e = row["expect"]
    assert (p.status, p.locale, p.challenge, p.type, p.title, p.detail) == (
        e["status"],
        e["locale"],
        e["challenge"],
        e["type"],
        e["title"],
        e["detail"],
    )
