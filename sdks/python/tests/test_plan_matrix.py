# @pkey-feature packs.plan packs.delta.feed
"""``plan-matrix.json`` (plans/P4-01.md §4.5; P4-07): the install planner, variant selection and
target mapping through the production functions, as the Node runner drives them
(``conformance/runners/node/suites.ts``). Rows → ``plan``; ``variantCases`` →
``select_variant``; ``targetCases`` → ``plan_target``; ``feedDeltaCases`` (plans/P4-29.md §4.3)
→ ``with_feed_deltas``, then ``plan_target`` and ``plan``. Verdicts compare as canonical JSON with
integral floats normalised.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from polaris_key.update.packs import plan, plan_target, select_variant, with_feed_deltas

_PATH = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "plan-matrix.json"
_MATRIX: Dict[str, Any] = json.loads(_PATH.read_text(encoding="utf-8"))


def _canonical(v: Any) -> Any:
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, dict):
        return {k: _canonical(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_canonical(x) for x in v]
    return v


def test_plan_matrix_has_every_row_and_case() -> None:
    assert _MATRIX["planMatrixVersion"] == 2
    assert _MATRIX["requestWeight"] == 16384
    assert len(_MATRIX["rows"]) == 28
    assert len(_MATRIX["variantCases"]) == 11
    assert len(_MATRIX["targetCases"]) == 22
    assert len(_MATRIX["feedDeltaCases"]) == 13


@pytest.mark.parametrize("row", _MATRIX["rows"], ids=[r["id"] for r in _MATRIX["rows"]])
def test_plan_row(row: Dict[str, Any]) -> None:
    assert _canonical(plan(row["input"])) == _canonical(row["expect"]), row["description"]


@pytest.mark.parametrize("case", _MATRIX["variantCases"], ids=[c["id"] for c in _MATRIX["variantCases"]])
def test_variant_case(case: Dict[str, Any]) -> None:
    assert select_variant(case["variants"], case["prefs"]) == case["expect"], case["description"]


@pytest.mark.parametrize("case", _MATRIX["targetCases"], ids=[c["id"] for c in _MATRIX["targetCases"]])
def test_target_case(case: Dict[str, Any]) -> None:
    # plans/P4-10.md §4.4: `chunkIndex` is absent (None) on the cases before P4-10.
    got = plan_target(case["variant"], case["recordSha256"], case["filesIndex"], case.get("chunkIndex"))
    assert _canonical(got) == _canonical(case["expect"]), case["description"]


@pytest.mark.parametrize(
    "case", _MATRIX["feedDeltaCases"], ids=[c["id"] for c in _MATRIX["feedDeltaCases"]]
)
def test_feed_delta_case(case: Dict[str, Any]) -> None:
    merged, feed_ids = with_feed_deltas(case["variant"], case["deltas"])
    target = plan_target(merged, case["recordSha256"], case["filesIndex"], case.get("chunkIndex"))
    planned = plan({"target": target, "installed": case["installed"], "caps": case["caps"]})
    got = {"feedIds": feed_ids, "target": target, "plan": planned}
    assert _canonical(got) == _canonical(case["expect"]), case["description"]
