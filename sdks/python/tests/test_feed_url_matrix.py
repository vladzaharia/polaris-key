# @pkey-feature update.feeds
"""``client.update.feed_url()`` against every row of the shared
``conformance/corpus/v2/feed-url-matrix.json`` (plans/SP-00.md D5, ``update.feeds``).

Each row's endpoint set becomes discovery's ``update.endpoints`` (a set with no templates is a
product with Update off); the row's input maps onto ``feed_url``'s keywords and the answer must
be the row's ``url``, or the typed :class:`~polaris_key.core.caps.Unsupported` with the row's
reason.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest

from polaris_key.core.caps import Unsupported

from helpers import PRODUCT, make_client

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v2/feed-url-matrix.json
_MATRIX_PATH = (
    Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "feed-url-matrix.json"
)
_MATRIX: Dict[str, Any] = json.loads(_MATRIX_PATH.read_text(encoding="utf-8"))
_ROWS: List[Dict[str, Any]] = _MATRIX["rows"]


def _client(endpoints: Dict[str, str]):
    doc = {
        "product": PRODUCT,
        "protocolVersion": 4,
        "services": {
            "update": (
                {"enabled": True, "endpoints": dict(endpoints)}
                if endpoints
                else {"enabled": False}
            )
        },
    }
    c = make_client(lambda r: httpx.Response(200, json=doc), expected_services=["update"])
    c.discover()
    return c


def test_the_matrix_is_present() -> None:
    assert _MATRIX["feedUrlMatrixVersion"] == 1 and _ROWS
    assert set(_MATRIX["kinds"]) == {"appcast", "winsparkle", "velopack", "appInstaller", "zsync"}


@pytest.mark.parametrize("row", _ROWS, ids=[r["name"] for r in _ROWS])
def test_feed_url_row(row: Dict[str, Any]) -> None:
    c = _client(_MATRIX["endpointSets"][row["endpoints"]])
    try:
        i = row["input"]
        got = c.update.feed_url(
            i["kind"],
            channel=i.get("channel"),
            velopack_channel=i.get("velopackChannel"),
            build_id=i.get("buildId"),
        )
    finally:
        c.close()
    want = row["expect"]
    if "url" in want:
        assert got == want["url"], row["name"]
    else:
        assert isinstance(got, Unsupported), f"{row['name']}: {got!r}"
        assert got.reason == want["unsupported"]
