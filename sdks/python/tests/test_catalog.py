"""``config.fetch_schema()`` — the catalog fetch (P1b-07, PARITY §5.3 ``config.schema``).

The conversation itself is pinned by the config-schema-fetch transcript (replayed in
tests/test_transcripts.py). This file holds the failures a transcript cannot record: a dropped
connection, a body that is not a catalog, a product without Config (D-21: not even probed), and
local-only mode. Every one of them is ``None``, never a raise — the catalog is unsigned and
diagnostic.
"""

# @pkey-feature config.schema

from __future__ import annotations

from typing import List

import httpx

from polaris_key.devices.store import InMemoryStore
from polaris_key.local import create_local_client

from helpers import BASE_URL, PRODUCT, TRUST, make_client

CATALOG = {
    "schemaVersion": 3,
    "entries": [
        {
            "key": "ui.theme",
            "kind": "config",
            "category": "Interface",
            "label": "Theme",
            "description": "Theme.",
            "schema": {"type": "string"},
        }
    ],
}


def _recording(respond) -> tuple:
    calls: List[str] = []

    def handler(r: httpx.Request) -> httpx.Response:
        calls.append(str(r.url))
        return respond(r)

    return handler, calls


def test_returns_the_catalog_without_a_credential() -> None:
    handler, calls = _recording(lambda r: httpx.Response(200, json=CATALOG))
    c = make_client(handler)
    assert c.config.fetch_schema() == CATALOG
    assert calls == [f"{BASE_URL}/{PRODUCT}/config/schema"]
    c.close()


def test_a_refusal_is_none() -> None:
    c = make_client(lambda r: httpx.Response(404, json={"error": "not_found"}))
    assert c.config.fetch_schema() is None
    c.close()


def test_a_network_failure_is_none_not_a_raise() -> None:
    def boom(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=r)

    c = make_client(boom)
    assert c.config.fetch_schema() is None
    c.close()


def test_a_body_that_is_not_a_catalog_is_none() -> None:
    for respond in (
        lambda r: httpx.Response(200, text="<html>"),
        lambda r: httpx.Response(200, json={"entries": []}),
        lambda r: httpx.Response(200, json=[CATALOG]),
        lambda r: httpx.Response(200, json={"schemaVersion": True, "entries": []}),
    ):
        c = make_client(respond)
        assert c.config.fetch_schema() is None
        c.close()


def test_a_product_without_config_is_none_and_never_probed() -> None:
    handler, calls = _recording(lambda r: httpx.Response(200, json=CATALOG))
    c = make_client(handler, expected_services=["license"])
    assert c.config.fetch_schema() is None
    assert calls == []
    c.close()


def test_local_only_is_none() -> None:
    c = create_local_client(
        product_slug=PRODUCT, version="1.0.0", trust=TRUST, store=InMemoryStore(PRODUCT)
    )
    assert c.config.fetch_schema() is None
