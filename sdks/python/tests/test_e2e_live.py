# @pkey-feature core.backend
"""SP-65, the Python lane: a real Python client -> an example backend -> a live ``pkey dev``.

``client.backend.httpx_auth()`` sends the licence the client holds to a FastAPI and a Flask app
(``polaris_key.server``), each built on the generated config's pins and trust manifest and listening
on a loopback socket. Nothing on the wire is mocked: the Worker's router signs the document, the
backend verifies it offline, the client reads the answer.

Per framework: a valid gated call, no credential (``license_required`` and its challenge), a call
the licence is not entitled to (``not_entitled``, typed), a re-sync that fails (``pkey dev
offline``), and a stale document that the client refreshes before the call succeeds, each with the
client's own gate state alongside.

"Stale" is the backend's clock running past the document (the core's ``clock=``); the document is
old to it until the device syncs, which is what the test's transport notices to put the backend's
clock back. The Worker's verdict matrix is replayed by the ``test_server_*`` files.

Environment (CI job ``e2e-backend``; a lane starts a fresh server for this file)::

    PKEY_DEV_BASE_URL  http://127.0.0.1:<port> of ``pkey dev --builtin --auto-approve``
    PKEY_DEV_CONFIG    the module ``pkey sdk --lang python --dev --write`` generated for it

With neither set the file skips, so a plain ``pytest -q`` stays green on a machine with no server.
Naming the file on the command line asks for the live run, and a missing variable then fails; a
partly set environment always fails. The ``ok`` key has three key entries and a deactivation returns
none, so each framework gets one client for all its cases.

Named slots: SP-59's clients (Swift, Kotlin, Godot) and the Django adapter (its middleware reads
Django settings, which the core's clock does not reach, so it has no stale case here).
"""

from __future__ import annotations

import importlib.util
import os
import threading
import time
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, Iterator, List

import httpx
import pytest

from polaris_key import InMemoryStore, PolarisKeyClient
from polaris_key.core.errors import PolarisError

ENV_BASE_URL, ENV_CONFIG = "PKEY_DEV_BASE_URL", "PKEY_DEV_CONFIG"
#: Past any document's ``expiresAt`` plus the server's 300 s allowance.
AHEAD = 30 * 24 * 3600
#: The least time between two forced syncs of one client (``FORCED_SYNC_MIN_INTERVAL_SECONDS``).
FORCED_SYNC_GAP = 10.5



class Skew:
    """The backend's clock: ``seconds`` ahead until the device syncs with the Worker."""

    seconds = 0

    def now(self) -> float:
        return time.time() + self.seconds


skew = Skew()


def _named_on_command_line(config: pytest.Config) -> bool:
    here = Path(__file__).resolve()
    params = config.invocation_params
    for arg in params.args:
        path = str(arg).split("::", 1)[0]
        if path and not path.startswith("-") and (Path(params.dir) / path).resolve() == here:
            return True
    return False


@pytest.fixture(scope="module")
def dev(request: pytest.FixtureRequest) -> Dict[str, Any]:
    values = {n: os.environ.get(n, "").strip() for n in (ENV_BASE_URL, ENV_CONFIG)}
    if not any(values.values()):
        if _named_on_command_line(request.config):
            pytest.fail(f"{ENV_BASE_URL} and {ENV_CONFIG} are unset: no live pkey dev to test")
        pytest.skip(f"no live pkey dev: set {ENV_BASE_URL} and {ENV_CONFIG} (see the docstring)")
    missing = [n for n, v in values.items() if not v]
    if missing:
        pytest.fail(f"the live lane needs both variables; unset: {', '.join(missing)}")
    base = values[ENV_BASE_URL].rstrip("/")
    info = httpx.get(f"{base}/__dev/info", timeout=10.0, trust_env=False).json()
    spec = importlib.util.spec_from_file_location("polaris_config", values[ENV_CONFIG])
    assert spec is not None and spec.loader is not None
    module: ModuleType = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {"base": base, "info": info, "config": module}


def control(dev: Dict[str, Any], command: str) -> None:
    res = httpx.post(
        f"{dev['base']}/__dev/{command}",
        headers={"x-pkey-dev": "1"},
        json={},
        timeout=10.0,
        trust_env=False,
    )
    assert res.status_code == 200, f"pkey dev {command}: {res.text}"


# ── the example backends ───────────────────────────────────────────────────────────────


class Served:
    def __init__(self, origin: str, stop: Any) -> None:
        self.origin, self._stop = origin, stop

    def close(self) -> None:
        self._stop()


def fastapi_backend(config: Any) -> Served:
    import uvicorn
    from fastapi import Depends, FastAPI

    from polaris_key.server import PolarisAuth
    from polaris_key.server.fastapi import PolarisKey

    polaris = PolarisKey(config=config, trust_refresh=False, clock=skew.now)
    app = FastAPI()
    polaris.install(app)

    @app.get("/whoami")
    def whoami(auth: PolarisAuth = Depends(polaris.require_license())) -> Dict[str, Any]:
        return {"licenseId": auth.license.id, "tier": auth.license.tier}  # type: ignore[union-attr]

    @app.get("/api/export")
    def export(auth: PolarisAuth = Depends(polaris.require_entitlement("export.pdf"))) -> Dict[str, Any]:
        return {"tier": auth.license.tier}  # type: ignore[union-attr]

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started, "uvicorn did not start"
    port = server.servers[0].sockets[0].getsockname()[1]

    def stop() -> None:
        server.should_exit = True
        thread.join(10)

    return Served(f"http://127.0.0.1:{port}", stop)


def flask_backend(config: Any) -> Served:
    from flask import Flask, g
    from werkzeug.serving import make_server

    from polaris_key.server.flask import PolarisKey

    polaris = PolarisKey(config=config, trust_refresh=False, clock=skew.now)
    app = Flask(__name__)
    polaris.init_app(app)

    @app.get("/whoami")
    @polaris.require_license()
    def whoami() -> Dict[str, Any]:
        return {"licenseId": g.polaris.license.id, "tier": g.polaris.license.tier}

    @app.get("/api/export")
    @polaris.require_entitlement("export.pdf")
    def export() -> Dict[str, Any]:
        return {"tier": g.polaris.license.tier}

    server = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def stop() -> None:
        server.shutdown()
        thread.join(10)

    return Served(f"http://127.0.0.1:{server.server_port}", stop)


BACKENDS = {"fastapi": fastapi_backend, "flask": flask_backend}


# ── the scenario, once per framework ───────────────────────────────────────────────────


class Rig:
    def __init__(self, dev: Dict[str, Any], tmp: Path, framework: str) -> None:
        self.dev = dev
        self.backend = BACKENDS[framework](dev["config"].CONFIG)
        base = dev["base"]

        def on_response(response: httpx.Response) -> None:
            # The device reached the Worker for a document: it is current again.
            if str(response.request.url).startswith(base) and "/license/" in str(response.request.url):
                if response.is_success:
                    skew.seconds = 0

        self.worker_http = httpx.Client(trust_env=False, event_hooks={"response": [on_response]})
        self.client = PolarisKeyClient.create(
            **{k: v for k, v in dev["config"].CONFIG.items() if k != "update"},
            version="1.0.0",
            store=InMemoryStore(f"{dev['info']['product']}-e2e-{framework}"),
            client=self.worker_http,
            config_dir=str(tmp / framework / "config"),
            data_dir=str(tmp / framework / "data"),
            cache_dir=str(tmp / framework / "cache"),
            state_dir=str(tmp / framework / "state"),
            fingerprint=False,
            backend={"origins": [self.backend.origin]},
        )
        result = self.client.license.activate_with_key(dev["info"]["keys"]["ok"])
        assert getattr(result, "kind", None) == "ok", result
        self.api = httpx.Client(
            trust_env=False, auth=self.client.backend.httpx_auth(), base_url=self.backend.origin
        )
        self.plain = httpx.Client(trust_env=False, base_url=self.backend.origin)

    def gate(self) -> str:
        return str(self.client.license.status().status)

    def close(self) -> None:
        for c in (self.api, self.plain):
            c.close()
        self.client.close()
        self.worker_http.close()
        self.backend.close()
        skew.seconds = 0


@pytest.fixture(scope="module", params=sorted(BACKENDS))
def rig(request: pytest.FixtureRequest, dev: Dict[str, Any], tmp_path_factory: pytest.TempPathFactory) -> Iterator[Rig]:
    r = Rig(dev, tmp_path_factory.mktemp("pkey-e2e"), request.param)
    yield r
    r.close()


def test_cases_run_in_order(rig: Rig, dev: Dict[str, Any]) -> None:
    # One test, in order: the cases share the client (three key entries per key) and its forced-sync
    # throttle, so they cannot be reordered or run apart.
    # 1. a valid gated call
    res = rig.api.get("/whoami")
    assert res.status_code == 200, res.text
    assert res.json()["licenseId"]
    assert rig.gate() == "ok"

    # 2. no credential
    res = rig.plain.get("/whoami")
    assert res.status_code == 401
    assert res.headers["www-authenticate"].startswith('PKey-License realm="')
    assert res.headers["www-authenticate"].endswith('error="license_required"')
    assert res.json()["code"] == "license_required"

    # 3. not entitled: typed, with the response status; the licence itself is fine
    with pytest.raises(PolarisError) as err:
        rig.api.get("/api/export")
    assert err.value.code == "not_entitled"
    assert err.value.status == 403
    assert rig.gate() == "ok"

    # 4. a failed re-sync hands back the backend's license_stale
    skew.seconds = AHEAD
    control(dev, "offline")
    try:
        res = rig.api.get("/whoami")
        assert (res.status_code, res.json()["code"]) == (401, "license_stale")
        assert skew.seconds == AHEAD  # the Worker was never reached
    finally:
        control(dev, "online")
        skew.seconds = 0
    assert rig.gate() == "ok"

    # 5. a stale document refreshes, then the call succeeds
    time.sleep(FORCED_SYNC_GAP)
    skew.seconds = AHEAD
    raw = rig.plain.get("/whoami", headers=rig.client.backend.headers())
    assert (raw.status_code, raw.json()["code"]) == (401, "license_stale")
    res = rig.api.get("/whoami")
    assert res.status_code == 200, res.text
    assert skew.seconds == 0
    assert rig.gate() == "ok"
