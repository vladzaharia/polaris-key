# @pkey-feature core.verify core.bundle update.feed release.record packs.record
"""Cross-language conformance: drive EVERY vector in ``conformance/corpus/v2/`` through
the production verifiers and assert the expected outcome.

Mirrors ``conformance/runners/node/corpusV2.test.ts`` against the SAME ``cases.json`` —
that is how four SDKs prove byte-identical verification. The corpus is found via a relative
path up to the monorepo root.

Six sections, six layers of the v3 documents (which wire contract v4 keeps), plus v4's
pointer-set section (§4.1) over the seven JWS families, ``feedCases`` and
``releaseRecordCases`` included, and the two pack families of plans/P4-01.md §4.6
(``packRecordCases`` and ``markerCases``, whose JWS is the marker's ``release``):

====================  ==========================================================
``jwsCases``          §1–§2 raw compact-JWS verification      -> ``verify_jws``
``licenseDocCases``   §3 claim validation, licence            -> ``verify_license_doc``
``configDocCases``    §3 claim validation, config             -> ``verify_config_doc``
``trustCases``        §1 trust merge / prune / revocation     -> ``verify_trust_manifest``
``clockFloorCases``   §4.2 monotonic floor over 3 artifacts   -> reload path + gate
``bundleCases``       §7 offline bundle import                -> ``inspect_bundle``
``feedCases``         V4 §2.5 steps 3–8, the channel feed     -> ``verify_feed``
``releaseRecordCases`` V4 §2.5 steps 12–15, the release record -> ``verify_release_record``
``packRecordCases``   V4 §3.5 steps 12–15 with ``pin.kind``     -> ``verify_release_record``
``markerCases``       V4 §3.7, the embedded-pack marker        -> ``verify_marker``
====================  ==========================================================

The two v4 sections also run the claims functions alone (``feed_claims``, steps 4–6, and
``release_record_claims``, step 14) over every case that reaches them, as the Node runner does.

The bundle section pins WHICH numbered step refuses for each vector, not merely that
something did — that attribution is the whole point of the section, so this drives the
shipped ``inspect_bundle`` rather than an inline reference implementation.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from polaris_key.core.b64url import b64url_decode
from polaris_key.core.bundle import (
    MAX_BUNDLE_BYTES,
    inspect_bundle,
    verify_bundle,
)
from polaris_key.core.clock import effective_now, high_water_mark
from polaris_key.core.feed import FeedFloor, feed_claims, verify_feed
from polaris_key.core.jws import sign_jws, verify_jws
from polaris_key.core.release_record import (
    ReleaseRecordPin,
    release_record_claims,
    verify_release_record,
)
from polaris_key.core.trust import merge_trust, verify_trust_manifest
from polaris_key.core.verify import verify_config_doc, verify_license_doc
from polaris_key.license.gate import license_state
from polaris_key.update.packs import verify_marker

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v2/cases.json
_CORPUS_DIR = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
_CORPUS_PATH = _CORPUS_DIR / "cases.json"

_CORPUS: Dict[str, Any] = json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))
_JWS_CASES: List[Dict[str, Any]] = _CORPUS["jwsCases"]
_LICENSE_DOC_CASES: List[Dict[str, Any]] = _CORPUS["licenseDocCases"]
_CONFIG_DOC_CASES: List[Dict[str, Any]] = _CORPUS["configDocCases"]
_TRUST_CASES: List[Dict[str, Any]] = _CORPUS["trustCases"]
_CLOCK_FLOOR_CASES: List[Dict[str, Any]] = _CORPUS["clockFloorCases"]
_BUNDLE_CASES: List[Dict[str, Any]] = _CORPUS["bundleCases"]
_FEED_CASES: List[Dict[str, Any]] = _CORPUS["feedCases"]
_RECORD_CASES: List[Dict[str, Any]] = _CORPUS["releaseRecordCases"]


def test_corpus_path_exists() -> None:
    assert _CORPUS_PATH.exists(), f"corpus not found at {_CORPUS_PATH}"


def test_corpus_has_vectors_in_every_section() -> None:
    assert _CORPUS["corpusVersion"] == 2
    for section in (
        _JWS_CASES,
        _LICENSE_DOC_CASES,
        _CONFIG_DOC_CASES,
        _TRUST_CASES,
        _CLOCK_FLOOR_CASES,
        _BUNDLE_CASES,
    ):
        assert len(section) > 0


# ── §1–§2: raw compact-JWS verification ─────────────────────────────────────────────
@pytest.mark.parametrize("case", _JWS_CASES, ids=[c["id"] for c in _JWS_CASES])
def test_jws_case(case: Dict[str, Any]) -> None:
    # §2 — v3 verifiers ALWAYS demand a `typ`. There is no call site that does not, so
    # the runner does not have a mode where it is off. The raised payload cap travels
    # WITH the vector, so a runner cannot accidentally grant bundle sizes to ordinary
    # documents.
    result = verify_jws(
        case["jws"],
        case["trust"],
        typ=case.get("typ"),
        require_typ=True,
        max_payload_bytes=case.get("maxPayloadBytes"),
    )
    expect = case["expect"]
    if expect["verify"] == "ok":
        assert result is not None, f"{case['id']} should verify"
        assert result.kid == expect["kid"]
        # Omitted where the payload is a quarter-megabyte of padding (the cap vectors).
        if "doc" in expect:
            assert result.payload == expect["doc"]
    else:
        assert result is None, f"{case['id']} must fail verification"


# ── §3: the claim layer, once per document type ─────────────────────────────────────
def _doc_kwargs(case: Dict[str, Any]) -> Dict[str, Any]:
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
    return kwargs


@pytest.mark.parametrize(
    "case", _LICENSE_DOC_CASES, ids=[c["id"] for c in _LICENSE_DOC_CASES]
)
def test_license_doc_case(case: Dict[str, Any]) -> None:
    doc = verify_license_doc(case["jws"], case["trust"], **_doc_kwargs(case))
    assert (doc is not None) is case["expect"]["accept"], (
        f"{case['id']} — {case['description']}"
    )


@pytest.mark.parametrize(
    "case", _CONFIG_DOC_CASES, ids=[c["id"] for c in _CONFIG_DOC_CASES]
)
def test_config_doc_case(case: Dict[str, Any]) -> None:
    doc = verify_config_doc(case["jws"], case["trust"], **_doc_kwargs(case))
    assert (doc is not None) is case["expect"]["accept"], (
        f"{case['id']} — {case['description']}"
    )


def test_license_and_config_typs_do_not_cross_verify() -> None:
    """§2 domain separation, stated as a property rather than a vector: the two document
    types share an envelope and MUST NOT be interchangeable."""
    lic = next(c for c in _LICENSE_DOC_CASES if c["id"] == "license-valid-control")
    cfg = next(c for c in _CONFIG_DOC_CASES if c["id"] == "config-valid-control")
    assert verify_config_doc(lic["jws"], lic["trust"], **_doc_kwargs(lic)) is None
    assert verify_license_doc(cfg["jws"], cfg["trust"], **_doc_kwargs(cfg)) is None


# ── §1: trust-set construction ──────────────────────────────────────────────────────
@pytest.mark.parametrize("case", _TRUST_CASES, ids=[c["id"] for c in _TRUST_CASES])
def test_trust_case(case: Dict[str, Any]) -> None:
    result = verify_trust_manifest(
        case["manifestJws"],
        pinned=case["pinned"],
        expected_aud="djdl",
        now=case["now"],
        check_freshness=case.get("checkFreshness", True),
    )
    assert (result.doc is not None) is case["expect"]["accepted"], case["id"]
    # Accepted => the discovered set REPLACES what was held; rejected => it is untouched.
    discovered = result.discovered if result.doc is not None else case["before"]
    assert merge_trust(case["pinned"], discovered) == case["expect"]["trust"]
    # The accepted manifest's `issuedAt` is what §4.2 folds into the clock floor.
    if "issuedAt" in case["expect"]:
        assert result.doc is not None
        assert result.doc["issuedAt"] == case["expect"]["issuedAt"], case["id"]


# ── §4.2: the monotonic clock floor, replayed as the cache-RELOAD path ──────────────
@pytest.mark.parametrize(
    "case", _CLOCK_FLOOR_CASES, ids=[c["id"] for c in _CLOCK_FLOOR_CASES]
)
def test_clock_floor_case(case: Dict[str, Any]) -> None:
    """Re-verify the cached manifest against the PINS (freshness off), re-verify each
    cached document against the resulting effective set (freshness off), fold the
    ``issuedAt`` of whatever actually verified, and gate at ``max(systemClock, floor)``."""
    trust: Dict[str, str] = dict(case["pinned"])
    verified: List[Optional[int]] = []

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
            verified.append(manifest.doc["issuedAt"])

    reload_kwargs = dict(
        expected_aud=case["expectedAud"],
        device_id=case["deviceId"],
        now=case["systemClock"],
        check_freshness=False,
    )
    license_doc = None
    if case.get("licenseJws") is not None:
        license_doc = verify_license_doc(case["licenseJws"], trust, **reload_kwargs)
        if license_doc is not None:
            verified.append(license_doc.issuedAt)
    if case.get("configJws") is not None:
        config_doc = verify_config_doc(case["configJws"], trust, **reload_kwargs)
        if config_doc is not None:
            verified.append(config_doc.issuedAt)

    floor = high_water_mark(verified)
    assert floor == case["expect"]["highWaterMark"], f"{case['id']} highWaterMark"
    assert effective_now(case["systemClock"], floor) == case["expect"]["effectiveNow"], (
        f"{case['id']} effectiveNow"
    )
    state = license_state(
        license_service_enabled=True,
        activation="token",
        doc=license_doc,
        now=case["systemClock"],
        high_water_mark=floor,
    )
    assert state.status == case["expect"]["status"], (
        f"{case['id']}: {case['description']}"
    )


# ── §7: offline bundle import, all-or-nothing, in the contract's numbered order ─────
def test_bundle_cap_is_pinned_against_the_implementation_constant() -> None:
    """The fixture supplies the cap so a runner CANNOT hand it to the verifier — the cap
    is a property of the ``typ``, not of the caller, and asserting agreement is a
    STRONGER pin than passing it in (a runner that supplies the cap cannot catch an
    implementation that forgot to apply one)."""
    for case in _BUNDLE_CASES:
        assert case["maxPayloadBytes"] == MAX_BUNDLE_BYTES, f"{case['id']} cap"


def _import_outcome(case: Dict[str, Any]) -> Dict[str, Any]:
    opts = dict(
        pinned=case["pinned"],
        product=case["expectedAud"],
        device_id=case["deviceId"],
        now=case["now"],
    )
    result = inspect_bundle(case["bundleJws"], **opts)
    if not result.ok:
        return {"imports": False, "reason": result.reason}
    # The two entry points must never disagree: `verify_bundle` is the same walk with the
    # step discarded, and a host that uses it has to see exactly what the corpus saw.
    assert verify_bundle(case["bundleJws"], **opts) == result.bundle
    # `docs` is reported in §7's order (license, then config) so the fixture's array is a
    # sequence rather than a set.
    docs = [name for name in ("license", "config") if name in result.bundle.docs]
    return {"imports": True, "docs": docs}


@pytest.mark.parametrize("case", _BUNDLE_CASES, ids=[c["id"] for c in _BUNDLE_CASES])
def test_bundle_case(case: Dict[str, Any]) -> None:
    assert _import_outcome(case) == case["expect"], (
        f"{case['id']} — {case['description']}"
    )


def test_bundle_valid_full_yields_the_artifacts_the_cache_write_needs() -> None:
    """A verified bundle hands back everything §7 step 5 needs, and the caller must not
    have to re-parse anything to write the cache."""
    case = next(c for c in _BUNDLE_CASES if c["id"] == "bundle-valid-full")
    bundle = verify_bundle(
        case["bundleJws"],
        pinned=case["pinned"],
        product=case["expectedAud"],
        device_id=case["deviceId"],
        now=case["now"],
    )
    assert bundle is not None
    assert isinstance(bundle.bundleId, str) and bundle.bundleId
    assert len(bundle.trustJws.split(".")) == 3
    # Step 3's set, not the bare pins: the config document in this vector is signed by a
    # rotated key only the inner manifest publishes, so the merge has to have happened.
    assert len(bundle.effectiveTrust) > len(case["pinned"])
    assert bundle.docs["license"].doc.deviceId == case["deviceId"]
    assert bundle.docs["license"].doc.aud == case["expectedAud"]
    assert bundle.docs["config"].doc.deviceId == case["deviceId"]
    # The artifacts are the exact inner bytes — the host persists these, never the payloads.
    assert len(bundle.docs["license"].jws.split(".")) == 3
    assert len(bundle.docs["config"].jws.split(".")) == 3


# ── The signer must stay byte-interchangeable with Node's ───────────────────────────
def test_sign_roundtrips_against_the_corpus_key() -> None:
    keys = {k["kid"]: k for k in _CORPUS["keys"]}
    entry = keys["pkey-test-prod-2026"]
    payload = {"hello": "world", "n": 7}
    jws = sign_jws(payload, entry["privateKeyPkcs8Pem"], "pkey-test-prod-2026")
    trust = {"pkey-test-prod-2026": entry["publicKeyRaw"]}
    v = verify_jws(jws, trust)
    assert v is not None and v.kid == "pkey-test-prod-2026" and v.payload == payload
    # And the published valid-stable JWS must re-verify under the same key.
    valid = next(c for c in _JWS_CASES if c["id"] == "valid-stable")
    assert verify_jws(valid["jws"], valid["trust"], require_typ=True) is not None


def test_python_signer_reproduces_the_non_ascii_corpus_vector_byte_for_byte() -> None:
    """The Python signer must be byte-interchangeable with the Node one (§1 / R2-07).

    ``valid-non-ascii-payload`` is signed by Node's ``signJws``. Re-signing the SAME
    decoded payload here must reproduce that compact JWS exactly — Ed25519 is
    deterministic, so any difference is a difference in the serialised signing input.
    Before ``ensure_ascii=False`` landed, Python escaped every non-ASCII code point to
    ``\\uXXXX`` and produced an entirely different (but self-consistent, and therefore
    silently wrong) signature. The corpus is ASCII-only apart from this vector, which is
    exactly why the divergence was structurally invisible to CI.
    """
    keys = {k["kid"]: k for k in _CORPUS["keys"]}
    case = next(c for c in _JWS_CASES if c["id"] == "valid-non-ascii-payload")
    kid = case["expect"]["kid"]
    resigned = sign_jws(
        case["expect"]["doc"], keys[kid]["privateKeyPkcs8Pem"], kid, case["typ"]
    )
    assert resigned == case["jws"]


# ── WIRE-CONTRACT-V4 §4.1: the non-wire-integer pointer sets, over the seven JWS families and
# the two pack families (plans/P4-01.md §4.6) ──
# Python's verifier needs no pointer set: ``json.loads`` returns an ``int`` exactly for a plain
# integer token and a ``float`` for any other, so ``_wire_int`` is already the token rule. For
# this comparison only, the set is the pointers of the payload's floats and of its ints above
# 2^53 - 1 in magnitude, and it must equal each case's ``nonWireIntegers`` (absent = empty).
_MAX_WIRE_INTEGER = 9_007_199_254_740_991


def _pointer_token(name: str) -> str:
    return name.replace("~", "~0").replace("/", "~1")


def non_wire_integers(value: Any, pointer: str = "") -> List[str]:
    """The RFC 6901 pointers of every number in ``value`` that cannot be a wire integer."""
    if isinstance(value, bool):
        return []
    if isinstance(value, float):
        return [pointer]
    if isinstance(value, int):
        return [pointer] if abs(value) > _MAX_WIRE_INTEGER else []
    if isinstance(value, dict):
        out: List[str] = []
        for key, item in value.items():
            out += non_wire_integers(item, f"{pointer}/{_pointer_token(key)}")
        return out
    if isinstance(value, list):
        out = []
        for index, item in enumerate(value):
            out += non_wire_integers(item, f"{pointer}/{index}")
        return out
    return []


def _family_views() -> List[Any]:
    views = []
    for c in _JWS_CASES:
        views.append(("jwsCases", c, c["jws"], c["trust"], c.get("typ"), c.get("maxPayloadBytes")))
    for c in _LICENSE_DOC_CASES + _CONFIG_DOC_CASES:
        views.append(("docCases", c, c["jws"], c["trust"], c["typ"], None))
    for c in _TRUST_CASES:
        views.append(("trustCases", c, c["manifestJws"], c["pinned"], "pkey-trust+jws", None))
    for c in _BUNDLE_CASES:
        views.append(("bundleCases", c, c["bundleJws"], c["pinned"], "pkey-bundle+jws", MAX_BUNDLE_BYTES))
    for c in _CORPUS["feedCases"]:
        views.append(("feedCases", c, c["jws"], c["trust"], "pkey-feed+jws", None))
    for c in _CORPUS["releaseRecordCases"]:
        views.append(("releaseRecordCases", c, c["jws"], c["releaseKeys"], "pkey-release+jws", None))
    # plans/P4-01.md §4.6 (P4-21): the two pack families; a marker's JWS is its ``release``.
    for c in _CORPUS["packRecordCases"]:
        views.append(("packRecordCases", c, c["jws"], c["releaseKeys"], "pkey-release+jws", None))
    for c in _CORPUS["markerCases"]:
        views.append(
            ("markerCases", c, _marker_release(c["marker"]) or "", c["releaseKeys"], "pkey-release+jws", None)
        )
    return views


def _marker_release(text: str) -> Optional[str]:
    """A marker's ``release``, when its text is a JSON object holding a string there."""
    try:
        marker = json.loads(text)
    except ValueError:
        return None
    if isinstance(marker, dict) and isinstance(marker.get("release"), str):
        return marker["release"]
    return None


_POINTER_VIEWS = _family_views()


@pytest.mark.parametrize(
    "view", _POINTER_VIEWS, ids=[f"{v[0]}/{v[1]['id']}" for v in _POINTER_VIEWS]
)
def test_non_wire_integer_pointer_set(view: Any) -> None:
    _family, case, jws, keys, typ, cap = view
    result = verify_jws(jws, keys, typ=typ, require_typ=True, max_payload_bytes=cap)
    if "nonWireIntegers" in case:
        assert result is not None, f"{case['id']} carries nonWireIntegers, so it must verify"
    if result is None:
        return
    assert sorted(non_wire_integers(result.payload)) == sorted(case.get("nonWireIntegers", []))


# ── WIRE-CONTRACT-V4 §2.3: the channel feed (client steps 3–8) ──────────────────────────────
_CLAIM_REASONS = {"claims", "channel", "selector"}
_AFTER_CLAIMS = {"freshness", "not-newer", "rollback"}


def test_has_every_feed_case_of_the_plan() -> None:
    assert len(_FEED_CASES) == 80


@pytest.mark.parametrize(
    "case",
    _FEED_CASES,
    ids=[f"{c['id']} -> {'ok' if c['expect']['verify'] == 'ok' else c['expect']['reason']}" for c in _FEED_CASES],
)
def test_feed_case(case: Dict[str, Any]) -> None:
    floors = {
        k: FeedFloor(seq=v["seq"], issuedAt=v["issuedAt"])
        for k, v in (case.get("floors") or {}).items()
    }
    r = verify_feed(
        case["jws"],
        trust=case["trust"],
        expected_aud=case["expectedAud"],
        channel=case["channel"],
        platform=case["platform"],
        now=case["now"],
        check_freshness=case["checkFreshness"],
        floors=floors if "floors" in case else None,
    )
    want = case["expect"]
    if want["verify"] == "ok":
        assert r.ok, f"{case['id']}: {case['description']} (refused: {r.reason})"
        assert r.feed is not None
        assert r.feed.seq == want["seq"]
        assert r.feed.issuedAt == want["issuedAt"]
        if "doc" in want:
            assert r.feed.to_dict() == want["doc"]
    else:
        assert not r.ok, f"{case['id']}: {case['description']}"
        assert r.reason == want["reason"], case["description"]


def _feed_claims_cases() -> List[Dict[str, Any]]:
    return [
        c
        for c in _FEED_CASES
        if c["expect"]["verify"] == "ok"
        or c["expect"]["reason"] in _CLAIM_REASONS | _AFTER_CLAIMS
    ]


@pytest.mark.parametrize("case", _feed_claims_cases(), ids=[c["id"] for c in _feed_claims_cases()])
def test_feed_claims_case(case: Dict[str, Any]) -> None:
    """Steps 4–6 alone, after ``verify_jws``: the case's reason where it fails there, no
    refusal otherwise."""
    v = verify_jws(case["jws"], case["trust"], typ="pkey-feed+jws", require_typ=True)
    assert v is not None, f"{case['id']} reaches the claims step"
    reason = None if case["expect"]["verify"] == "ok" else case["expect"]["reason"]
    got = feed_claims(
        v.payload,
        expected_aud=case["expectedAud"],
        channel=case["channel"],
        platform=case["platform"],
    )
    assert got == (reason if reason in _CLAIM_REASONS else None), case["description"]


# ── WIRE-CONTRACT-V4 §2.4: the release record (client steps 12–15) ──────────────────────────


def test_has_every_record_case_of_the_plan() -> None:
    assert len(_RECORD_CASES) == 49


@pytest.mark.parametrize(
    "case",
    _RECORD_CASES,
    ids=[f"{c['id']} -> {'ok' if c['expect']['verify'] == 'ok' else c['expect']['step']}" for c in _RECORD_CASES],
)
def test_release_record_case(case: Dict[str, Any]) -> None:
    pin = case.get("pin")
    r = verify_release_record(
        case["jws"],
        release_keys=case["releaseKeys"],
        product_trust=case["productTrust"],
        expected_aud=case["expectedAud"],
        expected_hash=case["expectedHash"],
        pin=ReleaseRecordPin(**pin) if pin else None,
    )
    want = case["expect"]
    if want["verify"] == "ok":
        assert r.ok, f"{case['id']}: {case['description']} (refused at {r.step})"
        assert r.record is not None
        assert r.record.kind == want["kind"]
        if "doc" in want:
            assert r.record.to_dict() == want["doc"]
    else:
        assert not r.ok, f"{case['id']}: {case['description']}"
        assert r.step == want["step"], case["description"]


def _record_claims_cases() -> List[Dict[str, Any]]:
    return [
        c
        for c in _RECORD_CASES
        if c["expect"]["verify"] == "ok" or c["expect"]["step"] in ("claims", "cross-check")
    ]


@pytest.mark.parametrize(
    "case", _record_claims_cases(), ids=[c["id"] for c in _record_claims_cases()]
)
def test_release_record_claims_case(case: Dict[str, Any]) -> None:
    """Step 14 alone, after step 13's key selection from the pinned release keys only."""
    header = json.loads(b64url_decode(case["jws"].split(".")[0]))
    kid = header["kid"]
    v = verify_jws(
        case["jws"], {kid: case["releaseKeys"][kid]}, typ="pkey-release+jws", require_typ=True
    )
    assert v is not None, f"{case['id']} reaches the claims step"
    ok = release_record_claims(v.payload, expected_aud=case["expectedAud"])
    assert ok == (case["expect"]["verify"] == "ok" or case["expect"]["step"] != "claims")


# ── plans/P4-01.md §4.6 (P4-07): pack records (steps 12–15 with ``pin.kind``) and markers ───
_PACK_RECORD_CASES: List[Dict[str, Any]] = _CORPUS["packRecordCases"]
_MARKER_CASES: List[Dict[str, Any]] = _CORPUS["markerCases"]


def test_pack_record_and_marker_counts() -> None:
    assert len(_PACK_RECORD_CASES) == 170
    assert len(_MARKER_CASES) == 17


def _pack_claims_cases(cases: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        c
        for c in cases
        if c["expect"]["verify"] == "ok" or c["expect"]["step"] in ("claims", "cross-check")
    ]


@pytest.mark.parametrize(
    "case",
    _PACK_RECORD_CASES,
    ids=[f"{c['id']} -> {'ok' if c['expect']['verify'] == 'ok' else c['expect']['step']}" for c in _PACK_RECORD_CASES],
)
def test_pack_record_case(case: Dict[str, Any]) -> None:
    pin = case.get("pin")
    r = verify_release_record(
        case["jws"],
        release_keys=case["releaseKeys"],
        product_trust=case["productTrust"],
        expected_aud=case["expectedAud"],
        expected_hash=case["expectedHash"],
        pin=ReleaseRecordPin(**pin) if pin else None,
    )
    want = case["expect"]
    if want["verify"] == "ok":
        assert r.ok, f"{case['id']}: {case['description']} (refused at {r.step})"
        assert r.record is not None
        assert r.record.kind == want["kind"]
        if "doc" in want:
            assert r.record.to_dict() == want["doc"]
    else:
        assert not r.ok, f"{case['id']}: {case['description']}"
        assert r.step == want["step"], case["description"]


@pytest.mark.parametrize(
    "case",
    _pack_claims_cases(_PACK_RECORD_CASES),
    ids=[c["id"] for c in _pack_claims_cases(_PACK_RECORD_CASES)],
)
def test_pack_record_claims_case(case: Dict[str, Any]) -> None:
    """Step 14 alone over every pack-record case that reaches it."""
    kid = json.loads(b64url_decode(case["jws"].split(".")[0]))["kid"]
    v = verify_jws(case["jws"], {kid: case["releaseKeys"][kid]}, typ="pkey-release+jws", require_typ=True)
    assert v is not None, f"{case['id']} reaches the claims step"
    ok = release_record_claims(v.payload, expected_aud=case["expectedAud"])
    assert ok == (case["expect"]["verify"] == "ok" or case["expect"]["step"] != "claims")


@pytest.mark.parametrize(
    "case",
    _MARKER_CASES,
    ids=[f"{c['id']} -> {'ok' if c['expect']['verify'] == 'ok' else c['expect']['step']}" for c in _MARKER_CASES],
)
def test_marker_case(case: Dict[str, Any]) -> None:
    r = verify_marker(
        case["marker"],
        release_keys=case["releaseKeys"],
        product_trust=case["productTrust"],
        expected_aud=case["expectedAud"],
    )
    want = case["expect"]
    if want["verify"] == "ok":
        assert r.ok, f"{case['id']}: {case['description']} (refused at {r.step})"
        assert {
            "verify": "ok",
            "packId": r.pack_id,
            "version": r.version,
            "recordSha256": r.record_sha256,
        } == want
        assert r.record is not None and r.record["kind"] == "pack"
    else:
        assert (r.ok, r.error, r.step) == (False, "marker-rejected", want["step"]), case["description"]
