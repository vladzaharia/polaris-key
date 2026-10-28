# @pkey-feature sync.keyring
"""The Cloud Sync key ring client (U-38.3; WIRE-CONTRACT-V5 §13.11) against an in-memory key ring
server that enforces the routes' rules the client depends on (create-only wraps, one ring per
subject, the recovery read limit). No network. The transcript replayer pins the routes themselves
(test_transcripts.py, the ``keyring-*`` set); sync-vectors.json pins the bytes
(test_sync_crypto_conformance.py)."""

from __future__ import annotations

import copy
import json
import os
import pickle
import stat
from typing import Any, Dict, List, Optional

import httpx
import pytest
from helpers import BASE_URL, PRODUCT, TOKEN, make_client

from polaris_key import PolarisError
from polaris_key.core import sync_crypto as sc
from polaris_key.core.b64url import b64url_decode, b64url_encode
from polaris_key.core.context import wire_code_of
from polaris_key.devices.keys import create_device_key_store
from polaris_key.devices.store import InMemoryStore
from polaris_key.keyring import AdoptRoot, KeyringError

P = f"/{PRODUCT}/devices/keyring"


class FakeServer:
    """One subject's ring on the Worker's terms: what the client relies on, nothing more."""

    def __init__(self) -> None:
        self.ring: Optional[Dict[str, Any]] = None
        self.wraps: Dict[str, Dict[str, Any]] = {}
        self.recovery: Optional[Dict[str, Any]] = None
        self.adopted: List[Dict[str, Any]] = []
        self.previous: Optional[Dict[str, Any]] = None
        self.requests: List[httpx.Request] = []
        self.bodies: List[Any] = []
        self.status_override: Optional[int] = None
        self.kem_on_read: Any = None

    def err(self, status: int, code: str) -> httpx.Response:
        return httpx.Response(status, json={"error": code})

    def __call__(self, r: httpx.Request) -> httpx.Response:
        self.requests.append(r)
        path, me = r.url.path, r.headers.get("x-pkey-device", "")
        body = json.loads(r.content) if r.content else None
        self.bodies.append(body)
        if self.status_override is not None:
            return self.err(self.status_override, "not_found")
        if not path.startswith(P):
            return httpx.Response(404)
        rest = path[len(P) :]
        if rest == "" and r.method == "GET":
            wrap = self.wraps.get(me)
            if wrap is not None and self.kem_on_read is not None:
                wrap = {**wrap, "kem": self.kem_on_read}
            ring = None
            if self.ring is not None:
                ring = {
                    **self.ring,
                    "state": "active",
                    "createdAt": 1,
                    "recovery": {"set": self.recovery is not None, "createdAt": 2},
                    "adopted": self.adopted,
                    **({"previous": self.previous} if self.previous else {}),
                }
            return httpx.Response(200, json={"ring": ring, "wrap": wrap})
        if rest == "" and r.method == "POST":
            if self.ring is not None:
                return self.err(409, "keyring_conflict")
            return self._make(body, me, None)
        if rest == "/reset" and r.method == "POST":
            if self.ring is None:
                return self.err(404, "not_found")
            old = self.ring
            self.wraps.clear()
            self.recovery = None
            return self._make(body, me, old)
        if rest.startswith("/wraps/"):
            target = rest[len("/wraps/") :]
            if r.method == "PUT":
                if target in self.wraps:
                    return self.err(409, "keyring_conflict")
                self.wraps[target] = {
                    "epoch": body["epoch"],
                    "kid": body["kid"],
                    "kem": body["kem"],
                    "enc": body["enc"],
                    "ct": body["ct"],
                    "by": me,
                }
                return httpx.Response(204)
            if r.method == "DELETE":
                if target != me:
                    return self.err(403, "forbidden")
                self.wraps.pop(me, None)
                return httpx.Response(204)
        if rest == "/recovery":
            if r.method == "PUT":
                self.recovery = body
                return httpx.Response(204)
            if self.recovery is None:
                return self.err(404, "not_found")
            return httpx.Response(200, json=self.recovery)
        if rest == "/adopt" and r.method == "POST":
            self.adopted.append(
                {"ringId": body["fromRingId"], "epoch": body["epoch"], "kid": body["kid"], "ct": body["ct"]}
            )
            return httpx.Response(204)
        return httpx.Response(404)

    def _make(self, body: Dict[str, Any], me: str, old: Optional[Dict[str, Any]]) -> httpx.Response:
        self.ring = {"ringId": body["ringId"], "epoch": 1, "rootKid": body["rootKid"]}
        self.wraps[me] = {"epoch": 1, "kid": body["rootKid"], **body["wrap"], "by": me}
        self.recovery = (
            {"ct": body["recovery"]["ct"], "epoch": 1, "kid": body["rootKid"]} if "recovery" in body else None
        )
        if old is not None:
            self.previous = {"ringId": old["ringId"], "kid": old["rootKid"], "until": 9_999_999_999}
        return httpx.Response(201, json={"ringId": body["ringId"], "epoch": 1})


_N = [0]


def device(server: FakeServer, keys=None, **kw):
    _N[0] += 1
    store = InMemoryStore(PRODUCT, device_id=f"TESTDEVICE{_N[0]:022d}")
    store.set_token(TOKEN)
    keys = keys if keys is not None else create_device_key_store(memory=True)
    c = make_client(server, store=store, device_keys=keys, **kw)
    return c, keys


def test_create_sends_the_contract_shape_and_holds_the_root() -> None:
    s = FakeServer()
    c, _ = device(s)
    made = c.keyring.create()
    body = s.bodies[-1]
    assert set(body) == {"ringId", "rootKid", "wrap", "recovery"}
    assert body["wrap"]["kem"] == 32 and isinstance(body["wrap"]["kem"], int)
    assert len(b64url_decode(body["wrap"]["enc"])) == 32 and len(b64url_decode(body["wrap"]["ct"])) == 48
    assert len(b64url_decode(body["recovery"]["ct"])) == 61
    assert made.ring_id == body["ringId"] and made.epoch == 1 and made.root_kid == body["rootKid"]
    assert made.recovery_code is not None and sc.parse_recovery_code(made.recovery_code) is not None
    assert c.keyring.unlocked and c.keyring.codec.kid == made.root_kid
    # Sealing works and the Worker would see only ciphertext.
    env = c.keyring.codec.seal("$settings", "theme", "dark")
    assert c.keyring.codec.open("$settings", "theme", env).value == "dark"


def test_create_without_recovery_sends_none() -> None:
    s = FakeServer()
    c, _ = device(s)
    made = c.keyring.create(recovery=False)
    assert "recovery" not in s.bodies[-1] and made.recovery_code is None


def test_unlock_after_a_restart_uses_this_devices_wrap() -> None:
    s = FakeServer()
    c, keys = device(s)
    made = c.keyring.create()
    kid = c.keyring.codec.kid
    store_dev = c.core.device_id
    c.keyring.lock()
    assert not c.keyring.unlocked and c.keyring.codec.locked
    r = c.keyring.unlock()
    assert (r.kind, r.ring_id, r.epoch) == ("unlocked", made.ring_id, 1)
    assert c.keyring.codec.kid == kid
    assert s.wraps[store_dev]["by"] == store_dev


def test_unlock_results_are_not_errors() -> None:
    s = FakeServer()
    c, _ = device(s)
    assert c.keyring.unlock().reason == "no-ring"
    c.keyring.create()
    other, _ = device(s)
    assert other.keyring.unlock().reason == "no-wrap"
    nokeys = make_client(s, store=_tokened(), device_keys=None)
    assert nokeys.keyring.unlock().reason == "no-wrap"


def test_a_wrap_without_device_keys_stays_locked() -> None:
    s = FakeServer()
    a, _ = device(s)
    a.keyring.create()
    same = make_client(s, store=a.core.store, device_keys=None)
    assert same.keyring.unlock().reason == "unusable-wrap"
    assert not same.keyring.unlocked


def _tokened() -> InMemoryStore:
    _N[0] += 1
    st = InMemoryStore(PRODUCT, device_id=f"TESTDEVICE{_N[0]:022d}")
    st.set_token(TOKEN)
    return st


def test_unlock_accepts_the_earlier_kem_spelling_and_refuses_others() -> None:
    s = FakeServer()
    c, _ = device(s)
    c.keyring.create()
    c.keyring.lock()
    s.kem_on_read = "x25519"
    assert c.keyring.unlock().kind == "unlocked"
    c.keyring.lock()
    s.kem_on_read = "p256"
    assert c.keyring.unlock().reason == "unusable-wrap"
    c.keyring.lock()
    s.kem_on_read = 16
    assert c.keyring.unlock().reason == "unusable-wrap"


def test_a_wrap_for_another_root_is_not_accepted() -> None:
    s = FakeServer()
    c, _ = device(s)
    c.keyring.create()
    c.keyring.lock()
    s.ring["rootKid"] = "00" * 16  # type: ignore[index]
    s.wraps[c.core.device_id]["kid"] = "00" * 16
    # A pinned client calls a different root a changed ring; one with no pin finds the wrap unusable.
    assert c.keyring.unlock().kind == "ring-changed"
    c.keyring.forget()
    assert c.keyring.unlock().reason == "unusable-wrap"
    assert not c.keyring.unlocked


def test_wrap_to_a_second_device_which_then_unlocks() -> None:
    s = FakeServer()
    a, _ = device(s)
    made = a.keyring.create()
    b, bkeys = device(s)
    a.keyring.wrap_to(b.core.device_id, bkeys.ensure().agree_key)
    put = s.bodies[-1]
    assert put["epoch"] == 1 and put["kid"] == made.root_kid and put["kem"] == 32
    assert b.keyring.unlock().kind == "unlocked"
    env = a.keyring.codec.seal("saves", "slot", {"x": 1})
    assert b.keyring.codec.open("saves", "slot", env).value == {"x": 1}


def test_wrap_to_is_create_only_and_a_wrong_key_is_refused_before_a_request() -> None:
    s = FakeServer()
    a, _ = device(s)
    a.keyring.create()
    b, bkeys = device(s)
    a.keyring.wrap_to(b.core.device_id, bkeys.ensure().agree_key)
    with pytest.raises(PolarisError) as e:
        a.keyring.wrap_to(b.core.device_id, bkeys.ensure().agree_key)
    assert (e.value.code, e.value.status) == ("keyring_conflict", 409)
    n = len(s.requests)
    with pytest.raises(KeyringError) as e2:
        a.keyring.wrap_to(b.core.device_id, b"short")
    assert e2.value.code == "invalid-argument"
    with pytest.raises(KeyringError):
        a.keyring.wrap_to("", bytes(32))
    with pytest.raises(KeyringError):
        a.keyring.wrap_to("a/b", bytes(32))
    assert len(s.requests) == n


def test_wrap_to_needs_a_root() -> None:
    s = FakeServer()
    a, _ = device(s)
    with pytest.raises(KeyringError) as e:
        a.keyring.wrap_to("dev", bytes(32))
    assert e.value.code == "sync-locked"
    with pytest.raises(KeyringError) as e2:
        a.keyring.codec.seal("c", "n", 1)
    assert e2.value.code == "sync-locked"
    with pytest.raises(KeyringError):
        a.keyring.codec.blind("record", "c", "n")


def test_recover_on_a_new_device_and_deposit_its_own_wrap() -> None:
    s = FakeServer()
    a, _ = device(s)
    made = a.keyring.create()
    b, _ = device(s)
    got = b.keyring.recover(made.recovery_code.lower().replace("-", " "))  # type: ignore[union-attr]
    assert (got.ring_id, got.epoch, got.wrap_deposited) == (made.ring_id, 1, True)
    assert b.core.device_id in s.wraps
    env = a.keyring.codec.seal("$settings", "k", [1, 2])
    assert b.keyring.codec.open("$settings", "k", env).value == [1, 2]
    # The next start needs no code.
    b.keyring.lock()
    assert b.keyring.unlock().kind == "unlocked"


def test_recover_with_a_bad_code_makes_no_request_and_a_wrong_one_is_typed() -> None:
    s = FakeServer()
    a, _ = device(s)
    made = a.keyring.create()
    b, _ = device(s)
    n = len(s.requests)
    for bad in ("", "nonsense", made.recovery_code[:-1] + "0" if made.recovery_code[-1] != "0" else "x"):  # type: ignore[index]
        with pytest.raises(KeyringError) as e:
            b.keyring.recover(bad)
        assert e.value.code == "recovery-code-invalid"
    assert len(s.requests) == n
    other = sc.encode_recovery_code(sc.new_recovery_code())
    with pytest.raises(KeyringError) as e2:
        b.keyring.recover(other)
    assert e2.value.code == "recovery-code-invalid" and not b.keyring.unlocked
    assert other not in str(e2.value)


def test_set_recovery_code_replaces_the_blob_and_the_old_code_stops_working() -> None:
    s = FakeServer()
    a, _ = device(s)
    first = a.keyring.create().recovery_code
    second = a.keyring.set_recovery_code()
    assert second != first
    assert s.bodies[-1].keys() == {"ct", "epoch", "kid"}
    b, _ = device(s)
    with pytest.raises(KeyringError):
        b.keyring.recover(first)  # type: ignore[arg-type]
    assert b.keyring.recover(second).ring_id == a.keyring.read().ring.ring_id  # type: ignore[union-attr]


def test_recover_without_a_recovery_code_set_is_not_found() -> None:
    s = FakeServer()
    a, _ = device(s)
    a.keyring.create(recovery=False)
    b, _ = device(s)
    with pytest.raises(PolarisError) as e:
        b.keyring.recover(sc.encode_recovery_code(sc.new_recovery_code()))
    assert e.value.code == "not_found"


def test_create_conflict_leaves_nothing_held_and_other_refusals_are_typed() -> None:
    s = FakeServer()
    a, _ = device(s)
    a.keyring.create()
    b, _ = device(s)
    with pytest.raises(PolarisError) as e:
        b.keyring.create()
    assert (e.value.code, e.value.status) == ("keyring_conflict", 409) and not b.keyring.unlocked
    s.status_override = 404
    with pytest.raises(PolarisError) as e2:
        a.keyring.read()
    assert (e2.value.code, e2.value.status) == ("not_found", 404)


def test_reset_keeps_the_old_root_for_adopt_and_open_adopted_reads_old_data() -> None:
    s = FakeServer()
    a, _ = device(s)
    first = a.keyring.create()
    old_env = a.keyring.codec.seal("$settings", "theme", "dark")
    second = a.keyring.reset()
    assert second.ring_id != first.ring_id and s.previous["ringId"] == first.ring_id  # type: ignore[index]
    # This device still holds the old root in memory, so it reads old data and can adopt it.
    assert a.keyring.codec.open("$settings", "theme", old_env).value == "dark"
    a.keyring.adopt(first.ring_id)
    adopt = s.bodies[-1]
    assert adopt["fromRingId"] == first.ring_id and adopt["epoch"] == 1 and adopt["kid"] == first.root_kid
    assert len(b64url_decode(adopt["ct"])) == 61
    # Another device that unlocks on the new ring opens the adopted root.
    a.keyring.lock()
    assert a.keyring.unlock().kind == "unlocked"
    # After a restart only the current root is held: the old envelope names another kid.
    assert a.keyring.codec.open("$settings", "theme", old_env).reason == "kid"
    assert a.keyring.open_adopted() == [first.ring_id]
    assert a.keyring.codec.open("$settings", "theme", old_env).value == "dark"


def test_adopt_a_root_the_host_holds_and_an_unknown_ring_is_refused() -> None:
    s = FakeServer()
    a, _ = device(s)
    a.keyring.create()
    root = bytes(range(32))
    a.keyring.adopt(AdoptRoot("rg_" + "A" * 22, 3, root))
    assert s.bodies[-1]["epoch"] == 3 and s.bodies[-1]["kid"] == sc.derive_kid(root).hex()
    with pytest.raises(KeyringError):
        a.keyring.adopt("rg_" + "B" * 22)
    with pytest.raises(KeyringError):
        a.keyring.adopt(AdoptRoot("not-a-ring", 1, root))
    with pytest.raises(KeyringError):
        a.keyring.adopt(AdoptRoot("rg_" + "A" * 22, 0, root))


def test_no_device_keys_and_no_token_are_typed() -> None:
    s = FakeServer()
    c = make_client(s, store=_tokened())
    with pytest.raises(KeyringError) as e:
        c.keyring.create()
    assert e.value.code == "device_keys_required"
    d, _ = device(s)
    d.core.store.clear_token()
    d._tokens.clear()
    with pytest.raises(KeyringError) as e2:
        d.keyring.read()
    assert e2.value.code == "no-token"


def test_the_machine_is_told_about_the_root() -> None:
    s = FakeServer()
    a, _ = device(s)
    seen: List[bool] = []

    class Machine:
        def set_root(self, present: bool) -> None:
            seen.append(present)

    detach = a.keyring.attach(Machine())
    a.keyring.create()
    a.keyring.lock()
    detach()
    a.keyring.unlock()
    assert seen == [False, True, False]


def test_deactivate_and_close_lock_the_ring() -> None:
    s = FakeServer()
    a, _ = device(s)
    a.keyring.create()
    a.close()
    assert not a.keyring.unlocked


def test_the_root_and_the_code_never_appear_in_a_repr_error_or_pickle() -> None:
    s = FakeServer()
    a, _ = device(s)
    made = a.keyring.create()
    held = a.keyring._held
    assert held is not None
    secrets = [bytes(held.root).hex(), b64url_encode(bytes(held.root)), made.recovery_code]
    code_digits = made.recovery_code.replace("-", "")  # type: ignore[union-attr]
    shown = [repr(a.keyring), str(a.keyring), repr(a.keyring.codec), repr(held), repr(made), str(made)]
    shown += [repr(a.keyring.codec.open("$settings", "x", b"")), repr(a.keyring.read())]
    for text in shown:
        for secret in secrets:
            assert secret not in text
        assert code_digits not in text.replace("-", "")
    for obj in (a.keyring, a.keyring.codec, held):
        with pytest.raises(TypeError):
            pickle.dumps(obj)
        with pytest.raises(TypeError):
            copy.deepcopy(obj)
    # An error from the server carries no key either.
    b, _ = device(s)
    with pytest.raises(PolarisError) as e:
        b.keyring.create()
    assert not any(x in str(e.value) for x in secrets)


def test_lock_zeroes_the_buffer() -> None:
    s = FakeServer()
    a, _ = device(s)
    a.keyring.create()
    buf = a.keyring._held.root  # type: ignore[union-attr]
    assert any(buf)
    a.keyring.lock()
    assert not any(buf)


def test_wire_code_helper_is_unused_here() -> None:
    assert wire_code_of(httpx.Response(409, json={"error": "keyring_conflict"})) == "keyring_conflict"
    _ = BASE_URL


# ── The pin: a changed ring is never adopted silently ─────────────────────────────────────────


def _attacked(tmp_path):
    """A victim holding ring 1; an attacker's device of the account resets and wraps its own root
    to the victim's device."""
    s = FakeServer()
    victim, vkeys = device(s, state_dir=str(tmp_path))
    made = victim.keyring.create()
    sealed = victim.keyring.codec.seal("n", "k", "mine")
    attacker, _ = device(s)
    attacker.keyring.reset()
    attacker.keyring.wrap_to(victim.core.device_id, vkeys.ensure().agree_key)
    return s, victim, vkeys, attacker, made, sealed


def test_the_pin_is_written_at_create_without_a_secret(tmp_path) -> None:
    s = FakeServer()
    c, _ = device(s, state_dir=str(tmp_path))
    made = c.keyring.create()
    pin = c.keyring.pin()
    assert (pin.ring_id, pin.epoch, pin.root_kid) == (made.ring_id, 1, made.root_kid)
    files = list(tmp_path.rglob("keyring-pin.json"))
    assert len(files) == 1
    text = files[0].read_text()
    assert made.recovery_code not in text and "ct" not in json.loads(text)
    assert stat.S_IMODE(os.stat(files[0]).st_mode) == 0o600


def test_an_attacker_reset_and_wrap_leave_the_victim_at_ring_changed(tmp_path) -> None:
    s, victim, vkeys, _attacker, made, sealed = _attacked(tmp_path)
    r = victim.keyring.unlock()
    assert r.kind == "ring-changed"
    assert r.pinned.ring_id == made.ring_id and r.served.ring_id == s.ring["ringId"] != made.ring_id
    # The root held before is intact and still reads its data.
    assert victim.keyring.unlocked
    assert victim.keyring.codec.open("n", "k", sealed).value == "mine"
    assert victim.keyring.pin().ring_id == made.ring_id
    # A restart: nothing in memory, the pin on disk. It is still not adopted.
    again = make_client(s, store=victim.core.store, device_keys=vkeys, state_dir=str(tmp_path))
    assert again.keyring.unlock().kind == "ring-changed"
    assert not again.keyring.unlocked


def test_recover_re_pins_and_the_old_code_does_not_open_the_attackers_ring(tmp_path) -> None:
    s, victim, vkeys, _attacker, made, _sealed = _attacked(tmp_path)
    again = make_client(s, store=victim.core.store, device_keys=vkeys, state_dir=str(tmp_path))
    assert again.keyring.unlock().kind == "ring-changed"
    # The attacker's ring has no recovery blob for the person's code.
    with pytest.raises(PolarisError):
        again.keyring.recover(made.recovery_code)
    assert again.keyring.pin().ring_id == made.ring_id
    # The person resets from another device of theirs and gets a code for the new ring.
    other, _ = device(s)
    fresh = other.keyring.reset()
    got = again.keyring.recover(fresh.recovery_code)
    assert got.ring_id == fresh.ring_id
    assert again.keyring.pin().ring_id == fresh.ring_id


def test_accept_ring_change_re_pins_after_confirmation(tmp_path) -> None:
    s, victim, vkeys, _attacker, _made, _sealed = _attacked(tmp_path)
    again = make_client(s, store=victim.core.store, device_keys=vkeys, state_dir=str(tmp_path))
    shown = again.keyring.unlock()
    assert shown.kind == "ring-changed"
    # The ring moves between the prompt and the accept: refused, nothing pinned.
    real = dict(s.ring)
    s.ring = {**real, "rootKid": "e" * 32}
    assert again.keyring.accept_ring_change(shown.served).kind == "ring-changed"
    assert again.keyring.pin().ring_id != real["ringId"]
    s.ring = real
    r = again.keyring.accept_ring_change(shown.served)
    assert r.kind == "unlocked" and r.ring_id == s.ring["ringId"]
    assert again.keyring.pin().ring_id == s.ring["ringId"]
    assert again.keyring.unlock().kind == "unlocked"


def test_a_subject_the_worker_serves_never_drops_the_pin(tmp_path) -> None:
    s, victim, vkeys, _attacker, _made, _sealed = _attacked(tmp_path)
    for f in tmp_path.rglob("keyring-pin.json"):
        (f.parent / "subject.json").write_text(json.dumps({"subject": "ps_" + "n" * 30}))
    again = make_client(s, store=victim.core.store, device_keys=vkeys, state_dir=str(tmp_path))
    assert again.keyring.unlock().kind == "ring-changed"
    assert not again.keyring.unlocked


def test_a_reset_by_this_device_re_pins_itself(tmp_path) -> None:
    s = FakeServer()
    c, _ = device(s, state_dir=str(tmp_path))
    c.keyring.create()
    fresh = c.keyring.reset()
    assert c.keyring.pin().ring_id == fresh.ring_id
    assert c.keyring.unlock().kind == "unlocked"


def test_another_epoch_or_root_kid_is_not_adopted(tmp_path) -> None:
    s = FakeServer()
    c, _ = device(s, state_dir=str(tmp_path))
    c.keyring.create()
    s.ring = {**s.ring, "epoch": 2}
    assert c.keyring.unlock().kind == "ring-changed"
    s.ring = {**s.ring, "epoch": 1, "rootKid": "f" * 32}
    assert c.keyring.unlock().kind == "ring-changed"


def test_forget_locks_and_drops_the_pin_and_sign_out_calls_it(tmp_path) -> None:
    s = FakeServer()
    c, _ = device(s, state_dir=str(tmp_path))
    c.keyring.create()
    c.keyring.forget()
    assert not c.keyring.unlocked and c.keyring.pin() is None
    assert not list(tmp_path.rglob("keyring-pin.json"))
    c.keyring.unlock()
    assert c.keyring.pin() is not None
    c.identity.forget()
    assert not c.keyring.unlocked and c.keyring.pin() is None


def test_an_in_memory_client_pins_in_memory() -> None:
    s = FakeServer()
    c, _ = device(s)
    made = c.keyring.create()
    assert c.keyring.pin().ring_id == made.ring_id
