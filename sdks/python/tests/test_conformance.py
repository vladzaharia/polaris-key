"""Cross-language conformance: drive EVERY case in the shared corpus through the
production verifiers and assert the expected outcome.

Mirrors ``conformance/runners/node/corpus.test.ts`` against the SAME
``corpus/v1/cases.json`` — that's how the SDKs prove byte-identical verification. The
corpus is found via a relative path up to the monorepo root.

Four sections, four layers of the wire contract:

======================  ==========================================================
``cases``               raw compact-JWS verification            -> ``verify_jws``
``docCases``            §3 claim validation                     -> ``verify_doc``
``trustCases``          §1 trust-set merge / prune / revocation -> ``verify_trust_manifest``
``clockFloorCases``     §4.3 monotonic clock floor              -> reload path + ``license_state``
======================  ==========================================================
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from polaris_key.license import license_state
from polaris_key.models import ManagedConfigDoc
from polaris_key.trust import merge_trust, verify_trust_manifest
from polaris_key.verify import sign_jws, verify_doc, verify_jws

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v1/cases.json
_CORPUS_PATH = (
    Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v1" / "cases.json"
)


def _load_corpus() -> Dict[str, Any]:
    return json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))


_CORPUS = _load_corpus()
_CASES: List[Dict[str, Any]] = _CORPUS["cases"]
_DOC_CASES: List[Dict[str, Any]] = _CORPUS.get("docCases", [])
_TRUST_CASES: List[Dict[str, Any]] = _CORPUS.get("trustCases", [])
_CLOCK_FLOOR_CASES: List[Dict[str, Any]] = _CORPUS.get("clockFloorCases", [])


def test_corpus_path_exists() -> None:
    assert _CORPUS_PATH.exists(), f"corpus not found at {_CORPUS_PATH}"


def test_corpus_has_cases() -> None:
    assert len(_CASES) > 0
    assert len(_DOC_CASES) > 0
    assert len(_TRUST_CASES) > 0
    assert len(_CLOCK_FLOOR_CASES) > 0


@pytest.mark.parametrize("case", _CASES, ids=[c["id"] for c in _CASES])
def test_corpus_case(case: Dict[str, Any]) -> None:
    # An optional per-case `typ` is the document-type domain separator the call site
    # requires (wire contract v2 §2.4). Absent => the caller states no expectation, which
    # is how the v1 cases keep passing.
    result = verify_jws(case["jws"], case["trust"], typ=case.get("typ"))
    expect = case["expect"]
    if expect["verify"] == "ok":
        assert result is not None, f"{case['id']} should verify"
        assert result.kid == expect["kid"]
        assert result.payload == expect["doc"]
    else:
        assert result is None, f"{case['id']} must fail verification"


@pytest.mark.parametrize("case", _DOC_CASES, ids=[c["id"] for c in _DOC_CASES])
def test_corpus_doc_case(case: Dict[str, Any]) -> None:
    """§3 claim validation — the same vectors the Node runner drives through `verifyDoc`."""
    kwargs: Dict[str, Any] = {
        "expected_aud": case["expectedAud"],
        "expected_iss": case["expectedIss"],
        "device_id": case["deviceId"],
        "now": case["now"],
    }
    if "lastAcceptedIssuedAt" in case:
        kwargs["last_accepted_issued_at"] = case["lastAcceptedIssuedAt"]
    if "checkFreshness" in case:
        kwargs["check_freshness"] = case["checkFreshness"]
    doc = verify_doc(case["jws"], case["trust"], **kwargs)
    if case["expect"]["accept"]:
        assert doc is not None, f"{case['id']} should be accepted"
    else:
        assert doc is None, f"{case['id']} must be rejected"


@pytest.mark.parametrize("case", _TRUST_CASES, ids=[c["id"] for c in _TRUST_CASES])
def test_corpus_trust_case(case: Dict[str, Any]) -> None:
    """§1 trust-set construction — pins terminal, `status` normative, pruning mandatory."""
    result = verify_trust_manifest(
        case["manifestJws"],
        pinned=case["pinned"],
        expected_aud="djdl",
        now=case["now"],
        check_freshness=case.get("checkFreshness", True),
    )
    assert (result.doc is not None) is case["expect"]["accepted"], f"{case['id']}"
    # Accepted => the discovered set REPLACES what was held; rejected => it is untouched.
    discovered = result.discovered if result.doc is not None else case["before"]
    assert merge_trust(case["pinned"], discovered) == case["expect"]["trust"]
    # The accepted manifest's `issuedAt` is what §4.3 folds into the clock floor.
    if "issuedAt" in case["expect"]:
        assert result.doc is not None
        assert result.doc["issuedAt"] == case["expect"]["issuedAt"], f"{case['id']}"


@pytest.mark.parametrize(
    "case", _CLOCK_FLOOR_CASES, ids=[c["id"] for c in _CLOCK_FLOOR_CASES]
)
def test_corpus_clock_floor_case(case: Dict[str, Any]) -> None:
    """§4.3 — the monotonic clock floor, replayed as the cache-RELOAD path.

    Re-verify the cached manifest (freshness OFF), re-verify the cached document against
    the resulting trust set (freshness OFF), take the floor as the max of the ``issuedAt``
    of whatever actually verified, and gate at ``max(systemClock, floor)``. Deriving the
    floor from the document alone is inert (R4-04), which is exactly what
    ``floor-config-doc-alone-does-not-stop-rollback`` pins.
    """
    trust: Dict[str, str] = dict(case["pinned"])
    high_water_mark = 0

    if case.get("trustJws") is not None:
        manifest = verify_trust_manifest(
            case["trustJws"],
            pinned=case["pinned"],
            expected_aud=case["expectedAud"],
            now=case["systemClock"],
            check_freshness=False,
        )
        if manifest.doc is not None:
            trust = merge_trust(case["pinned"], manifest.discovered)
            high_water_mark = max(high_water_mark, manifest.doc["issuedAt"])

    doc: Optional[ManagedConfigDoc] = None
    if case.get("configJws") is not None:
        doc = verify_doc(
            case["configJws"],
            trust,
            expected_aud=case["expectedAud"],
            device_id=case["deviceId"],
            now=case["systemClock"],
            check_freshness=False,
        )
        if doc is not None:
            high_water_mark = max(high_water_mark, doc.issuedAt)

    assert high_water_mark == case["expect"]["highWaterMark"], f"{case['id']} floor"
    effective_now = max(case["systemClock"], high_water_mark)
    assert effective_now == case["expect"]["effectiveNow"], f"{case['id']} effectiveNow"
    state = license_state(
        has_token=True,
        doc=doc,
        now=case["systemClock"],
        high_water_mark=high_water_mark,
    )
    assert state.status == case["expect"]["status"], f"{case['id']}: {case['description']}"


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


def test_python_signer_reproduces_the_non_ascii_corpus_vector_byte_for_byte() -> None:
    """The Python signer must be byte-interchangeable with the Node one (§2.5 / R2-07).

    ``valid-non-ascii-payload`` is signed by Node's ``signJws``. Re-signing the SAME
    decoded payload here must reproduce that compact JWS exactly — Ed25519 is
    deterministic, so any difference is a difference in the serialised signing input.
    Before ``ensure_ascii=False`` landed, Python escaped every non-ASCII code point to
    ``\\uXXXX`` and produced an entirely different (but self-consistent, and therefore
    silently wrong) signature. The corpus is ASCII-only apart from this vector, which is
    exactly why the divergence was structurally invisible to CI.
    """
    keys = {k["kid"]: k for k in _CORPUS["keys"]}
    case = next(c for c in _CASES if c["id"] == "valid-non-ascii-payload")
    kid = case["expect"]["kid"]
    resigned = sign_jws(case["expect"]["doc"], keys[kid]["privateKeyPkcs8Pem"], kid)
    assert resigned == case["jws"]
