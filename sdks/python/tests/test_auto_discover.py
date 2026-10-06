# @pkey-feature core.discover
"""``create(auto_discover=…)`` (SDK parity pass, SP-P04): discovery is the default when the host
pins no ``expected_services``, and best-effort."""

from __future__ import annotations

import httpx

import polaris_key
from polaris_key import PolarisKeyClient
from polaris_key.devices.store import InMemoryStore

from helpers import BASE_URL, PRODUCT, TRUST, discovery_doc, mock_client


def _create(handler, **kw):
    return polaris_key.create(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url=BASE_URL,
        store=InMemoryStore(PRODUCT),
        client=mock_client(handler),
        **kw,
    )


def _discovery(seen):
    def handler(r: httpx.Request) -> httpx.Response:
        seen.append(r.url.path)
        if r.url.path.endswith("/.well-known/polaris.json"):
            return httpx.Response(200, json=discovery_doc(license=True, config=False, update=True))
        return httpx.Response(404)

    return handler


def test_create_discovers_by_default() -> None:
    seen = []
    c = _create(_discovery(seen))
    assert seen == [f"/{PRODUCT}/.well-known/polaris.json"]
    assert c.capabilities()["update"]["enabled"] is True
    assert c.capabilities()["config"]["enabled"] is False
    c.close()


def test_pinned_services_skip_discovery() -> None:
    seen = []
    c = _create(_discovery(seen), expected_services=["license"])
    assert seen == []
    c.close()


def test_auto_discover_can_be_forced_either_way() -> None:
    seen = []
    c = _create(_discovery(seen), expected_services=["license"], auto_discover=True)
    assert len(seen) == 1 and c.capabilities()["update"]["enabled"] is True
    c.close()
    seen.clear()
    c = _create(_discovery(seen), auto_discover=False)
    assert seen == []
    c.close()


def test_unreachable_discovery_keeps_the_default() -> None:
    def down(_r):
        raise httpx.ConnectError("offline")

    c = _create(down)
    assert c.capabilities()["license"]["enabled"] is True
    c.close()


def test_module_create_is_the_classmethod() -> None:
    assert polaris_key.create == PolarisKeyClient.create
