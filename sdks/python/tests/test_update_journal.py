# @pkey-feature devices.report
"""The update-health journal and the report's ``gate``, ``outlet``, ``updates`` and
``packInstalls`` keys (P6-03; SDK parity pass §3.13, SP-P03)."""

from __future__ import annotations

import json
import os

import httpx

from polaris_key.core.update_journal import MAX_UPDATE_EVENTS, UpdateJournal

from helpers import PRODUCT, TOKEN, make_client, routes, sign_license


def _ctx():
    return {"outlet": "direct", "channel": "stable", "release": "1.0.0"}


def test_an_event_has_the_workers_shape(tmp_path) -> None:
    j = UpdateJournal(str(tmp_path), _ctx, clock=lambda: 1_700_000_000)
    e = j.record("update_downloaded", release="1.1.0", from_release="1.0.0")
    assert e is not None
    assert set(e) == {"eventId", "event", "deliverable", "release", "fromRelease", "outlet", "channel", "at"}
    assert e["deliverable"] == "app" and e["outlet"] == "direct" and e["at"] == 1_700_000_000
    assert e["eventId"].endswith("-update_downloaded")


def test_the_journal_is_persisted(tmp_path) -> None:
    UpdateJournal(str(tmp_path), _ctx).record("update_confirmed", release="1.1.0")
    again = UpdateJournal(str(tmp_path), _ctx)
    assert [e["event"] for e in again.events()] == ["update_confirmed"]
    assert oct(os.stat(tmp_path / "update-events.json").st_mode & 0o777) == "0o600"


def test_invalid_entries_are_not_recorded(tmp_path) -> None:
    j = UpdateJournal(str(tmp_path), _ctx)
    assert j.record("not_an_event", release="1.0.0") is None
    assert j.record("update_applied", release="has spaces") is None
    # An outlet that is not an outlet id is reported as `unknown`, as the Worker would show it.
    assert j.record("update_applied", release="1.0.0", outlet="Not An Id")["outlet"] == "unknown"


def test_at_most_sixteen_go_per_report_and_sent_ones_are_dropped(tmp_path) -> None:
    j = UpdateJournal(str(tmp_path), _ctx)
    for i in range(20):
        j.record("update_applied", release=f"1.0.{i}")
    pending = j.pending()
    assert len(pending) == MAX_UPDATE_EVENTS
    assert pending[0]["release"] == "1.0.0"
    j.mark_sent([e["eventId"] for e in pending])
    assert [e["release"] for e in j.events()] == ["1.0.16", "1.0.17", "1.0.18", "1.0.19"]


def test_offered_is_recorded_once_per_release(tmp_path) -> None:
    j = UpdateJournal(str(tmp_path), _ctx)
    assert j.offered("1.2.0") is not None
    assert j.offered("1.2.0") is None
    assert j.offered("1.3.0") is not None
    assert [e["release"] for e in j.events()] == ["1.2.0", "1.3.0"]


def test_the_report_carries_gate_and_updates_and_marks_them_sent() -> None:
    bodies = []
    base = routes(license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]))

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/devices/report":
            bodies.append(json.loads(r.content))
            return httpx.Response(200, json={"ok": True})
        return base(r)

    c = make_client(handler)
    c.license.activate_with_key("k")
    c.update_journal.record("update_confirmed", release="1.0.0")
    assert c.devices.report() is True
    body = bodies[-1]
    assert body["gate"] == {"status": "ok"}
    assert [e["event"] for e in body["updates"]] == ["update_confirmed"]
    assert c.update_journal.events() == []
    # Nothing pending: the key is left out.
    c.devices.report()
    assert "updates" not in bodies[-1]
    c.close()


def test_a_refused_report_keeps_the_events() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    c = make_client(handler)
    c._tokens.set(TOKEN)
    c.update_journal.record("update_confirmed", release="1.0.0")
    assert c.devices.report() is False
    assert len(c.update_journal.events()) == 1
    c.close()


def test_in_memory_store_never_writes_to_the_state_directory() -> None:
    c = make_client(lambda r: httpx.Response(404))
    assert c.core.local_state_dir() is None
    assert c.update_journal._file.path is None
    c.close()


def test_an_explicit_state_dir_persists(tmp_path) -> None:
    c = make_client(lambda r: httpx.Response(404), state_dir=str(tmp_path))
    assert c.core.local_state_dir() == os.path.join(str(tmp_path), PRODUCT)
    c.close()
