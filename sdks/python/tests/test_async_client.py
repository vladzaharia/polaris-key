# @pkey-feature core.sync identity.devicecode
"""``AsyncPolarisKeyClient`` (SDK parity pass §2.3, SP-P05): the shared core off the event loop,
native-asyncio sign-in waits that cancel at once, and async progress and event streams."""

from __future__ import annotations

import asyncio

import httpx
import pytest

import polaris_key
from polaris_key import AsyncClient
from polaris_key.devices.store import InMemoryStore

from helpers import BASE_URL, PRODUCT, TOKEN, TRUST, mock_client, routes, sign_config, sign_license


def _handler(poll_answers=None):
    base = routes(
        license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
        config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
    )
    answers = list(poll_answers or [])

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("/identity/auth/device/start"):
            return httpx.Response(200, json={"deviceCode": "dc", "userCode": "AB-CD", "verificationUri": "https://k/d", "verificationUriComplete": "https://k/d?c", "expiresIn": 600, "interval": 1})
        if r.url.path.endswith("/identity/auth/device/poll"):
            body = answers.pop(0) if len(answers) > 1 else (answers[0] if answers else {"status": "pending"})
            return httpx.Response(200, json=body)
        return base(r)

    return handler


async def _create(handler, **kw):
    return await AsyncClient.create(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url=BASE_URL,
        store=InMemoryStore(PRODUCT),
        client=mock_client(handler),
        expected_services=kw.pop("services", ["license", "config", "identity"]),
        **kw,
    )


def test_methods_are_coroutines_over_the_shared_core() -> None:
    async def main():
        c = await _create(_handler())
        r = await c.license.activate_with_key("k")
        assert r.kind == "ok"
        assert (await c.status()).status == "ok"
        assert await c.config.get_config("run.concurrency") == 4
        out = await c.boot(auto_confirm=False)
        assert out.ready
        assert c.supports("license.gate").supported  # cheap reads stay synchronous
        await c.aclose()

    asyncio.run(main())


def test_wait_for_sign_in_is_native_and_cancellable(monkeypatch) -> None:
    real_sleep = asyncio.sleep

    async def fast_sleep(_s):
        await real_sleep(0)

    async def main():
        c = await _create(_handler([{"status": "pending"}, {"status": "ready", "token": TOKEN, "identity": {"name": "Ada"}}]))
        monkeypatch.setattr(polaris_key.aio.asyncio, "sleep", fast_sleep)
        prompt = await c.identity.begin_sign_in()
        r = await c.identity.wait_for_sign_in(prompt)
        assert r.status == "ready" and r.identity.name == "Ada"
        await c.aclose()

    asyncio.run(main())


def test_cancelling_the_wait_stops_polling() -> None:
    async def main():
        c = await _create(_handler([{"status": "pending"}]))
        prompt = await c.identity.begin_sign_in()
        task = asyncio.ensure_future(c.identity.wait_for_sign_in(prompt))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await c.aclose()

    asyncio.run(main())


def test_event_stream_yields_changes() -> None:
    async def main():
        c = await _create(_handler())
        got = []

        async def consume():
            async for e in c.events.stream(kinds=["license"]):
                got.append(e)
                return

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0)
        await c.license.activate_with_key("k")
        await asyncio.wait_for(task, 5)
        assert got[0]["status"] == "ok"
        await c.aclose()

    asyncio.run(main())


def test_pack_progress_stream_yields_engine_events() -> None:
    async def main():
        c = await _create(_handler())
        from polaris_key.update.packs.engine import PackProgress

        got = []

        async def consume():
            async for p in c.update.packs.progress(until_done=True):
                got.append(p.phase)

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0)
        packs = c.sync_client.update.packs
        for phase in ("download", "done"):
            for fn in list(packs._listeners):
                fn(PackProgress("p", phase, 1, 1))
        await asyncio.wait_for(task, 5)
        assert got == ["download", "done"]
        await c.aclose()

    asyncio.run(main())
