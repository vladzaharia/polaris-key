# @pkey-feature ui.cli.portal
"""``core.portal`` in the Python SDK (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md).

Every row of ``conformance/corpus/v2/portal-matrix.json`` (``parseCases`` with the cold-start fixed
point through ``portal.json``, ``linkCases``), then the edges the corpus cannot carry: what a
tampered ``portal.json`` does, and the terminal kit's own ``portal_url`` over the same rows.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict

import pytest

from polaris_key.constants_generated import PORTAL_MATRIX_VERSION
from polaris_key.core.portal import PORTAL_MEMBER_FILE, PortalStore, parse_portal, portal_link
from polaris_key.ui.terminal.screens import ensure_portal, portal_url

# tests/ -> python/ -> sdks/ -> repo root
MATRIX = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "portal-matrix.json").read_text("utf-8")
)

ACTIVATE = "https://polaris.locker/activate?product=djdl"
BASE = "https://key.plrs.im"


def test_the_version_is_the_one_the_sdk_was_built_against() -> None:
    assert MATRIX["portalMatrixVersion"] == PORTAL_MATRIX_VERSION


@pytest.mark.parametrize("row", MATRIX["parseCases"], ids=lambda r: r["name"])
def test_parse(row: Dict[str, Any], tmp_path: Path) -> None:
    assert parse_portal(row["core"]) == row["expect"]
    # The fixed point: what was stored reads back to itself on a cold start.
    store = PortalStore("djdl", BASE, str(tmp_path))
    store.accept({"core": row["core"]})
    assert store.current() == row["expect"]
    cold = PortalStore("djdl", BASE, str(tmp_path))
    cold.load_cached()
    assert cold.current() == row["expect"]


@pytest.mark.parametrize("row", MATRIX["linkCases"], ids=lambda r: r["name"])
def test_link(row: Dict[str, Any]) -> None:
    assert portal_link(row["served"], row["portal"], row["baseUrl"], row["product"]) == row["expect"]
    # The kit's own resolution, over a client that holds the row's member.
    client = SimpleNamespace(
        product=row["product"], core=SimpleNamespace(base_url=row["baseUrl"]), portal=lambda: row["portal"]
    )
    assert portal_url(client, row["served"]) == row["expect"]


def test_a_client_without_portal_is_the_legacy_guess() -> None:
    bare = SimpleNamespace(product="djdl", core=SimpleNamespace(base_url=BASE + "/"))
    assert portal_url(bare) == ACTIVATE


def test_no_cache_dir_keeps_the_member_in_memory() -> None:
    store = PortalStore("djdl", BASE, None)
    store.accept({"core": {"portal": {"enabled": False}}})
    assert store.current() == {"enabled": False}
    store.accept({"core": {}})
    assert store.current() is None


def test_a_discovery_without_the_member_clears_the_memory_and_the_file(tmp_path: Path) -> None:
    store = PortalStore("djdl", BASE, str(tmp_path))
    store.accept({"core": {"portal": {"enabled": False}}})
    assert (tmp_path / PORTAL_MEMBER_FILE).exists()
    store.accept({"core": {}})
    assert store.current() is None and not (tmp_path / PORTAL_MEMBER_FILE).exists()


def test_this_sessions_discovery_wins_over_a_late_load(tmp_path: Path) -> None:
    PortalStore("djdl", BASE, str(tmp_path)).accept({"core": {"portal": {"enabled": False}}})
    store = PortalStore("djdl", BASE, str(tmp_path))
    store.accept({"core": {"portal": {"enabled": True, "activate": ACTIVATE}}})
    store.load_cached()
    assert store.current() == {"enabled": True, "activate": ACTIVATE}


@pytest.mark.parametrize(
    "body",
    [
        {"v": 1, "product": "other", "baseUrl": BASE, "portal": {"enabled": False}},
        {"v": 1, "product": "djdl", "baseUrl": "https://other.example", "portal": {"enabled": False}},
        {"v": 2, "product": "djdl", "baseUrl": BASE, "portal": {"enabled": False}},
        {"v": 1, "product": "djdl", "baseUrl": BASE, "portal": {"enabled": True, "activate": "http://evil.example/x"}},
        {"v": 1, "product": "djdl", "baseUrl": BASE, "portal": {"enabled": False, "activate": ACTIVATE}},
        "not an object",
    ],
)
def test_a_file_that_does_not_read_back_to_itself_is_deleted(body: Any, tmp_path: Path) -> None:
    path = tmp_path / PORTAL_MEMBER_FILE
    path.write_text(json.dumps(body), "utf-8")
    store = PortalStore("djdl", BASE, str(tmp_path))
    store.load_cached()
    assert store.current() is None and not path.exists()


def test_a_file_that_is_not_json_is_deleted(tmp_path: Path) -> None:
    path = tmp_path / PORTAL_MEMBER_FILE
    path.write_text("{nope", "utf-8")
    store = PortalStore("djdl", BASE, str(tmp_path))
    store.load_cached()
    assert store.current() is None and not path.exists()


def test_ensure_portal_discovers_once_when_the_session_has_neither() -> None:
    calls = []
    client = SimpleNamespace(
        portal=lambda: None,
        discovery=lambda: None,
        core=SimpleNamespace(local_only=False),
        try_discover=lambda: calls.append(1),
    )
    ensure_portal(client)
    assert calls == [1]


@pytest.mark.parametrize("held", ["portal", "discovery", "local"])
def test_ensure_portal_does_not_dial_when_it_need_not(held: str) -> None:
    calls = []
    client = SimpleNamespace(
        portal=lambda: {"enabled": False} if held == "portal" else None,
        discovery=lambda: {} if held == "discovery" else None,
        core=SimpleNamespace(local_only=held == "local"),
        try_discover=lambda: calls.append(1),
    )
    ensure_portal(client)
    assert calls == []
