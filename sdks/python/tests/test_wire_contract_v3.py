# @pkey-feature core.verify core.cache core.sync
"""Wire contract v3 regression suite — every audit PoC, inverted, re-expressed against v3.

This is the direct heir of ``test_wire_contract_v2.py``. Each test asserts that an attack
the red team **proved working** against the v1 client still fails, and each is named for
the finding it closes so a regression points straight back at
``docs/security/WIRE-CONTRACT-V3.md``, the R2 audit findings and
the R4 audit findings.

WHAT THE v2→v3 RE-BASELINE CHANGED, case by case:

* ``test_r2_10_absent_typ_is_tolerated_but_a_wrong_one_is_not`` is the ONE structurally
  obsolete case: v3 §2 REJECTS a missing ``typ`` outright, so the v2 assertion ("absent is
  tolerated") is now a bug. Its heir
  ``test_r2_10_absent_typ_is_now_rejected_and_a_wrong_one_still_is`` asserts the inverted
  half and keeps the other half verbatim.
* the R2-08 ``schemaVersion`` case moves from the (single) v2 document to the CONFIG
  document, which is where the field lives in v3 (§2.2).
* the R4-13 ``profile`` case is re-based: v3's normative verifier (``@polaris-key/client-core``)
  checks that ``profile`` is an OBJECT and nothing more, so a malformed inner field must be
  ACCEPTED-AND-INERT rather than rejected — a Python that rejected there would be a fifth
  implementation disagreeing with the other four. The heir pins that, and the
  "never raises" property it was actually protecting.
* everything else carries over with v3 identifiers (``pkey-*`` typs, ``key.plrs.im`` issuer,
  ``X-PKey-*`` headers, ``/license/document`` + ``/config/document``, cache v3).

Grouped by spec section:

* §1     R2-05 — strict base64url (no silent discarding of junk)
* §1     R2-07 — canonical, non-ASCII-safe signing bytes
* §1     R2-04 — encoded + decoded size caps, and verify-BEFORE-parse ordering
* §1     R2-06 — duplicate JSON keys are rejected, not resolved
* §2     R2-10 — ``typ`` domain separation, now MANDATORY
* §1     C2/C3/H9 — pins terminal, ``key.status`` honoured, pruning mandatory
* §4.1   R2-03/R4-01/R4-02/R4-03 — only signed artifacts persist; state is derived
* §3     R2-08 — the full claim set, with clock skew
* §4.2   R4-04 — the monotonic time floor
* §5     R2-11 — a 304 renews freshness
* R4-13 — a signed-but-malformed doc returns "no document", never raises
* R4-07 / R12-13 / R4-10 — CLI + store hardening
* §2/§3/§5/§6/§7 — the classes v3 introduced (per-type floors, config-without-licence,
  registration minting, bundle all-or-nothing, the raised bundle cap, gate
  ``not-applicable``/``activation``), plus the two Python parity gaps this phase closed.
"""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any, Dict, List

import httpx
import pytest

import polaris_key.core.jws as jws_mod
from polaris_key.cli import core as cli_core
from polaris_key.core.b64url import b64url_decode, b64url_encode, b64url_encode_str
from polaris_key.core.bundle import (
    BUNDLE_CLAIMS_REJECTED,
    BUNDLE_JWS_REJECTED,
    MAX_BUNDLE_BYTES,
    inspect_bundle,
)
from polaris_key.core.context import (
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    CoreContext,
    normalize_base_url,
)
from polaris_key.core.errors import InsecureBaseUrlError, PolarisError
from polaris_key.core.jws import MAX_HEADER_B64, MAX_PAYLOAD_B64, sign_jws, verify_jws
from polaris_key.core.models import (
    MAX_DOC_BYTES,
    TYP_BUNDLE,
    TYP_LICENSE,
    TYP_TRUST,
    LicenseDoc,
)
from polaris_key.core.store import CACHE_FORMAT_VERSION, CacheRecord
from polaris_key.core.trust import verify_trust_manifest
from polaris_key.core.verify import verify_config_doc, verify_license_doc
from polaris_key.devices.store import SYMLINK_GUARD, FileStore
from polaris_key.license.gate import license_state

from helpers import (
    ATTACKER_PEM,
    ATTACKER_PUB,
    DAY,
    KID,
    NOW,
    PRIVATE_PEM,
    PRODUCT,
    PUBKEY_RAW,
    ROTATED_PEM,
    ROTATED_PUB,
    TOKEN,
    TRUST,
    config_payload,
    key_entry,
    license_payload,
    make_client,
    manifest_payload,
    routes,
    sign_bundle,
    sign_config,
    sign_license,
    sign_manifest,
)


def _verify_lic(jws: str, trust=None, *, device_id: str = "dev-1", **kw: Any):
    return verify_license_doc(
        jws,
        TRUST if trust is None else trust,
        expected_aud=PRODUCT,
        device_id=device_id,
        now=NOW,
        **{"last_accepted_issued_at": None, **kw},
    )


def _verify_cfg(jws: str, trust=None, *, device_id: str = "dev-1", **kw: Any):
    return verify_config_doc(
        jws,
        TRUST if trust is None else trust,
        expected_aud=PRODUCT,
        device_id=device_id,
        now=NOW,
        **{"last_accepted_issued_at": None, **kw},
    )


# ════════════════════════════════════════════════════════════════════════════════════
# §1 / R2-05 — strict base64url
# ════════════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "junk", ["!!", "@", "***", "\n \t", "  ", "====", "+", "/", "a=", "a b"]
)
def test_r2_05_b64url_decode_rejects_out_of_alphabet(junk: str) -> None:
    with pytest.raises(ValueError):
        b64url_decode("QUJD" + junk)


def test_r2_05_signature_segment_junk_is_rejected_end_to_end() -> None:
    """The exact transcript from R2-05: ``***``, ``\\n \\t`` and ``====`` used to be
    ACCEPTED. Acceptance was length-dependent because the old re-padding counted the junk,
    so a 3- or 4-character injection kept the count consistent. All of them now fail,
    matching Node (``atob`` throws) and Swift (``Data(base64Encoded:)`` returns nil)."""
    jws = sign_jws({"hello": "world"}, PRIVATE_PEM, KID, TYP_LICENSE)
    assert verify_jws(jws, TRUST, typ=TYP_LICENSE) is not None
    for junk in ("!!", "@", "***", "\n \t", "  ", "===="):
        assert verify_jws(jws + junk, TRUST, typ=TYP_LICENSE) is None


def test_r2_05_standard_alphabet_and_padding_are_not_accepted() -> None:
    """``+``/``/`` (the STANDARD alphabet) and explicit ``=`` padding are not wire-legal."""
    raw = bytes(range(64))  # produces both `+` and `/` under the standard alphabet
    std = base64.b64encode(raw).decode("ascii")
    assert "+" in std or "/" in std
    with pytest.raises(ValueError):
        b64url_decode(std)
    with pytest.raises(ValueError):
        b64url_decode(b64url_encode(raw) + "=")


def test_r2_05_trust_set_key_with_junk_is_rejected() -> None:
    """``b64url_decode`` also backs trust-set key import, so junk there fails too."""
    jws = sign_jws({"hello": "world"}, PRIVATE_PEM, KID, TYP_LICENSE)
    assert verify_jws(jws, {KID: PUBKEY_RAW + "***"}, typ=TYP_LICENSE) is None


# ════════════════════════════════════════════════════════════════════════════════════
# §1 / R2-07 — canonical signing bytes for non-ASCII payloads
# ════════════════════════════════════════════════════════════════════════════════════
def test_r2_07_non_ascii_payload_matches_the_node_signer_bytes() -> None:
    """``ensure_ascii=False`` — the payload segment must be the bytes Node emits.

    Before the fix Python emitted the ``\\uXXXX``-escaped form, i.e. a DIFFERENT signing
    input and therefore a different signature for the same input document. The expected
    segment is the one recorded in R2-07 from a real ``JSON.stringify`` + ``signJws`` run;
    the corpus's ``valid-non-ascii-payload`` vector pins the same property end to end.
    """
    payload = {"n": "Ångström 💻"}
    jws = sign_jws(payload, PRIVATE_PEM, KID, TYP_LICENSE)
    enc_payload = jws.split(".")[1]
    assert enc_payload == "eyJuIjoiw4VuZ3N0csO2bSDwn5K7In0"
    assert b64url_decode(enc_payload).decode("utf-8") == '{"n":"Ångström 💻"}'
    v = verify_jws(jws, TRUST, typ=TYP_LICENSE)
    assert v is not None and v.payload == payload


# ════════════════════════════════════════════════════════════════════════════════════
# §1 / R2-04 — size caps and verify-BEFORE-parse ordering
# ════════════════════════════════════════════════════════════════════════════════════
class _RecordingTrust(dict):
    """A trust set that records every ``kid`` lookup — the deterministic PoC probe."""

    def __init__(self, *a: Any, **kw: Any) -> None:
        super().__init__(*a, **kw)
        self.reads: List[str] = []

    def get(self, key: Any, default: Any = None) -> Any:  # type: ignore[override]
        self.reads.append(key)
        return super().get(key, default)


def test_r2_04_oversized_header_never_reaches_the_trust_set() -> None:
    """An 8 MiB protected header used to be decoded and JSON-parsed pre-verification."""
    header = json.dumps(
        {"alg": "EdDSA", "typ": TYP_LICENSE, "kid": KID, "junk": "A" * (8 * 1024 * 1024)}
    )
    jws = b64url_encode_str(header) + ".e30." + "A" * 86
    trust = _RecordingTrust(TRUST)
    assert verify_jws(jws, trust, typ=TYP_LICENSE) is None
    assert trust.reads == [], "the kid must never be looked up for an oversized header"
    assert len(jws.split(".")[0]) > MAX_HEADER_B64


def test_r2_04_the_bundle_cap_does_not_widen_the_header_cap() -> None:
    """§1: the raised ``pkey-bundle+jws`` payload cap is exactly that. Moving a blob into
    the HEADER is R2-04, and no ``typ`` widens it."""
    header = json.dumps(
        {"alg": "EdDSA", "typ": TYP_BUNDLE, "kid": KID, "junk": "A" * 4096}
    )
    jws = b64url_encode_str(header) + ".e30." + "A" * 86
    trust = _RecordingTrust(TRUST)
    assert (
        verify_jws(
            jws,
            trust,
            typ=TYP_BUNDLE,
            max_payload_bytes=MAX_BUNDLE_BYTES,
        )
        is None
    )
    assert trust.reads == []


def test_r2_04_payload_at_cap_accepted_over_cap_rejected() -> None:
    at_cap = {"blob": "x" * (MAX_DOC_BYTES - len('{"blob":""}'))}
    assert len(json.dumps(at_cap, separators=(",", ":"))) == MAX_DOC_BYTES
    assert (
        verify_jws(sign_jws(at_cap, PRIVATE_PEM, KID, TYP_LICENSE), TRUST, typ=TYP_LICENSE)
        is not None
    )

    # One byte over the DECODED cap still fits under the ENCODED cap, so this exercises
    # the second (post-verify) bound rather than the pre-decode one.
    just_over = {"blob": "x" * (MAX_DOC_BYTES - len('{"blob":""}') + 1)}
    over_jws = sign_jws(just_over, PRIVATE_PEM, KID, TYP_LICENSE)
    assert len(over_jws.split(".")[1]) <= MAX_PAYLOAD_B64
    assert verify_jws(over_jws, TRUST, typ=TYP_LICENSE) is None

    # And a genuinely huge payload is rejected on the ENCODED length, pre-allocation.
    huge = sign_jws({"blob": "x" * (4 * 1024 * 1024)}, PRIVATE_PEM, KID, TYP_LICENSE)
    trust = _RecordingTrust(TRUST)
    assert verify_jws(huge, trust, typ=TYP_LICENSE) is None
    assert trust.reads == []


def test_r2_04_the_raised_bundle_cap_is_raise_only() -> None:
    """§1: ``max_payload_bytes`` may only ever RAISE. A value BELOW the frozen 64 KiB is
    inert, so no call site can quietly tighten one document out of step with the wire
    contract — and the raised cap is available only where the caller asks for it."""
    payload = {"blob": "x" * (MAX_DOC_BYTES + 1024)}
    jws = sign_jws(payload, PRIVATE_PEM, KID, TYP_BUNDLE)
    # Default cap: refused.
    assert verify_jws(jws, TRUST, typ=TYP_BUNDLE) is None
    # Raised: accepted.
    assert (
        verify_jws(jws, TRUST, max_payload_bytes=MAX_BUNDLE_BYTES, typ=TYP_BUNDLE)
        is not None
    )
    # A downward "cap" is ignored — a small document still verifies.
    small = sign_jws({"a": 1}, PRIVATE_PEM, KID, TYP_LICENSE)
    assert verify_jws(small, TRUST, max_payload_bytes=8, typ=TYP_LICENSE) is not None


def test_r2_04_payload_is_not_parsed_before_the_signature_is_verified(monkeypatch) -> None:
    """Steps 12->13: no implementation may JSON-parse an unverified payload."""
    calls: List[int] = []
    real = jws_mod._parse_strict_json

    def counting(raw: bytes) -> Any:
        calls.append(len(raw))
        return real(raw)

    monkeypatch.setattr(jws_mod, "_parse_strict_json", counting)

    jws = sign_jws({"hello": "world", "padding": "x" * 500}, PRIVATE_PEM, KID, TYP_LICENSE)
    head, payload, sig = jws.split(".")
    # Flip one signature character so verification fails but everything before it passes.
    tampered = head + "." + payload + "." + ("B" if sig[0] != "B" else "C") + sig[1:]

    assert verify_jws(tampered, TRUST, typ=TYP_LICENSE) is None
    assert len(calls) == 1, "only the header may be parsed when the signature is bad"
    assert calls[0] < 200, "the parsed bytes must be the small header, not the payload"

    calls.clear()
    assert verify_jws(jws, TRUST, typ=TYP_LICENSE) is not None
    assert len(calls) == 2, "a valid JWS parses header then payload"


# ════════════════════════════════════════════════════════════════════════════════════
# §1 / R2-06 — duplicate JSON keys
# ════════════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "header_json",
    [
        '{"alg":"none","kid":"' + KID + '","alg":"EdDSA"}',
        '{"alg":"EdDSA","kid":"' + KID + '","alg":"none"}',
        '{"alg":"EdDSA","kid":"' + KID + '","kid":"other"}',
        '{"alg":"EdDSA","typ":"' + TYP_LICENSE + '","kid":"' + KID + '","typ":"' + TYP_TRUST + '"}',
    ],
)
def test_r2_06_duplicate_header_keys_are_rejected(header_json: str) -> None:
    """TS/Python were last-wins, Swift first-wins — the downgrade guard disagreed."""
    jws = b64url_encode_str(header_json) + ".e30." + "A" * 86
    trust = _RecordingTrust(TRUST)
    assert verify_jws(jws, trust, typ=TYP_LICENSE) is None
    assert trust.reads == [], "a duplicate-key header must fail before key selection"


def test_r2_06_duplicate_payload_keys_are_rejected() -> None:
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    header = b64url_encode_str(
        '{"alg":"EdDSA","typ":"' + TYP_LICENSE + '","kid":"' + KID + '"}'
    )
    payload = b64url_encode_str('{"a":1,"a":2}')
    key = load_pem_private_key(PRIVATE_PEM.encode(), password=None)
    sig = b64url_encode(key.sign((header + "." + payload).encode("ascii")))
    # Correctly signed — the ONLY reason to reject is the duplicate member.
    assert verify_jws(header + "." + payload + "." + sig, TRUST, typ=TYP_LICENSE) is None


# ════════════════════════════════════════════════════════════════════════════════════
# §2 / R2-10 — `typ` domain separation, now MANDATORY
# ════════════════════════════════════════════════════════════════════════════════════
def test_r2_10_trust_manifest_cannot_be_replayed_as_a_license_doc() -> None:
    manifest_jws = sign_manifest([])
    assert verify_jws(manifest_jws, TRUST, typ=TYP_LICENSE) is None
    assert verify_jws(manifest_jws, TRUST, typ=TYP_TRUST) is not None


def test_r2_10_the_two_documents_cannot_be_replayed_as_each_other() -> None:
    """NEW IN v3: one signing key signs BOTH per-service documents, so without domain
    separation a config document could be presented where a licence document is
    expected — which would be a free grant."""
    lic = sign_license("dev-1")
    cfg = sign_config("dev-1")
    assert _verify_cfg(lic) is None
    assert _verify_lic(cfg) is None
    assert _verify_lic(lic) is not None
    assert _verify_cfg(cfg) is not None


def test_r2_10_absent_typ_is_now_rejected_and_a_wrong_one_still_is() -> None:
    """HEIR of ``test_r2_10_absent_typ_is_tolerated_but_a_wrong_one_is_not``.

    That v2 case is the ONE structurally obsolete assertion in this file: §2 closes the
    tolerance window, so "a v1 header with no ``typ`` verifies" is now a bug rather than a
    guarantee. Its second half — "never accept a MISMATCHED one" — carries over verbatim.
    """
    untyped = sign_jws({"hello": "world"}, PRIVATE_PEM, KID)
    assert verify_jws(untyped, TRUST, typ=TYP_LICENSE) is None
    assert verify_jws(untyped, TRUST, typ=TYP_TRUST) is None
    # Every shipping verifier in this SDK demands one, so an untyped document is not a
    # document at any of them.
    assert _verify_lic(sign_jws(license_payload("dev-1"), PRIVATE_PEM, KID)) is None
    assert _verify_cfg(sign_jws(config_payload("dev-1"), PRIVATE_PEM, KID)) is None
    assert (
        verify_trust_manifest(
            sign_jws(manifest_payload([]), PRIVATE_PEM, KID),
            pinned=TRUST,
            expected_aud=PRODUCT,
            now=NOW,
        ).doc
        is None
    )
    # A mismatched typ is still refused, as in v2.
    typed = sign_jws({"hello": "world"}, PRIVATE_PEM, KID, TYP_LICENSE)
    assert verify_jws(typed, TRUST, typ=TYP_LICENSE) is not None
    assert verify_jws(typed, TRUST, typ=TYP_TRUST) is None


def test_r2_10_license_doc_replayed_as_a_manifest_does_not_raise() -> None:
    """v1 rejected this only via a ``TypeError`` swallowed by a bare ``.catch``."""
    result = verify_trust_manifest(
        sign_license("dev-1"), pinned=TRUST, expected_aud=PRODUCT, now=NOW
    )
    assert result.doc is None and result.discovered == {}


# ════════════════════════════════════════════════════════════════════════════════════
# §1 — pins terminal, `key.status` normative, pruning mandatory (C2 / C3 / H9)
# ════════════════════════════════════════════════════════════════════════════════════
def test_c2_manifest_cannot_substitute_the_bytes_behind_a_pinned_kid() -> None:
    """R2-01/R4-02, CRITICAL: the whole manifest is rejected, not merged."""
    hostile = sign_manifest([key_entry(KID, ATTACKER_PUB), key_entry("extra", ROTATED_PUB)])
    c = make_client(routes(trust_jws=hostile))
    assert c._trust.refresh() is None
    assert c._trust.effective == TRUST, "the pinned bytes must survive untouched"
    assert "extra" not in c._trust.effective, "a rejected manifest installs nothing at all"
    # ...and a doc signed by the attacker key under the pinned kid is still refused.
    forged = sign_license(c.core.device_id, pem=ATTACKER_PEM)
    assert _verify_lic(forged, c._trust.effective, device_id=c.core.device_id) is None
    c.close()


def test_c2_cache_is_no_longer_a_key_source(tmp_path) -> None:
    """The v1 exploit: write ``trustedKeys`` into managed.json, serve a forged doc."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token(TOKEN)
    with open(
        os.path.join(str(tmp_path), PRODUCT, "managed.json"), "w", encoding="utf-8"
    ) as f:
        json.dump(
            {
                "v": CACHE_FORMAT_VERSION,
                "docs": {},
                "trustedKeys": {KID: ATTACKER_PUB, "attacker-forever-2099": ATTACKER_PUB},
            },
            f,
        )
    forged = sign_license(device_id, pem=ATTACKER_PEM)
    c = make_client(
        routes(license_jws=forged), store=FileStore(PRODUCT, str(tmp_path))
    )
    assert c._trust.effective == TRUST
    assert c.sync(force=True).applied is False, "a forged doc must not be applied"
    assert c.status().status == "needs-activation"
    assert c.license.is_entitled("polarisVpn") is False
    assert c.config.get_secret("proxy.subscriptionUrl") is None
    c.close()


def test_c3_revoked_key_is_refused_and_pruned() -> None:
    m = sign_manifest([key_entry(KID, PUBKEY_RAW), key_entry("rot", ROTATED_PUB, "revoked")])
    c = make_client(routes(trust_jws=m))
    assert c._trust.refresh() is not None
    assert "rot" not in c._trust.effective, "a revoked key must never enter the trust set"
    doc = sign_license("dev-1", pem=ROTATED_PEM, kid="rot")
    assert verify_jws(doc, c._trust.effective, typ=TYP_LICENSE) is None
    c.close()


@pytest.mark.parametrize("status", ["active", "staged", "retired"])
def test_c3_usable_statuses_are_installed(status: str) -> None:
    m = sign_manifest([key_entry(KID, PUBKEY_RAW), key_entry("rot", ROTATED_PUB, status)])
    c = make_client(routes(trust_jws=m))
    assert c._trust.refresh() is not None
    assert c._trust.effective.get("rot") == ROTATED_PUB
    c.close()


def test_c3_only_live_statuses_are_kept() -> None:
    """§1/§3.2: the set is ``usable pins ∪ {manifest keys whose status is exactly active,
    staged or retired}``.

    An allow-list: a status outside it (here ``quarantined``) skips the entry, and is never
    fatal. A non-EdDSA/OKP/Ed25519 entry is skipped on its algorithm, independently of
    status, and must never be FATAL: a future-alg key in the manifest cannot be allowed to
    brick current verifiers.
    """
    m = sign_manifest(
        [
            key_entry("rot", ROTATED_PUB, "staged"),
            key_entry("quar", ROTATED_PUB, "quarantined"),
            key_entry("gone", ATTACKER_PUB, "revoked"),
            {**key_entry("future", ATTACKER_PUB), "alg": "ML-DSA-65"},
        ]
    )
    c = make_client(routes(trust_jws=m))
    assert c._trust.refresh() is not None
    assert c._trust.effective.get("rot") == ROTATED_PUB
    assert "quar" not in c._trust.effective, "an unknown status is skipped, not trusted"
    assert "gone" not in c._trust.effective
    assert "future" not in c._trust.effective, "unknown alg is SKIPPED, not fatal"
    assert KID in c._trust.effective, "and the rest of the manifest still installed"
    c.close()


def test_trust_manifest_schema_version_is_allow_listed() -> None:
    """Unlike the config document's catalog version, the manifest's IS a wire version."""
    c = make_client(
        routes(trust_jws=sign_manifest([key_entry(KID, PUBKEY_RAW)], schemaVersion=2))
    )
    assert c._trust.refresh() is None
    c.close()


def test_h9_absence_is_revocation_the_trust_set_is_pruned() -> None:
    """R2-02: the v1 set only ever grew, so a compromised kid stayed trusted forever."""
    state = {"n": 0}

    def trust_body(_r: httpx.Request) -> str:
        state["n"] += 1
        if state["n"] == 1:
            return sign_manifest(
                [key_entry(KID, PUBKEY_RAW), key_entry("rot", ROTATED_PUB)], issued=NOW
            )
        # Manifest #2: higher issuedAt, `rot` simply gone.
        return sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=NOW + 60)

    c = make_client(routes(trust_jws=trust_body))
    assert c._trust.refresh() is not None
    assert c._trust.effective.get("rot") == ROTATED_PUB
    assert c._trust.refresh() is not None
    assert "rot" not in c._trust.effective, "a kid absent from the new manifest is dropped"
    assert c._trust.effective == TRUST, "pins survive pruning"
    c.close()


def test_h9_a_pinned_key_is_never_pruned_even_by_an_empty_manifest() -> None:
    c = make_client(routes(trust_jws=sign_manifest([])))
    assert c._trust.refresh() is not None
    assert c._trust.effective == TRUST
    c.close()


def test_c2_manifest_learned_key_cannot_sign_the_next_manifest() -> None:
    """The self-perpetuation amplifier: v1 verified manifests against the poisoned set."""
    state = {"n": 0}

    def trust_body(_r: httpx.Request) -> str:
        state["n"] += 1
        if state["n"] == 1:
            return sign_manifest(
                [key_entry(KID, PUBKEY_RAW), key_entry("rot", ROTATED_PUB)]
            )
        # Signed by the LEARNED key, minting a brand-new kid.
        return sign_manifest(
            [key_entry("attacker-forever-2099", ATTACKER_PUB)],
            issued=NOW + 60,
            pem=ROTATED_PEM,
            kid="rot",
        )

    c = make_client(routes(trust_jws=trust_body))
    assert c._trust.refresh() is not None
    assert c._trust.refresh() is None, "manifests verify against PINNED keys only"
    assert "attacker-forever-2099" not in c._trust.effective
    c.close()


# ════════════════════════════════════════════════════════════════════════════════════
# §4.1 — cache integrity (R2-03 / R4-01 / R4-02 / R4-03)
# ════════════════════════════════════════════════════════════════════════════════════
def test_r4_01_hand_written_cache_grants_nothing(tmp_path) -> None:
    """The 40-line "crack": a fabricated doc with a century of grace, no signature."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token(TOKEN)
    forged = license_payload(device_id, graceUntil=NOW + 100 * 365 * DAY)
    path = os.path.join(str(tmp_path), PRODUCT, "managed.json")
    for record in (
        {"doc": forged, "lastAcceptedIssuedAt": 0},  # v1 shape
        {"v": 2, "configJws": json.dumps(forged), "lastSyncUnauthorized": False},  # v2
        {"v": CACHE_FORMAT_VERSION, "docs": {"license": json.dumps(forged)}},
        {"v": CACHE_FORMAT_VERSION, "docs": {"license": "a.b.c"}},
    ):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(record, f)
        c = make_client(
            routes(license_status=503), store=FileStore(PRODUCT, str(tmp_path))
        )
        assert c.status().status == "needs-activation"
        assert c.is_licensed() is False
        assert c.license.is_entitled("polarisVpn") is False
        assert c.config.get_secret("proxy.subscriptionUrl") is None
        c.close()


def test_r4_01_a_v2_cache_record_is_discarded_not_migrated(tmp_path) -> None:
    """§4.1 / §9: ``v != 3`` is DISCARDED. A genuinely-signed v2 record buys nothing —
    one network round trip is the right price for not carrying poisoned state forward."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token(TOKEN)
    with open(
        os.path.join(str(tmp_path), PRODUCT, "managed.json"), "w", encoding="utf-8"
    ) as f:
        json.dump(
            {"v": 2, "configJws": sign_license(device_id), "lastSyncUnauthorized": False},
            f,
        )
    assert FileStore(PRODUCT, str(tmp_path)).read_cache() is None
    c = make_client(routes(license_status=503), store=FileStore(PRODUCT, str(tmp_path)))
    assert c.status().status == "needs-activation"
    c.close()


def test_r4_01_cache_persists_the_jws_and_re_verifies_it_on_load(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    lic = sign_license(device_id)
    cfg = sign_config(device_id)
    c = make_client(routes(license_jws=lic, config_jws=cfg), store=store)
    assert c.license.activate_with_key("k").kind == "ok"
    assert c.status().status == "ok"
    c.close()

    raw = json.loads(
        open(os.path.join(str(tmp_path), PRODUCT, "managed.json"), encoding="utf-8").read()
    )
    assert raw["v"] == CACHE_FORMAT_VERSION
    assert raw["docs"] == {"license": lic, "config": cfg}
    assert "doc" not in raw and "trustedKeys" not in raw

    # A fresh client with NO network re-verifies the stored artifacts and derives state.
    c2 = make_client(
        routes(license_status=503, config_status=503),
        store=FileStore(PRODUCT, str(tmp_path)),
    )
    assert c2.status().status == "ok"
    assert c2._cache.license_doc().issuedAt == NOW
    assert c2.config.get_secret("proxy.subscriptionUrl") == "https://vpn.example.com/sub/abc"
    c2.close()


def test_r4_01_a_doc_from_another_device_is_refused_on_load(tmp_path) -> None:
    """The ``aud``/``deviceId`` bindings are re-checked on RELOAD, not only on the wire."""
    store = FileStore(PRODUCT, str(tmp_path))
    store.get_device_id()
    store.set_token(TOKEN)
    store.write_cache(CacheRecord(docs={"license": sign_license("some-other-device")}))
    c = make_client(routes(license_status=503), store=FileStore(PRODUCT, str(tmp_path)))
    assert c.status().status == "needs-activation"
    c.close()


def test_r4_01_a_failed_slice_is_absent_not_partial(tmp_path) -> None:
    """§4.1 fail-closed, per SLICE: a licence document that does not verify leaves
    ``needs-activation`` while a VALID config slice in the same record still loads. That
    independence is what makes the two documents two services rather than one."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token(TOKEN)
    store.write_cache(
        CacheRecord(
            docs={
                "license": sign_license(device_id, pem=ATTACKER_PEM),
                "config": sign_config(device_id),
            }
        )
    )
    c = make_client(
        routes(license_status=503, config_status=503),
        store=FileStore(PRODUCT, str(tmp_path)),
    )
    assert c.status().status == "needs-activation"
    assert c.config.get_config("run.concurrency") == 4, "the config slice is independent"
    c.close()


def test_r4_03_anti_replay_counter_is_derived_not_stored(tmp_path) -> None:
    """Setting ``lastAcceptedIssuedAt`` far into the future used to block revocation."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token(TOKEN)
    store.write_cache(CacheRecord(docs={"license": sign_license(device_id, issued=NOW)}))

    # Plant the poisoned counter alongside the signed artifact.
    path = os.path.join(str(tmp_path), PRODUCT, "managed.json")
    raw = json.loads(open(path, encoding="utf-8").read())
    raw["lastAcceptedIssuedAt"] = NOW + 100 * 365 * DAY
    with open(path, "w", encoding="utf-8") as f:
        json.dump(raw, f)

    newer = sign_license(device_id, issued=NOW + 60, licenseId="lic_REVOKED")
    c = make_client(routes(license_jws=newer), store=FileStore(PRODUCT, str(tmp_path)))
    assert c._cache.license_doc().issuedAt == NOW, "derived from the JWS, not read from disk"
    assert c.sync(force=True).applied is True
    assert c._cache.license_doc().licenseId == "lic_REVOKED"
    c.close()


def test_r4_03_replaying_the_previous_doc_is_still_rejected(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    docs = [
        sign_license(device_id, issued=NOW + 60),
        sign_license(device_id, issued=NOW),
    ]
    state = {"n": 0}

    def body(_r: httpx.Request) -> str:
        i = min(state["n"], len(docs) - 1)
        state["n"] += 1
        return docs[i]

    c = make_client(routes(license_jws=body), store=store)
    assert c.license.activate_with_key("k").kind == "ok"
    assert c._cache.license_doc().issuedAt == NOW + 60
    assert c.sync(force=True).applied is False, "an older issuedAt must be refused"
    assert c._cache.license_doc().issuedAt == NOW + 60
    c.close()


def test_r4_03_the_anti_replay_floors_are_PER_TYPE() -> None:
    """NEW IN v3 (§3): licence and config carry INDEPENDENT floors.

    A shared floor would mean a newer licence document blocks a settings refresh minted
    the same second — the two services would silently throttle each other.
    """
    lic_new = sign_license("dev-1", issued=NOW + 200)  # inside the skew window
    cfg_old = sign_config("dev-1", issued=NOW)
    assert _verify_lic(lic_new, last_accepted_issued_at=NOW) is not None
    # The config floor is its own; the licence's higher `issuedAt` is irrelevant to it.
    assert _verify_cfg(cfg_old, last_accepted_issued_at=NOW - 1) is not None
    assert _verify_cfg(cfg_old, last_accepted_issued_at=NOW) is None


# ════════════════════════════════════════════════════════════════════════════════════
# §3 / R2-08 — the full claim set
# ════════════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "over,why",
    [
        ({"iss": "https://evil.example"}, "iss mismatch"),
        ({"iss": "plrs.im"}, "a foreign issuer is refused (§8)"),
        ({"aud": "other-product"}, "aud mismatch"),
        ({"deviceId": "someone-else"}, "device mismatch"),
        ({"issuedAt": NOW + 10 * 365 * DAY}, "far-future issuedAt"),
        ({"expiresAt": NOW - 400 * DAY, "issuedAt": NOW - 401 * DAY}, "expired"),
        ({"graceUntil": NOW + 1000 * DAY}, "grace beyond MAX_GRACE_SECONDS"),
        ({"graceUntil": NOW}, "graceUntil before expiresAt"),
        ({"licenseId": ""}, "empty licenseId"),
        ({"entitlements": []}, "entitlements must be an object"),
        ({"profile": "Grace"}, "a smuggled scalar profile"),
    ],
)
def test_r2_08_license_claim_checks(over: Dict[str, Any], why: str) -> None:
    assert _verify_lic(sign_license("dev-1", **over)) is None, why


@pytest.mark.parametrize(
    "over,why",
    [
        ({"iss": "plrs.im"}, "a foreign issuer is refused (§8)"),
        ({"schemaVersion": 0}, "non-positive schemaVersion"),
        ({"schemaVersion": "4"}, "schemaVersion is shape-checked, not coerced"),
        ({"config": []}, "config must be an object"),
        ({"secrets": None}, "secrets must be an object"),
        ({"graceUntil": NOW + 1000 * DAY}, "grace beyond MAX_GRACE_SECONDS"),
    ],
)
def test_r2_08_config_claim_checks(over: Dict[str, Any], why: str) -> None:
    assert _verify_cfg(sign_config("dev-1", **over)) is None, why


def test_r2_08_clock_skew_tolerance_is_300_seconds() -> None:
    assert _verify_lic(sign_license("dev-1", issued=NOW + 200)) is not None
    assert _verify_lic(sign_license("dev-1", issued=NOW + 400)) is None


def test_r2_08_a_valid_doc_still_verifies() -> None:
    doc = _verify_lic(sign_license("dev-1"))
    assert doc is not None and doc.licenseId == "lic_v3"
    cfg = _verify_cfg(sign_config("dev-1"))
    assert cfg is not None and cfg.schemaVersion == 4


def test_r2_08_the_grace_ceiling_binds_at_verify_time_not_only_in_the_gate() -> None:
    """§3.3: the 365-day ceiling applies at VERIFY time, so an over-generous offline
    bundle is refused before it can reach the cache."""
    ok = sign_license("dev-1", graceUntil=NOW + 365 * DAY)
    over = sign_license("dev-1", graceUntil=NOW + 365 * DAY + 1)
    assert _verify_lic(ok) is not None
    assert _verify_lic(over) is None
    # …and the same on the RELOAD path, where the gate would otherwise be the only guard.
    assert _verify_lic(over, check_freshness=False) is None


# ════════════════════════════════════════════════════════════════════════════════════
# §4.2 / R4-04 — the monotonic time floor
# ════════════════════════════════════════════════════════════════════════════════════
def test_r4_04_clock_floor_clamps_a_rolled_back_clock() -> None:
    c = make_client(
        routes(license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]))
    )
    assert c.license.activate_with_key("k").kind == "ok"
    assert c.core.now(NOW - 400 * DAY) == NOW
    assert c.core.now(NOW + 10) == NOW + 10
    c.close()


def test_r4_04_the_gate_evaluates_at_the_floor_not_the_wall_clock() -> None:
    """``license_state`` never sees a time earlier than the newest verified ``issuedAt``."""
    doc = LicenseDoc(
        iss="key.plrs.im",
        aud=PRODUCT,
        deviceId="dev",
        issuedAt=NOW,
        expiresAt=NOW + 3600,
        graceUntil=NOW + 30 * DAY,
        licenseId="lic",
    )
    rolled_back = NOW - 400 * DAY
    # Without a floor a wound-back clock reads `ok`; with one the gate uses the mark.
    assert (
        license_state(activation="token", doc=doc, now=rolled_back).status == "ok"
    )
    assert (
        license_state(
            activation="token", doc=doc, now=rolled_back, high_water_mark=NOW + 31 * DAY
        ).status
        == "expired"
    )


def test_r4_04_offline_reload_preserves_grace_but_still_clamps(tmp_path) -> None:
    """§3: freshness is NOT re-checked on reload — grace survives.

    Re-asserting ``expiresAt`` on the reload path would delete offline operation outright,
    since a cached document is expected to be past its one-hour expiry. The signed outer
    bound is ``graceUntil``, and the gate applies the monotonic floor to it.
    """
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token(TOKEN)
    issued = NOW - 2 * DAY  # long past `expiresAt`, comfortably inside `graceUntil`
    store.write_cache(CacheRecord(docs={"license": sign_license(device_id, issued=issued)}))
    c = make_client(routes(license_status=503), store=FileStore(PRODUCT, str(tmp_path)))
    assert c.status().status == "grace", "offline grace must survive a reload"
    assert c.core.high_water_mark == issued
    # Winding the clock back below the floor changes nothing.
    assert c.status(now=issued - 400 * DAY).status == c.status(now=issued).status
    c.close()


def test_r4_04_the_trust_manifest_anchors_time_independently(tmp_path) -> None:
    """§4.2 — the floor needs a SECOND source or it is inert.

    Derived from a document alone, ``high_water_mark == doc.issuedAt``, which is below
    that same document's ``graceUntil`` by construction — so the floor can never reach the
    end of grace and winding the clock back still extends offline operation indefinitely
    (the residual half of R4-04). The trust manifest is signed, cached separately, and
    refreshed on CORE's own cadence in v3 rather than riding a service's document fetch,
    so it advances even while the document does not.
    """
    issued = NOW - 400 * DAY  # grace ended 370 days ago
    rolled_back = issued + 60  # `sudo date`, back inside the document's window
    # A manifest verified YESTERDAY. Long past its own `expiresAt` — which is exactly what
    # a cached manifest looks like — so this also pins that the reload path stays
    # freshness-free while still anchoring time.
    manifest_jws = sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=NOW - DAY)

    def seeded(name: str, *, with_manifest: bool) -> FileStore:
        path = str(tmp_path / name)
        store = FileStore(PRODUCT, path)
        store.set_token(TOKEN)
        store.write_cache(
            CacheRecord(
                # Bound to THIS store's device id, as a real document would be.
                docs={"license": sign_license(store.get_device_id(), issued=issued)},
                trustJws=manifest_jws if with_manifest else None,
            )
        )
        # A fresh instance, so the client re-reads and re-verifies from disk.
        return FileStore(PRODUCT, path)

    # (a) Document only: the rollback still works. This is the defect, pinned.
    doc_only = make_client(
        routes(license_status=503), store=seeded("doconly", with_manifest=False)
    )
    assert doc_only.core.high_water_mark == issued
    assert doc_only.status(now=rolled_back).status == "ok"
    doc_only.close()

    # (b) With the cached manifest the floor clears `graceUntil`, so the gate refuses.
    anchored = make_client(
        routes(license_status=503), store=seeded("anchored", with_manifest=True)
    )
    assert anchored.core.high_water_mark == NOW - DAY
    assert anchored.status(now=rolled_back).status == "expired"
    assert not anchored.is_licensed(now=rolled_back)
    # …and the manifest's keys still loaded: freshness is NOT re-checked on reload.
    assert KID in anchored._trust.effective
    anchored.close()

    # (c) The network path raises it too, even when BOTH documents are unreachable —
    #     v3's point: trust refresh no longer rides a service's fetch.
    online = make_client(
        routes(
            license_status=503,
            config_status=503,
            trust_jws=sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=NOW),
        ),
        store=seeded("online", with_manifest=False),
    )
    assert online.status(now=rolled_back).status == "ok"
    online.sync()
    assert online.core.high_water_mark == NOW
    assert online.status(now=rolled_back).status == "expired"
    online.close()


def test_r4_04_trust_refresh_runs_for_a_config_only_product(tmp_path) -> None:
    """§4.2's abolition of the v2 coupling, stated directly: a product with the LICENCE
    service disabled still advances the independent signed clock, because Core refreshes
    trust on its own cadence before any document is fetched."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token(TOKEN)
    c = make_client(
        routes(
            config_jws=sign_config(device_id),
            # Inside the network path's skew window, and STRICTLY newer than the config
            # document — so a floor that only moved on documents would stop at NOW.
            trust_jws=sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=NOW + 200),
        ),
        store=FileStore(PRODUCT, str(tmp_path)),
        expected_services=["config"],
    )
    assert c.core.enabled("license") is False
    c.sync()
    assert c.core.high_water_mark == NOW + 200
    assert c.status().status == "not-applicable"
    c.close()


# ════════════════════════════════════════════════════════════════════════════════════
# §5 / R2-11 — a 304 renews freshness
# ════════════════════════════════════════════════════════════════════════════════════
def test_r2_11_a_continuously_online_client_never_drifts_into_grace(monkeypatch) -> None:
    """v1: a stable document 304s forever, so ``expiresAt`` froze and the gate aged out."""
    clock = {"t": NOW}
    monkeypatch.setattr(time, "time", lambda: float(clock["t"]))
    served: List[int] = []

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/license/document":
            # A content-only ETag: unchanged grants always 304 on a conditional request.
            if r.headers.get("if-none-match") == "stable-etag":
                return httpx.Response(304, headers={"etag": "stable-etag"})
            served.append(clock["t"])
            return httpx.Response(
                200,
                text=sign_license(r.headers["X-PKey-Device"], issued=clock["t"]),
                headers={"etag": "stable-etag"},
            )
        if path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler, expected_services=["license"])
    assert c.license.activate_with_key("k").kind == "ok"
    assert len(served) == 1

    # Poll every 10 minutes for 6 hours — well past the 1h `expiresAt`.
    for _ in range(36):
        clock["t"] += 600
        c.sync()
        assert c.status().status == "ok", "an online client must never enter grace"

    assert len(served) > 1, "the 304 must escalate to a full re-request past half-life"
    assert c._cache.license_doc().issuedAt >= clock["t"] - 1800
    c.close()


def test_r2_11_a_304_inside_the_window_does_not_re_request(monkeypatch) -> None:
    clock = {"t": NOW}
    monkeypatch.setattr(time, "time", lambda: float(clock["t"]))
    full = {"n": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/license/document":
            if r.headers.get("if-none-match") == "stable-etag":
                return httpx.Response(304, headers={"etag": "stable-etag"})
            full["n"] += 1
            return httpx.Response(
                200,
                text=sign_license(r.headers["X-PKey-Device"], issued=clock["t"]),
                headers={"etag": "stable-etag"},
            )
        if path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler, expected_services=["license"])
    c.license.activate_with_key("k")
    assert full["n"] == 1
    clock["t"] += 60  # comfortably inside expiresAt - REFRESH_MARGIN
    c.sync()
    assert full["n"] == 1, "a 304 well inside the window is still a cheap no-op"
    c.close()


def test_r2_11_the_half_life_boundary_runs_at_effective_now(monkeypatch) -> None:
    """§5 × §4.2 — the escalation boundary compares EFFECTIVE now (the monotonic floor),
    so a system-clock rollback — the exact condition the floor exists for — cannot also
    disable the half-life defense and leave the client coasting into grace behind a
    content-stable ETag."""
    clock = {"t": NOW}
    monkeypatch.setattr(time, "time", lambda: float(clock["t"]))
    served = {"n": 0}
    manifest = {"issued": NOW}

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/.well-known/polaris-trust.jws":
            return httpx.Response(
                200,
                text=sign_manifest(
                    [key_entry(KID, PUBKEY_RAW)], issued=manifest["issued"]
                ),
            )
        if path == f"{p}/license/document":
            if r.headers.get("if-none-match") == "stable-etag":
                return httpx.Response(304, headers={"etag": "stable-etag"})
            served["n"] += 1
            # Content-stable: issuedAt pinned to NOW, so the escalation boundary stays
            # fixed at NOW + 1800 for the whole test.
            return httpx.Response(
                200,
                text=sign_license(r.headers["X-PKey-Device"], issued=NOW),
                headers={"etag": "stable-etag"},
            )
        if path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler, expected_services=["license"])
    c.license.activate_with_key("k")
    assert served["n"] == 1

    # Raise the floor past the boundary: a manifest issued at NOW + 2500 is verifiable
    # AT NOW + 2500, and refresh() lifts the floor to its issuedAt.
    clock["t"] = NOW + 2500
    manifest["issued"] = NOW + 2500
    c.sync()
    assert c.core.high_water_mark == NOW + 2500
    after_raise = served["n"]

    # ROLLBACK inside the window (NOW + 600 < boundary NOW + 1800). The floor still says
    # the half-life has passed, so the 304 must escalate to a full re-request.
    clock["t"] = NOW + 600
    c.sync()
    assert served["n"] > after_raise, (
        "the escalation must run at effective now, not the wall clock"
    )
    c.close()


def test_r2_11_the_half_life_rule_is_applied_PER_DOCUMENT(monkeypatch) -> None:
    """NEW IN v3 (§5): licence and config carry independent ETags, so each escalates on
    its OWN half-life. A shared rule would make one document's staleness force the
    other's re-download."""
    clock = {"t": NOW}
    monkeypatch.setattr(time, "time", lambda: float(clock["t"]))
    full = {"license": 0, "config": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        for slice_name, signer in (("license", sign_license), ("config", sign_config)):
            if path == f"{p}/{slice_name}/document":
                tag = f"{slice_name}-etag"
                if r.headers.get("if-none-match") == tag:
                    return httpx.Response(304, headers={"etag": tag})
                full[slice_name] += 1
                # The CONFIG document is minted with a far longer window, so it stays
                # inside its half-life while the licence passes through two of them.
                issued = clock["t"]
                extra = (
                    {}
                    if slice_name == "license"
                    else {"expiresAt": issued + 10 * 3600}
                )
                return httpx.Response(
                    200,
                    text=signer(r.headers["X-PKey-Device"], issued=issued, **extra),
                    headers={"etag": tag},
                )
        if path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler)
    c.license.activate_with_key("k")
    assert full == {"license": 1, "config": 1}
    clock["t"] += 3600  # past the licence's half-life, far inside the config's
    c.sync()
    assert full["license"] == 2, "the licence re-signed"
    assert full["config"] == 1, "the config did not have to"
    c.close()


# ════════════════════════════════════════════════════════════════════════════════════
# R4-13 — signed-but-malformed documents return "no document", never raise
# ════════════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "over",
    [
        {"issuedAt": "5"},
        {"expiresAt": None},
        {"graceUntil": "9999999999"},
        {"aud": 7},
        {"deviceId": 12},
        {"issuedAt": True},
        {"licenseId": 5},
    ],
)
def test_r4_13_malformed_signed_license_returns_none(over: Dict[str, Any]) -> None:
    assert _verify_lic(sign_license("dev-1", **over)) is None


@pytest.mark.parametrize("over", [{"schemaVersion": "1"}, {"issuedAt": "5"}])
def test_r4_13_malformed_signed_config_returns_none(over: Dict[str, Any]) -> None:
    """The v2 case ``{"schemaVersion": "1"}`` lives HERE now: ``schemaVersion`` is a
    config-document field in v3 (§2.2), not a claim on the (now split) single document."""
    assert _verify_cfg(sign_config("dev-1", **over)) is None


def test_r4_13_a_malformed_nested_profile_is_accepted_and_inert() -> None:
    """HEIR of the v2 ``{"profile": {... "activatedAt": "0"}}`` case, RE-BASELINED.

    v3's normative verifier (``@polaris-key/client-core``'s ``verify.ts``) checks that ``profile``
    is an OBJECT and nothing more. Rejecting on a malformed inner field would make this
    SDK the one implementation of four that refuses a document Node, React and Swift
    accept — a divergence in the strict direction is still a divergence (§10). What
    R4-13 was actually protecting is that a malformed field must never RAISE, and that is
    asserted here: the document verifies and the bad field decodes to an inert default.
    A smuggled SCALAR profile is still refused (see the R2-08 claim table above).
    """
    jws = sign_license(
        "dev-1",
        profile={"name": "A", "firstName": "A", "email": "a@b", "activatedAt": "0"},
    )
    doc = _verify_lic(jws)
    assert doc is not None, "the reference implementation accepts this"
    assert doc.profile is not None and doc.profile.activatedAt == 0
    assert doc.profile.name == "A"


def test_r4_13_license_state_never_raises_on_a_bad_window() -> None:
    """The gate is the client's hottest read path; a ``TypeError`` escaping it turns every
    check into a crash."""
    doc = LicenseDoc(
        iss="key.plrs.im",
        aud=PRODUCT,
        deviceId="dev",
        issuedAt=NOW,
        expiresAt=NOW + 3600,
        graceUntil="9999999999",  # type: ignore[arg-type]
        licenseId="lic",
    )
    assert license_state(activation="token", doc=doc, now=NOW).status == "needs-activation"


def test_r4_13_sync_survives_a_malformed_signed_doc() -> None:
    bad = sign_license("dev-1", issuedAt="5")
    c = make_client(routes(license_jws=bad))
    assert c.license.activate_with_key("k").kind == "ok"  # no TypeError escapes sync()
    assert c.sync(force=True).applied is False
    assert c.status().status == "needs-activation"
    c.close()


# ════════════════════════════════════════════════════════════════════════════════════
# R4-07 / R12-13 / R4-10 — CLI + store hardening
# ════════════════════════════════════════════════════════════════════════════════════
def test_r4_07_cli_no_longer_defaults_to_a_build_gate_bypassing_version() -> None:
    from polaris_key.core.semver import channel_for_version, is_dev_build

    assert not is_dev_build(cli_core.DEFAULT_VERSION)
    assert channel_for_version(cli_core.DEFAULT_VERSION) == "stable"
    assert cli_core.ClientOptions(product=PRODUCT).version == cli_core.DEFAULT_VERSION

    import argparse

    from polaris_key.cli.argparse_cli import _options, build_parser

    args = build_parser().parse_args(["status", "--product", PRODUCT])
    assert isinstance(args, argparse.Namespace)
    # The flag's default resolves when the verb runs (the installed version, read lazily).
    assert _options(args).version == cli_core.DEFAULT_VERSION
    assert not is_dev_build(_options(args).version)


def test_r12_13_key_resolution_prefers_non_argv_sources(tmp_path) -> None:
    import io

    key_file = tmp_path / "key.txt"
    key_file.write_text("FROM-FILE\n")

    warnings: List[str] = []
    warn = warnings.append

    # 1. --key-file wins.
    assert (
        cli_core.resolve_activation_key(
            "FROM-ARGV", key_file=str(key_file), env={}, warn=warn
        )
        == "FROM-FILE"
    )
    # 2. --key-stdin next.
    assert (
        cli_core.resolve_activation_key(
            "FROM-ARGV",
            key_stdin=True,
            stdin=io.StringIO("FROM-STDIN\n"),
            env={},
            warn=warn,
        )
        == "FROM-STDIN"
    )
    # 3. the env var next.
    assert (
        cli_core.resolve_activation_key(
            "FROM-ARGV", env={cli_core.KEY_ENV_VAR: "FROM-ENV"}, warn=warn
        )
        == "FROM-ENV"
    )
    assert warnings == [], "the non-argv paths must not warn"

    # 4. argv still works, but warns about shell history / ps.
    assert cli_core.resolve_activation_key("FROM-ARGV", env={}, warn=warn) == "FROM-ARGV"
    assert len(warnings) == 1 and "shell history" in warnings[0]

    # 5. nothing at all, non-interactive -> a clear error, not a silent empty key.
    with pytest.raises(ValueError):
        cli_core.resolve_activation_key(None, env={}, stdin=io.StringIO(""), warn=warn)


def test_r12_13_the_key_env_var_is_namespaced_and_no_other_name_is_read(monkeypatch) -> None:
    """§8: the CLI reads exactly one env var. The un-namespaced ``POLARIS_ACTIVATION_KEY``
    the interim suite design used (withdrawn by Amendment A1) is NOT read as a fallback —
    a second accepted name is a second way to smuggle a key past the intended one."""
    assert cli_core.KEY_ENV_VAR == "POLARIS_KEY_ACTIVATION_KEY"
    with pytest.raises(ValueError):
        cli_core.resolve_activation_key(
            None, env={"POLARIS_ACTIVATION_KEY": "STALE"}, stdin=__import__("io").StringIO("")
        )


def test_r12_13_argparse_activate_reads_the_env_var(monkeypatch) -> None:
    import argparse

    from polaris_key.cli.argparse_cli import register_argparse
    from polaris_key.license.endpoints import ActivationOk
    from polaris_key.license.gate import LicenseState

    seen: Dict[str, Any] = {}

    class _FakeLicense:
        def activate_with_key(self, key: str):
            seen["key"] = key
            return ActivationOk(token=TOKEN, schemaVersion=4)

        def get_profile(self):
            return None

    class _Fake:
        license = _FakeLicense()

        def status(self, now=None):
            return LicenseState(status="ok")

        def is_licensed(self, now=None):
            return True

        def close(self) -> None:
            seen["closed"] = True

    parser = argparse.ArgumentParser(prog="host")
    sub = parser.add_subparsers(dest="command", required=True)
    register_argparse(sub, client_factory=lambda opts: _Fake())
    monkeypatch.setenv(cli_core.KEY_ENV_VAR, "PKEY-FROM-ENV")
    args = parser.parse_args(["activate", "--product", PRODUCT])
    assert args.key is None, "the positional is optional now"
    assert args.func(args) == 0
    assert seen["key"] == "PKEY-FROM-ENV"
    assert seen["closed"] is True


def test_r4_10_symlink_guard_is_declared_honestly() -> None:
    """``getattr(os, "O_NOFOLLOW", 0)`` silently became 0 on Windows."""
    assert SYMLINK_GUARD in ("O_NOFOLLOW", "lstat-precheck")
    if hasattr(os, "O_NOFOLLOW"):
        assert SYMLINK_GUARD == "O_NOFOLLOW"


def test_r4_10_lstat_precheck_refuses_a_symlink(monkeypatch, tmp_path) -> None:
    """Force the no-O_NOFOLLOW (Windows) path and prove it refuses rather than writes."""
    import polaris_key.devices.store as store_mod

    store = FileStore(PRODUCT, str(tmp_path))
    target = tmp_path / "outside.txt"
    target.write_text("attacker-owned")
    token_path = os.path.join(str(tmp_path), PRODUCT, "token")
    if os.path.exists(token_path):
        os.remove(token_path)
    os.symlink(str(target), token_path)

    monkeypatch.setattr(store_mod, "_O_NOFOLLOW", None)
    with pytest.raises(OSError):
        store.set_token("secret-token")
    assert target.read_text() == "attacker-owned"


# ════════════════════════════════════════════════════════════════════════════════════
# §8 — the identifier rebrand, asserted on the wire
# ════════════════════════════════════════════════════════════════════════════════════
def test_v3_identifier_rebrand_on_every_product_scoped_call() -> None:
    """§8: ``X-PKey-*`` headers, ``key.plrs.im`` issuer, ``pkeyt_`` credential, and the
    ``/license/*`` + ``/config/*`` + ``/devices/*`` route shapes."""
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            seen["activate_headers"] = dict(r.headers)
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/license/document":
            seen["doc_headers"] = dict(r.headers)
            return httpx.Response(
                200,
                text=sign_license(r.headers["X-PKey-Device"]),
                headers={"etag": "lic"},
            )
        if path == f"{p}/config/document":
            return httpx.Response(
                200,
                text=sign_config(r.headers["X-PKey-Device"]),
                headers={"etag": "cfg"},
            )
        if path == f"{p}/devices/report":
            seen["report"] = True
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler)
    assert c.license.activate_with_key("k").kind == "ok"
    for headers in (seen["activate_headers"], seen["doc_headers"]):
        for name in (
            "x-pkey-device",
            "x-pkey-version",
            "x-pkey-channel",
            "x-pkey-platform",
            "x-pkey-arch",
            "x-pkey-sdk",
            "x-pkey-sdk-version",
        ):
            assert name in headers, name
        assert not any(
            k.startswith("x-polaris-") for k in headers
        ), "the withdrawn X-Polaris-* headers must not be sent"
    assert seen["doc_headers"]["authorization"] == f"Bearer {TOKEN}"
    assert TOKEN.startswith("pkeyt_")
    assert seen.get("report") is True, "telemetry lands on POST /devices/report"
    assert c._cache.license_doc().iss == "key.plrs.im"
    c.close()


def test_v3_the_old_config_report_path_is_never_called() -> None:
    """§6/§R1: ``POST /<p>/config/report`` is GONE. A client still calling it would be
    reporting into a 404 and losing the fleet's telemetry silently."""
    seen: Dict[str, Any] = {"paths": []}
    c = make_client(
        routes(
            license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
            config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
            seen=seen,
        )
    )
    c.license.activate_with_key("k")
    assert f"/{PRODUCT}/devices/report" in seen["paths"]
    assert f"/{PRODUCT}/config/report" not in seen["paths"]
    assert f"/{PRODUCT}/config" not in seen["paths"], "the v2 combined route is gone too"
    c.close()


def test_v3_keyring_service_tag_is_pkey(tmp_path) -> None:
    """§8: the OS keyring service tag is ``pkey:<product>``."""
    from polaris_key.devices.store import KeyringStore

    assert KeyringStore(PRODUCT, str(tmp_path)).service == f"pkey:{PRODUCT}"


def test_v3_env_prefix_is_pkey_config_and_plrs_config_is_not_read() -> None:
    """§8 + the negative half: the ``PLRS_CONFIG_`` spelling that Amendment A1 withdrew is
    NOT read as a fallback. A dual-accept window here would mean a stale exported variable
    silently overriding a deployment's settings."""
    from polaris_key.config.resolve import DEFAULT_ENV_PREFIX

    assert DEFAULT_ENV_PREFIX == "PKEY_CONFIG_"
    c = make_client(
        routes(config_jws=lambda r: sign_config(r.headers["X-PKey-Device"])),
        env={"PLRS_CONFIG_ui__theme": '"dark"'},
    )
    c.license.activate_with_key("k")
    assert c.config.get_config("ui.theme") == "light", "the withdrawn prefix must be inert"
    assert c.config.get_config_source("ui.theme") == "remote-default"
    c.close()

    c2 = make_client(
        routes(config_jws=lambda r: sign_config(r.headers["X-PKey-Device"])),
        env={"PKEY_CONFIG_ui__theme": '"dark"'},
    )
    c2.license.activate_with_key("k")
    assert c2.config.get_config("ui.theme") == "dark"
    assert c2.config.get_config_source("ui.theme") == "env"
    c2.close()


# ════════════════════════════════════════════════════════════════════════════════════
# The two Python parity gaps this phase closed
# ════════════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "url",
    [
        "http://key.plrs.im",
        "http://evil.example",
        "ftp://key.plrs.im",
        "//key.plrs.im",
        "key.plrs.im",
        "",
    ],
)
def test_parity_insecure_base_url_is_refused_at_construction(url: str) -> None:
    """PARITY GAP CLOSED. Node has refused a non-HTTPS base URL since v3; this client
    accepted anything, so a plaintext control plane turned trust-set injection (R4-02)
    from a local attack into a coffee-shop one. Nothing else happens first: the refusal is
    in the constructor, before the store is touched or a request is built."""
    with pytest.raises(InsecureBaseUrlError):
        normalize_base_url(url)
    from polaris_key import PolarisKeyClient

    with pytest.raises(InsecureBaseUrlError):
        PolarisKeyClient(product_slug=PRODUCT, version="1.0.0", trust=TRUST, base_url=url)


@pytest.mark.parametrize(
    "url", ["https://key.plrs.im", "http://localhost:8787", "http://127.0.0.1:8787"]
)
def test_parity_https_and_loopback_are_accepted(url: str) -> None:
    """Loopback keeps ``http:`` usable for ``wrangler dev`` and integration suites."""
    assert normalize_base_url(url) == url
    assert normalize_base_url(url + "///") == url


def test_parity_per_request_timeout_is_applied_to_an_INJECTED_client() -> None:
    """PARITY GAP CLOSED. The pre-suite client set a timeout only on the client it
    CONSTRUCTED, so an injected ``httpx.Client`` — which is how every host that wants
    pooling, retries or a proxy supplies one — ran with whatever deadline it happened to
    carry, possibly none. A slowloris on any endpoint then stalled the sync forever
    (R4-08). ``timeout=`` is now passed on EVERY request, which httpx honours per-call
    regardless of who built the client."""
    seen: List[Any] = []

    class _RecordingClient(httpx.Client):
        def request(self, method, url, **kwargs):  # type: ignore[override]
            seen.append(kwargs.get("timeout"))
            return super().request(method, url, **kwargs)

    handler = routes(
        license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
        config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
        trust_jws=sign_manifest([key_entry(KID, PUBKEY_RAW)]),
    )
    injected = _RecordingClient(transport=httpx.MockTransport(handler), base_url="")
    c = make_client(handler, client=injected, request_timeout=7.5)
    c.license.activate_with_key("k")  # activate + trust refresh + two documents + report
    c.devices.list()
    c.close()
    assert seen, "no request was recorded"
    assert all(t == 7.5 for t in seen), f"a call escaped the deadline: {seen}"


def test_parity_request_timeout_defaults_and_can_be_disabled() -> None:
    ctx = CoreContext(product_slug=PRODUCT, version="1.0.0", trust=TRUST,
                      store=__import__("polaris_key").InMemoryStore(PRODUCT))
    assert ctx.timeout == DEFAULT_REQUEST_TIMEOUT_SECONDS
    off = CoreContext(product_slug=PRODUCT, version="1.0.0", trust=TRUST,
                      request_timeout=0,
                      store=__import__("polaris_key").InMemoryStore(PRODUCT))
    assert off.timeout is None


# ════════════════════════════════════════════════════════════════════════════════════
# §10 — the divergence classes v3 introduced
# ════════════════════════════════════════════════════════════════════════════════════
def test_v3_config_document_is_issued_without_a_license(tmp_path) -> None:
    """§2.2 / D-08, the wire-level guarantee of service independence: a product with
    Config enabled and License DISABLED serves config documents to any registered device,
    and its gate reads ``not-applicable`` (usable) rather than ``needs-activation``."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    seen: Dict[str, Any] = {"paths": []}
    c = make_client(
        routes(config_jws=sign_config(device_id), seen=seen),
        store=FileStore(PRODUCT, str(tmp_path)),
        expected_services=["config"],
    )
    assert c.devices.register().kind == "ok"
    c.sync(force=True)
    assert c.status().status == "not-applicable"
    assert c.is_licensed() is True, "a config-only product boots USABLE"
    assert c.config.get_config("run.concurrency") == 4
    assert f"/{PRODUCT}/license/document" not in seen["paths"], (
        "a disabled service is never fetched"
    )
    c.close()


def test_v3_registration_mints_a_credential_with_no_license() -> None:
    """§6: ``POST /<p>/devices/register`` is the keyless mint path, and it sends NO
    Authorization header even when a stale token is held — a client re-registering is
    asking for a FRESH credential, not authenticating with the old one."""
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/devices/register":
            seen["auth"] = r.headers.get("authorization")
            seen["device"] = r.headers.get("X-PKey-Device")
            return httpx.Response(
                200, json={"token": TOKEN, "deviceId": seen["device"]}
            )
        return httpx.Response(404)

    c = make_client(handler)
    c._tokens.set("pkeyt_" + "s" * 43)
    r = c.devices.register()
    assert r.kind == "ok" and r.token == TOKEN
    assert seen["auth"] is None, "registration is keyless"
    assert c._tokens.current == TOKEN
    c.close()


def test_v3_registration_closed_is_reported_not_retried() -> None:
    """A ``requires-license`` product answers 403 ``registration_closed``. Quietly
    substituting ``activate`` would hide a misconfigured policy."""
    c = make_client(routes(register_status=403))
    assert c.devices.register().kind == "registration-closed"
    assert c._tokens.current is None
    c.close()


def test_v3_bundle_import_is_all_or_nothing(tmp_path) -> None:
    """§7: a refusal at ANY step writes nothing — not even the documents that verified
    before it."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    c = make_client(routes(), store=FileStore(PRODUCT, str(tmp_path)))
    good_config = sign_config(device_id)
    bad_license = sign_license(device_id, pem=ATTACKER_PEM)
    bundle = sign_bundle(
        device_id, docs={"license": bad_license, "config": good_config}
    )
    with pytest.raises(PolarisError) as exc:
        c.import_bundle(bundle, NOW)
    assert exc.value.code == "inner-doc-rejected"
    assert c._cache.config_doc() is None, "the good config slice was NOT written"
    assert store.read_cache() is None
    assert c.status().status == "needs-activation"
    c.close()


def test_v3_bundle_cap_and_missing_typ_are_step_1_refusals() -> None:
    """§1/§7: the raised cap belongs to the ``typ``, so an untyped 256 KiB blob is refused
    at step 1 rather than becoming a document that could be replayed elsewhere."""
    untyped = sign_bundle("dev-1", typ=None)
    result = inspect_bundle(
        untyped, pinned=TRUST, product=PRODUCT, device_id="dev-1", now=NOW,
        floors={"license": None, "config": None},
    )
    assert result.ok is False and result.reason == BUNDLE_JWS_REJECTED

    oversized = sign_bundle("dev-1", padding="x" * (MAX_BUNDLE_BYTES + 1024))
    result = inspect_bundle(
        oversized, pinned=TRUST, product=PRODUCT, device_id="dev-1", now=NOW,
        floors={"license": None, "config": None},
    )
    assert result.ok is False and result.reason == BUNDLE_JWS_REJECTED


def test_v3_a_vacuous_bundle_is_refused() -> None:
    """§7: a bundle carrying NEITHER document can grant nothing and configure nothing, so
    importing it would write a ``bundle`` slice with no content behind it — an
    install that LOOKS provisioned and is not."""
    empty = sign_bundle("dev-1", docs={})
    result = inspect_bundle(
        empty, pinned=TRUST, product=PRODUCT, device_id="dev-1", now=NOW,
        floors={"license": None, "config": None},
    )
    assert result.ok is False and result.reason == BUNDLE_CLAIMS_REJECTED


def test_v3_gate_not_applicable_and_bundle_activation() -> None:
    """§5: the two new gate inputs, stated directly."""
    doc = LicenseDoc(
        iss="key.plrs.im",
        aud=PRODUCT,
        deviceId="dev",
        issuedAt=NOW,
        expiresAt=NOW + 3600,
        graceUntil=NOW + 30 * DAY,
        licenseId="lic",
    )
    # licence service off ⇒ not-applicable, and it precedes EVERY other rule.
    assert (
        license_state(
            license_service_enabled=False,
            activation=None,
            doc=None,
            now=NOW,
            last_sync_unauthorized=True,
        ).status
        == "not-applicable"
    )
    # bundle activation gates exactly like a token.
    assert license_state(activation="bundle", doc=doc, now=NOW).status == "ok"
    assert (
        license_state(activation="bundle", doc=doc, now=NOW + 31 * DAY).status
        == "expired"
    )
    # and no activation at all still wins over a stale blocked hint (the v3 ordering).
    from polaris_key.core.models import BlockedState

    assert (
        license_state(
            activation=None,
            doc=None,
            now=NOW,
            blocked=BlockedState(reason="version-too-new"),
        ).status
        == "needs-activation"
    )
