# @pkey-feature connect.identity
"""``client.connect`` (CC-10.1; WIRE-CONTRACT-V5 §15.2, §15.3, §15.4, §15.8): keys registered on first
need, the identity fetched, the roster and certificate verified and kept with K_disc, and the device
list. A fake Worker signs real documents with the test product key. No network."""

from __future__ import annotations

import json
import os
import stat
from typing import Any, Dict, List, Optional

import httpx
import pytest
from helpers import ATTACKER_PEM, KID, PRIVATE_PEM, PRODUCT, TOKEN, make_client

from polaris_key import PolarisError
from polaris_key.connect.state import CONNECT_STATE_FILE
from polaris_key.core.b64url import b64url_encode
from polaris_key.core.caps import UnsupportedError
from polaris_key.core.jws import sign_jws
from polaris_key.devices.keys import create_device_key_store
from polaris_key.devices.store import InMemoryStore

SUB = "ps_AbCdEfGhIjKlMnOpQrStUv"
OTHER_SUB = "ps_ZyXwVuTsRqPoNmLkJiHgFe"
WEEK = 604_800
_N = [0]


def _b(seed: int) -> str:
    return b64url_encode(bytes([seed]) * 32)


def _tokened() -> InMemoryStore:
    _N[0] += 1
    st = InMemoryStore(PRODUCT, device_id=f"CONNECTDEVICE{_N[0]:019d}")
    st.set_token(TOKEN)
    return st


class FakeWorker:
    """`PUT devices/keys`, `GET connect/identity` and `GET connect/devices`, signing with the product key."""

    def __init__(self, *, now: int) -> None:
        self.now = now
        self.registered: Dict[str, Dict[str, str]] = {}
        self.epoch = 1
        self.sub = SUB
        self.others: List[Dict[str, str]] = []
        self.disc: List[str] = [_b(1)]
        self.requests: List[httpx.Request] = []
        self.pem = PRIVATE_PEM
        self.fail: Optional[httpx.Response] = None
        self.skip_self_in_ring = False
        self.cert_epoch: Optional[int] = None
        self.cert_keys: Optional[Dict[str, str]] = None
        self.ring_override: Optional[str] = None
        self.listing: Any = None

    def count(self, method: str, suffix: str) -> int:
        return sum(1 for r in self.requests if r.method == method and r.url.path.endswith(suffix))

    def ring(self, me: str) -> str:
        keys = self.registered[me]
        devs = ([] if self.skip_self_in_ring else [{"deviceId": me, **keys}]) + self.others
        devs.sort(key=lambda d: d["deviceId"])
        return sign_jws(
            {
                "iss": "key.plrs.im",
                "aud": PRODUCT,
                "sub": self.sub,
                "epoch": self.epoch,
                "issuedAt": self.now,
                "expiresAt": self.now + WEEK,
                "devices": devs,
            },
            self.pem,
            KID,
            "pkey-ring+jws",
        )

    def cert(self, me: str) -> str:
        keys = self.cert_keys or self.registered[me]
        return sign_jws(
            {
                "iss": "key.plrs.im",
                "aud": PRODUCT,
                "sub": self.sub,
                "deviceId": me,
                **keys,
                "ringEpoch": self.cert_epoch or self.epoch,
                "issuedAt": self.now,
                "expiresAt": self.now + WEEK,
            },
            self.pem,
            KID,
            "pkey-peer+jws",
        )

    def __call__(self, r: httpx.Request) -> httpx.Response:
        self.requests.append(r)
        me = r.headers.get("x-pkey-device", "")
        path = r.url.path
        if path.endswith("/devices/keys") and r.method == "PUT":
            body = json.loads(r.content)
            self.registered[me] = {"signKey": body["signKey"], "agreeKey": body["agreeKey"]}
            return httpx.Response(200, json={"keySeq": 1})
        if self.fail is not None:
            return self.fail
        if path.endswith("/connect/identity"):
            if me not in self.registered:
                return httpx.Response(409, json={"error": {"code": "device_keys_required"}})
            return httpx.Response(
                200,
                json={
                    "ring": self.ring_override or self.ring(me),
                    "certificate": self.cert(me),
                    "discKeys": self.disc,
                },
            )
        if path.endswith("/connect/devices"):
            if self.listing is not None:
                return httpx.Response(200, json=self.listing)
            return httpx.Response(
                200,
                json={
                    "devices": [
                        {"deviceId": me, "label": "Desk", "platform": "macos", "lastSeen": self.now, "self": True},
                        {"deviceId": "z" * 32, "label": None, "platform": None, "lastSeen": None, "self": False},
                    ]
                },
            )
        return httpx.Response(404)


def device(w: FakeWorker, tmp_path, **kw: Any):
    kw.setdefault("store", _tokened())
    kw.setdefault("state_dir", str(tmp_path))
    kw.setdefault("expected_services", ["license", "config", "connect"])
    return make_client(w, **kw)


@pytest.fixture
def worker() -> FakeWorker:
    import time

    return FakeWorker(now=int(time.time()))


def other_device(seed: int, device_id: str = "o" * 32) -> Dict[str, str]:
    # A second member of the roster; its keys only need to pass the §15.2 step 4 rules.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    s = Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    a = X25519PrivateKey.generate().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return {"deviceId": device_id, "signKey": b64url_encode(s), "agreeKey": b64url_encode(a)}


def test_identity_registers_keys_on_first_need_then_fetches_and_stores(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    assert worker.count("PUT", "/devices/keys") == 0
    ident = c.connect.identity()
    assert worker.count("PUT", "/devices/keys") == 1 and worker.count("GET", "/connect/identity") == 1
    assert ident.sub == SUB and ident.epoch == 1 and ident.device_id == c.core.device_id
    assert [d.device_id for d in ident.devices] == [c.core.device_id]
    assert ident.certificate_expires_at == worker.now + WEEK
    # Held: a second call and a restart send nothing.
    assert c.connect.identity().certificate == ident.certificate
    again = device(worker, tmp_path, store=c.core.store)
    assert again.connect.current() is not None
    assert again.connect.identity().epoch == 1
    assert worker.count("PUT", "/devices/keys") == 1 and worker.count("GET", "/connect/identity") == 1


def test_the_state_is_owner_only_and_k_disc_is_in_no_repr(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    ident = c.connect.identity()
    path = os.path.join(c.core.dirs.state, CONNECT_STATE_FILE)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    if os.name != "nt":
        assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
    secret = worker.disc[0]
    keys = c.connect.discovery_keys()
    assert keys is not None and keys.previous is None
    for text in (repr(c.connect), repr(ident), repr(keys), str(ident)):
        assert secret not in text
    with pytest.raises(TypeError):
        import pickle

        pickle.dumps(c.connect)


def test_memory_only_keys_refuse_before_any_request(worker, tmp_path) -> None:
    mem = create_device_key_store(memory=True)
    c = device(worker, tmp_path, device_keys=mem)
    with pytest.raises(PolarisError) as e:
        c.connect.identity()
    assert e.value.code == "invalid-options" and worker.requests == []
    ok = device(worker, tmp_path / "b", device_keys=create_device_key_store(memory=True), allow_ephemeral_keys=True)
    assert ok.connect.identity().epoch == 1


def test_connect_off_is_the_typed_product_refusal(worker, tmp_path) -> None:
    c = device(worker, tmp_path, expected_services=["license", "config"])
    with pytest.raises(UnsupportedError) as e:
        c.connect.identity()
    assert e.value.reason == "product" and e.value.code == "service-unavailable" and worker.requests == []


def test_no_token_refuses(worker, tmp_path) -> None:
    st = InMemoryStore(PRODUCT, device_id="D" * 32)
    c = device(worker, tmp_path, store=st)
    with pytest.raises(PolarisError) as e:
        c.connect.identity()
    assert e.value.code == "no-token"


@pytest.mark.parametrize(
    "status,code",
    [(403, "account_required"), (409, "ring_too_large"), (409, "device_keys_required")],
)
def test_the_workers_refusals_keep_their_codes(worker, tmp_path, status, code) -> None:
    worker.fail = httpx.Response(status, json={"error": {"code": code}})
    c = device(worker, tmp_path)
    with pytest.raises(PolarisError) as e:
        c.connect.identity()
    assert e.value.code == code and e.value.status == status


def test_a_purged_server_row_is_registered_again_once(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    c.connect.identity()
    worker.registered.clear()
    again = c.connect.identity(refresh=True)
    assert again.epoch == 1 and worker.count("PUT", "/devices/keys") == 2


def test_an_unsigned_or_foreign_signed_roster_is_refused_and_nothing_is_stored(worker, tmp_path) -> None:
    worker.pem = ATTACKER_PEM
    c = device(worker, tmp_path)
    with pytest.raises(PolarisError) as e:
        c.connect.identity()
    assert e.value.code == "bad_response"
    assert c.connect.current() is None and c.connect.discovery_keys() is None
    assert not os.path.exists(os.path.join(c.core.dirs.state, CONNECT_STATE_FILE))


def test_a_certificate_for_other_keys_or_another_roster_epoch_is_refused(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    c.connect.identity()
    worker.epoch = 2
    worker.cert_epoch = 1
    with pytest.raises(PolarisError) as e:
        c.connect.identity(refresh=True)
    assert e.value.code == "bad_response"
    worker.cert_epoch = None
    worker.cert_keys = {"signKey": other_device(1)["signKey"], "agreeKey": other_device(1)["agreeKey"]}
    with pytest.raises(PolarisError):
        c.connect.identity(refresh=True)


def test_a_roster_without_this_device_is_refused(worker, tmp_path) -> None:
    worker.skip_self_in_ring = True
    worker.others = [other_device(1)]
    c = device(worker, tmp_path)
    with pytest.raises(PolarisError) as e:
        c.connect.identity()
    assert e.value.code == "bad_response"


def test_stale_and_foreign_rosters_are_refused_and_the_held_state_stays(worker, tmp_path) -> None:
    worker.epoch = 5
    c = device(worker, tmp_path)
    held = c.connect.identity()
    worker.epoch = 4
    with pytest.raises(PolarisError) as e:
        c.connect.identity(refresh=True)
    assert e.value.code == "bad_response"
    worker.epoch = 6
    worker.sub = OTHER_SUB
    with pytest.raises(PolarisError):
        c.connect.identity(refresh=True)
    now = c.connect.current()
    assert now is not None and now.epoch == 5 and now.ring == held.ring
    # The same epoch with another device set is a different roster under the same number.
    worker.sub = SUB
    worker.epoch = 5
    worker.others = [other_device(2)]
    with pytest.raises(PolarisError):
        c.connect.identity(refresh=True)
    # A higher epoch of the same subject replaces it.
    worker.epoch = 7
    assert c.connect.identity(refresh=True).epoch == 7


def test_the_previous_k_disc_survives_a_join_but_not_a_leave(worker, tmp_path) -> None:
    d1, d2 = other_device(1), other_device(2, "p" * 32)
    worker.others = [d1]
    worker.disc = [_b(1)]
    c = device(worker, tmp_path)
    c.connect.identity()
    # A device joins: the Worker delivers the old key as previous, and it is kept.
    worker.epoch = 2
    worker.others = [d1, d2]
    worker.disc = [_b(2), _b(1)]
    c.connect.identity(refresh=True)
    keys = c.connect.discovery_keys()
    assert keys is not None and keys.current == b"\x02" * 32 and keys.previous == b"\x01" * 32
    # A device leaves: even if an answer still names a previous key, none is kept.
    worker.epoch = 3
    worker.others = [d2]
    worker.disc = [_b(3), _b(2)]
    c.connect.identity(refresh=True)
    keys = c.connect.discovery_keys()
    assert keys is not None and keys.current == b"\x03" * 32 and keys.previous is None


def test_the_previous_k_disc_lapses_after_24_hours(worker, tmp_path) -> None:
    worker.disc = [_b(2), _b(1)]
    c = device(worker, tmp_path)
    c.connect.identity()
    keys = c.connect.discovery_keys()
    assert keys is not None and keys.previous == b"\x01" * 32
    real = c.core.now
    c.core.now = lambda system_now=None: real(system_now) + 86_401  # type: ignore[method-assign]
    keys = c.connect.discovery_keys()
    assert keys is not None and keys.previous is None


def test_leave_forgets_the_state_and_keeps_the_device_keys(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    c.connect.identity()
    keys_file = os.path.join(c.core.dirs.state, "device-keys.json")
    assert os.path.exists(keys_file)
    c.connect.leave()
    assert c.connect.current() is None and c.connect.discovery_keys() is None
    assert os.path.exists(keys_file)
    c.connect.leave()  # nothing left: not an error
    c.connect.identity()
    assert worker.count("PUT", "/devices/keys") == 2  # the held "registered" marker went with the state


@pytest.mark.parametrize("bad", [[], ["short"], [_b(1), _b(1)], [_b(1), _b(2), _b(3)], "x"])
def test_a_malformed_k_disc_answer_is_refused(worker, tmp_path, bad) -> None:
    worker.disc = bad
    c = device(worker, tmp_path)
    with pytest.raises(PolarisError) as e:
        c.connect.identity()
    assert e.value.code == "bad_response"


def test_an_unreadable_state_record_is_an_error_not_a_reset(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    c.connect.identity()
    path = os.path.join(c.core.dirs.state, CONNECT_STATE_FILE)
    with open(path, "wb") as f:
        f.write(b"{not json")
    os.chmod(path, 0o600)
    with pytest.raises(PolarisError) as e:
        c.connect.current()
    assert e.value.code == "store-failed"
    c.connect.leave()
    assert c.connect.current() is None


def test_list_devices(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    rows = c.connect.list_devices()
    assert worker.count("PUT", "/devices/keys") == 1  # the device is not in its own list until it registers
    assert [(r.self, r.label, r.platform) for r in rows] == [(True, "Desk", "macos"), (False, None, None)]
    assert rows[1].last_seen is None and rows[0].last_seen == worker.now
    assert "keys" not in json.dumps([vars(r) for r in rows]).lower()


def test_list_devices_refuses_a_malformed_or_oversized_answer(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    worker.listing = {"devices": [{"deviceId": 5, "self": True}]}
    with pytest.raises(PolarisError):
        c.connect.list_devices()
    worker.listing = {"devices": [{"deviceId": f"{i:032d}", "self": False} for i in range(129)]}
    with pytest.raises(PolarisError):
        c.connect.list_devices()
    worker.listing = {"nope": 1}
    with pytest.raises(PolarisError):
        c.connect.list_devices()
