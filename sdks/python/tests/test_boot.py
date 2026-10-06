# @pkey-feature update.bootguard ui.stages
"""``client.boot()``, ``ensure_activated()`` and the app build's boot guard (SDK parity pass §3.4,
§3.15; SP-P08). The guard's decision and the confirmation timing come from
``conformance/corpus/v2/stage-matrix.json`` (``guardCases``, ``maxFailedBoots``,
``confirmCases``); the guard here persists the count and acts on that decision."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from polaris_key.update.bootguard import NO_PREVIOUS, BootGuard
from polaris_key.core.update_journal import UpdateJournal

from helpers import PRODUCT, TOKEN, discovery_doc, make_client, routes, sign_config, sign_license

MATRIX = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "stage-matrix.json").read_text()
)


def _journal(tmp_path):
    return UpdateJournal(str(tmp_path), lambda: {"outlet": "direct", "channel": "stable", "release": "1.0.0"})


@pytest.mark.parametrize("case", MATRIX["guardCases"], ids=lambda c: c["name"])
def test_the_guard_acts_on_every_guard_case(case, tmp_path) -> None:
    g = BootGuard(str(tmp_path), lambda: "1.0.0")
    g._file.save({"version": "1.0.0", "failedBoots": case["input"]["failedBoots"], "confirmed": False})
    g.staged = lambda: case["input"]["staged"]
    g.rollback = lambda: True
    out = g.mark_boot_attempt()
    want = {"none": "ok", "apply-staged": "applied", "roll-back": "rolled-back"}[case["expect"]["action"]]
    assert out.result == want


def test_unconfirmed_launches_count_up_to_a_rollback(tmp_path) -> None:
    j = _journal(tmp_path)
    g = BootGuard(str(tmp_path), lambda: "1.1.0", journal=j)
    g._file.save({"version": "1.0.0", "failedBoots": 0, "confirmed": True})
    rolled = []
    g.rollback = lambda: rolled.append(1) or True
    for _ in range(MATRIX["maxFailedBoots"]):
        assert g.mark_boot_attempt().result == "ok"
    out = g.mark_boot_attempt()
    assert out.result == "rolled-back" and out.previous == "1.0.0" and rolled == [1]
    assert [e["event"] for e in j.events()] == ["update_reverted", "boot_rolled_back"]
    assert j.events()[1]["release"] == "1.0.0" and j.events()[1]["fromRelease"] == "1.1.0"


def test_without_a_previous_build_it_reports_no_previous_once(tmp_path) -> None:
    j = _journal(tmp_path)
    g = BootGuard(str(tmp_path), lambda: "1.0.0", journal=j)
    for _ in range(MATRIX["maxFailedBoots"]):
        g.mark_boot_attempt()
    a = g.mark_boot_attempt()
    b = g.mark_boot_attempt()
    assert a.kind == b.kind == "rollback-unavailable" and a.result == "ok"
    events = j.events()
    assert [e["event"] for e in events] == ["boot_rolled_back"] and events[0]["code"] == NO_PREVIOUS


def test_confirming_a_new_build_records_update_confirmed_once(tmp_path) -> None:
    j = _journal(tmp_path)
    g = BootGuard(str(tmp_path), lambda: "1.1.0", journal=j)
    g._file.save({"version": "1.0.0", "failedBoots": 0, "confirmed": True})
    g.mark_boot_attempt()
    assert g.confirm_boot() is True
    assert g.failed_boots() == 0
    g.mark_boot_attempt()
    assert g.confirm_boot() is False
    events = j.events()
    assert [e["event"] for e in events] == ["update_confirmed"]
    assert (events[0]["release"], events[0]["fromRelease"]) == ("1.1.0", "1.0.0")


def test_the_guard_persists_across_clients(tmp_path) -> None:
    BootGuard(str(tmp_path), lambda: "1.0.0").mark_boot_attempt()
    assert BootGuard(str(tmp_path), lambda: "1.0.0").failed_boots() == 1


# ── client.boot() ───────────────────────────────────────────────────────────────────
def _ok():
    return routes(
        license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
        config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
    )


def test_boot_reaches_ready_for_an_activated_device() -> None:
    c = make_client(_ok(), expected_services=["license", "config"])
    c._tokens.set(TOKEN)
    stages = []
    out = c.boot(on_stage=lambda s, e: stages.append(s.stage), auto_confirm=False)
    assert out.ready and out.status == "ok"
    assert stages[:5] == ["shell", "guard", "sync", "gate", "decide"]
    assert stages[-1] == "ready"
    assert c.update.guard.failed_boots() == 1  # unconfirmed until the host confirms
    c.update.confirm_boot()
    assert c.update.guard.failed_boots() == 0
    c.close()


def test_boot_waits_for_activation_and_confirms_at_once() -> None:
    c = make_client(_ok(), expected_services=["license", "config"])
    out = c.boot()
    assert out.outcome == "waiting" and out.needs_activation
    assert {"type": "waiting", "status": "needs-activation"} in out.emits
    assert c.update.guard.failed_boots() == 0  # `waiting` confirms now
    c.close()


def test_boot_registers_an_open_product_without_license() -> None:
    seen = {}
    c = make_client(routes(config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]), seen=seen),
                    expected_services=["config"])
    out = c.boot(auto_confirm=False)
    assert f"/{PRODUCT}/devices/register" in seen["paths"]
    assert out.ready and out.status == "not-applicable"
    c.close()


def test_ensure_activated_enrols_only_when_asked() -> None:
    c = make_client(_ok(), expected_services=["license", "config"])
    assert c.ensure_activated().kind == "needs-activation"
    a = c.ensure_activated(enroll=True)
    assert a.kind == "enrolled" and a.status == "ok"
    c.close()


def test_boot_discovers_when_nothing_is_pinned() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("polaris.json"):
            return httpx.Response(200, json=discovery_doc(license=True, config=True))
        return _ok()(r)

    c = make_client(handler)
    c._tokens.set(TOKEN)
    assert c.boot(auto_confirm=False).ready
    assert c._discovery_doc is not None
    c.close()


def test_boot_goes_offline_when_unreachable_and_allowed() -> None:
    def down(_r):
        raise httpx.ConnectError("offline")

    c = make_client(down, expected_services=["license"])
    c._tokens.set(TOKEN)
    out = c.boot(auto_confirm=False)
    # No verified licence was ever cached, so the gate needs activation even offline.
    assert out.outcome == "waiting"
    c.close()
