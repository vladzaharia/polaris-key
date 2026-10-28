# @pkey-feature connect.protocol
"""``TrustManager.accept_peer`` (CC-10.5; WIRE-CONTRACT-V5 §15.8): a trust manifest a peer pushed is
verified against the usable pins and tombstones only, must be newer than the held one, raises the clock
floor, and answers the refusal reason. Mirrors Node's ``acceptPeer`` in ``core/trust.ts``."""

from __future__ import annotations

import threading
from typing import Any

from helpers import KID, NOW, PRODUCT, PUBKEY_RAW, ROTATED_PEM, ROTATED_PUB, key_entry, make_client, routes, sign_manifest

ALT = "alt-test-2026"
PINS = {KID: PUBKEY_RAW, ALT: ROTATED_PUB}


def _client(**kw: Any):
    return make_client(routes(), pinned_keys=kw.pop("pinned_keys", PINS), **kw)


def _newer(issued: int, **over: Any) -> str:
    return sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=issued, **over)


def test_a_newer_manifest_signed_by_a_usable_pin_is_applied() -> None:
    c = _client()
    r = c._trust.accept_peer(_newer(NOW))
    assert (r.applied, r.reason) == (True, None)
    assert c._trust.last_issued_at == NOW
    # It raised the clock floor.
    assert c._trust._ctx._floor == NOW


def test_it_must_be_newer_than_the_held_one() -> None:
    c = _client()
    assert c._trust.accept_peer(_newer(NOW + 10)).applied
    for issued in (NOW + 10, NOW + 5):
        r = c._trust.accept_peer(_newer(issued))
        assert (r.applied, r.reason) == (False, "not_newer")
    assert c._trust.last_issued_at == NOW + 10
    assert c._trust.accept_peer(_newer(NOW + 11)).applied


def test_a_manifest_that_does_not_verify_is_invalid_and_changes_nothing() -> None:
    c = _client()
    assert c._trust.accept_peer(_newer(NOW)).applied
    before = c._trust.effective
    for bad in (
        "not.a.jws",
        "",
        # signed by a key that is not pinned
        sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=NOW + 50, pem=ROTATED_PEM, kid="stranger"),
        # bound to another product
        _newer(NOW + 50, aud="other-product"),
    ):
        r = c._trust.accept_peer(bad)
        assert (r.applied, r.reason) == (False, "invalid")
    assert c._trust.last_issued_at == NOW and c._trust.effective == before


def test_a_revoked_pin_no_longer_signs_a_pushed_manifest() -> None:
    c = _client()
    revoke = sign_manifest(
        [key_entry(KID, PUBKEY_RAW, "revoked"), key_entry(ALT, ROTATED_PUB)], issued=NOW, pem=ROTATED_PEM, kid=ALT
    )
    r = c._trust.accept_peer(revoke)
    assert r.applied is True
    assert c._trust.revoked_pins == [KID] and KID not in c._trust.effective
    assert c._trust.pin_revocations == {KID: revoke}
    # The tombstoned pin's signature is no longer enough.
    r = c._trust.accept_peer(_newer(NOW + 100))
    assert (r.applied, r.reason) == (False, "invalid")


def test_the_discovered_tier_is_replaced_not_merged() -> None:
    c = _client()
    extra = key_entry("extra-2026", ROTATED_PUB)
    assert c._trust.accept_peer(sign_manifest([key_entry(KID, PUBKEY_RAW), extra], issued=NOW)).applied
    assert "extra-2026" in c._trust.discovered
    assert c._trust.accept_peer(_newer(NOW + 1)).applied
    assert "extra-2026" not in c._trust.discovered


def test_concurrent_pushes_apply_at_most_once_per_issued_at() -> None:
    c = _client()
    results = []

    def push() -> None:
        results.append(c._trust.accept_peer(_newer(NOW + 1)).applied)

    threads = [threading.Thread(target=push) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert results.count(True) == 1


def test_the_result_names_no_key_material() -> None:
    c = _client()
    r = c._trust.accept_peer(_newer(NOW))
    assert PRODUCT not in repr(r) and "pkey" not in repr(r)
