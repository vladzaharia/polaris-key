# @pkey-feature core.devicekeys
"""The Python device key store and the ``pkey-proof/1`` signer (CC-26.3).

Mirrors ``packages/client-core/test/deviceKeys.test.ts`` and the Kotlin ``DeviceKeysTest``: one pair on
first need, rotate and wipe, low-order refusal, an unreadable record that only ``wipe()`` resets, an
unsupported backend that is never "unreadable", transient faults that never read as "no keys", the
file's permissions and locking, the proof signer and the ``PUT /devices/keys`` helper.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from helpers import PRODUCT, TOKEN, make_client

from polaris_key.core.b64url import b64url_decode
from polaris_key.core.device_keys import (
    DeviceKeyError,
    DeviceKeyStoreError,
    DeviceKeysUnreadableError,
    DeviceKeyUnsupportedError,
    DeviceProofError,
    DevicePublicKeys,
    build_device_keys_request,
    sign_device_proof,
    sign_keys_proof,
)
from polaris_key.core.device_proof import (
    DeviceProof,
    device_proof_message,
    is_x25519_low_order,
    verify_device_proof,
)
from polaris_key.core.errors import PolarisError
from polaris_key.devices import keys as keysmod
from polaris_key.devices.client import DeviceManagementUnsupportedError, DeviceRefusedError
from polaris_key.devices.keys import (
    DeviceKeyStore,
    FileDeviceKeyStorage,
    InMemoryDeviceKeyStorage,
    create_device_key_store,
)

DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
NOW = 1_700_000_000
SRC = str(Path(__file__).resolve().parents[1] / "src")
posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX modes, owners and symlinks")


def mem() -> DeviceKeyStore:
    return DeviceKeyStore(InMemoryDeviceKeyStorage())


def file_store(tmp_path: Path, sub: str = "state") -> DeviceKeyStore:
    return DeviceKeyStore(FileDeviceKeyStorage(str(tmp_path / sub / "device-keys.json")))


@pytest.fixture()
def tmp(tmp_path: Path) -> Path:
    """A private base directory (pytest's own may be wider than 0700 on some hosts)."""
    base = tmp_path / "base"
    base.mkdir(mode=0o700)
    os.chmod(base, 0o700)
    return base


# ---- the store ---------------------------------------------------------------------------------


def test_makes_one_pair_on_first_need_and_keeps_it() -> None:
    s = mem()
    assert s.public_keys() is None
    a = s.ensure()
    assert a.generation == 1 and len(a.sign_key) == 43 and len(b64url_decode(a.agree_key)) == 32
    assert s.ensure() == a and s.public_keys() == a


def test_sign_before_ensure_is_an_error_and_signatures_verify() -> None:
    s = mem()
    with pytest.raises(DeviceKeyError):
        s.sign(b"x")
    k = s.ensure()
    sig = s.sign(b"hello")
    assert len(sig) == 64
    pub = Ed25519PublicKey.from_public_bytes(b64url_decode(k.sign_key))
    pub.verify(sig, b"hello")


def test_dh_matches_the_peer_and_refuses_low_order_and_wrong_size() -> None:
    a, b = mem(), mem()
    ka, kb = a.ensure(), b.ensure()
    sa = a.dh(b64url_decode(kb.agree_key))
    sb = b.dh(b64url_decode(ka.agree_key))
    assert sa is not None and sa == sb and len(sa) == 32
    low = [bytes(32), b"\x01" + bytes(31), bytes.fromhex("ecff" + "ff" * 29 + "7f"), bytes.fromhex("ecff" + "ff" * 30)]
    low.append(bytes.fromhex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"))
    low.append(bytes.fromhex("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"))
    for p in low:
        assert is_x25519_low_order(p)
        assert a.dh(p) is None
    assert a.dh(b"short") is None
    assert a.dh(bytes(33)) is None
    # a spelling with the high bit set is the same point
    hi = bytearray(bytes(32))
    hi[31] = 0x80
    assert a.dh(bytes(hi)) is None
    assert mem().dh(b64url_decode(ka.agree_key)) is None  # no keys: null, not an error


def test_dh_refuses_an_all_zero_result(monkeypatch: pytest.MonkeyPatch) -> None:
    s = mem()
    s.ensure()

    real = keysmod.X25519PrivateKey.from_private_bytes

    class Z:
        def __init__(self, b: bytes) -> None:
            self._k = real(b)

        def public_key(self) -> Any:
            return self._k.public_key()

        def exchange(self, _peer: Any) -> bytes:
            return bytes(32)

    monkeypatch.setattr(keysmod.X25519PrivateKey, "from_private_bytes", staticmethod(Z))
    peer = X25519PrivateKey.generate().public_key().public_bytes_raw()
    assert s.dh(peer) is None


def test_rotate_makes_a_new_pair_and_counts_the_generation() -> None:
    s = mem()
    a = s.ensure()
    b = s.rotate()
    assert b.generation == 2 and b.sign_key != a.sign_key and b.agree_key != a.agree_key
    assert s.public_keys() == b
    assert mem().rotate().generation == 1  # rotate on an empty store makes the first pair


def test_wipe_deletes_and_the_next_ensure_starts_again() -> None:
    s = mem()
    a = s.ensure()
    s.rotate()
    s.wipe()
    assert s.public_keys() is None
    c = s.ensure()
    assert c.generation == 1 and c.sign_key != a.sign_key


def test_private_halves_are_in_no_repr_no_member_and_no_error() -> None:
    s = mem()
    k = s.ensure()
    raw = s._storage.get()  # type: ignore[attr-defined]
    assert raw is not None
    rec = json.loads(bytes(raw))
    secrets_ = [rec["sign"]["seed"], rec["agree"]["priv"]]
    surfaces = [repr(s), repr(k), repr(s._storage), repr(s.public_keys()), repr(s._load())]  # type: ignore[attr-defined]
    for text in surfaces:
        assert not any(x in text for x in secrets_)
    members = [m.lower() for m in dir(DeviceKeyStore) if not m.startswith("_")]
    assert not any("private" in m or "seed" in m or "secret" in m for m in members)
    # a corrupted record's error text names nothing
    s2 = DeviceKeyStore(InMemoryDeviceKeyStorage())
    s2._storage.update(lambda _c: bytearray(b'{"v":1,"seed":"' + secrets_[0].encode() + b'"'))  # type: ignore[attr-defined]
    with pytest.raises(DeviceKeysUnreadableError) as e:
        s2.ensure()
    assert secrets_[0] not in str(e.value) and secrets_[0] not in repr(e.value)


def test_threads_racing_ensure_agree() -> None:
    s = mem()
    out: List[DevicePublicKeys] = []
    ts = [threading.Thread(target=lambda: out.append(s.ensure())) for _ in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(set(out)) == 1


def test_a_memory_store_reports_memory_and_refuses_registration_unless_allowed() -> None:
    s = mem()
    assert s.persistence() == "memory"
    with pytest.raises(DeviceKeyUnsupportedError):
        sign_keys_proof(s, product=PRODUCT, device_id=DEVICE)
    with pytest.raises(DeviceKeyUnsupportedError):
        build_device_keys_request(s, product=PRODUCT, device_id=DEVICE)
    proof, keys, at = sign_keys_proof(s, product=PRODUCT, device_id=DEVICE, issued_at=NOW, allow_ephemeral=True)
    assert proof.sign_key == keys.sign_key and at == NOW


def test_a_port_without_persistence_is_taken_to_be_durable() -> None:
    inner = mem()

    class Bare:
        ensure = inner.ensure
        public_keys = inner.public_keys
        sign = inner.sign
        dh = inner.dh
        rotate = inner.rotate
        wipe = inner.wipe

    proof, _k, _a = sign_keys_proof(Bare(), product=PRODUCT, device_id=DEVICE, issued_at=NOW)  # type: ignore[arg-type]
    assert verify_device_proof(proof, now=NOW)


# ---- unreadable, unsupported, transient -----------------------------------------------------------

BAD_RECORDS = [
    b"",
    b"not json",
    b"[]",
    b'{"v":2}',
    b'{"v":1,"generation":0}',
    b'{"v":true,"generation":1,"sign":{},"agree":{}}',
    b'{"v":1,"generation":1,"sign":{"seed":"AA","pub":"AA"},"agree":{"priv":"AA","pub":"AA"}}',
]


def _mismatched() -> bytes:
    s = mem()
    s.ensure()
    rec = json.loads(bytes(s._storage.get()))  # type: ignore[attr-defined]
    other = mem()
    other.ensure()
    rec["sign"]["pub"] = json.loads(bytes(other._storage.get()))["sign"]["pub"]  # type: ignore[attr-defined]
    return json.dumps(rec).encode()


@pytest.mark.parametrize("raw", BAD_RECORDS + [None], ids=lambda r: repr(r)[:30])
def test_an_unreadable_record_is_an_error_and_only_wipe_resets_it(tmp: Path, raw: Any) -> None:
    if raw is None:
        raw = _mismatched()
    path = tmp / "state" / "device-keys.json"
    st = FileDeviceKeyStorage(str(path))
    st.update(lambda _c: bytearray(raw))
    before = path.read_bytes()
    s = DeviceKeyStore(st)
    for call in (s.ensure, s.public_keys, s.rotate, lambda: s.sign(b"x"), lambda: s.dh(bytes([9]) + bytes(31))):
        with pytest.raises(DeviceKeysUnreadableError):
            call()
    assert path.read_bytes() == before  # never replaced
    s.wipe()
    assert not path.exists()
    assert s.ensure().generation == 1


def test_an_oversize_record_is_unreadable_not_read(tmp: Path) -> None:
    s = file_store(tmp)
    s.ensure()
    path = tmp / "state" / "device-keys.json"
    path.write_bytes(b"x" * (70 * 1024))
    os.chmod(path, 0o600)
    with pytest.raises(DeviceKeysUnreadableError):
        s.ensure()
    s.wipe()
    assert not path.exists()


def test_an_unsupported_backend_is_unsupported_never_unreadable(tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    s = file_store(tmp)
    k = s.ensure()
    path = tmp / "state" / "device-keys.json"
    before = path.read_bytes()

    def boom(*_a: Any, **_k: Any) -> Any:
        raise UnsupportedAlgorithm("no x25519")

    monkeypatch.setattr(keysmod.X25519PrivateKey, "from_private_bytes", staticmethod(boom))
    for call in (s.ensure, s.public_keys, s.rotate, lambda: s.sign(b"x")):
        with pytest.raises(DeviceKeyUnsupportedError):
            call()
    monkeypatch.undo()
    assert path.read_bytes() == before and s.public_keys() == k

    fresh = file_store(tmp, "other")
    monkeypatch.setattr(keysmod.Ed25519PrivateKey, "generate", staticmethod(boom))
    with pytest.raises(DeviceKeyUnsupportedError):
        fresh.ensure()
    assert not (tmp / "other" / "device-keys.json").exists()  # nothing half-written


@posix_only
def test_a_transient_fault_raises_and_never_reads_as_no_keys(tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    s = file_store(tmp)
    k = s.ensure()
    path = tmp / "state" / "device-keys.json"
    real_open = os.open

    def flaky(p: Any, flags: int, *a: Any, **kw: Any) -> int:
        if str(p) == "device-keys.json" or str(p).endswith("/device-keys.json"):
            raise OSError(5, "I/O error")  # EIO
        return real_open(p, flags, *a, **kw)

    monkeypatch.setattr(keysmod.os, "open", flaky)
    for call in (s.public_keys, s.ensure, s.rotate, lambda: s.sign(b"x")):
        with pytest.raises(DeviceKeyStoreError):
            call()
    monkeypatch.undo()
    assert path.exists() and s.public_keys() == k  # still the same pair, nothing replaced


@posix_only
def test_a_failed_write_leaves_the_old_record_and_no_temporary(tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    s = file_store(tmp)
    k = s.ensure()
    d = tmp / "state"

    def fail(*_a: Any, **_k: Any) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(keysmod.os, "replace", fail)
    with pytest.raises(DeviceKeyStoreError):
        s.rotate()
    monkeypatch.undo()
    assert s.public_keys() == k
    assert [n for n in os.listdir(d) if n.endswith(".tmp")] == []


# ---- the file ----------------------------------------------------------------------------------


@posix_only
def test_the_file_is_0600_in_a_0700_directory(tmp: Path) -> None:
    s = file_store(tmp)
    s.ensure()
    s.rotate()
    d = tmp / "state"
    assert stat.S_IMODE(os.stat(d).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(d / "device-keys.json").st_mode) == 0o600
    assert stat.S_IMODE(os.stat(d / ".device-keys.json.lock").st_mode) == 0o600
    assert s.persistence() == "durable"


@posix_only
def test_a_restrictive_umask_does_not_leave_an_unusable_directory(tmp: Path) -> None:
    old = os.umask(0o277)
    try:
        s = file_store(tmp)
        k = s.ensure()
    finally:
        os.umask(old)
    assert stat.S_IMODE(os.stat(tmp / "state").st_mode) == 0o700
    assert s.public_keys() == k


@posix_only
def test_two_stores_over_one_file_agree_and_survive_a_restart(tmp: Path) -> None:
    a, b = file_store(tmp), file_store(tmp)
    k = a.ensure()
    assert b.ensure() == k and b.rotate().generation == 2 and a.public_keys() == b.public_keys()
    assert file_store(tmp).public_keys() == a.public_keys()


@posix_only
def test_a_loose_directory_or_file_is_refused_and_left_alone(tmp: Path) -> None:
    s = file_store(tmp)
    k = s.ensure()
    d, f = tmp / "state", tmp / "state" / "device-keys.json"
    os.chmod(f, 0o644)
    with pytest.raises(DeviceKeyStoreError):
        s.public_keys()
    os.chmod(f, 0o600)
    os.chmod(d, 0o750)
    with pytest.raises(DeviceKeyStoreError):
        s.ensure()
    assert stat.S_IMODE(os.stat(d).st_mode) == 0o750  # never widened or silently tightened
    os.chmod(d, 0o700)
    assert s.public_keys() == k


@posix_only
def test_a_loose_lock_file_is_refused(tmp: Path) -> None:
    s = file_store(tmp)
    s.ensure()
    lock = tmp / "state" / ".device-keys.json.lock"
    os.chmod(lock, 0o666)
    with pytest.raises(DeviceKeyStoreError):
        s.public_keys()


@posix_only
def test_a_foreign_owned_directory_or_file_is_refused(tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    s = file_store(tmp)
    k = s.ensure()
    real = os.geteuid()
    monkeypatch.setattr(keysmod.os, "geteuid", lambda: real + 1)
    with pytest.raises(DeviceKeyStoreError, match="another user"):
        s.public_keys()
    monkeypatch.undo()
    assert s.public_keys() == k


@posix_only
def test_a_symlink_in_place_of_the_file_or_directory_is_refused(tmp: Path) -> None:
    s = file_store(tmp)
    s.ensure()
    d, f = tmp / "state", tmp / "state" / "device-keys.json"
    target = tmp / "elsewhere.json"
    target.write_bytes(f.read_bytes())
    os.chmod(target, 0o600)
    f.unlink()
    os.symlink(target, f)
    with pytest.raises(DeviceKeyStoreError):
        s.public_keys()
    with pytest.raises(DeviceKeyStoreError):
        s.rotate()
    assert target.exists()
    f.unlink()
    # the directory itself
    moved = tmp / "real"
    d.rename(moved)
    os.symlink(moved, d)
    with pytest.raises(DeviceKeyStoreError):
        s.ensure()


@posix_only
def test_a_symlinked_lock_file_is_refused(tmp: Path) -> None:
    s = file_store(tmp)
    s.ensure()
    lock = tmp / "state" / ".device-keys.json.lock"
    lock.unlink()
    os.symlink(tmp / "x", lock)
    with pytest.raises(DeviceKeyStoreError):
        s.ensure()


@posix_only
def test_a_directory_under_a_writable_unsticky_ancestor_is_refused(tmp: Path) -> None:
    wide = tmp / "wide"
    wide.mkdir()
    os.chmod(wide, 0o777)
    s = DeviceKeyStore(FileDeviceKeyStorage(str(wide / "state" / "device-keys.json")))
    old_home = os.environ.get("HOME")
    os.environ["HOME"] = str(tmp.parent)  # the walk stops at the home directory
    try:
        with pytest.raises(DeviceKeyStoreError, match="others may write"):
            s.ensure()
        os.chmod(wide, 0o777 | stat.S_ISVTX)  # sticky: the /tmp shape, fine
        assert s.ensure().generation == 1
    finally:
        if old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = old_home


@posix_only
def test_stale_temporaries_are_zeroed_and_swept(tmp: Path) -> None:
    s = file_store(tmp)
    s.ensure()
    d = tmp / "state"
    stale = d / ".device-keys.json.deadbeef.tmp"
    stale.write_bytes(b"A" * 200)
    os.chmod(stale, 0o600)
    other = d / "unrelated.tmp"
    other.write_bytes(b"keep")
    fd = os.open(stale, os.O_RDONLY)  # watch the same inode: its bytes are zeros before the unlink
    s.rotate()
    assert not stale.exists() and other.exists()
    assert os.read(fd, 400) == bytes(200)
    os.close(fd)


@posix_only
def test_wipe_zeroes_the_file_before_deleting_it(tmp: Path) -> None:
    s = file_store(tmp)
    s.ensure()
    f = tmp / "state" / "device-keys.json"
    size = f.stat().st_size
    fd = os.open(f, os.O_RDONLY)
    s.wipe()
    assert not f.exists()
    assert os.read(fd, size + 10) == bytes(size)
    os.close(fd)
    assert not any(n.endswith(".tmp") for n in os.listdir(tmp / "state"))


@posix_only
def test_wipe_with_nothing_stored_is_fine_and_sweeps(tmp: Path) -> None:
    s = file_store(tmp)
    s.wipe()
    s.ensure()
    s.wipe()
    s.wipe()
    assert s.public_keys() is None


@posix_only
def test_a_busy_lock_times_out_with_a_store_error_not_no_keys(tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import fcntl

    s = file_store(tmp)
    k = s.ensure()
    lock = tmp / "state" / ".device-keys.json.lock"
    fd = os.open(lock, os.O_RDWR)
    fcntl.flock(fd, fcntl.LOCK_EX)
    monkeypatch.setattr(keysmod, "_LOCK_TIMEOUT_S", 0.2)
    try:
        with pytest.raises(DeviceKeyStoreError, match="lock is busy"):
            s.ensure()
        with pytest.raises(DeviceKeyStoreError):
            s.public_keys()
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    monkeypatch.undo()
    assert s.public_keys() == k


@posix_only
def test_a_lock_left_by_a_dead_process_does_not_block(tmp: Path) -> None:
    code = (
        "import os, sys\n"
        f"sys.path.insert(0, {SRC!r})\n"
        "from polaris_key.devices.keys import DeviceKeyStore, FileDeviceKeyStorage\n"
        f"s = FileDeviceKeyStorage({str(tmp / 'state' / 'device-keys.json')!r})\n"
        "def t(c):\n"
        "    os._exit(0)\n"  # dies holding the lock, no cleanup
        "s.update(t)\n"
    )
    assert subprocess.run([sys.executable, "-I", "-c", code], timeout=60).returncode == 0
    s = file_store(tmp)
    assert s.ensure().generation == 1


_WORKER = """
import json, sys
sys.path.insert(0, {src!r})
from polaris_key.devices.keys import DeviceKeyStore, FileDeviceKeyStorage
s = DeviceKeyStore(FileDeviceKeyStorage({path!r}))
out = []
for _ in range({n}):
    k = s.{op}()
    out.append([k.sign_key, k.agree_key, k.generation])
print(json.dumps(out))
"""


def _run_workers(path: Path, op: str, procs: int, n: int) -> List[List[Any]]:
    code = _WORKER.format(src=SRC, path=str(path), op=op, n=n)
    ps = [
        subprocess.Popen([sys.executable, "-I", "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(procs)
    ]
    rows: List[List[Any]] = []
    for p in ps:
        out, err = p.communicate(timeout=120)
        assert p.returncode == 0, err.decode()[-400:]
        rows += json.loads(out)
    return rows


@posix_only
def test_processes_racing_ensure_make_one_pair(tmp: Path) -> None:
    path = tmp / "state" / "device-keys.json"
    rows = _run_workers(path, "ensure", 5, 3)
    assert len({(r[0], r[1]) for r in rows}) == 1 and {r[2] for r in rows} == {1}


@posix_only
def test_processes_racing_rotate_never_repeat_a_generation(tmp: Path) -> None:
    path = tmp / "state" / "device-keys.json"
    rows = _run_workers(path, "rotate", 4, 4)
    gens = sorted(r[2] for r in rows)
    assert gens == list(range(1, 17))
    assert len({r[0] for r in rows}) == 16  # no pair was made twice
    assert DeviceKeyStore(FileDeviceKeyStorage(str(path))).public_keys().generation == 16  # type: ignore[union-attr]


def test_create_device_key_store_defaults_to_the_state_directory(tmp: Path) -> None:
    s = create_device_key_store(product="djdl", state_dir=str(tmp / "st"))
    s.ensure()
    assert (tmp / "st" / "djdl" / "device-keys.json").is_file()
    assert create_device_key_store(memory=True).persistence() == "memory"
    for bad in (None, "", "../x", "a/b", ".."):
        with pytest.raises(DeviceKeyStoreError):
            create_device_key_store(product=bad)


# ---- the signer --------------------------------------------------------------------------------


def test_signs_every_purpose_and_the_verifier_accepts_it() -> None:
    s = mem()
    keys = s.ensure()
    for purpose in ("nonce", "exchange", "link", "nearby-start", "nearby-poll", "nearby-approve", "vouch", "restore"):
        p = sign_device_proof(
            s, purpose=purpose, product=PRODUCT, device_id=DEVICE, value="v-1", token_hash="-", now=NOW
        )
        assert p.sign_key == keys.sign_key
        assert verify_device_proof(p, now=NOW)
        assert device_proof_message(p) == f"pkey-proof/1\n{purpose}\n{PRODUCT}\n{DEVICE}\nv-1\n-".encode()
    with_token = sign_device_proof(s, purpose="link", product=PRODUCT, device_id=DEVICE, value="v", token_hash="abc_-9")
    assert with_token.token_hash == "abc_-9"


def test_refuses_a_field_that_breaks_the_line_format() -> None:
    s = mem()
    for kw in ({"value": "a\nb"}, {"value": ""}, {"device_id": "a b"}, {"product": "dj\ndl"}, {"token_hash": "é"}):
        args = dict(purpose="nonce", product=PRODUCT, device_id=DEVICE, value="v")
        args.update(kw)
        with pytest.raises(DeviceProofError):
            sign_device_proof(s, **args)  # type: ignore[arg-type]
    with pytest.raises(DeviceProofError):
        sign_device_proof(s, purpose="bogus", product=PRODUCT, device_id=DEVICE, value="v")
    for bad in ("", "Djdl", "dj dl", "-x", "a" * 65, "djdl\n"):
        with pytest.raises(DeviceProofError):
            sign_keys_proof(s, product=bad, device_id=DEVICE, allow_ephemeral=True)
    with pytest.raises(DeviceProofError):
        sign_keys_proof(s, product=PRODUCT, device_id=DEVICE, issued_at=-1, allow_ephemeral=True)


def test_refuses_when_the_keys_change_while_signing() -> None:
    inner = mem()

    class Rotating:
        ensure = inner.ensure
        public_keys = inner.public_keys
        dh = inner.dh
        wipe = inner.wipe
        persistence = inner.persistence

        def sign(self, m: bytes) -> bytes:
            sig = inner.sign(m)
            inner.rotate()
            return sig

        def rotate(self) -> DevicePublicKeys:
            return inner.rotate()

    with pytest.raises(DeviceProofError, match="changed while signing"):
        sign_device_proof(Rotating(), purpose="nonce", product=PRODUCT, device_id=DEVICE, value="v")  # type: ignore[arg-type]


def test_refuses_a_port_whose_signature_does_not_verify() -> None:
    inner = mem()

    class Liar:
        ensure = inner.ensure
        public_keys = inner.public_keys
        dh = inner.dh
        wipe = inner.wipe
        rotate = inner.rotate
        persistence = inner.persistence

        def sign(self, m: bytes) -> bytes:
            return bytes(64)

    with pytest.raises(DeviceProofError, match="did not verify"):
        sign_device_proof(Liar(), purpose="nonce", product=PRODUCT, device_id=DEVICE, value="v")  # type: ignore[arg-type]


def test_the_keys_proof_names_the_current_keys_and_the_request_body_is_right() -> None:
    s = mem()
    path, body = build_device_keys_request(s, product=PRODUCT, device_id=DEVICE, issued_at=NOW, allow_ephemeral=True)
    k = s.public_keys()
    assert k is not None
    assert path == f"/{PRODUCT}/devices/keys"
    assert body.to_json() == {"signKey": k.sign_key, "agreeKey": k.agree_key, "issuedAt": NOW, "sig": body.sig}
    proof = DeviceProof("keys", PRODUCT, DEVICE, f"{k.sign_key}.{k.agree_key}.{NOW}", "-", k.sign_key, body.sig)
    assert verify_device_proof(proof, now=NOW) and not verify_device_proof(proof, now=NOW + 301)
    rotated = s.rotate()
    _p, body2 = build_device_keys_request(s, product=PRODUCT, device_id=DEVICE, issued_at=NOW, allow_ephemeral=True)
    assert body2.sign_key == rotated.sign_key != k.sign_key
    # the same keys, signed again (Ed25519 is deterministic): a resend is byte-identical
    _p, body3 = build_device_keys_request(s, product=PRODUCT, device_id=DEVICE, issued_at=NOW, allow_ephemeral=True)
    assert body3 == body2


# ---- the client helper -------------------------------------------------------------------------


def _durable(tmp: Path) -> DeviceKeyStore:
    return file_store(tmp)


@posix_only
def test_register_keys_sends_the_put_with_the_bearer_and_returns_the_key_seq(tmp: Path) -> None:
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        if r.method == "PUT" and r.url.path == f"/{PRODUCT}/devices/keys":
            seen["body"] = json.loads(r.content)
            seen["auth"] = r.headers.get("authorization")
            seen["device"] = r.headers.get("X-PKey-Device")
            return httpx.Response(200, json={"keySeq": 3})
        return httpx.Response(404)

    c = make_client(handler)
    c._tokens.set(TOKEN)
    port = _durable(tmp)
    out = c.devices.register_keys(port)
    assert out.key_seq == 3
    k = port.public_keys()
    assert k is not None
    b = seen["body"]
    assert set(b) == {"signKey", "agreeKey", "issuedAt", "sig"}
    assert (b["signKey"], b["agreeKey"]) == (k.sign_key, k.agree_key)
    assert seen["auth"] == f"Bearer {TOKEN}" and seen["device"] == c.core.device_id
    value = f"{b['signKey']}.{b['agreeKey']}.{b['issuedAt']}"
    proof = DeviceProof("keys", PRODUCT, c.core.device_id, value, "-", b["signKey"], b["sig"])
    assert verify_device_proof(proof, now=b["issuedAt"])
    assert "seed" not in json.dumps(b) and "priv" not in json.dumps(b)
    c.close()


def test_register_keys_refuses_a_memory_port_without_a_credential_and_on_refusal(tmp: Path) -> None:
    calls: List[str] = []

    def handler(r: httpx.Request) -> httpx.Response:
        calls.append(r.method)
        if r.url.path.endswith("/devices/keys"):
            return httpx.Response(429, json={"error": "rate_limited", "message": "slow down"})
        return httpx.Response(404)

    c = make_client(handler)
    with pytest.raises(DeviceManagementUnsupportedError):
        c.devices.register_keys(mem(), allow_ephemeral=True)
    c._tokens.set(TOKEN)
    with pytest.raises(DeviceKeyUnsupportedError):
        c.devices.register_keys(mem())
    assert calls == []  # nothing was sent for either
    with pytest.raises(DeviceRefusedError) as e:
        c.devices.register_keys(mem(), allow_ephemeral=True)
    assert e.value.code == "rate_limited" and e.value.status == 429
    c.close()


@pytest.mark.parametrize("answer", [{}, {"keySeq": 0}, {"keySeq": "3"}, {"keySeq": True}, {"keySeq": 1.5}])
def test_register_keys_rejects_an_answer_without_a_key_seq(answer: Dict[str, Any]) -> None:
    c = make_client(lambda r: httpx.Response(200, json=answer))
    c._tokens.set(TOKEN)
    with pytest.raises(PolarisError) as e:
        c.devices.register_keys(mem(), allow_ephemeral=True)
    assert e.value.code == "bad_response" or e.value.code == "bad-response"
    c.close()
