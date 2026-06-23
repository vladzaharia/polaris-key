"""Cross-language conformance: drive EVERY case in the shared corpus through the
production verifier and assert the expected verify outcome.

Mirrors ``conformance/runners/node/corpus.test.ts`` against the SAME
``corpus/v1/cases.json`` — that's how the SDKs prove byte-identical verification. The
corpus is found via a relative path up to the monorepo root.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.verify import verify_jws

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v1/cases.json
_CORPUS_PATH = (
    Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v1" / "cases.json"
)


def _load_corpus() -> Dict[str, Any]:
    return json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))


_CORPUS = _load_corpus()
_CASES: List[Dict[str, Any]] = _CORPUS["cases"]


def test_corpus_path_exists() -> None:
    assert _CORPUS_PATH.exists(), f"corpus not found at {_CORPUS_PATH}"


def test_corpus_has_cases() -> None:
    assert len(_CASES) > 0


@pytest.mark.parametrize("case", _CASES, ids=[c["id"] for c in _CASES])
def test_corpus_case(case: Dict[str, Any]) -> None:
    result = verify_jws(case["jws"], case["trust"])
    expect = case["expect"]
    if expect["verify"] == "ok":
        assert result is not None, f"{case['id']} should verify"
        assert result.kid == expect["kid"]
        assert result.payload == expect["doc"]
    else:
        assert result is None, f"{case['id']} must fail verification"


def test_sign_roundtrips_against_corpus_key() -> None:
    """Signing with the test PEM then verifying must round-trip with the matching pubkey."""
    from polaris_key.verify import sign_jws

    keys = {k["kid"]: k for k in _CORPUS["keys"]}
    entry = keys["pkey-test-prod-2026"]
    payload = {"hello": "world", "n": 7}
    jws = sign_jws(payload, entry["privateKeyPkcs8Pem"], "pkey-test-prod-2026")
    trust = {"pkey-test-prod-2026": entry["publicKeyRaw"]}
    v = verify_jws(jws, trust)
    assert v is not None
    assert v.kid == "pkey-test-prod-2026"
    assert v.payload == payload
    # And the published valid-stable JWS must re-verify under the same key.
    valid = next(c for c in _CASES if c["id"] == "valid-stable")
    assert verify_jws(valid["jws"], valid["trust"]) is not None
