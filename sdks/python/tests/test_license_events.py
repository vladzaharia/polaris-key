# @pkey-feature license.deactivate core.sync identity.devicecode
"""One ``license`` event per deactivation, whichever entry point the host called, and a failing
listener is logged instead of swallowed.

``client.license.deactivate()`` (the kit's sign-out verb calls it) used to change the gate with
no event at all; only the root's ``client.deactivate()`` published it. The licence client now
raises the change itself, so the root, the sub-client, ``identity.sign_out()`` and
``deauthorize_device(<this device>)`` each emit exactly one ``license`` event and call
``on_change`` exactly once.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, List

import pytest

from helpers import make_client, routes, sign_config, sign_license

ENTRY_POINTS: List[Any] = [
    ("license.deactivate", lambda c: c.license.deactivate()),
    ("deactivate", lambda c: c.deactivate()),
    ("identity.sign_out", lambda c: c.identity.sign_out()),
    ("deauthorize_device(self)", lambda c: c.deauthorize_device(c.core.device_id)),
]


def _activated(**kw: Any) -> Any:
    c = make_client(
        routes(
            license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
            config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
        ),
        expected_services=["license", "config", "identity"],
        **kw,
    )
    assert c.license.activate_with_key("pkey_" + "K" * 40).kind == "ok"
    assert c.status().status == "ok"
    return c


@pytest.mark.parametrize("name,deactivate", ENTRY_POINTS, ids=[n for n, _ in ENTRY_POINTS])
def test_one_license_event_per_deactivate_from_any_entry_point(
    name: str, deactivate: Callable[[Any], None]
) -> None:
    """The acceptance line: one licence event per deactivate from either entry point."""
    changes: List[Any] = []
    c = _activated(on_change=changes.append)
    events: List[Any] = []
    c.subscribe(events.append, kinds=["license"])
    changes.clear()
    deactivate(c)
    assert [(e["status"], e["previous"]) for e in events] == [("needs-activation", "ok")], name
    assert [s.status for s in changes] == ["needs-activation"], name
    c.close()


def test_a_failing_listener_is_logged_and_the_others_still_run(caplog: pytest.LogCaptureFixture) -> None:
    c = _activated()
    seen: List[Any] = []

    def broken(_e: Any) -> None:
        raise RuntimeError("host bug")

    c.subscribe(broken, kinds=["license"])
    c.subscribe(seen.append, kinds=["license"])
    with caplog.at_level(logging.ERROR, logger="polaris_key"):
        c.license.deactivate()
    assert len(seen) == 1, "the next listener still ran"
    records = [r for r in caplog.records if r.name == "polaris_key"]
    assert len(records) == 1
    assert "'license' event listener" in records[0].getMessage()
    assert records[0].exc_info is not None and isinstance(records[0].exc_info[1], RuntimeError)
    c.close()


def test_a_failing_on_change_is_logged_and_never_breaks_a_sync(caplog: pytest.LogCaptureFixture) -> None:
    def on_change(_state: Any) -> None:
        raise RuntimeError("host bug")

    c = make_client(
        routes(
            license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
            config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
        ),
        on_change=on_change,
    )
    with caplog.at_level(logging.ERROR, logger="polaris_key"):
        assert c.license.activate_with_key("pkey_" + "K" * 40).kind == "ok"  # syncs
        c.deactivate()
    messages = [r.getMessage() for r in caplog.records if r.name == "polaris_key"]
    assert len(messages) == 2 and all("on_change" in m for m in messages)
    assert c.status().status == "needs-activation"
    c.close()


def test_a_failing_boot_stage_callback_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    c = _activated()

    def on_stage(_state: Any, _emits: Any) -> None:
        raise RuntimeError("host bug")

    with caplog.at_level(logging.ERROR, logger="polaris_key"):
        out = c.boot(on_stage=on_stage, auto_confirm=False)
    assert out.ready
    assert any("on_stage" in r.getMessage() for r in caplog.records if r.name == "polaris_key")
    c.close()
