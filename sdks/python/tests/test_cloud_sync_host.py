# @pkey-feature sync.e2e
"""The Python Cloud Sync host (U-06.9): ``CloudSyncMachine`` driven over bearer HTTP, with the host codec
on both sides, against a small fake of the Worker's ``/sync`` routes. Mirrors ``cloudSyncHost.test.ts``.

It pins the security points of plans/U-sync-clients-slices.md section 9 that a host owns (SEC-SYNC-HOST):
a locked ring sends nothing (S3), a forged ``sealed`` flag is ignored (S1), a plaintext row below
``encryptionSince`` is legacy data and one above it is not, a conflict's server copy opens against the
mutation's own setting, an answer that cannot be opened never advances the cursor (S10), a repeated
``mutationId`` is refused, served aliases never reach the machine, a NUL in a name is refused, the
compiled mirror is authoritative over a served catalog, bodies are read under a byte cap, the state file
is 0600 and never holds the root, and the bearer is not sent past the product origin.
"""

from __future__ import annotations

import json
import os
import stat
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Union

import httpx
import pytest
from helpers import BASE_URL, PRODUCT, TOKEN, make_client

from polaris_key.cloud_sync.host import (
    CATALOG_REFETCH_MS,
    CloudSyncHost,
    CloudSyncHostDeps,
    CloudSyncHostOptions,
)
from polaris_key.cloud_sync.host_codec import member_envelope_name, open_pull, seal_push
from polaris_key.cloud_sync.transport import is_sync_path, send_sync
from polaris_key.core.b64url import b64url_encode
from polaris_key.core.bounded_body import MAX_BODY_BYTES, read_capped_text
from polaris_key.core.errors import PolarisError
from polaris_key.devices.keys import create_device_key_store
from polaris_key.devices.store import InMemoryStore

SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg"
Body = Dict[str, Any]

ROOM: Body = {
    "usage": {"files": 0, "records": 0, "settings": 0, "bytes": 0},
    "quota": {"files": True, "bytes": 2**28},
}


def entry(key: str, **user: Any) -> Body:
    return {
        "key": key,
        "kind": "config",
        "category": "ui",
        "label": key,
        "description": key,
        "schema": {"type": "string"},
        "user": {"sync": "user", "conflict": "lastWrite", **user},
    }


def catalog(version: int) -> Body:
    return {"schemaVersion": version, "entries": [entry("theme")]}


class World:
    """A fake of the Worker's ``/sync`` routes and ``/config/schema``."""

    def __init__(self) -> None:
        self.seen: List[httpx.Request] = []
        self.bodies: List[Optional[Body]] = []
        self.schema_fetches = 0
        self.schema: Any = catalog(1)
        self.schema_response: Optional[Callable[[], httpx.Response]] = None
        self.pull: Callable[[httpx.URL], Union[httpx.Response, Body]] = lambda url: self.body()
        self.version = 100
        self.push: Callable[[Body], Union[httpx.Response, Body]] = self._accept_all

    def _accept_all(self, body: Body) -> Body:
        results = []
        for m in body["mutations"]:
            self.version += 1
            results.append({"mutationId": m["mutationId"], "status": "ok", "version": self.version})
        return self.body(results=results)

    def body(self, **over: Any) -> Body:
        return {
            "subject": SUBJECT,
            "serverNow": 1_700_000_000_000,
            "cursor": 0,
            "more": False,
            "lastMutationId": 0,
            "catalogVersion": 1,
            "aliases": {},
            **ROOM,
            "encryption": "e2e",
            "encryptionSince": 1,
            "changes": [],
            "tombstones": [],
            **over,
        }

    @property
    def sync_reqs(self) -> List[httpx.Request]:
        return [r for r in self.seen if r.url.path.startswith(f"/{PRODUCT}/sync")]

    def pushes(self) -> List[Body]:
        return [
            json.loads(r.content) for r in self.sync_reqs if r.method == "POST" and r.url.path.endswith("/sync/ops")
        ]

    def __call__(self, r: httpx.Request) -> httpx.Response:
        self.seen.append(r)
        path = r.url.path
        if path == f"/{PRODUCT}/devices/keyring" and r.method == "POST":
            body = json.loads(r.content)
            return httpx.Response(201, json={"ringId": body["ringId"], "epoch": 1})
        if path == f"/{PRODUCT}/config/schema":
            self.schema_fetches += 1
            if self.schema_response is not None:
                return self.schema_response()
            return httpx.Response(200, json=self.schema)
        if path == f"/{PRODUCT}/sync" and r.method == "GET":
            return self._wrap(self.pull(r.url))
        if path == f"/{PRODUCT}/sync/ops" and r.method == "POST":
            return self._wrap(self.push(json.loads(r.content)))
        return httpx.Response(404, json={})

    @staticmethod
    def _wrap(r: Union[httpx.Response, Body]) -> httpx.Response:
        return r if isinstance(r, httpx.Response) else httpx.Response(200, json=r)


class Rig:
    def __init__(self, w: World, state_dir: Path, mirror: bool = True, keys: bool = True) -> None:
        self.w = w
        self.state_dir = state_dir
        store = InMemoryStore(PRODUCT, device_id="DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB")
        store.set_token(TOKEN)
        self.client = make_client(
            w,
            store=store,
            state_dir=str(state_dir),
            expected_services=["license", "config", "sync"],
            device_keys=create_device_key_store(memory=True) if keys else None,
            cloud_sync={"catalog": catalog(1), "encryption": "e2e"} if mirror else {},
        )
        self.host = self.client.cloud_sync_host

    def sign_in(self) -> None:
        with self.host.locked() as m:
            m.sign_in(SUBJECT)
        self.host.touch()

    def m(self, name: str, *args: Any, **kw: Any) -> Any:
        with self.host.locked() as machine:
            return getattr(machine, name)(*args, **kw)

    def ct(self, name: str, value: Any) -> str:
        return b64url_encode(self.client.keyring.codec.seal("$settings", name, value))


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


def live(rigs: Callable[..., Rig], w: World) -> Rig:
    """A rig with a created ring (the root held), the host started and SUBJECT signed in."""
    r = rigs(w)
    r.client.keyring.create()
    r.host.start()
    r.sign_in()
    return r


def change(**over: Any) -> Body:
    return {
        "setting": "theme",
        "scope": "user",
        "version": 5,
        "editedHlc": "0199c82cc000:0000",
        "updatedBy": "c_AAAAAAAAAAAAAAAAAAAAAA",
        **over,
    }


def state_file(d: Path) -> str:
    for root, _dirs, files in os.walk(d):
        if "cloud-sync.json" in files:
            return os.path.join(root, "cloud-sync.json")
    return ""


# ── the ring gates every request (S3) ────────────────────────────────────────────────────────────


def test_a_locked_ring_sends_nothing_and_an_unlock_sends_edits_sealed(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = rigs(w)
    r.host.start()
    r.sign_in()
    r.m("set", "theme", "dark")
    r.host.flush(1000)
    assert w.sync_reqs == []
    assert r.m("status") == {"state": "locked", "pending": 1, "reason": "keyring"}
    assert r.m("get", "theme")["value"] == "dark"

    r.client.keyring.create()  # attach(): the ring tells the host, a pump applies it
    r.host.flush(1000)
    pushes = w.pushes()
    assert len(pushes) == 1
    m = pushes[0]["mutations"][0]
    assert "ct" in m and "value" not in m
    assert "dark" not in json.dumps(pushes[0])
    push = [x for x in w.sync_reqs if x.method == "POST"][0]
    assert push.headers["authorization"] == f"Bearer {TOKEN}"
    assert push.headers["x-pkey-device"]


def test_an_open_key_leaves_blinded_and_never_in_the_clear(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = live(rigs, w)
    r.m("set", "notes-private", "x")
    r.host.flush(1000)
    push = w.pushes()[0]
    assert "notes" not in push["mutations"][0]["target"]["setting"]
    assert "notes-private" not in json.dumps(push)


def test_a_ring_locked_while_a_pull_is_in_flight_drops_the_answer_and_the_cursor_stays(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    r = rigs(w)
    r.client.keyring.create()
    r.host.start()

    def pull(_url: httpx.URL) -> Body:
        r.client.keyring.lock()
        return w.body(cursor=7)

    w.pull = pull
    r.sign_in()
    assert r.m("persist")["partitions"][SUBJECT]["cursor"] == 0


def test_the_root_reaches_the_machine_only_through_the_ring(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = rigs(w)
    r.client.keyring.create()
    r.host.start()
    r.sign_in()
    r.client.keyring.lock()
    r.host.touch()
    assert r.m("status")["state"] == "locked"
    r.m("set", "theme", "dark")
    r.host.flush(1000)
    assert w.pushes() == []


# ── what a Worker serves is not trusted (S1, S10) ───────────────────────────────────────────────


def test_a_forged_sealed_flag_on_a_plaintext_row_is_ignored(rigs: Callable[..., Rig]) -> None:
    w = World()
    w.pull = lambda _u: w.body(
        cursor=5,
        encryptionSince=3,
        changes=[change(value="evil", sealed=True, invalid=False, seq=1)],
    )
    r = live(rigs, w)
    assert r.m("setting_state", "theme")["invalid"] is True
    assert r.m("get", "theme")["value"] != "evil"


def test_a_plaintext_row_below_encryption_since_is_legacy_and_one_above_is_invalid(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    w.pull = lambda _u: w.body(cursor=2, encryptionSince=4, changes=[change(value="legacy", version=2)])
    a = live(rigs, w)
    assert a.m("setting_state", "theme")["invalid"] is False
    assert a.m("get", "theme")["value"] == "legacy"

    w2 = World()
    w2.pull = lambda _u: w2.body(cursor=6, encryptionSince=4, changes=[change(value="late", version=6)])
    b = live(rigs, w2)
    assert b.m("setting_state", "theme")["invalid"] is True


def test_a_sealed_row_opens_and_an_unopenable_ct_is_invalid(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = rigs(w)
    r.client.keyring.create()
    good = r.ct("theme", "dark")
    w.pull = lambda _u: w.body(cursor=5, changes=[change(ct=good, version=5)])
    r.host.start()
    r.sign_in()
    assert r.m("get", "theme")["value"] == "dark"

    w2 = World()
    w2.pull = lambda _u: w2.body(cursor=5, changes=[change(ct="AAAA", version=5)])
    bad = live(rigs, w2)
    assert bad.m("setting_state", "theme")["invalid"] is True


def test_a_conflicts_server_copy_opens_against_the_mutations_own_setting(rigs: Callable[..., Rig]) -> None:
    def run(use_other: bool) -> Rig:
        w = World()
        r = rigs(w)
        r.client.keyring.create()
        copy = r.ct("other" if use_other else "theme", "swapped" if use_other else "theirs")
        w.pull = lambda _u: w.body(cursor=5)

        def push(body: Body) -> Body:
            mid = body["mutations"][0]["mutationId"]
            return w.body(
                cursor=5,
                results=[{"mutationId": mid, "status": "conflict", "server": change(ct=copy, version=9)}],
            )

        w.push = push
        r.host.start()
        r.sign_in()
        r.m("set", "theme", "mine")
        r.host.flush(1000)
        return r

    ok = run(False)
    assert ok.m("setting_state", "theme")["invalid"] is False
    assert ok.m("get", "theme")["value"] == "theirs"
    assert run(True).m("setting_state", "theme")["invalid"] is True


def test_a_body_that_repeats_a_mutation_id_is_dropped_and_the_cursor_stays(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = rigs(w)
    r.client.keyring.create()
    forged = r.ct("theme", "forged")
    w.pull = lambda _u: w.body(cursor=5)

    def push(body: Body) -> Body:
        mid = body["mutations"][0]["mutationId"]
        return w.body(
            cursor=9,
            results=[
                {"mutationId": mid, "status": "conflict", "server": change(ct=forged, version=9)},
                {"mutationId": mid, "status": "ok", "version": 9},
            ],
        )

    w.push = push
    r.host.start()
    r.sign_in()
    r.m("set", "theme", "mine")
    r.host.flush(1000)
    assert r.m("persist")["partitions"][SUBJECT]["cursor"] == 5
    assert r.m("get", "theme")["value"] != "forged"


def test_served_aliases_never_reach_the_machine(rigs: Callable[..., Rig]) -> None:
    w = World()
    w.pull = lambda _u: w.body(cursor=5, aliases={"theme": "other"})
    r = live(rigs, w)
    assert r.m("persist")["aliases"] == {}


def test_a_name_holding_nul_is_refused_both_ways(rigs: Callable[..., Rig]) -> None:
    w = World()
    w.pull = lambda _u: w.body(cursor=5, changes=[change(setting="a\0b", value="x", version=5)])
    r = live(rigs, w)
    assert r.m("setting_state", "a\0b")["invalid"] is True
    assert r.m("get", "a\0b")["value"] is None
    # Sending: a NUL name cannot be sealed, so nothing is sent and the edit stays pending.
    r.m("set", "x\0y", "v")
    r.host.flush(1000)
    assert w.pushes() == []
    assert r.m("status")["pending"] == 1


def test_a_worker_that_answers_in_server_mode_is_not_read_when_the_app_requires_e2e(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    w.pull = lambda _u: w.body(encryption="server", cursor=3, changes=[change(value="plain", version=3)])
    r = live(rigs, w)
    assert r.m("status") == {
        "state": "unsupported",
        "pending": 0,
        "reason": "encryption",
        "code": "sync-encryption-pinned",
    }
    assert r.m("get", "theme")["value"] != "plain"


# ── the codec on its own ─────────────────────────────────────────────────────────────────────────


def test_the_codec_strips_served_flags_aliases_and_renamed_to(rigs: Callable[..., Rig]) -> None:
    r = rigs(World())
    r.client.keyring.create()
    codec = r.client.keyring.codec
    body = {
        "sealed": True,
        "seq": 3,
        "aliases": {"a": "b"},
        "changes": [{"setting": "theme", "version": 2, "value": "v", "sealed": True, "invalid": True, "seq": 99}],
        "results": [{"mutationId": 1, "status": "ok", "renamedTo": "stolen", "seq": 4, "ct": "x"}],
    }
    out, opened = open_pull(
        body,
        codec,
        mutations=[{"mutationId": 1, "target": {"setting": "old"}, "op": "set"}],
        aliases={"old": "new"},
    )
    assert out["aliases"] == {"old": "new"}
    row = out["changes"][0]
    assert "sealed" not in row and "invalid" not in row and "seq" not in row
    assert opened["changes"][0] == {"seq": 2}
    res = out["results"][0]
    assert "renamedTo" not in res and "seq" not in res and "ct" not in res
    assert "sealed" not in out and "seq" not in out
    # An alias the app declares survives.
    ok, _ = open_pull(
        {"results": [{"mutationId": 1, "status": "ok", "renamedTo": "new"}]},
        codec,
        mutations=[{"mutationId": 1, "target": {"setting": "old"}, "op": "set"}],
        aliases={"old": "new"},
    )
    assert ok["results"][0]["renamedTo"] == "new"


def test_a_conflict_copy_for_an_id_the_request_did_not_send_does_not_open(rigs: Callable[..., Rig]) -> None:
    r = rigs(World())
    r.client.keyring.create()
    copy = r.ct("theme", "forged")
    body = {"results": [{"mutationId": 7, "status": "conflict", "server": {"ct": copy, "version": 2}}]}
    _out, opened = open_pull(body, r.client.keyring.codec, mutations=[])
    assert opened["conflicts"][7] == {"invalid": True}
    with pytest.raises(PolarisError) as e:
        open_pull(
            {"results": [{"mutationId": 7, "status": "ok"}, {"mutationId": 7, "status": "ok"}]},
            r.client.keyring.codec,
        )
    assert e.value.code == "sync-failed"


def test_a_locked_codec_seals_and_opens_nothing(rigs: Callable[..., Rig]) -> None:
    r = rigs(World())
    assert r.client.keyring.codec.locked
    for call in (
        lambda: seal_push({"mutations": []}, r.client.keyring.codec, []),
        lambda: open_pull({"changes": []}, r.client.keyring.codec),
    ):
        with pytest.raises(PolarisError) as e:
            call()
        assert e.value.code == "sync-locked"


def test_a_merge_member_round_trips_and_a_nul_member_is_refused(rigs: Callable[..., Rig]) -> None:
    r = rigs(World())
    r.client.keyring.create()
    codec = r.client.keyring.codec
    routes = [{"key": "tags", "route": "synced"}]
    set_member: Body = {"mutationId": 1, "target": {"setting": "tags"}, "op": "setMember", "member": "a", "value": True}
    sealed = seal_push({"mutations": [set_member]}, codec, routes)
    m = sealed["mutations"][0]
    assert m["member"].startswith("x:") and "ct" in m and "value" not in m
    served = {"setting": "tags", "version": 2, "members": [{"member": m["member"], "ct": m["ct"]}]}
    out, opened = open_pull({"changes": [served]}, codec)
    assert out["changes"][0]["value"] == {"a": True} and opened["changes"][0] == {"sealed": True}
    assert member_envelope_name("tags", "a") == "tags\0a"
    with pytest.raises(PolarisError):
        seal_push({"mutations": [{**set_member, "member": "a\0"}]}, codec, routes)


# ── catalog and state ────────────────────────────────────────────────────────────────────────────


def timed(r: Rig, mirror: Optional[Body] = None) -> "tuple[CloudSyncHost, List[int]]":
    clock = [1_700_000_000_000]
    host = CloudSyncHost(
        CloudSyncHostDeps(
            ctx=r.client.core,
            tokens=r.client._tokens,
            keyring=r.client.keyring,
            discovery=lambda: None,
            fetch_schema=r.client.config.fetch_schema,
            document=lambda: {"values": {}},
            clock=lambda: clock[0],
        ),
        CloudSyncHostOptions(catalog=mirror),
    )
    return host, clock


def test_the_catalog_is_fetched_once_when_none_is_cached_or_compiled_and_again_only_after_the_window(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    r = rigs(w, mirror=False)
    r.client.keyring.create()
    host, clock = timed(r)
    host.start()
    assert w.schema_fetches == 1
    w.schema = catalog(2)
    w.pull = lambda _u: w.body(catalogVersion=2)
    with host.locked() as m:
        m.sign_in(SUBJECT)
    host.touch()
    # A Worker alternating versions cannot make the client fetch on every pull.
    assert w.schema_fetches == 1
    clock[0] += CATALOG_REFETCH_MS + 1
    with host.locked() as m:
        m.set_network("online")
    host.touch()
    assert w.schema_fetches == 2
    # A version it does not serve is not asked for again, window or not.
    w.pull = lambda _u: w.body(catalogVersion=3)
    clock[0] += CATALOG_REFETCH_MS + 1
    host.touch()
    after = w.schema_fetches
    clock[0] += CATALOG_REFETCH_MS + 1
    host.touch()
    assert w.schema_fetches == after
    host.flush(1000)
    saved = json.loads(Path(state_file(r.state_dir)).read_text())
    assert saved["catalog"]["schemaVersion"] == 2
    host.close()


def test_the_compiled_mirror_is_authoritative_and_bad_keys_are_dropped(rigs: Callable[..., Rig]) -> None:
    w = World()
    w.schema = {
        "schemaVersion": 2,
        "entries": [
            entry("theme", sync="local"),
            entry("extra", sync="local"),
            entry("bad key!", sync="local"),
        ],
    }
    r = rigs(w)
    r.client.keyring.create()
    r.host.start()
    w.pull = lambda _u: w.body(catalogVersion=2)
    r.sign_in()
    r.host.touch()
    r.m("set", "theme", "dark")
    r.m("set", "extra", "x")
    assert r.m("setting_state", "theme")["sync"] != "local"
    assert r.m("setting_state", "extra")["sync"] == "local"
    r.host.flush(1000)
    saved = json.loads(Path(state_file(r.state_dir)).read_text())
    assert "bad key!" not in [e["key"] for e in saved["catalog"]["entries"]]


def test_a_served_catalog_cannot_reclassify_an_open_setting_the_person_already_uses(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    r = rigs(w, mirror=False)
    r.client.keyring.create()
    host, clock = timed(r)
    host.start()
    with host.locked() as m:
        m.sign_in(SUBJECT)
    host.touch()
    with host.locked() as m:
        m.set("notes", "mine")
    host.flush(1000)
    w.schema = {"schemaVersion": 2, "entries": [entry("notes", sync="local"), entry("fresh", sync="local")]}
    w.pull = lambda _u: w.body(catalogVersion=2)
    clock[0] += CATALOG_REFETCH_MS + 1
    with host.locked() as m:
        m.set_network("online")
    host.touch()
    assert w.schema_fetches == 2
    with host.locked() as m:
        assert m.setting_state("notes")["sync"] != "local"
        assert m.setting_state("fresh")["sync"] == "local"
    host.close()


def test_junk_names_a_worker_serves_cannot_push_open_keys_out(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = live(rigs, w)
    r.m("set", "notes-private", "x")
    r.host.flush(1000)
    w.pull = lambda _u: w.body(
        cursor=9,
        encryptionSince=100,
        changes=[change(setting=f"junk{i}", value=i, version=i + 1) for i in range(5000)],
    )
    r.m("set_network", "online")
    r.host.touch()
    r.host.flush(1000)
    keys = json.loads(Path(state_file(r.state_dir)).read_text())["openKeys"]
    assert "notes-private" in keys
    assert [k for k in keys if k.startswith("junk")] == []


def test_the_state_file_is_0600_atomic_and_holds_the_journal_not_the_root(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = live(rigs, w)
    r.m("set", "theme", "dark")
    r.host.flush(1000)
    file = state_file(r.state_dir)
    assert file
    assert stat.S_IMODE(os.stat(file).st_mode) == 0o600
    saved = json.loads(Path(file).read_text())
    assert saved["product"] == PRODUCT and SUBJECT in saved["persisted"]["partitions"]
    assert [f for f in os.listdir(os.path.dirname(file)) if f.endswith(".tmp")] == []
    held = r.client.keyring._held
    assert held is not None and bytes(held.root).hex() not in Path(file).read_text().lower()


def test_a_planted_temp_name_is_never_followed(tmp_path: Path) -> None:
    from polaris_key.cloud_sync import state as st

    target = tmp_path / "victim"
    target.write_text("keep")
    real = st.secrets.token_hex
    st.secrets.token_hex = lambda n: "fixed"  # type: ignore[assignment]
    try:
        (tmp_path / "f.json.fixed.tmp").symlink_to(target)
        with pytest.raises(OSError):
            st.write_json_atomic(str(tmp_path / "f.json"), {"a": 1})
    finally:
        st.secrets.token_hex = real  # type: ignore[assignment]
    assert target.read_text() == "keep"


def test_the_journal_survives_a_relaunch(rigs: Callable[..., Rig]) -> None:
    w = World()
    a = live(rigs, w)
    a.m("set", "theme", "dark")
    a.client.keyring.lock()
    a.host.flush(1000)
    a.client.close()
    b = Rig(w, a.state_dir, keys=False)
    b.host.start()
    assert b.m("get", "theme")["value"] == "dark"
    assert b.m("status")["pending"] == 1
    b.client.close()


def test_purge_deletes_the_file_and_nothing_is_saved_until_resume(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = live(rigs, w)
    r.m("set", "theme", "dark")
    r.host.flush(1000)
    assert state_file(r.state_dir)
    r.host.purge()
    assert state_file(r.state_dir) == ""
    assert r.m("get", "theme")["value"] != "dark"
    r.host.flush(1000)
    assert state_file(r.state_dir) == ""
    r.host.resume()
    r.sign_in()
    r.m("set", "theme", "light")
    r.host.flush(1000)
    assert state_file(r.state_dir) != ""


# ── transport ────────────────────────────────────────────────────────────────────────────────────


def test_only_the_machines_own_routes_are_sent() -> None:
    assert is_sync_path("djdl", "/djdl/sync?cursor=0&clientId=c_x")
    assert is_sync_path("djdl", "/djdl/sync/ops")
    assert not is_sync_path("djdl", "/djdl/sync/other")
    assert not is_sync_path("djdl", "/other/sync?cursor=0")
    assert not is_sync_path("djdl", "/djdl/sync?cursor=0#x y")
    assert not is_sync_path("djdl", "//evil.example/djdl/sync/ops")


def test_a_redirect_is_not_followed_and_the_bearer_goes_nowhere_else(rigs: Callable[..., Rig]) -> None:
    w = World()

    def pull(_u: httpx.URL) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://evil.example/steal"})

    w.pull = pull
    r = rigs(w)
    r.client.keyring.create()
    r.host.start()
    r.sign_in()
    hits = [x for x in w.seen if x.url.host != httpx.URL(BASE_URL).host]
    assert hits == []
    assert r.m("persist")["partitions"][SUBJECT]["cursor"] == 0
    req = {"method": "GET", "path": f"/{PRODUCT}/sync?cursor=0&clientId=c_x"}
    assert send_sync(r.client.core, r.client._tokens, req) == {"status": 302}


def test_a_token_less_client_sends_nothing(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = rigs(w)
    r.client._tokens._token = None
    assert send_sync(r.client.core, r.client._tokens, {"method": "GET", "path": f"/{PRODUCT}/sync?cursor=0"}) == {
        "error": "transport"
    }
    assert w.sync_reqs == []


# ── bounded bodies ───────────────────────────────────────────────────────────────────────────────


def _stream_response(chunks: Iterator[bytes], headers: Optional[Dict[str, str]] = None) -> httpx.Response:
    return httpx.Response(200, content=chunks, headers=headers or {})


def test_the_cap_counts_bytes_not_characters() -> None:
    res = httpx.Response(200, content=("é" * 5).encode())
    assert read_capped_text(res, 9) is None
    res2 = httpx.Response(200, content=("é" * 5).encode())
    assert read_capped_text(res2, 10) == "é" * 5


def test_content_length_refuses_without_reading_and_a_stream_that_outgrows_its_cap_is_cut() -> None:
    read: List[int] = []

    def gen() -> Iterator[bytes]:
        for _ in range(20):
            read.append(1)
            yield b"x" * 1024

    lying = httpx.Response(200, headers={"content-length": str(MAX_BODY_BYTES + 1)}, content=b"{}")
    assert read_capped_text(lying) is None
    res = httpx.Response(200, content=gen())
    assert read_capped_text(res, 4096) is None
    assert len(read) <= 6


def test_an_oversized_sync_answer_is_a_transport_error_and_an_oversized_schema_is_none(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    big = b'{"x":"' + b"a" * (MAX_BODY_BYTES + 10) + b'"}'
    w.pull = lambda _u: httpx.Response(200, content=big)
    r = rigs(w)
    r.client.keyring.create()
    r.host.start()
    r.sign_in()
    assert r.m("persist")["partitions"][SUBJECT]["cursor"] == 0

    w.schema_response = lambda: httpx.Response(200, content=big)
    assert r.client.config.fetch_schema() is None
    w.schema_response = lambda: httpx.Response(200, headers={"content-length": str(MAX_BODY_BYTES + 1)}, content=b"{}")
    assert r.client.config.fetch_schema() is None
    w.schema_response = None
    assert r.client.config.fetch_schema() is not None


# ── lifecycle ────────────────────────────────────────────────────────────────────────────────────


def test_the_timer_is_a_daemon_armed_only_while_work_waits_and_close_stops_it(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = live(rigs, w)
    host = r.host
    assert host._timer is None
    r.m("set", "theme", "dark")
    host.catch_up()
    r.m("set_network", "offline")
    with host.locked() as m:
        m.set_network("online")
    host._arm()
    t = host._timer
    if t is not None:
        assert t.daemon is True
    host.close()
    assert host._timer is None
    host.close()  # twice is fine


def test_close_removes_the_exit_hook_and_flush_after_close_is_a_no_op(rigs: Callable[..., Rig]) -> None:
    import atexit

    w = World()
    r = live(rigs, w)
    hook = r.host._exit_hook
    assert hook is not None
    r.host.close()
    assert r.host._exit_hook is None
    r.host.flush(10)  # not started: nothing happens
    atexit.unregister(hook)


def test_a_timer_wake_while_a_pump_runs_waits_and_does_not_double_send(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = live(rigs, w)
    r.m("set", "theme", "dark")
    gate = threading.Event()
    real = w.push

    def slow(body: Body) -> Union[httpx.Response, Body]:
        gate.wait(2)
        return real(body)

    w.push = slow
    r.m("flush")
    t1 = threading.Thread(target=r.host.touch)
    t1.start()
    t2 = threading.Thread(target=r.host.touch)
    t2.start()
    gate.set()
    t1.join(5)
    t2.join(5)
    assert len(w.pushes()) == 1


def test_the_async_facade_runs_the_host_on_a_worker_thread(rigs: Callable[..., Rig]) -> None:
    import asyncio

    from polaris_key.aio import AsyncPolarisKeyClient

    w = World()
    r = live(rigs, w)
    r.m("set", "theme", "dark")
    a = AsyncPolarisKeyClient(r.client)

    async def go() -> None:
        host = a.cloud_sync_host
        assert host.started is True
        await host.flush(1000)
        with host.locked() as m:  # the lock is held on the caller's thread, not wrapped as a coroutine
            assert m.status()["pending"] == 0

    asyncio.run(go())
    assert len(w.pushes()) == 1


# ── requests are bound to the person they were queued for ────────────────────────────────────────


def bound_host(r: Rig, now: List[Optional[str]]) -> CloudSyncHost:
    return CloudSyncHost(
        CloudSyncHostDeps(
            ctx=r.client.core,
            tokens=r.client._tokens,
            keyring=r.client.keyring,
            discovery=lambda: None,
            fetch_schema=r.client.config.fetch_schema,
            document=lambda: {"values": {}},
            subject=lambda: now[0],
        ),
        CloudSyncHostOptions(catalog=catalog(1), encryption="e2e"),
    )


def test_a_request_queued_for_one_person_is_never_sent_once_the_session_is_anothers(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    r = rigs(w)
    r.client.keyring.create()
    now: List[Optional[str]] = [SUBJECT]
    host = bound_host(r, now)
    host.start()
    with host.locked() as m:
        m.sign_in(SUBJECT)
    host.bind_subject(SUBJECT)
    host.touch()
    before = len(w.sync_reqs)
    with host.locked() as m:
        m.set("theme", "P1-VALUE")
    now[0] = "P2"
    host.flush(1000)
    assert w.sync_reqs[before:] == []
    host.close()


def test_an_unknown_subject_still_sends(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = rigs(w)
    r.client.keyring.create()
    now: List[Optional[str]] = [None]
    host = bound_host(r, now)
    host.start()
    with host.locked() as m:
        m.sign_in(SUBJECT)
    host.bind_subject(SUBJECT)
    host.touch()
    before = len(w.sync_reqs)
    with host.locked() as m:
        m.set("theme", "offline-boot")
    host.flush(1000)
    assert any(x.method == "POST" for x in w.sync_reqs[before:])
    host.close()
