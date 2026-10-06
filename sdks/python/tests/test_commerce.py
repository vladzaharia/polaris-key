# @pkey-feature commerce.receipt
"""``client.commerce`` (P6-01; SDK parity pass §3.9, SP-P06) against a mock answering like the
Worker. The wire conversation itself is replayed from ``commerce-claim.json``."""

from __future__ import annotations

import json

import httpx
import pytest

from polaris_key.commerce import ClaimOk, hidden_on
from polaris_key.core.caps import Supported
from polaris_key.core.errors import PolarisError

from helpers import PRODUCT, TOKEN, make_client

BINDING = "F8606AE6-C6AF-419A-A7CA-125107444036"
PRODUCTS = [{"store": "steam", "productId": "1234560", "flag": "extras.diceSkins", "deliverable": "app"}]
SERVICES = ["license", "config", "release", "distribution"]


def _client(handler, **kw):
    c = make_client(handler, expected_services=kw.pop("services", SERVICES), **kw)
    c._tokens.set(TOKEN)
    return c


def test_binding_is_lowercased_and_kept() -> None:
    seen = []

    def h(r):
        seen.append(r)
        return httpx.Response(200, json={"bindingId": BINDING, "products": PRODUCTS + [{"bad": 1}]})

    c = _client(h)
    b = c.commerce.binding()
    assert b.bindingId == BINDING.lower() == c.commerce.binding_id
    assert len(b.products) == 1 and b.products[0].flag == "extras.diceSkins"
    assert seen[0].url.path == f"/{PRODUCT}/distribution/commerce/binding"
    assert seen[0].headers["authorization"] == f"Bearer {TOKEN}"
    c.close()


def test_a_binding_without_a_uuid_is_bad_response() -> None:
    c = _client(lambda r: httpx.Response(200, json={"bindingId": "nope"}))
    with pytest.raises(PolarisError) as e:
        c.commerce.binding()
    assert e.value.code == "bad_response"
    c.close()


def test_claim_steam_posts_the_ticket_and_syncs() -> None:
    bodies = []

    def h(r):
        if r.url.path.endswith("/distribution/commerce/claim"):
            bodies.append(json.loads(r.content))
            return httpx.Response(200, json={"ok": True, "store": "steam", "productId": "1234560", "flag": "extras.diceSkins", "deliverable": "app", "state": "active", "granted": True, "changed": True})
        return httpx.Response(404)

    c = _client(h)
    synced = []
    c.commerce._sync = lambda: synced.append(1)
    r = c.commerce.claim_steam("14000000ab", 1234560)
    assert isinstance(r, ClaimOk) and r.granted and r.synced
    assert bodies == [{"store": "steam", "ticket": "14000000ab", "dlcAppId": "1234560"}]
    assert synced == [1]
    # The plain claim never syncs.
    assert c.commerce.claim("steam", {"ticket": "ab", "dlcAppId": "1"}).synced is False
    assert synced == [1]
    c.close()


@pytest.mark.parametrize(
    "body,kind,code,reason",
    [
        ({"error": {"code": "forbidden"}, "reason": "not_owned"}, "not-owned", "forbidden", "not_owned"),
        ({"error": {"code": "attestation_required"}}, "attestation-required", "attestation_required", None),
        ({"error": {"code": "not_entitled"}, "reason": "no_license"}, "refused", "not_entitled", "no_license"),
        ({"error": {"code": "forbidden"}, "reason": "binding_mismatch"}, "refused", "forbidden", "binding_mismatch"),
    ],
)
def test_refusals_keep_code_and_reason(body, kind, code, reason) -> None:
    c = _client(lambda r: httpx.Response(403, json=body))
    r = c.commerce.claim("play", {"productId": "sku", "purchaseToken": "t"})
    assert (r.kind, r.code, r.reason) == (kind, code, reason)
    c.close()


def test_bad_payloads_are_refused_before_any_request() -> None:
    c = _client(lambda r: (_ for _ in ()).throw(AssertionError("no request")))
    for store, payload in (("steam", {"ticket": "x"}), ("play", {}), ("app-store", {}), ("epic", {})):
        with pytest.raises(PolarisError) as e:
            c.commerce.claim(store, payload)
        assert e.value.code == "invalid-options"
    c.close()


def test_needs_license_and_distribution_and_a_token() -> None:
    c = _client(lambda r: httpx.Response(404), services=["license"])
    with pytest.raises(PolarisError) as e:
        c.commerce.binding()
    assert e.value.code == "service-unavailable"
    c.close()
    c = make_client(lambda r: httpx.Response(404), expected_services=SERVICES)
    with pytest.raises(PolarisError) as e:
        c.commerce.binding()
    assert e.value.code == "no-token"
    assert isinstance(c.supports("commerce.receipt"), Supported)
    c.close()


def test_hidden_on_apple_outlets() -> None:
    assert hidden_on("x", [{"store": "steam", "flag": "x"}]) is True
    assert hidden_on("x", [{"store": "steam", "flag": "x"}, {"store": "app-store", "flag": "x"}]) is False
    assert hidden_on("grant", [{"store": "steam", "flag": "x"}]) is False
