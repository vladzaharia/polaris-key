# @pkey-feature sync.settings config.sync
"""The Cloud Sync settings API on the Python client (U-06.10). Mirrors ``cloudSyncSettings.test.ts``.

``config.set`` and ``clear`` go through the machine while a principal is held, ``setting(k).sync()``,
``on_config_change`` with ``origin``, ``client.cloud_sync.status()`` / ``flush()`` and the ``cloudSync``
event, the one-time import of the legacy local file, and the identity subject driving the machine.
Security (S6): every way the machine leaves a principal forgets the key ring and deletes the synced
data, and the licence state is never touched.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Iterator, List

import httpx
import pytest
from helpers import BASE_URL, PRODUCT, TOKEN, make_client
from test_cloud_sync_host import SUBJECT, Rig, World, state_file

from polaris_key.client import PolarisKeyClient
from polaris_key.core.errors import PolarisError
from polaris_key.devices.store import InMemoryStore


@pytest.fixture
def rigs(tmp_path: Path) -> Iterator[Callable[..., Rig]]:
    made: List[Rig] = []

    def build(w: World, **kw: Any) -> Rig:
        r = Rig(w, tmp_path / f"s{len(made)}", **kw)
        made.append(r)
        return r

    yield build
    for r in made:
        r.client.close()


def identity(c: PolarisKeyClient, change: str, subject: Any = None) -> None:
    extra = {"released": False} if change == "signed_out" else {"subject": subject}
    c.events.emit("identity", change=change, **extra)


def signed_in(rigs: Callable[..., Rig], w: World) -> Rig:
    """A ring (root held), the host started and SUBJECT signed in through the identity event, the way a
    real sign-in reaches the client."""
    r = rigs(w)
    r.client.keyring.create()
    r.host.start()
    identity(r.client, "signed_in", SUBJECT)
    r.client.cloud_sync.flush()
    return r


def locked_ring(r: Rig) -> bool:
    return bool(r.client.keyring.codec.locked)


def pushed(w: World) -> bool:
    return any(p.get("mutations") for p in w.pushes())


def lock_theme(r: Rig, value: str = "light") -> None:
    """The signed document enforces ``theme``."""
    r.host._deps.document = lambda: {"values": {"theme": value}, "locked": ["theme"]}
    r.host.note_document_refreshed()
    r.host.touch()


# ── config.set and clear through the machine ─────────────────────────────────────────────────────


def test_set_applies_reports_origin_and_sync_goes_pending_then_synced(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    c = r.client
    changes: List[Any] = []
    c.config.on_config_change("theme", changes.append)
    s = c.config.setting("theme")
    s.set("dark")
    assert c.config.get("theme", "x") == "dark"
    assert c.config.get_config_source("theme") == "local"
    assert s.sync() == "pending"
    assert [(e["value"], e["origin"]) for e in changes] == [("dark", "local")]
    c.cloud_sync.flush()
    assert s.sync() == "synced"
    assert pushed(w)
    # The fake Worker serves nothing back, so the pull after the push reads the value as gone.
    assert [e["origin"] for e in changes][:1] == ["local"]


def test_clear_goes_through_the_machine_and_reports_a_local_origin(rigs: Callable[..., Rig]) -> None:
    r = signed_in(rigs, World())
    c = r.client
    c.config.set("theme", "dark")
    changes: List[Any] = []
    c.config.on_config_change("theme", changes.append)
    c.config.setting("theme").clear()
    assert c.config.setting("theme").value is None
    assert [(e["value"], e["previous"], e["origin"]) for e in changes] == [(None, "dark", "local")]
    assert c.config.setting("theme").sync() == "pending"


def test_set_refuses_in_machine_order_bad_request_for_an_invalid_value(rigs: Callable[..., Rig]) -> None:
    r = signed_in(rigs, World())
    with pytest.raises(PolarisError) as e:
        r.client.config.set("theme", 5)
    assert e.value.code == "bad_request"
    assert r.client.config.get("theme", "none") == "none"


def test_set_refuses_managed_by_admin_for_a_key_the_operator_locked(rigs: Callable[..., Rig]) -> None:
    r = signed_in(rigs, World())
    lock_theme(r)
    with pytest.raises(PolarisError) as e:
        r.client.config.set("theme", "dark")
    assert e.value.code == "managed_by_admin"
    with pytest.raises(PolarisError) as e2:
        r.client.config.clear("theme")
    assert e2.value.code == "managed_by_admin"


def test_without_a_principal_set_keeps_the_legacy_local_file_and_sync_is_local(
    rigs: Callable[..., Rig],
) -> None:
    r = rigs(World())
    c = r.client
    c.config.set("theme", "dark")
    assert c.config.get("theme", "x") == "dark"
    assert c.config.setting("theme").sync() == "local"
    assert c.config.local_values() == {"theme": "dark"}


# ── client.cloud_sync ────────────────────────────────────────────────────────────────────────────


def test_status_and_flush_answer_and_the_typed_na_names_a_product_without_sync(
    rigs: Callable[..., Rig], tmp_path: Path
) -> None:
    w = World()
    r = signed_in(rigs, w)
    c = r.client
    assert c.cloud_sync.status()["pending"] == 0
    seen: List[str] = []
    c.events.subscribe(lambda e: seen.append(e["type"]), ("cloudSync",))
    c.config.set("theme", "dark")
    s = c.cloud_sync.flush()
    assert s["pending"] == 0
    assert "change" in seen

    off = make_client(
        w,
        store=InMemoryStore(PRODUCT, device_id="DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB"),
        state_dir=str(tmp_path / "off"),
        expected_services=["license"],
    )
    try:
        with pytest.raises(Exception, match="sync"):
            off.cloud_sync.status()
        with pytest.raises(Exception, match="sync"):
            off.cloud_sync.flush()
    finally:
        off.close()


def test_status_is_local_before_cloud_sync_has_started(rigs: Callable[..., Rig]) -> None:
    r = rigs(World())
    assert r.client.cloud_sync.status() == {"state": "local", "pending": 0}


# ── import_local of the legacy local file ────────────────────────────────────────────────────────


def test_import_local_runs_once(rigs: Callable[..., Rig], tmp_path: Path) -> None:
    w = World()
    first = Rig(w, tmp_path / "shared")
    first.client.config.set("theme", "legacy")
    first.client.close()
    r = Rig(w, tmp_path / "shared")
    try:
        r.client.keyring.create()
        identity(r.client, "signed_in", SUBJECT)
        r.client.cloud_sync.flush()
        assert r.m("persist")["imported"] is True
        assert r.client.config.get("theme", "x") == "legacy"
        calls: List[Any] = []
        with r.host.locked() as m:
            real = m.import_local
            m.import_local = lambda v: (calls.append(v), real(v))[1]  # type: ignore[method-assign]
        r.host.import_local_once({"theme": "other"})
        # The host passes an empty offer once the install has imported; nothing new enters.
        assert calls == [{}]
        assert r.client.config.get("theme", "x") == "legacy"
    finally:
        r.client.close()


# ── the identity subject drives the machine; leaving forgets the ring (S6) ───────────────────────


def sign_out_hook(r: Rig) -> None:
    r.client._cloud_sync_api.before_sign_out()


def test_a_sign_out_flushes_forgets_the_ring_then_offers_sign_in(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    order: List[str] = []
    r.client.events.subscribe(lambda e: order.append(e["type"]), ("cloudSync",))
    r.client.config.set("theme", "dark")
    assert not locked_ring(r)
    sign_out_hook(r)
    assert locked_ring(r)
    assert "signedOut" in order
    assert order[-1] == "signInOffered"
    assert pushed(w)


def test_account_required_forgets_the_ring_and_offers_sign_in_with_the_url(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    offers: List[Any] = []
    r.client.events.subscribe(
        lambda e: offers.append(e["signInUrl"]) if e["type"] == "signInOffered" else None, ("cloudSync",)
    )
    w.push = lambda _b: httpx.Response(
        403, json={"error": {"code": "account_required", "signInUrl": f"{BASE_URL}/signin"}}
    )
    r.client.config.set("theme", "dark")
    r.client.cloud_sync.flush()
    assert locked_ring(r)
    assert offers == [f"{BASE_URL}/signin"]


def test_a_forget_that_fails_is_logged_away_and_does_not_replace_the_sign_out(
    rigs: Callable[..., Rig], monkeypatch: pytest.MonkeyPatch
) -> None:
    w = World()
    r = signed_in(rigs, w)
    logged: List[str] = []
    r.client._cloud_sync_api._log = logged.append

    def boom() -> None:
        raise OSError("disk")

    monkeypatch.setattr(r.client.keyring, "forget", boom)
    sign_out_hook(r)  # does not raise
    assert logged == ["cloud sync: the key ring pin could not be removed"]
    assert not any("disk" in m for m in logged)


def test_a_purge_that_fails_is_logged_and_the_ring_is_still_forgotten(
    rigs: Callable[..., Rig], monkeypatch: pytest.MonkeyPatch
) -> None:
    r = signed_in(rigs, World())
    logged: List[str] = []
    r.client._cloud_sync_api._log = logged.append

    def boom() -> None:
        raise OSError("disk")

    monkeypatch.setattr(r.host, "purge", boom)
    sign_out_hook(r)
    assert locked_ring(r)
    assert logged == ["cloud sync: the synced data could not be deleted"]


def test_an_identity_sign_out_with_no_state_held_does_nothing_and_fails_nothing(
    rigs: Callable[..., Rig],
) -> None:
    r = rigs(World())
    identity(r.client, "signed_out")
    r.client.cloud_sync.flush()
    assert r.client.cloud_sync.status()["state"] == "local"
    sign_out_hook(r)
    r.client._cloud_sync_api.on_deactivated()


def test_never_touches_licence_state(rigs: Callable[..., Rig], monkeypatch: pytest.MonkeyPatch) -> None:
    w = World()
    r = signed_in(rigs, w)
    c = r.client
    store = c._tokens._store if hasattr(c._tokens, "_store") else None
    calls: List[str] = []
    monkeypatch.setattr(c.license, "wipe_local", lambda *a, **k: calls.append("wipe_local"))
    monkeypatch.setattr(c.license, "deactivate", lambda *a, **k: calls.append("deactivate"))
    if store is not None:
        monkeypatch.setattr(store, "clear_token", lambda *a, **k: calls.append("clear_token"))
        monkeypatch.setattr(store, "clear_cache", lambda *a, **k: calls.append("clear_cache"))
    token_before = c._tokens.current
    status_before = json.dumps(str(c.license.status()))
    c.config.set("theme", "dark")
    sign_out_hook(r)
    c._cloud_sync_api.on_deactivated()
    assert calls == []
    assert c._tokens.current == token_before == TOKEN
    assert json.dumps(str(c.license.status())) == status_before


def test_deletes_the_synced_data_on_sign_out_and_does_not_write_it_back(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    r.client.config.set("theme", "dark")
    r.client.cloud_sync.flush()
    assert state_file(r.state_dir) != ""
    sign_out_hook(r)
    assert state_file(r.state_dir) == ""
    assert r.client.cloud_sync.status()["state"] == "local"
    r.host.close()
    assert state_file(r.state_dir) == ""
    # The person's value is gone with the file.
    assert r.client.config.get("theme", "none") == "none"


def test_deletes_the_synced_data_when_the_account_is_required_again(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    w.push = lambda _b: httpx.Response(403, json={"error": {"code": "account_required"}})
    r.client.config.set("theme", "dark")
    r.client.cloud_sync.flush()
    assert state_file(r.state_dir) == ""
    assert locked_ring(r)


def test_deletes_the_synced_data_on_deactivation_signed_in_or_not(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    r.client.config.set("theme", "dark")
    r.client.cloud_sync.flush()
    assert state_file(r.state_dir) != ""
    api = r.client._cloud_sync_api
    api.on_deactivated()
    assert state_file(r.state_dir) == ""
    assert locked_ring(r)
    api.on_deactivated()  # nothing held: nothing to do, nothing fails
    assert r.state_dir.exists()


def test_another_person_signing_in_drops_the_first_persons_data_before_theirs_starts(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    r = signed_in(rigs, w)
    r.client.config.set("theme", "dark")
    r.client.cloud_sync.flush()
    identity(r.client, "subject_changed", "ps_bbbbbbbbbbbbbbbbbbbbbb")
    r.client.cloud_sync.flush()
    assert locked_ring(r)
    assert r.client.config.get("theme", "none") != "dark"


def test_events_name_keys_and_never_values_or_the_root(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    seen: List[Any] = []
    r.client.events.subscribe(seen.append, ("cloudSync",))
    r.client.config.set("theme", "very-secret-value")
    r.client.cloud_sync.flush()
    sign_out_hook(r)
    assert seen
    assert "very-secret-value" not in json.dumps([dict(e.data) for e in seen])
