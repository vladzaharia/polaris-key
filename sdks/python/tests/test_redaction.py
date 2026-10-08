# @pkey-feature license.activate license.enroll devices.register identity.devicecode
"""No public result's ``repr`` (or ``str``) carries the device token.

``print(result)`` after ``activate_with_key`` used to print ``ActivationOk(token='pkeyt_…')``,
and so did a log line, a traceback's locals or a REPL echo. Every token field is now
``repr=False``: ``ActivationOk``, ``RegisterOk`` and ``Reacquired``, and the results that nest
them (``ActivationOutcome.detail``, ``BootOutcome``). The sweep below also fails a future result
type that adds a credential field without hiding it.
"""

from __future__ import annotations

import dataclasses
import importlib
import pkgutil
from typing import Any, List

import httpx

import polaris_key
from polaris_key.core.token import Reacquired

from helpers import BASE_URL, PRODUCT, TOKEN, discovery_doc, make_client

#: Field names that hold a credential. A dataclass field with one of these names must be hidden.
CREDENTIAL_FIELDS = {"token", "deviceCode", "device_token", "deviceToken", "access_token", "refresh_token"}


def _plane(r: httpx.Request) -> httpx.Response:
    p = f"/{PRODUCT}"
    path = r.url.path
    if path in (f"{p}/license/activate", f"{p}/license/enroll", f"{p}/license/token"):
        return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
    if path == f"{p}/devices/register":
        return httpx.Response(200, json={"token": TOKEN, "deviceId": "d" * 32})
    if path == f"{p}/identity/auth/device/start":
        return httpx.Response(
            200,
            json={
                "deviceCode": "dc_" + "x" * 40,
                "userCode": "WDJB-MJHT",
                "verificationUri": "https://key.example/device",
                "verificationUriComplete": "https://key.example/device?code=WDJB-MJHT",
                "expiresIn": 600,
                "interval": 1,
            },
        )
    if path == f"{p}/identity/auth/device/poll":
        return httpx.Response(200, json={"status": "ready", "token": TOKEN, "identity": {"name": "Ada"}})
    if path == f"{p}/.well-known/polaris.json":
        return httpx.Response(200, json=discovery_doc(license=True, config=True, identity=True))
    return httpx.Response(404)


def _results() -> List[Any]:
    c = make_client(_plane, expected_services=["license", "config", "identity"])
    out: List[Any] = [
        c.license.activate_with_key("pkey_" + "K" * 40),
        c.license.enroll(),
        c.devices.register(),
        c.register(),
        c.devices.request_registration(),
        c.ensure_activated(),
        c.boot(decide=False, auto_confirm=False),
        c.get_sync_state(),
        c.current_device(),
        c.sync(),
    ]
    prompt = c.identity.begin_sign_in()
    out += [prompt, c.identity.poll_sign_in(prompt)]
    c.close()
    out.append(Reacquired(TOKEN, "reacquire"))
    return out


def test_no_public_result_repr_contains_the_device_token() -> None:
    """The acceptance line: no public result's repr contains ``pkeyt_``."""
    results = _results()
    assert results[0].token == TOKEN  # the field is still there for code that needs it
    for r in results:
        assert "pkeyt_" not in repr(r), type(r).__name__
        assert "pkeyt_" not in str(r), type(r).__name__
        assert "dc_" not in repr(r), type(r).__name__


def test_every_credential_field_in_the_package_is_hidden_from_repr() -> None:
    """A static sweep: every dataclass under ``polaris_key`` with a credential-named field keeps
    it out of the repr, so a new result type cannot reintroduce the leak."""
    leaks = []
    for mod in pkgutil.walk_packages(polaris_key.__path__, "polaris_key."):
        if ".ui.qt" in mod.name or mod.name.endswith("textual_app"):
            continue  # optional GUI extras; they hold no credentials
        try:
            m = importlib.import_module(mod.name)
        except ImportError:
            continue
        for obj in vars(m).values():
            if isinstance(obj, type) and dataclasses.is_dataclass(obj) and obj.__module__ == m.__name__:
                for f in dataclasses.fields(obj):
                    if f.name in CREDENTIAL_FIELDS and f.repr:
                        leaks.append(f"{obj.__module__}.{obj.__qualname__}.{f.name}")
    assert leaks == []
