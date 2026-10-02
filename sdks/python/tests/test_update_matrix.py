# @pkey-feature update.decide
"""``update-matrix.json`` (plans/P3-01.md §4.6) through the Python port of the decision.

Mirrors the ``update-matrix`` sections of ``conformance/runners/node/corpusV2.test.ts`` against
the SAME file, with the same ids: the vocabularies, ``versionCases`` through
``compare_versions``, ``capabilityCases`` through ``effective_capabilities``, ``outletCases``
through ``resolve_update_outlet``, ``bucketVectors`` through ``rollout_bucket`` and every row
through ``decide_update`` and ``boot_decision``. ``outlet-matrix.json``'s compiled tables are
asserted equal to ``polaris_key.core.outlets`` (its detection rows are P3-11's).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.constants_generated import (
    BINARY_METHOD_VALUES,
    OUTLET_MATRIX_VERSION,
    UPDATE_ACTION_VALUES,
    UPDATE_BLOCKED_REASON_VALUES,
    UPDATE_MATRIX_VERSION,
    UPDATE_NONE_REASON_VALUES,
)
from polaris_key.core.decide import (
    boot_decision,
    decide_update,
    effective_capabilities,
    is_undismissable,
    resolve_update_outlet,
    rollout_bucket,
)
from polaris_key.core.models import UpdateDecision, UpdateDecisionInput
from polaris_key.core.outlets import (
    LISTING_URL_PREFIXES,
    OUTLET_CAPABILITY_DEFAULTS,
    OUTLET_CONFIDENCES,
    OUTLET_KINDS,
    OUTLET_PLATFORMS,
    OUTLET_SUBKINDS,
    PLATFORM_NARROWING,
    SUBKIND_NARROWING,
)
from polaris_key.core.stages import BOOT_DECISIONS
from polaris_key.core.version import VERSION_SCHEMES, compare_versions

_V2 = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
MATRIX: Dict[str, Any] = json.loads((_V2 / "update-matrix.json").read_text(encoding="utf-8"))
OUTLETS: Dict[str, Any] = json.loads((_V2 / "outlet-matrix.json").read_text(encoding="utf-8"))


def _plain(value: Any) -> Any:
    """Read-only tables as plain JSON values, for comparing with the matrix."""
    if hasattr(value, "items"):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


# ── Vocabulary and versions ─────────────────────────────────────────────────────────────────


def test_version_and_vocabulary() -> None:
    assert MATRIX["updateMatrixVersion"] == UPDATE_MATRIX_VERSION == 1
    assert MATRIX["vocabulary"] == {
        "actions": list(UPDATE_ACTION_VALUES),
        "noneReasons": list(UPDATE_NONE_REASON_VALUES),
        "blockedReasons": list(UPDATE_BLOCKED_REASON_VALUES),
        "methods": list(BINARY_METHOD_VALUES),
        "boot": list(BOOT_DECISIONS),
        "schemes": list(VERSION_SCHEMES),
    }


@pytest.mark.parametrize("c", MATRIX["versionCases"], ids=[c["name"] for c in MATRIX["versionCases"]])
def test_version_case(c: Dict[str, Any]) -> None:
    assert compare_versions(c["scheme"], c["a"], c["b"]) == c["expect"]


# ── outlet-matrix.json's compiled tables ────────────────────────────────────────────────────


def test_outlet_tables_equal_the_matrix() -> None:
    assert OUTLETS["outletMatrixVersion"] == OUTLET_MATRIX_VERSION == 1
    kinds = {
        kind: {**_plain(caps), "platforms": list(OUTLET_PLATFORMS[kind])}
        for kind, caps in OUTLET_CAPABILITY_DEFAULTS.items()
    }
    assert OUTLETS["kinds"] == kinds
    assert list(OUTLETS["kinds"]) == list(kinds)
    assert OUTLETS["platformNarrowing"] == _plain(PLATFORM_NARROWING)
    assert OUTLETS["subkinds"] == _plain(SUBKIND_NARROWING)
    assert OUTLETS["platformData"]["listingUrlPrefixes"] == _plain(LISTING_URL_PREFIXES)
    assert OUTLETS["vocabulary"]["kinds"] == list(OUTLET_KINDS)
    assert OUTLETS["vocabulary"]["subkinds"] == list(OUTLET_SUBKINDS)
    assert OUTLETS["vocabulary"]["confidence"] == list(OUTLET_CONFIDENCES)


# ── Capabilities, outlets, buckets and rows ─────────────────────────────────────────────────


def test_has_every_case_of_the_plan() -> None:
    assert len(MATRIX["capabilityCases"]) == 10
    assert len(MATRIX["outletCases"]) == 12
    assert len(MATRIX["bucketVectors"]) == 6
    assert len(MATRIX["rows"]) == 65


@pytest.mark.parametrize(
    "c", MATRIX["capabilityCases"], ids=[c["name"] for c in MATRIX["capabilityCases"]]
)
def test_capability_case(c: Dict[str, Any]) -> None:
    got = effective_capabilities(
        c["kind"], platform=c["platform"], subkind=c["subkind"], server=c["server"]
    )
    assert got.to_dict() == c["expect"]


@pytest.mark.parametrize("c", MATRIX["outletCases"], ids=[c["name"] for c in MATRIX["outletCases"]])
def test_outlet_case(c: Dict[str, Any]) -> None:
    got = resolve_update_outlet(host=c["host"], stamp=c["stamp"], detected=c["detected"])
    assert got is not None
    assert got.to_dict() == c["expect"]


@pytest.mark.parametrize(
    "host",
    [
        "epic",
        {"id": "Direct Build", "kind": "direct"},
        {"id": "direct", "kind": "epic"},
        {"id": "direct", "kind": "direct", "subkind": "brew"},
        7,
        {"kind": "direct"},
    ],
)
def test_an_invalid_host_outlet_resolves_to_none(host: Any) -> None:
    # The SDK raises invalid-options for it at construction.
    assert resolve_update_outlet(host=host) is None


@pytest.mark.parametrize(
    "v", MATRIX["bucketVectors"], ids=[v["name"] for v in MATRIX["bucketVectors"]]
)
def test_bucket_vector(v: Dict[str, Any]) -> None:
    assert rollout_bucket(v["salt"], v["installId"]) == v["bucket"]
    assert v["u32"] % 10000 == v["bucket"]


@pytest.mark.parametrize("row", MATRIX["rows"], ids=[r["name"] for r in MATRIX["rows"]])
def test_row(row: Dict[str, Any]) -> None:
    decision = decide_update(UpdateDecisionInput.from_dict(row["input"]))
    assert decision.to_dict() == row["expect"]["decision"]
    assert boot_decision(decision) == row["expect"]["boot"]


def test_every_v4_boot_value_is_none_or_optional() -> None:
    # No floor stops play: a mandatory or blocked answer is a prompt over a running game.
    assert {r["expect"]["boot"] for r in MATRIX["rows"]} <= {"none", "optional"}


def _undismissable_rows() -> List[Dict[str, Any]]:
    return [
        r
        for r in MATRIX["rows"]
        if r["expect"]["decision"]["action"] == "blocked"
        or r["expect"]["decision"].get("mandatory") is True
    ]


def test_mandatory_and_blocked_are_undismissable() -> None:
    rows = _undismissable_rows()
    assert rows, "the matrix pins at least one mandatory or blocked decision"
    for row in MATRIX["rows"]:
        decision = decide_update(UpdateDecisionInput.from_dict(row["input"]))
        assert is_undismissable(decision) == (row in rows), row["name"]


def test_a_decision_emits_only_its_actions_members() -> None:
    none = UpdateDecision(action="none", reason="stale", behind=False, discardStaged=False)
    assert none.to_dict() == {
        "action": "none",
        "reason": "stale",
        "behind": False,
        "discardStaged": False,
    }
    blocked = UpdateDecision(action="blocked", reason="app-floor", discardStaged=True)
    assert blocked.to_dict() == {"action": "blocked", "reason": "app-floor", "discardStaged": True}
