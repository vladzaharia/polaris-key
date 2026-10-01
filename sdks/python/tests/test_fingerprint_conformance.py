# @pkey-feature devices.fingerprint
"""The Python conformance runner for the fingerprint + device-id formulas.

Mirrors conformance/runners/node/fingerprint.test.ts against the SAME
conformance/corpus/v2/fingerprint.json. The file's CONTENT is unchanged from v1 —
``fingerprintVersion`` is still 1, because §8 rebrands user-visible identifiers and not hash
domains — but it is copied into v2 so every runner consumes ONE corpus directory.

P1b-09 added the three SOURCE rules (WIRE-CONTRACT-V3 §6.1). Python reads Windows and Linux
hardware, so it runs all three sections — ``windowsCim``, ``linuxAnchor``, ``ramBuckets`` —
plus the pinned ``windowsCimCommand``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from polaris_key.devices.deviceid import device_id_from_raw
from polaris_key.devices.fingerprint import (
    COMPONENT_ORDER,
    WINDOWS_CIM_COMMAND,
    hash_components,
    linux_anchor_source,
    parse_windows_cim,
    ram_bucket,
)

CORPUS = json.loads(
    (
        Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "fingerprint.json"
    ).read_text(encoding="utf-8")
)


def test_corpus_has_vectors() -> None:
    assert CORPUS["vectors"]
    assert CORPUS["deviceIds"]


def test_component_order_matches_the_corpus() -> None:
    # The hwid digest walks this order; a divergence here silently changes every hwid.
    assert list(COMPONENT_ORDER) == CORPUS["componentOrder"]


@pytest.mark.parametrize("vector", CORPUS["vectors"], ids=lambda v: v["id"])
def test_fingerprint_vector(vector: dict) -> None:
    actual = hash_components(vector["product"], vector["raw"])
    assert actual["components"] == vector["components"]
    assert actual["hwid"] == vector["hwid"]


@pytest.mark.parametrize("vector", CORPUS["deviceIds"], ids=lambda v: v["id"])
def test_device_id_vector(vector: dict) -> None:
    assert device_id_from_raw(vector["product"], vector["raw"]) == vector["expected"]


# ── P1b-09: the source rules ─────────────────────────────────────────────────────────
def test_windows_cim_command_is_the_pinned_one() -> None:
    pinned = CORPUS["windowsCimCommand"]
    assert WINDOWS_CIM_COMMAND.program == pinned["program"]
    assert list(WINDOWS_CIM_COMMAND.args) == pinned["args"]
    assert WINDOWS_CIM_COMMAND.stdin == pinned["stdin"]
    assert WINDOWS_CIM_COMMAND.timeout_ms == pinned["timeoutMs"]


def test_corpus_has_every_source_section() -> None:
    assert CORPUS["windowsCim"]
    assert CORPUS["linuxAnchor"]
    assert CORPUS["ramBuckets"]


@pytest.mark.parametrize("case", CORPUS["windowsCim"], ids=lambda c: c["id"])
def test_windows_cim_case(case: dict) -> None:
    assert parse_windows_cim(case["stdout"]) == case["expected"]


@pytest.mark.parametrize("case", CORPUS["linuxAnchor"], ids=lambda c: c["id"])
def test_linux_anchor_case(case: dict) -> None:
    got = linux_anchor_source(case["files"])
    expected = case["expected"]
    if expected is None:
        assert got is None
    else:
        assert got is not None
        assert {"source": got.source, "value": got.value} == expected


@pytest.mark.parametrize("case", CORPUS["ramBuckets"], ids=lambda c: c["id"])
def test_ram_bucket_case(case: dict) -> None:
    assert ram_bucket(case["bytes"]) == case["bucket"]
