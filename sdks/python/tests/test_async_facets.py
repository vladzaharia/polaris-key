# @pkey-feature connect.links
"""Structure of the async client's facets: the explicit methods sit on the class they belong to."""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

from polaris_key import aio
from polaris_key.connect.links import CloudLinks
from polaris_key.connect.nearby import NearbyRequest


def _explicit(cls: type) -> set:  # type: ignore[type-arg]
    return {n for n, v in vars(cls).items() if not n.startswith("_") and inspect.isfunction(v)}


class _Connect:
    def __init__(self, on: bool) -> None:
        self.on = on

    def inter_account(self) -> bool:
        return self.on


def _links(on: bool = True) -> Any:
    return aio._AsyncLinks(CloudLinks(None, _Connect(on)))  # type: ignore[arg-type]


def test_links_register_and_answer_without_a_coroutine() -> None:
    async def run() -> None:
        links = _links()
        seen: list = []
        off = links.on_link(seen.append)
        assert callable(off) and not inspect.isawaitable(off)
        for fn in list(links._target._on_link):
            fn("session")
        assert seen == ["session"]
        off()
        assert links._target._on_link == []
        assert _links(True).inter_account() is True
        assert _links(False).inter_account() is False

    asyncio.run(run())


def test_links_blocking_calls_stay_coroutines() -> None:
    async def run() -> None:
        pending = _links().list()
        assert inspect.isawaitable(pending)
        coroutine: Any = pending
        coroutine.close()

    asyncio.run(run())


def test_each_facet_keeps_its_own_methods() -> None:
    assert _explicit(aio._AsyncLinks) == {"on_link", "inter_account"}
    assert _explicit(aio._AsyncNearbyRequest) == set()
    assert _explicit(aio._AsyncNearbyApprover) == {"status"}


def test_explicit_facet_methods_exist_on_the_sync_facet() -> None:
    for facet, sync in ((aio._AsyncLinks, CloudLinks), (aio._AsyncNearbyRequest, NearbyRequest)):
        for name in _explicit(facet):
            assert callable(getattr(sync, name)), (facet.__name__, name)
    for name in ("on_approvers", "on_result", "on_record", "on_close"):
        assert callable(getattr(NearbyRequest, name)), name
