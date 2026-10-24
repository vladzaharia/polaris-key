# @pkey-feature server.config
"""``server_client()`` (framework drop-ins §5.7, SP-63): the normal client for a container. A
stable device id, the key from PKEY_LICENSE_KEY, a memory store, no device report, a background
refresh and the usual config read."""

from __future__ import annotations

import threading
from typing import Dict, List

import httpx
import pytest

from polaris_key import server_client
from polaris_key.core.errors import PolarisError
from polaris_key.devices.store import InMemoryStore

from helpers import BASE_URL, PRODUCT, TOKEN, TRUST, mock_client, routes, sign_config, sign_license

DEVICE = "srvDeviceId0123456789abcdefABCDE"
ENV = {"PKEY_DEVICE_ID": DEVICE, "PKEY_LICENSE_KEY": "pkey_djdl_server"}


def plane(seen: Dict[str, List[str]], **kw):
    base = routes(
        license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
        config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
        seen=seen,
        **kw,
    )

    def handler(r: httpx.Request) -> httpx.Response:
        seen.setdefault("devices", []).append(r.headers.get("X-PKey-Device", ""))
        return base(r)

    return handler


def start(seen, env=None, **kw):
    handler = plane(seen)
    return server_client(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url=BASE_URL,
        client=mock_client(handler),
        expected_services=["license", "config"],
        trust_refresh=False,
        env=ENV if env is None else env,
        **kw,
    )


def test_reads_config_under_the_env_id_and_key() -> None:
    seen: Dict[str, List[str]] = {}
    with start(seen) as c:
        assert c.core.device_id == DEVICE
        assert c.config.get("run.concurrency", 1) == 4
    assert {d for d in seen["devices"] if d} == {DEVICE}
    assert f"/{PRODUCT}/license/activate" in seen["paths"]


def test_makes_no_device_report() -> None:
    log: Dict[str, List[str]] = {"paths": []}
    handler = plane(log)
    with server_client(
        product_slug=PRODUCT, version="1.0.0", trust=TRUST, base_url=BASE_URL,
        client=mock_client(handler), expected_services=["license", "config"],
        trust_refresh=False, env=ENV,
    ) as c:
        c.sync(force=True)
        assert c.devices.report() is False
    assert not [p for p in log["paths"] if p.endswith("/devices/report")]
    assert any(p.endswith("/license/activate") for p in log["paths"])


def test_id_file_survives_a_restart(tmp_path) -> None:
    f = tmp_path / "state" / "device-id"
    env = {"PKEY_DEVICE_ID_FILE": str(f), "PKEY_LICENSE_KEY": "k"}
    with start({}, env) as first:
        ident = first.core.device_id
    assert len(ident) == 32 and f.read_text().strip() == ident
    with start({}, env) as second:
        assert second.core.device_id == ident


def test_token_is_held_in_memory_only() -> None:
    with start({}) as c:
        assert isinstance(c.core.store, InMemoryStore)
        assert c.core.store.status().backend == "memory"


def test_refreshes_in_the_background() -> None:
    log: Dict[str, List[str]] = {"paths": []}
    handler = plane(log)
    c = server_client(
        product_slug=PRODUCT, version="1.0.0", trust=TRUST, base_url=BASE_URL,
        client=mock_client(handler), expected_services=["license", "config"],
        trust_refresh=False, env=ENV, refresh_interval_seconds=0.05,
    )
    try:
        for _ in range(100):
            if sum(p.endswith("/config/document") for p in log["paths"]) >= 3:
                break
            threading.Event().wait(0.05)
        assert sum(p.endswith("/config/document") for p in log["paths"]) >= 3
    finally:
        c.close()


@pytest.mark.parametrize(
    "env",
    [{"PKEY_LICENSE_KEY": "k"}, {"PKEY_DEVICE_ID": DEVICE}, {"PKEY_DEVICE_ID": "short", "PKEY_LICENSE_KEY": "k"}],
)
def test_refuses_without_a_stable_id_or_key(env) -> None:
    seen: Dict[str, List[str]] = {}
    with pytest.raises(PolarisError) as e:
        start(seen, env)
    assert e.value.code == "invalid-options"
    assert seen.get("paths", []) == []


def test_malformed_id_file(tmp_path) -> None:
    f = tmp_path / "id"
    f.write_text("nope\n")
    with pytest.raises(PolarisError) as e:
        start({}, {"PKEY_DEVICE_ID_FILE": str(f), "PKEY_LICENSE_KEY": "k"})
    assert e.value.code == "invalid-options"


def test_raises_the_servers_code_when_the_key_is_refused() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "device_limit", "limit": 1})

    with pytest.raises(PolarisError) as e:
        server_client(
            product_slug=PRODUCT, version="1.0.0", trust=TRUST, base_url=BASE_URL,
            client=mock_client(handler), expected_services=["license", "config"],
            trust_refresh=False, env=ENV,
        )
    assert e.value.code == "device_limit"
