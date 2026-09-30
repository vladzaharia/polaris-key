# @pkey-feature devices.fingerprint
"""The Python conformance runner for the fingerprint + device-id formulas.

Mirrors conformance/runners/node/fingerprint.test.ts against the SAME
conformance/corpus/v2/fingerprint.json. The file's CONTENT is unchanged from v1 —
``fingerprintVersion`` is still 1, because §8 rebrands user-visible identifiers and not hash
domains — but it is copied into v2 so every runner consumes ONE corpus directory.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from polaris_key.devices.deviceid import device_id_from_raw
from polaris_key.devices.fingerprint import COMPONENT_ORDER, hash_components

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
