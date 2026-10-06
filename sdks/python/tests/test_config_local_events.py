# @pkey-feature config.resolve core.sync
"""``config.local`` (persisted settings) and ``client.events`` (SDK parity pass §3.11, SP-P11)."""

from __future__ import annotations

import httpx
import pytest

from polaris_key.config.client import validate_value
from polaris_key.core.errors import PolarisError

from helpers import PRODUCT, make_client, routes, sign_config, sign_license


def _ok(**lic):
    return routes(
        license_jws=lambda r: sign_license(r.headers["X-PKey-Device"], **lic),
        config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
    )


CATALOG = {
    "schemaVersion": 4,
    "entries": [
        {"key": "ui.theme", "kind": "config", "schema": {"type": "string", "enum": ["light", "dark"]}},
        {"key": "run.limit", "kind": "config", "schema": {"type": "integer", "minimum": 1, "maximum": 8}},
    ],
}


def test_set_persists_across_clients(tmp_path) -> None:
    c = make_client(_ok(), state_dir=str(tmp_path))
    c.license.activate_with_key("k")
    c.config.set("ui.theme", "dark")
    assert c.config.get_config("ui.theme") == "dark" and c.config.get_config_source("ui.theme") == "local"
    c.close()
    again = make_client(_ok(), state_dir=str(tmp_path))
    assert again.config.get_config("ui.theme") == "dark"
    again.config.clear("ui.theme")
    assert "ui.theme" not in again.config.local_values()
    again.close()


def test_enforced_keys_refuse_a_local_value() -> None:
    c = make_client(_ok())
    c.license.activate_with_key("k")
    with pytest.raises(PolarisError) as e:
        c.config.set("run.concurrency", 9)
    assert e.value.code == "managed_by_admin"
    c.close()


def test_set_validates_against_the_catalog() -> None:
    c = make_client(_ok())
    with pytest.raises(PolarisError) as e:
        c.config.set("ui.theme", "neon", catalog=CATALOG)
    assert e.value.code == "bad_request"
    c.config.set("ui.theme", "light", catalog=CATALOG)
    with pytest.raises(PolarisError):
        c.config.set("x", float("nan"))
    c.close()


def test_validate_value_subset() -> None:
    assert validate_value(3, {"type": "integer", "minimum": 1}) is None
    assert validate_value(0, {"type": "integer", "minimum": 1}) is not None
    assert validate_value(True, {"type": "integer"}) is not None
    assert validate_value(["a", 1], {"type": "array", "items": {"type": "string"}}) is not None
    assert validate_value({"a": 1}, {"type": "object", "additionalProperties": False}) is not None
    assert validate_value("abc", {"type": "string", "pattern": "^a"}) is None


def test_events_for_config_license_and_entitlements() -> None:
    state = {"revoked": False}
    base = _ok()

    def handler(r: httpx.Request) -> httpx.Response:
        if state["revoked"] and r.url.path.endswith(("/license/document", "/config/document", "/license/token")):
            return httpx.Response(401, json={"error": {"code": "unauthorized"}})
        return base(r)

    c = make_client(handler)
    seen = []
    c.subscribe(seen.append)
    theme = []
    c.config.setting("ui.theme").subscribe(theme.append)
    c.license.activate_with_key("k")
    kinds = [e.kind for e in seen]
    assert "license" in kinds and "entitlement" in kinds and "config" in kinds
    lic = next(e for e in seen if e.kind == "license")
    assert (lic["previous"], lic["status"]) == ("needs-activation", "ok")
    seen.clear()
    c.config.set("ui.theme", "solarized")
    assert [(e.kind, e["key"], e["value"]) for e in seen] == [("config", "ui.theme", "solarized")]
    assert theme and theme[-1]["value"] == "solarized"
    seen.clear()
    c.sync(force=True)
    assert seen == []  # nothing changed, nothing re-emitted
    state["revoked"] = True
    c.sync(force=True)
    ent = [e for e in seen if e.kind == "entitlement" and e["name"] == "polarisVpn"]
    assert ent and ent[0]["value"] is None and ent[0]["previous"] is True  # G11
    assert any(e.kind == "license" and e["status"] == "revoked" for e in seen)
    c.close()


def test_deactivate_emits_license() -> None:
    c = make_client(_ok())
    c.license.activate_with_key("k")
    seen = []
    c.events.on("license", seen.append)
    c.deactivate()
    assert seen and seen[-1]["status"] == "needs-activation"
    c.close()


def test_a_failing_listener_does_not_break_the_others() -> None:
    c = make_client(_ok())
    got = []
    c.subscribe(lambda e: 1 / 0)
    c.subscribe(got.append, kinds=["config"])
    c.config.set("ui.theme", "x")
    assert len(got) == 1
    c.close()
