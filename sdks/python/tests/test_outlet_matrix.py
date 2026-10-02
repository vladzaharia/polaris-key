# @pkey-feature outlet.detect
"""``outlet-matrix.json``'s detection rows (plans/P3-01.md §2.9, §4.7) through the Python port.

Mirrors the detection section of ``conformance/runners/node/corpusV2.test.ts`` against the SAME
file, with the same row names: the signal table and platform data equal the compiled
``OUTLET_SIGNALS`` and ``OUTLET_PLATFORM_DATA``, and every row runs through ``detect_outlet``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from polaris_key.core.detection import (
    OUTLET_PLATFORM_DATA,
    OUTLET_SIGNALS,
    WEB_DETECTION_STAMP,
    detect_outlet,
    detection_stamp,
    unknown_detection,
)

_V2 = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
OUTLETS: Dict[str, Any] = json.loads((_V2 / "outlet-matrix.json").read_text(encoding="utf-8"))


def _plain(value: Any) -> Any:
    if hasattr(value, "items"):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def test_signal_table_equals_the_matrix() -> None:
    assert [s for s, _ in OUTLET_SIGNALS] == OUTLETS["vocabulary"]["signals"]
    assert [
        (s["signal"], s["confidence"]) for s in OUTLETS["signals"]
    ] == list(OUTLET_SIGNALS)


def test_platform_data_equals_the_matrix() -> None:
    data = dict(OUTLETS["platformData"])
    del data["listingUrlPrefixes"]
    assert _plain(OUTLET_PLATFORM_DATA) == data


def test_row_count() -> None:
    assert len(OUTLETS["rows"]) == 48


@pytest.mark.parametrize("row", OUTLETS["rows"], ids=[r["name"] for r in OUTLETS["rows"]])
def test_row(row: Dict[str, Any]) -> None:
    assert detect_outlet(stamp=row["stamp"], signals=row["signals"]) == row["expect"]


# ── Edges the rows do not reach ─────────────────────────────────────────────────────────────


def test_detection_stamp_reads_the_kind_as_resolve_update_outlet_does() -> None:
    assert detection_stamp({"outlet": "steam-beta", "outletKind": "steam"}) == {
        "outletKind": "steam",
        "subkind": None,
        "outletIds": {},
    }
    assert detection_stamp({"outlet": "itch"})["outletKind"] == "itch"  # type: ignore[index]
    assert detection_stamp({"outlet": "epic-store", "outletKind": "epic"}) is None
    assert detection_stamp({"outlet": "itch-beta"}) is None
    assert detection_stamp(None) is None
    assert detection_stamp(
        {"outlet": "direct", "outletSubkind": "flatpak", "outletIds": {"flatpakId": "a", "x": 1}}
    ) == {"outletKind": "direct", "subkind": "flatpak", "outletIds": {"flatpakId": "a"}}
    assert WEB_DETECTION_STAMP["outletKind"] == "web"


def test_a_missing_identity_never_matches() -> None:
    stamp = {"outletKind": "direct", "subkind": None, "outletIds": {}}
    assert detect_outlet(stamp=stamp, signals={"steam.libraryManifest": None})["kind"] == "direct"
    assert (
        detect_outlet(
            stamp=stamp,
            signals={"windows.packageIdentity": None, "windows.signatureKind": "Store"},
        )["kind"]
        == "direct"
    )


@pytest.mark.parametrize(
    "signals",
    [
        {"linux.snapEnv": None},
        {"linux.snapEnv": "diceroll"},
        {"steam.appIdEnv": [3166810]},
        {"android.installSource": None},
        {"android.installSource": {"installer": 5, "initiator": 5}},
        {"linux.appImageEnv": {"appDir": 1, "exePath": "/x"}},
        {"node.packageManager": {"manager": "yarn", "packageMatch": True}},
        {"ios.appDistributor": 7},
        {"unknown.signal": True},
    ],
)
def test_malformed_values_are_no_evidence(signals: Dict[str, Any]) -> None:
    stamp = {"outletKind": "direct", "subkind": None, "outletIds": {"steamAppId": "3166810", "snapName": "diceroll"}}
    assert detect_outlet(stamp=stamp, signals=signals)["kind"] == "direct"


def test_no_stamp_and_bad_inputs_are_unknown() -> None:
    assert detect_outlet() == unknown_detection()
    assert detect_outlet(stamp={"outletKind": "epic"}, signals={}) == unknown_detection()
    assert detect_outlet(stamp=None, signals="nope") == unknown_detection()  # type: ignore[arg-type]
