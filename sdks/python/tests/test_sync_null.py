# @pkey-feature sync.scenarios
"""A synced JSON ``null`` is a value, not "no value": the TypeScript separates ``null`` from ``undefined``,
and the Python machine separates ``None`` from its private ``_ABSENT``."""

from __future__ import annotations

from typing import Any, Dict

from polaris_key.cloud_sync.machine import _ABSENT, CloudSyncMachine, apply_setting_op, relaunch


def _machine(subject: Any = "sub_alice") -> Any:
    ids = iter(["c_000000000000000client1", "c_000000000000000client2"])
    opts: Dict[str, Any] = {
        "product": "demo",
        "catalog": {"settings": [{"key": "a.num", "route": "synced", "scope": "user", "policy": "lastWrite"}]},
        "document": {"values": {"open.key": "doc"}},
        "now": 1760000000000,
        "contacted": True,
        "subject": subject,
        "encryption": "server",
        "newClientId": lambda: next(ids),
    }
    return opts, CloudSyncMachine(opts)


def test_apply_setting_op_null_versus_clear() -> None:
    assert apply_setting_op("lastWrite", 1, {"op": "set", "value": None}) is None
    assert apply_setting_op("lastWrite", 1, {"op": "clear"}) is _ABSENT
    assert apply_setting_op("lastWrite", _ABSENT, {"op": "set", "value": 2}) == 2


def test_null_is_read_back_and_clear_falls_to_the_document() -> None:
    opts, m = _machine()
    assert m.set("open.key", None) == {"ok": True}
    assert m.get("open.key") == {"value": None, "from": "pending"}
    m.flush()
    assert m.journal()["sub_alice"]["pending"][0]["value"] is None
    assert m.get("open.key") == {"value": None, "from": "pending"}
    assert m.clear("open.key") == {"ok": True}
    assert m.get("open.key") == {"value": "doc", "from": "document"}


def test_null_survives_a_relaunch_on_a_signed_out_device() -> None:
    opts, m = _machine(subject=None)
    m.set("open.key", None)
    m.flush()
    assert m.get("open.key") == {"value": None, "from": "device"}
    m = relaunch(m, opts)
    assert m.get("open.key") == {"value": None, "from": "device"}
    m.clear("open.key")
    m.flush()
    assert m.get("open.key") == {"value": "doc", "from": "document"}


def test_a_null_cloud_value_is_a_value() -> None:
    opts, m = _machine()
    m.take_requests()
    m.receive(
        {
            "status": 200,
            "body": {
                "encryption": "server",
                "serverNow": 1760000000000,
                "cursor": 1,
                "changes": [{"setting": "open.key", "value": None, "version": 1}],
            },
        }
    )
    assert m.get("open.key") == {"value": None, "from": "cloud"}
