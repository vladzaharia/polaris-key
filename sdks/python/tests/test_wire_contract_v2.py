"""Wire contract v2 regression suite — every audit PoC, inverted.

Each test here asserts that an attack the red team **proved working** against the v1
client now fails. They are named for the finding they close so a regression points
straight back at `docs/security/WIRE-CONTRACT-V2.md` and
`docs/security/findings/R2-crypto.md` / `R4-client.md`.

Grouped by spec section:

* §2.3  R2-05 — strict base64url (no silent discarding of junk)
* §2.5  R2-07 — canonical, non-ASCII-safe signing bytes
* §2.1  R2-04 — encoded + decoded size caps, and verify-BEFORE-parse ordering
* §2.2  R2-06 — duplicate JSON keys are rejected, not resolved
* §2.4  R2-10 — `typ` domain separation closes cross-protocol replay
* §1     C2/C3/H9 — pins terminal, `key.status` honoured, pruning mandatory
* §4     R2-03/R4-01/R4-02/R4-03 — only signed artifacts persist; state is derived
* §3     R2-08 — the full claim set, with clock skew
* §4.3  R4-04 — the monotonic time floor
* §5     R2-11 — a 304 renews freshness
* R4-13 — a signed-but-malformed doc returns "no document", never raises
* R4-07 / R12-13 / R4-10 — CLI + store hardening
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import polaris_key.verify as verify_mod
from polaris_key.b64url import b64url_decode, b64url_encode
from polaris_key.cli import core as cli_core
from polaris_key.client import PolarisKeyClient
from polaris_key.license import license_state
from polaris_key.models import DocProfile, ManagedConfigDoc, ManagedPayload
from polaris_key.store import SYMLINK_GUARD, CacheRecord, FileStore, InMemoryStore
from polaris_key.verify import (
    MAX_DOC_BYTES,
    MAX_HEADER_B64,
    MAX_PAYLOAD_B64,
    TYP_CONFIG,
    TYP_TRUST,
    sign_jws,
    verify_doc,
    verify_jws,
)

PRODUCT = "djdl"
KID = "pkey-test-prod-2026"
PUBKEY_RAW = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
PRIVATE_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n"
    "-----END PRIVATE KEY-----"
)
TRUST = {KID: PUBKEY_RAW}
TOKEN = "tok_test_123"
NOW = int(time.time())
DAY = 86_400


# ── attacker key material (freshly generated; the vendor key is never involved) ──────
def _new_keypair():
    sk = Ed25519PrivateKey.generate()
    pem = sk.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    raw = sk.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return pem, b64url_encode(raw)


ATTACKER_PEM, ATTACKER_PUB = _new_keypair()
ROTATED_PEM, ROTATED_PUB = _new_keypair()


def _doc(device_id: str, *, issued: int = NOW, **over: Any) -> Dict[str, Any]:
    d: Dict[str, Any] = {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "iss": "key.plrs.im",
        "licenseId": "lic_v2",
        "deviceId": device_id,
        "issuedAt": issued,
        "expiresAt": issued + 3600,
        "graceUntil": issued + 30 * DAY,
        "profile": {
            "name": "Grace Hopper",
            "firstName": "Grace",
            "email": "grace@example.com",
            "activatedAt": issued - 1000,
        },
        "payload": {
            "config": {"quality.floor": {"state": "enforced", "value": 1, "updatedAt": 0}},
            "secrets": {
                "soundcloud.oauth": {"state": "hidden", "value": "REAL", "updatedAt": 0}
            },
            "entitlements": {
                "polarisVpn": {"state": "enforced", "value": True, "updatedAt": 0}
            },
        },
    }
    d.update(over)
    return d


def _manifest(keys: List[Dict[str, Any]], *, issued: int = NOW) -> Dict[str, Any]:
    return {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "iss": "key.plrs.im",
        "issuedAt": issued,
        "expiresAt": issued + 3600,
        "jwksUrl": f"https://key.example/{PRODUCT}/.well-known/jwks.json",
        "cacheSeconds": 3600,
        "keys": keys,
    }


def _key_entry(kid: str, pub: str, status: str = "active") -> Dict[str, Any]:
    return {
        "kid": kid,
        "alg": "EdDSA",
        "kty": "OKP",
        "crv": "Ed25519",
        "publicKey": pub,
        "status": status,
    }


def _client(handler, *, store=None, trust=None, **kw) -> PolarisKeyClient:
    http = httpx.Client(transport=httpx.MockTransport(handler), base_url="")
    c = PolarisKeyClient(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST if trust is None else trust,
        base_url="https://key.example",
        store=store or InMemoryStore(PRODUCT),
        client=http,
        **kw,
    )
    c.init()
    return c


def _routes(*, config_jws=None, trust_jws=None, config_status=200):
    """A mock control plane. `config_jws`/`trust_jws` may be callables of the request."""

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        if path == f"/{PRODUCT}/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/.well-known/polaris-trust.jws":
            if trust_jws is None:
                return httpx.Response(404)
            body = trust_jws(r) if callable(trust_jws) else trust_jws
            return httpx.Response(200, text=body)
        if path == f"/{PRODUCT}/config":
            if config_status != 200:
                return httpx.Response(config_status)
            body = config_jws(r) if callable(config_jws) else config_jws
            return httpx.Response(200, text=body, headers={"etag": "stable-etag"})
        if path in (f"/{PRODUCT}/config/report", f"/{PRODUCT}/deauthorize"):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    return handler


# ════════════════════════════════════════════════════════════════════════════════════
# §2.3 / R2-05 — strict base64url
# ════════════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "junk", ["!!", "@", "***", "\n \t", "  ", "====", "+", "/", "a=", "a b"]
)
def test_r2_05_b64url_decode_rejects_out_of_alphabet(junk: str) -> None:
    with pytest.raises(ValueError):
        b64url_decode("QUJD" + junk)


def test_r2_05_signature_segment_junk_is_rejected_end_to_end() -> None:
    """The exact transcript from R2-05: `***`, `\\n \\t` and `====` used to be ACCEPTED.

    Acceptance was length-dependent because the old re-padding counted the junk, so a
    3- or 4-character injection kept the count consistent. All of them now fail, matching
    Node (`atob` throws) and Swift (`Data(base64Encoded:)` returns nil).
    """
    jws = sign_jws({"hello": "world"}, PRIVATE_PEM, KID)
    assert verify_jws(jws, TRUST) is not None, "the clean JWS must still verify"
    for junk in ("!!", "@", "***", "\n \t", "  ", "===="):
        assert verify_jws(jws + junk, TRUST) is None, f"sig junk {junk!r} must be rejected"


def test_r2_05_standard_alphabet_and_padding_are_not_accepted() -> None:
    """`+`/`/` (the STANDARD alphabet) and explicit `=` padding are not wire-legal."""
    raw = bytes(range(64))  # produces both `+` and `/` under the standard alphabet
    import base64

    std = base64.b64encode(raw).decode("ascii")
    assert "+" in std or "/" in std
    with pytest.raises(ValueError):
        b64url_decode(std)
    with pytest.raises(ValueError):
        b64url_decode(b64url_encode(raw) + "=")


def test_r2_05_trust_set_key_with_junk_is_rejected() -> None:
    """`b64url_decode` also backs trust-set key import, so junk there fails too."""
    jws = sign_jws({"hello": "world"}, PRIVATE_PEM, KID)
    assert verify_jws(jws, {KID: PUBKEY_RAW + "***"}) is None


# ════════════════════════════════════════════════════════════════════════════════════
# §2.5 / R2-07 — canonical signing bytes for non-ASCII payloads
# ════════════════════════════════════════════════════════════════════════════════════
def test_r2_07_non_ascii_payload_matches_the_node_signer_bytes() -> None:
    """`ensure_ascii=False` — the payload segment must be the bytes Node emits.

    The expected segment is the one recorded in R2-07 from a real `JSON.stringify` +
    `signJws` run. Before the fix Python emitted
    `eyJuIjoiXHUwMGM1bmdzdHJcdTAwZjZtIFx1ZDgzZFx1ZGNiYiJ9` — the `\\uXXXX`-escaped form,
    i.e. a DIFFERENT signing input and therefore a different signature for the same
    input document.
    """
    payload = {"n": "Ångström 💻"}
    jws = sign_jws(payload, PRIVATE_PEM, KID)
    enc_payload = jws.split(".")[1]
    assert enc_payload == "eyJuIjoiw4VuZ3N0csO2bSDwn5K7In0"
    assert b64url_decode(enc_payload).decode("utf-8") == '{"n":"Ångström 💻"}'
    v = verify_jws(jws, TRUST)
    assert v is not None and v.payload == payload


# ════════════════════════════════════════════════════════════════════════════════════
# §2.1 / R2-04 — size caps and verify-BEFORE-parse ordering
# ════════════════════════════════════════════════════════════════════════════════════
class _RecordingTrust(dict):
    """A trust set that records every `kid` lookup — the deterministic PoC probe."""

    def __init__(self, *a: Any, **kw: Any) -> None:
        super().__init__(*a, **kw)
        self.reads: List[str] = []

    def get(self, key: Any, default: Any = None) -> Any:  # type: ignore[override]
        self.reads.append(key)
        return super().get(key, default)


def test_r2_04_oversized_header_never_reaches_the_trust_set() -> None:
    """An 8 MiB protected header used to be decoded and JSON-parsed pre-verification."""
    from polaris_key.b64url import b64url_encode_str

    header = json.dumps({"alg": "EdDSA", "kid": KID, "junk": "A" * (8 * 1024 * 1024)})
    jws = b64url_encode_str(header) + ".e30." + "A" * 86
    trust = _RecordingTrust(TRUST)
    assert verify_jws(jws, trust) is None
    assert trust.reads == [], "the kid must never be looked up for an oversized header"
    assert len(jws.split(".")[0]) > MAX_HEADER_B64


def test_r2_04_payload_at_cap_accepted_over_cap_rejected() -> None:
    at_cap = {"blob": "x" * (MAX_DOC_BYTES - len('{"blob":""}'))}
    assert len(json.dumps(at_cap, separators=(",", ":"))) == MAX_DOC_BYTES
    assert verify_jws(sign_jws(at_cap, PRIVATE_PEM, KID), TRUST) is not None

    # One byte over the DECODED cap still fits under the ENCODED cap, so this exercises
    # the second (post-verify) bound rather than the pre-decode one.
    just_over = {"blob": "x" * (MAX_DOC_BYTES - len('{"blob":""}') + 1)}
    over_jws = sign_jws(just_over, PRIVATE_PEM, KID)
    assert len(over_jws.split(".")[1]) <= MAX_PAYLOAD_B64
    assert verify_jws(over_jws, TRUST) is None

    # And a genuinely huge payload is rejected on the ENCODED length, pre-allocation.
    huge = sign_jws({"blob": "x" * (4 * 1024 * 1024)}, PRIVATE_PEM, KID)
    trust = _RecordingTrust(TRUST)
    assert verify_jws(huge, trust) is None
    assert trust.reads == []


def test_r2_04_payload_is_not_parsed_before_the_signature_is_verified(monkeypatch) -> None:
    """Steps 12->13: no implementation may JSON-parse an unverified payload."""
    calls: List[int] = []
    real = verify_mod._parse_strict_json

    def counting(raw: bytes) -> Any:
        calls.append(len(raw))
        return real(raw)

    monkeypatch.setattr(verify_mod, "_parse_strict_json", counting)

    jws = sign_jws({"hello": "world", "padding": "x" * 500}, PRIVATE_PEM, KID)
    head, payload, sig = jws.split(".")
    # Flip one signature character so verification fails but everything before it passes.
    tampered = head + "." + payload + "." + ("B" if sig[0] != "B" else "C") + sig[1:]

    assert verify_jws(tampered, TRUST) is None
    assert len(calls) == 1, "only the header may be parsed when the signature is bad"
    assert calls[0] < 200, "the parsed bytes must be the small header, not the payload"

    calls.clear()
    assert verify_jws(jws, TRUST) is not None
    assert len(calls) == 2, "a valid JWS parses header then payload"


# ════════════════════════════════════════════════════════════════════════════════════
# §2.2 / R2-06 — duplicate JSON keys
# ════════════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "header_json",
    [
        '{"alg":"none","kid":"' + KID + '","alg":"EdDSA"}',
        '{"alg":"EdDSA","kid":"' + KID + '","alg":"none"}',
        '{"alg":"EdDSA","kid":"' + KID + '","kid":"other"}',
    ],
)
def test_r2_06_duplicate_header_keys_are_rejected(header_json: str) -> None:
    """TS/Python were last-wins, Swift first-wins — the downgrade guard disagreed."""
    from polaris_key.b64url import b64url_encode_str

    jws = b64url_encode_str(header_json) + ".e30." + "A" * 86
    trust = _RecordingTrust(TRUST)
    assert verify_jws(jws, trust) is None
    assert trust.reads == [], "a duplicate-key header must fail before key selection"


def test_r2_06_duplicate_payload_keys_are_rejected() -> None:
    from polaris_key.b64url import b64url_encode_str
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    header = b64url_encode_str('{"alg":"EdDSA","kid":"' + KID + '"}')
    payload = b64url_encode_str('{"a":1,"a":2}')
    key = load_pem_private_key(PRIVATE_PEM.encode(), password=None)
    sig = b64url_encode(key.sign((header + "." + payload).encode("ascii")))
    # Correctly signed — the ONLY reason to reject is the duplicate member.
    assert verify_jws(header + "." + payload + "." + sig, TRUST) is None


# ════════════════════════════════════════════════════════════════════════════════════
# §2.4 / R2-10 — `typ` domain separation
# ════════════════════════════════════════════════════════════════════════════════════
def test_r2_10_trust_manifest_cannot_be_replayed_as_a_config_doc() -> None:
    manifest_jws = sign_jws(_manifest([]), PRIVATE_PEM, KID, TYP_TRUST)
    assert verify_jws(manifest_jws, TRUST, typ=TYP_CONFIG) is None
    assert verify_jws(manifest_jws, TRUST, typ=TYP_TRUST) is not None


def test_r2_10_absent_typ_is_tolerated_but_a_wrong_one_is_not() -> None:
    """Rollout §7.2: accept a v1 header with no `typ`; never accept a mismatched one."""
    v1 = sign_jws({"hello": "world"}, PRIVATE_PEM, KID)
    assert verify_jws(v1, TRUST, typ=TYP_CONFIG) is not None
    assert verify_jws(v1, TRUST, typ=TYP_TRUST) is not None
    typed = sign_jws({"hello": "world"}, PRIVATE_PEM, KID, TYP_CONFIG)
    assert verify_jws(typed, TRUST, typ=TYP_CONFIG) is not None
    assert verify_jws(typed, TRUST, typ=TYP_TRUST) is None


def test_r2_10_config_doc_replayed_as_a_manifest_does_not_raise() -> None:
    """v1 rejected this only via a TypeError swallowed by a bare `.catch`."""
    c = _client(_routes())
    doc_jws = sign_jws(_doc(c._device_id), PRIVATE_PEM, KID, TYP_CONFIG)
    assert c._apply_trust_manifest(doc_jws, now=NOW, persist=False) is False
    c.close()


# ════════════════════════════════════════════════════════════════════════════════════
# §1 — pins terminal, `key.status` normative, pruning mandatory (C2 / C3 / H9)
# ════════════════════════════════════════════════════════════════════════════════════
def test_c2_manifest_cannot_substitute_the_bytes_behind_a_pinned_kid() -> None:
    """R2-01/R4-02, CRITICAL: the whole manifest is rejected, not merged."""
    hostile = sign_jws(
        _manifest([_key_entry(KID, ATTACKER_PUB), _key_entry("extra", ROTATED_PUB)]),
        PRIVATE_PEM,
        KID,
        TYP_TRUST,
    )
    c = _client(_routes(trust_jws=hostile))
    assert c._refresh_trust() is False
    assert c._trust == TRUST, "the pinned bytes must survive untouched"
    assert "extra" not in c._trust, "a rejected manifest installs nothing at all"
    # ...and a doc signed by the attacker key under the pinned kid is still refused.
    forged = sign_jws(_doc(c._device_id), ATTACKER_PEM, KID, TYP_CONFIG)
    assert verify_doc(
        forged, c._trust, expected_aud=PRODUCT, device_id=c._device_id, now=NOW
    ) is None
    c.close()


def test_c2_cache_is_no_longer_a_key_source(tmp_path) -> None:
    """The v1 exploit: write `trustedKeys` into managed.json, serve a forged doc."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token("anything")
    with open(os.path.join(str(tmp_path), PRODUCT, "managed.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "doc": None,
                "lastAcceptedIssuedAt": 0,
                "trustedKeys": {KID: ATTACKER_PUB, "attacker-forever-2099": ATTACKER_PUB},
            },
            f,
        )
    forged = sign_jws(_doc(device_id), ATTACKER_PEM, KID, TYP_CONFIG)
    c = _client(_routes(config_jws=forged), store=store)
    assert c._trust == TRUST
    r = c.refresh(force=True)
    assert r.applied is False, "a forged doc must not be applied"
    assert c.status().status == "needs-activation"
    assert c.is_entitled("polarisVpn") is False
    assert c.get_secret("soundcloud.oauth") is None
    c.close()


def test_c3_revoked_key_is_refused_and_pruned() -> None:
    m = sign_jws(
        _manifest([_key_entry(KID, PUBKEY_RAW), _key_entry("rot", ROTATED_PUB, "revoked")]),
        PRIVATE_PEM,
        KID,
        TYP_TRUST,
    )
    c = _client(_routes(trust_jws=m))
    assert c._refresh_trust() is True
    assert "rot" not in c._trust, "a revoked key must never enter the trust set"
    doc = sign_jws(_doc(c._device_id), ROTATED_PEM, "rot", TYP_CONFIG)
    assert verify_jws(doc, c._trust) is None
    c.close()


@pytest.mark.parametrize("status", ["active", "staged", "retired"])
def test_c3_usable_statuses_are_installed(status: str) -> None:
    m = sign_jws(
        _manifest([_key_entry(KID, PUBKEY_RAW), _key_entry("rot", ROTATED_PUB, status)]),
        PRIVATE_PEM,
        KID,
        TYP_TRUST,
    )
    c = _client(_routes(trust_jws=m))
    assert c._refresh_trust() is True
    assert c._trust.get("rot") == ROTATED_PUB
    c.close()


def test_c3_only_revoked_is_excluded_by_status() -> None:
    """§1.2 rule 4: the set is `pinned ∪ {manifest keys whose status != revoked}`.

    Exactly `revoked`, not an allow-list — a future status must not silently drop a key
    that the server still considers usable. A non-EdDSA/OKP/Ed25519 entry is skipped on
    its algorithm, independently of status.
    """
    m = sign_jws(
        _manifest(
            [
                _key_entry("rot", ROTATED_PUB, "quarantined"),
                _key_entry("gone", ATTACKER_PUB, "revoked"),
            ]
        ),
        PRIVATE_PEM,
        KID,
        TYP_TRUST,
    )
    c = _client(_routes(trust_jws=m))
    assert c._refresh_trust() is True
    assert c._trust.get("rot") == ROTATED_PUB
    assert "gone" not in c._trust
    c.close()


def test_trust_manifest_schema_version_is_allow_listed() -> None:
    """Unlike the config doc's catalog version, the manifest's IS a wire version (§3.1)."""
    doc = _manifest([_key_entry(KID, PUBKEY_RAW)])
    doc["schemaVersion"] = 2
    c = _client(_routes(trust_jws=sign_jws(doc, PRIVATE_PEM, KID, TYP_TRUST)))
    assert c._refresh_trust() is False
    c.close()


def test_h9_absence_is_revocation_the_trust_set_is_pruned() -> None:
    """R2-02: the v1 set only ever grew, so a compromised kid stayed trusted forever."""
    state = {"n": 0}

    def trust_body(_r: httpx.Request) -> str:
        state["n"] += 1
        if state["n"] == 1:
            keys = [_key_entry(KID, PUBKEY_RAW), _key_entry("rot", ROTATED_PUB)]
            return sign_jws(_manifest(keys, issued=NOW), PRIVATE_PEM, KID, TYP_TRUST)
        # Manifest #2: higher issuedAt, `rot` simply gone.
        return sign_jws(
            _manifest([_key_entry(KID, PUBKEY_RAW)], issued=NOW + 60),
            PRIVATE_PEM,
            KID,
            TYP_TRUST,
        )

    c = _client(_routes(trust_jws=trust_body))
    assert c._refresh_trust() is True
    assert c._trust.get("rot") == ROTATED_PUB
    assert c._refresh_trust() is True
    assert "rot" not in c._trust, "a kid absent from the new manifest must be dropped"
    assert c._trust == TRUST, "pins survive pruning"
    c.close()


def test_h9_a_pinned_key_is_never_pruned_even_by_an_empty_manifest() -> None:
    m = sign_jws(_manifest([]), PRIVATE_PEM, KID, TYP_TRUST)
    c = _client(_routes(trust_jws=m))
    assert c._refresh_trust() is True
    assert c._trust == TRUST
    c.close()


def test_c2_manifest_learned_key_cannot_sign_the_next_manifest() -> None:
    """The self-perpetuation amplifier: v1 verified manifests against the poisoned set."""
    state = {"n": 0}

    def trust_body(_r: httpx.Request) -> str:
        state["n"] += 1
        if state["n"] == 1:
            return sign_jws(
                _manifest([_key_entry(KID, PUBKEY_RAW), _key_entry("rot", ROTATED_PUB)]),
                PRIVATE_PEM,
                KID,
                TYP_TRUST,
            )
        # Signed by the LEARNED key, minting a brand-new kid.
        return sign_jws(
            _manifest(
                [_key_entry("attacker-forever-2099", ATTACKER_PUB)], issued=NOW + 60
            ),
            ROTATED_PEM,
            "rot",
            TYP_TRUST,
        )

    c = _client(_routes(trust_jws=trust_body))
    assert c._refresh_trust() is True
    assert c._refresh_trust() is False, "manifests verify against PINNED keys only"
    assert "attacker-forever-2099" not in c._trust
    c.close()


# ════════════════════════════════════════════════════════════════════════════════════
# §4 — cache integrity (R2-03 / R4-01 / R4-02 / R4-03)
# ════════════════════════════════════════════════════════════════════════════════════
def test_r4_01_hand_written_cache_grants_nothing(tmp_path) -> None:
    """The 40-line "crack": a fabricated doc with a century of grace, no signature."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token("anything")
    forged = _doc(device_id, graceUntil=NOW + 100 * 365 * DAY)
    forged["payload"]["secrets"]["soundcloud.oauth"]["value"] = "FORGED-SECRET"
    for record in (
        {"doc": forged, "lastAcceptedIssuedAt": 0},  # v1 shape
        {"v": 2, "configJws": json.dumps(forged), "lastSyncUnauthorized": False},
        {"v": 2, "configJws": "a.b.c", "lastSyncUnauthorized": False},
    ):
        with open(
            os.path.join(str(tmp_path), PRODUCT, "managed.json"), "w", encoding="utf-8"
        ) as f:
            json.dump(record, f)
        c = _client(_routes(config_status=503), store=FileStore(PRODUCT, str(tmp_path)))
        assert c.status().status == "needs-activation"
        assert c.is_licensed() is False
        assert c.is_entitled("polarisVpn") is False
        assert c.get_secret("soundcloud.oauth") is None
        c.close()


def test_r4_01_cache_persists_the_jws_and_re_verifies_it_on_load(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    jws = sign_jws(_doc(device_id), PRIVATE_PEM, KID, TYP_CONFIG)
    c = _client(_routes(config_jws=jws), store=store)
    assert c.activate_with_key("k").kind == "ok"
    assert c.status().status == "ok"
    c.close()

    raw = json.loads(
        open(os.path.join(str(tmp_path), PRODUCT, "managed.json"), encoding="utf-8").read()
    )
    assert raw["configJws"] == jws
    assert "doc" not in raw and "trustedKeys" not in raw

    # A fresh client with NO network re-verifies the stored artifact and derives state.
    c2 = _client(_routes(config_status=503), store=FileStore(PRODUCT, str(tmp_path)))
    assert c2.status().status == "ok"
    assert c2._last_accepted_issued_at == NOW
    assert c2.get_secret("soundcloud.oauth") == "REAL"
    c2.close()


def test_r4_01_a_doc_from_another_device_is_refused_on_load(tmp_path) -> None:
    """The `aud`/`deviceId` bindings are re-checked on RELOAD, not only on the wire."""
    store = FileStore(PRODUCT, str(tmp_path))
    store.get_device_id()
    store.set_token("anything")
    foreign = sign_jws(_doc("some-other-device"), PRIVATE_PEM, KID, TYP_CONFIG)
    store.write_cache(CacheRecord(configJws=foreign))
    c = _client(_routes(config_status=503), store=FileStore(PRODUCT, str(tmp_path)))
    assert c.status().status == "needs-activation"
    c.close()


def test_r4_03_anti_replay_counter_is_derived_not_stored(tmp_path) -> None:
    """Setting `lastAcceptedIssuedAt` far into the future used to block revocation."""
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    first = sign_jws(_doc(device_id, issued=NOW), PRIVATE_PEM, KID, TYP_CONFIG)
    store.set_token("t")
    store.write_cache(CacheRecord(configJws=first))

    # Plant the poisoned counter alongside the signed artifact.
    path = os.path.join(str(tmp_path), PRODUCT, "managed.json")
    raw = json.loads(open(path, encoding="utf-8").read())
    raw["lastAcceptedIssuedAt"] = NOW + 100 * 365 * DAY
    with open(path, "w", encoding="utf-8") as f:
        json.dump(raw, f)

    newer = sign_jws(
        _doc(device_id, issued=NOW + 60, licenseId="lic_REVOKED"),
        PRIVATE_PEM,
        KID,
        TYP_CONFIG,
    )
    c = _client(_routes(config_jws=newer), store=FileStore(PRODUCT, str(tmp_path)))
    assert c._last_accepted_issued_at == NOW, "derived from the JWS, not read from disk"
    assert c.refresh(force=True).applied is True
    assert c._doc is not None and c._doc.licenseId == "lic_REVOKED"
    c.close()


def test_r4_03_replaying_the_previous_doc_is_still_rejected(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    docs = [
        sign_jws(_doc(device_id, issued=NOW + 60), PRIVATE_PEM, KID, TYP_CONFIG),
        sign_jws(_doc(device_id, issued=NOW), PRIVATE_PEM, KID, TYP_CONFIG),
    ]
    state = {"n": 0}

    def body(_r: httpx.Request) -> str:
        i = min(state["n"], len(docs) - 1)
        state["n"] += 1
        return docs[i]

    c = _client(_routes(config_jws=body), store=store)
    assert c.activate_with_key("k").kind == "ok"
    assert c._last_accepted_issued_at == NOW + 60
    assert c.refresh(force=True).applied is False, "an older issuedAt must be refused"
    assert c._last_accepted_issued_at == NOW + 60
    c.close()


# ════════════════════════════════════════════════════════════════════════════════════
# §3 / R2-08 — the full claim set
# ════════════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "over,why",
    [
        ({"iss": "https://evil.example"}, "iss mismatch"),
        ({"aud": "other-product"}, "aud mismatch"),
        ({"deviceId": "someone-else"}, "device mismatch"),
        ({"schemaVersion": 0}, "non-positive schemaVersion"),
        ({"issuedAt": NOW + 10 * 365 * DAY}, "far-future issuedAt"),
        ({"expiresAt": NOW - 400 * DAY, "issuedAt": NOW - 401 * DAY}, "expired"),
        ({"graceUntil": NOW + 1000 * DAY}, "grace beyond MAX_GRACE_SECONDS"),
        ({"graceUntil": NOW}, "graceUntil before expiresAt"),
    ],
)
def test_r2_08_claim_checks(over: Dict[str, Any], why: str) -> None:
    jws = sign_jws(_doc("dev-1", **over), PRIVATE_PEM, KID, TYP_CONFIG)
    assert (
        verify_doc(jws, TRUST, expected_aud=PRODUCT, device_id="dev-1", now=NOW) is None
    ), why


def test_r2_08_clock_skew_tolerance_is_300_seconds() -> None:
    jws = sign_jws(_doc("dev-1", issued=NOW + 200), PRIVATE_PEM, KID, TYP_CONFIG)
    assert verify_doc(jws, TRUST, expected_aud=PRODUCT, device_id="dev-1", now=NOW)
    jws = sign_jws(_doc("dev-1", issued=NOW + 400), PRIVATE_PEM, KID, TYP_CONFIG)
    assert verify_doc(jws, TRUST, expected_aud=PRODUCT, device_id="dev-1", now=NOW) is None


def test_r2_08_a_valid_doc_still_verifies() -> None:
    jws = sign_jws(_doc("dev-1"), PRIVATE_PEM, KID, TYP_CONFIG)
    doc = verify_doc(jws, TRUST, expected_aud=PRODUCT, device_id="dev-1", now=NOW)
    assert doc is not None and doc.licenseId == "lic_v2"


# ════════════════════════════════════════════════════════════════════════════════════
# §4.3 / R4-04 — the monotonic time floor
# ════════════════════════════════════════════════════════════════════════════════════
def test_r4_04_clock_floor_clamps_a_rolled_back_clock() -> None:
    c = _client(_routes(config_jws=lambda r: sign_jws(
        _doc(r.headers["X-PKey-Device"]), PRIVATE_PEM, KID, TYP_CONFIG
    )))
    assert c.activate_with_key("k").kind == "ok"
    assert c._effective_now(NOW - 400 * DAY) == NOW
    assert c._effective_now(NOW + 10) == NOW + 10
    c.close()


def test_r4_04_the_gate_evaluates_at_the_floor_not_the_wall_clock() -> None:
    """`license_state` never sees a time earlier than the newest verified `issuedAt`."""
    doc = ManagedConfigDoc(
        schemaVersion=1,
        aud=PRODUCT,
        iss="key.plrs.im",
        licenseId="lic",
        deviceId="dev",
        issuedAt=NOW,
        expiresAt=NOW + 3600,
        graceUntil=NOW + 30 * DAY,
        profile=DocProfile(name="A", firstName="A", email="a@b.c", activatedAt=0),
        payload=ManagedPayload(config={}, secrets={}, entitlements={}),
    )
    rolled_back = NOW - 400 * DAY
    # Without a floor a wound-back clock reads `ok`; with one the gate uses the mark.
    assert license_state(has_token=True, doc=doc, now=rolled_back).status == "ok"
    assert (
        license_state(
            has_token=True, doc=doc, now=rolled_back, high_water_mark=NOW + 31 * DAY
        ).status
        == "expired"
    )


def test_r4_04_offline_reload_preserves_grace_but_still_clamps(tmp_path) -> None:
    """§3.1 correction 2: freshness is NOT re-checked on reload — grace survives.

    Re-asserting `expiresAt` on the reload path would delete offline operation outright,
    since a cached document is expected to be past its one-hour expiry. The signed outer
    bound is `graceUntil`, and the gate applies the monotonic floor to it.
    """
    store = FileStore(PRODUCT, str(tmp_path))
    device_id = store.get_device_id()
    store.set_token("t")
    issued = NOW - 2 * DAY  # long past `expiresAt`, comfortably inside `graceUntil`
    store.write_cache(
        CacheRecord(
            configJws=sign_jws(
                _doc(device_id, issued=issued), PRIVATE_PEM, KID, TYP_CONFIG
            )
        )
    )
    c = _client(_routes(config_status=503), store=FileStore(PRODUCT, str(tmp_path)))
    assert c.status().status == "grace", "offline grace must survive a reload"
    assert c._high_water_mark == issued
    # Winding the clock back below the floor changes nothing.
    assert c.status(now=issued - 400 * DAY).status == c.status(now=issued).status
    c.close()


def test_r4_04_the_trust_manifest_anchors_time_independently(tmp_path) -> None:
    """§4.3 as CORRECTED — the floor needs a SECOND source or it is inert.

    Derived from the config document alone, ``high_water_mark == doc.issuedAt``, which is
    below that same document's ``graceUntil`` by construction — so the floor can never
    reach the end of grace and winding the clock back still extends offline operation
    indefinitely (the residual half of R4-04). The trust manifest is signed, cached
    separately, and refreshed by default, so it advances even while the document does not.
    """
    issued = NOW - 400 * DAY  # grace ended 370 days ago
    rolled_back = issued + 60  # `sudo date`, back inside the document's window
    # A manifest verified YESTERDAY. Long past its own `expiresAt` — which is exactly what
    # a cached manifest looks like — so this also pins that the reload path stays
    # freshness-free while still anchoring time.
    manifest_jws = sign_jws(
        _manifest([_key_entry(KID, PUBKEY_RAW)], issued=NOW - DAY),
        PRIVATE_PEM,
        KID,
        TYP_TRUST,
    )

    def seeded(name: str, *, with_manifest: bool) -> FileStore:
        path = str(tmp_path / name)
        store = FileStore(PRODUCT, path)
        store.set_token("t")
        store.write_cache(
            CacheRecord(
                # The document is bound to THIS store's device id, as a real one would be.
                configJws=sign_jws(
                    _doc(store.get_device_id(), issued=issued),
                    PRIVATE_PEM,
                    KID,
                    TYP_CONFIG,
                ),
                trustJws=manifest_jws if with_manifest else None,
            )
        )
        # A fresh instance, so the client re-reads and re-verifies from disk.
        return FileStore(PRODUCT, path)

    # (a) Document only: the rollback still works. This is the defect, pinned.
    doc_only = _client(
        _routes(config_status=503), store=seeded("doconly", with_manifest=False)
    )
    assert doc_only._high_water_mark == issued
    assert doc_only.status(now=rolled_back).status == "ok"
    doc_only.close()

    # (b) With the cached manifest the floor clears `graceUntil`, so the gate refuses.
    anchored = _client(
        _routes(config_status=503), store=seeded("anchored", with_manifest=True)
    )
    assert anchored._high_water_mark == NOW - DAY
    assert anchored.status(now=rolled_back).status == "expired"
    assert not anchored.is_licensed(now=rolled_back)
    # …and the manifest's keys still loaded: freshness is NOT re-checked on reload.
    assert KID in anchored._manifest_keys
    anchored.close()

    # (c) The network path raises it too, even when /config is unreachable.
    online = _client(
        _routes(
            config_status=503,
            trust_jws=sign_jws(
                _manifest([_key_entry(KID, PUBKEY_RAW)], issued=NOW),
                PRIVATE_PEM,
                KID,
                TYP_TRUST,
            ),
        ),
        store=seeded("online", with_manifest=False),
    )
    assert online.status(now=rolled_back).status == "ok"
    online.refresh()
    assert online._high_water_mark == NOW
    assert online.status(now=rolled_back).status == "expired"
    online.close()


# ════════════════════════════════════════════════════════════════════════════════════
# §5 / R2-11 — a 304 renews freshness
# ════════════════════════════════════════════════════════════════════════════════════
def test_r2_11_a_continuously_online_client_never_drifts_into_grace(monkeypatch) -> None:
    """v1: a stable config 304s forever, so `expiresAt` froze and the gate aged out."""
    clock = {"t": NOW}
    monkeypatch.setattr(time, "time", lambda: float(clock["t"]))
    served: List[int] = []

    def config_body(r: httpx.Request) -> httpx.Response:
        served.append(clock["t"])
        return sign_jws(
            _doc(r.headers["X-PKey-Device"], issued=clock["t"]),
            PRIVATE_PEM,
            KID,
            TYP_CONFIG,
        )

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        if path == f"/{PRODUCT}/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            # A content-only ETag: unchanged config always 304s on a conditional request.
            if r.headers.get("if-none-match") == "stable-etag":
                return httpx.Response(304, headers={"etag": "stable-etag"})
            return httpx.Response(
                200, text=config_body(r), headers={"etag": "stable-etag"}
            )
        if path == f"/{PRODUCT}/config/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    assert c.activate_with_key("k").kind == "ok"
    assert len(served) == 1

    # Poll every 10 minutes for 6 hours — well past the 1h `expiresAt`.
    for _ in range(36):
        clock["t"] += 600
        c.refresh()
        assert c.status().status == "ok", "an online client must never enter grace"

    assert len(served) > 1, "the 304 must escalate to a full re-request past half-life"
    # Freshness is renewed: the derived lastVerifiedAt tracks the newest signature.
    assert c._doc is not None and c._doc.issuedAt >= clock["t"] - 1800
    c.close()


def test_r2_11_a_304_inside_the_window_does_not_re_request(monkeypatch) -> None:
    clock = {"t": NOW}
    monkeypatch.setattr(time, "time", lambda: float(clock["t"]))
    full = {"n": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        if path == f"/{PRODUCT}/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            if r.headers.get("if-none-match") == "stable-etag":
                return httpx.Response(304, headers={"etag": "stable-etag"})
            full["n"] += 1
            return httpx.Response(
                200,
                text=sign_jws(
                    _doc(r.headers["X-PKey-Device"], issued=clock["t"]),
                    PRIVATE_PEM,
                    KID,
                    TYP_CONFIG,
                ),
                headers={"etag": "stable-etag"},
            )
        if path == f"/{PRODUCT}/config/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    c.activate_with_key("k")
    assert full["n"] == 1
    clock["t"] += 60  # comfortably inside expiresAt - REFRESH_MARGIN
    c.refresh()
    assert full["n"] == 1, "a 304 well inside the window is still a cheap no-op"
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
        {"schemaVersion": "1"},
        {"aud": 7},
        {"profile": {"name": "A", "firstName": "A", "email": "a@b", "activatedAt": "0"}},
        {"issuedAt": True},
    ],
)
def test_r4_13_malformed_signed_doc_returns_none(over: Dict[str, Any]) -> None:
    jws = sign_jws(_doc("dev-1", **over), PRIVATE_PEM, KID, TYP_CONFIG)
    assert (
        verify_doc(jws, TRUST, expected_aud=PRODUCT, device_id="dev-1", now=NOW) is None
    )


def test_r4_13_license_state_never_raises_on_a_bad_window() -> None:
    """`license.py:146` used to raise `TypeError` from a tampered cache."""
    doc = ManagedConfigDoc(
        schemaVersion=1,
        aud=PRODUCT,
        iss="key.plrs.im",
        licenseId="lic",
        deviceId="dev",
        issuedAt=NOW,
        expiresAt=NOW + 3600,
        graceUntil="9999999999",  # type: ignore[arg-type]
        profile=DocProfile(name="A", firstName="A", email="a@b.c", activatedAt=0),
        payload=ManagedPayload(config={}, secrets={}, entitlements={}),
    )
    st = license_state(has_token=True, doc=doc, now=NOW)
    assert st.status == "needs-activation"


def test_r4_13_refresh_survives_a_malformed_signed_doc() -> None:
    bad = sign_jws(_doc("dev-1", issuedAt="5"), PRIVATE_PEM, KID, TYP_CONFIG)
    c = _client(_routes(config_jws=bad))
    assert c.activate_with_key("k").kind == "ok"  # no TypeError escapes refresh()
    assert c.refresh(force=True).applied is False
    assert c.status().status == "needs-activation"
    c.close()


# ════════════════════════════════════════════════════════════════════════════════════
# R4-07 / R12-13 / R4-10 — CLI + store hardening
# ════════════════════════════════════════════════════════════════════════════════════
def test_r4_07_cli_no_longer_defaults_to_a_build_gate_bypassing_version() -> None:
    from polaris_key.license import channel_for_version, is_dev_build

    assert not is_dev_build(cli_core.DEFAULT_VERSION)
    assert channel_for_version(cli_core.DEFAULT_VERSION) == "stable"
    assert cli_core.ClientOptions(product=PRODUCT).version == cli_core.DEFAULT_VERSION

    import argparse

    from polaris_key.cli.argparse_cli import build_parser

    args = build_parser().parse_args(["status", "--product", PRODUCT])
    assert not is_dev_build(args.version)
    assert isinstance(args, argparse.Namespace)


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
            "FROM-ARGV", key_stdin=True, stdin=io.StringIO("FROM-STDIN\n"), env={}, warn=warn
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


def test_r12_13_argparse_activate_reads_the_env_var(monkeypatch, capsys) -> None:
    import argparse

    from polaris_key.cli.argparse_cli import register_argparse

    seen: Dict[str, Any] = {}

    class _Fake:
        def activate_with_key(self, key: str):
            seen["key"] = key
            from polaris_key.endpoints import ActivationOk

            return ActivationOk(token="t", schemaVersion=1)

        def status(self, now=None):
            from polaris_key.license import LicenseState

            return LicenseState(status="ok")

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


def test_r4_10_symlink_guard_is_declared_honestly() -> None:
    """`getattr(os, "O_NOFOLLOW", 0)` silently became 0 on Windows."""
    assert SYMLINK_GUARD in ("O_NOFOLLOW", "lstat-precheck")
    if hasattr(os, "O_NOFOLLOW"):
        assert SYMLINK_GUARD == "O_NOFOLLOW"


def test_r4_10_lstat_precheck_refuses_a_symlink(monkeypatch, tmp_path) -> None:
    """Force the no-O_NOFOLLOW (Windows) path and prove it refuses rather than writes."""
    import polaris_key.store as store_mod

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
