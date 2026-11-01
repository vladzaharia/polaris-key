# @pkey-feature connect.transfer
"""The partial-file store (WIRE-CONTRACT-V5 §15.11, plan D-19): files named only by the derived path,
owner-only modes, a 24 h life, atomic delivery into the host's destination, purge by peer and for all."""

from __future__ import annotations

import hashlib
import os
import stat
import sys
from pathlib import Path
from typing import Any, List

import pytest

from polaris_key.connect.transfer_store import PartialStore, peer_tag
from polaris_key.core.peer_xfer import XFER_PARTIAL_SECONDS, xfer_partial_path

KEY = bytes(range(32))
OTHER = bytes(range(1, 33))
ID = "mM6QZzGG1pHeEeIOBHXPjQ"
SHA = "578091f7924f577fb22f2776d28666ce51346719ec816cb87aaf09a88e26c55d"
META = {"id": ID, "sha256": SHA, "size": 100, "chunk": 10}


class Clock:
    t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


def _make(tmp: Path, clock: Any) -> PartialStore:
    return PartialStore(str(tmp / "transfers"), clock)


def test_a_partial_is_named_by_its_derived_path_and_lists_for_its_peer(tmp_path: Path) -> None:
    c = Clock()
    s = _make(tmp_path, c)
    ref = xfer_partial_path(KEY, ID, SHA)
    s.apply(KEY, {"create": ref}, META)
    s.apply(KEY, {"write": ref, "offset": 0, "data": b"x" * 50})
    s.apply(KEY, {"keep": ref})
    assert sorted(os.listdir(tmp_path / "transfers")) == sorted([ref, "index.json"])
    got = s.partials(KEY)
    assert got == [
        {"ref": ref, "id": ID, "sha256": SHA, "size": 100, "chunk": 10, "bytes": 50, "writtenAt": c.t}
    ]
    assert s.partials(OTHER) == []
    assert s.partials(KEY, {ref})[0]["held"] is True
    # the index names a peer by a hash, never by the key
    raw = (tmp_path / "transfers" / "index.json").read_bytes()
    assert KEY.hex().encode() not in raw and peer_tag(KEY).encode() in raw
    if sys.platform != "win32":
        assert stat.S_IMODE(os.stat(tmp_path / "transfers").st_mode) == 0o700
        assert stat.S_IMODE(os.stat(tmp_path / "transfers" / ref).st_mode) == 0o600
    # a new process reads it back
    s2 = _make(tmp_path, c)
    assert s2.partials(KEY)[0]["bytes"] == 50


def test_rehash_truncate_and_a_ref_that_is_not_a_derived_path(tmp_path: Path) -> None:
    s = _make(tmp_path, Clock())
    ref = xfer_partial_path(KEY, ID, SHA)
    s.apply(KEY, {"create": ref}, META)
    s.apply(KEY, {"write": ref, "offset": 0, "data": bytes(range(80))})
    h = s.rehash(ref, 60)
    assert h.hexdigest() == hashlib.sha256(bytes(range(60))).hexdigest()
    s.apply(KEY, {"truncate": ref, "to": 60})
    assert os.path.getsize(tmp_path / "transfers" / ref) == 60
    for bad in ("../x", "report.pdf", "A" * 64, ref + "0"):
        with pytest.raises(ValueError):
            s.apply(KEY, {"create": bad}, META)


def test_a_partial_expires_after_a_day(tmp_path: Path) -> None:
    c = Clock()
    s = _make(tmp_path, c)
    ref = xfer_partial_path(KEY, ID, SHA)
    s.apply(KEY, {"create": ref}, META)
    s.apply(KEY, {"keep": ref})
    c.t += XFER_PARTIAL_SECONDS - 1
    assert len(s.partials(KEY)) == 1
    c.t += 2
    assert s.partials(KEY) == []
    assert os.listdir(tmp_path / "transfers") == ["index.json"]


def test_a_file_no_record_holds_is_swept(tmp_path: Path) -> None:
    s = _make(tmp_path, Clock())
    s.sweep()
    stray = tmp_path / "transfers" / ("ab" * 32)
    stray.write_bytes(b"x")
    keep = tmp_path / "transfers" / "notes.txt"  # not a partial name: left alone
    keep.write_bytes(b"x")
    s.sweep()
    s2 = _make(tmp_path, Clock())
    s2.sweep()
    assert not stray.exists() and keep.exists()


def _filled(s: PartialStore, data: bytes) -> str:
    ref = xfer_partial_path(KEY, ID, SHA)
    s.apply(KEY, {"create": ref}, META)
    s.apply(KEY, {"write": ref, "offset": 0, "data": data})
    return ref


def test_delivery_is_a_rename_into_the_hosts_choice_and_never_over_a_file(tmp_path: Path) -> None:
    s = _make(tmp_path, Clock())
    out = tmp_path / "out"
    out.mkdir()
    ref = _filled(s, b"content")
    dest = out / "chosen.bin"
    dest.write_bytes(b"mine")
    with pytest.raises(FileExistsError):
        s.deliver(ref, str(dest))
    assert dest.read_bytes() == b"mine" and [p.name for p in out.iterdir()] == ["chosen.bin"]  # no temp left
    s.deliver(ref, str(dest), overwrite=True)
    assert dest.read_bytes() == b"content"
    assert [p.name for p in out.iterdir()] == ["chosen.bin"]
    assert os.listdir(tmp_path / "transfers") == ["index.json"]
    assert s.destination_ok(str(out / "x")) and not s.destination_ok(str(out / "no" / "x"))


def test_purge_one_peer_or_all(tmp_path: Path) -> None:
    s = _make(tmp_path, Clock())
    a = _filled(s, b"1")
    b = xfer_partial_path(OTHER, ID, SHA)
    s.apply(OTHER, {"create": b}, META)
    s.purge(KEY)
    assert sorted(os.listdir(tmp_path / "transfers")) == sorted([b, "index.json"])
    assert not (tmp_path / "transfers" / a).exists()
    s.purge()
    assert os.listdir(tmp_path / "transfers") == ["index.json"]
    PartialStore(str(tmp_path / "never")).purge()  # nothing there: nothing to do
    assert not (tmp_path / "never").exists()


def test_free_space_leaves_a_reserve(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import shutil
    from collections import namedtuple

    U = namedtuple("U", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda p: U(10**12, 0, 512 * 1024 * 1024))
    s = _make(tmp_path, Clock())
    assert s.free() == 256 * 1024 * 1024
    monkeypatch.setattr(shutil, "disk_usage", lambda p: U(10**9, 0, 1000))
    assert s.free() == 0


def test_a_corrupt_index_is_dropped_not_trusted(tmp_path: Path) -> None:
    d = tmp_path / "transfers"
    d.mkdir()
    (d / "index.json").write_bytes(b"{not json")
    s = PartialStore(str(d), Clock())
    assert s.partials(KEY) == []
    lst: List[Any] = os.listdir(d)
    assert "index.json" in lst


def _usage(monkeypatch: pytest.MonkeyPatch, free: int) -> None:
    import shutil
    from collections import namedtuple

    U = namedtuple("U", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda p: U(10**12, 0, free))


def test_accepted_sizes_are_reserved_and_released(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from polaris_key.connect.transfer_store import FREE_RESERVE_BYTES, StoreRefused

    _usage(monkeypatch, FREE_RESERVE_BYTES + 150)
    s = _make(tmp_path, Clock())
    a, b = object(), object()
    ra = xfer_partial_path(KEY, ID, SHA)
    rb = xfer_partial_path(OTHER, ID, SHA)
    assert s.free() == 150
    s.apply(KEY, {"create": ra}, META, owner=a)  # promises 100
    assert s.free() == 50
    with pytest.raises(StoreRefused):  # four offers that each passed the offer-time check cannot all fit
        s.apply(OTHER, {"create": rb}, META, owner=b)
    # a write past the promised size is refused; writes inside it lower the promise
    with pytest.raises(StoreRefused):
        s.apply(KEY, {"write": ra, "offset": 0, "data": b"x" * 101}, owner=a)
    s.apply(KEY, {"write": ra, "offset": 0, "data": b"x" * 60}, owner=a)
    assert s.free() == 110
    s.apply(KEY, {"keep": ra}, owner=a)  # the partial stays, the rest of the promise goes
    assert s.free() == 150
    s.apply(OTHER, {"create": rb}, META, owner=b)


def test_a_session_cannot_touch_the_partial_another_holds(tmp_path: Path) -> None:
    from polaris_key.connect.transfer_store import StoreRefused

    s = _make(tmp_path, Clock())
    a, b = object(), object()
    ref = xfer_partial_path(KEY, ID, SHA)
    s.apply(KEY, {"create": ref}, META, owner=a)
    assert s.partials(KEY)[0]["held"] is True
    s.apply(KEY, {"evict": ref}, owner=b)  # not b's: ignored
    s.apply(KEY, {"delete": ref}, owner=b)
    assert (tmp_path / "transfers" / ref).exists()
    with pytest.raises(StoreRefused):
        s.apply(KEY, {"write": ref, "offset": 0, "data": b"x"}, owner=b)
    with pytest.raises(OSError):
        s.rehash(ref, 0, b)
    s.release_owner(a)
    assert "held" not in s.partials(KEY)[0]


def test_create_and_truncate_by_another_owner_are_refused(tmp_path: Path) -> None:
    from polaris_key.connect.transfer_store import StoreRefused

    s = _make(tmp_path, Clock())
    a, b = object(), object()
    ref = xfer_partial_path(KEY, ID, SHA)
    s.apply(KEY, {"create": ref}, META, owner=a)
    s.apply(KEY, {"write": ref, "offset": 0, "data": b"x" * 40}, owner=a)
    with pytest.raises(StoreRefused):
        s.apply(KEY, {"create": ref}, META, owner=b)
    with pytest.raises(StoreRefused):
        s.apply(KEY, {"truncate": ref, "to": 0}, owner=b)
    # Nothing of the holder's partial changed: it is still 40 bytes long when the holder lets go.
    s.apply(KEY, {"keep": ref}, owner=a)
    s.apply(KEY, {"truncate": ref, "to": 10}, owner=b)
    s.apply(KEY, {"keep": ref}, owner=b)
    assert (tmp_path / "transfers" / ref).read_bytes() == b"x" * 10


def test_rehash_of_a_missing_or_short_partial_raises(tmp_path: Path) -> None:
    s = _make(tmp_path, Clock())
    ref = _filled(s, b"x" * 10)
    with pytest.raises(OSError):
        s.rehash(ref, 50)
    os.unlink(tmp_path / "transfers" / ref)
    with pytest.raises(OSError):
        s.rehash(ref, 5)


def test_no_late_effect_recreates_what_a_purge_removed(tmp_path: Path) -> None:
    from polaris_key.connect.transfer_store import StoreRefused

    s = _make(tmp_path, Clock())
    e = s.epoch(KEY)
    ref = xfer_partial_path(KEY, ID, SHA)
    s.purge(KEY)
    with pytest.raises(StoreRefused):
        s.apply(KEY, {"create": ref}, META, epoch=e)
    e2 = s.epoch(KEY)
    s.purge()
    with pytest.raises(StoreRefused):
        s.apply(KEY, {"create": ref}, META, epoch=e2)
    s.apply(KEY, {"create": ref}, META, epoch=s.epoch(KEY))  # a session that starts afterwards is fine


def test_accepted_transfers_cannot_pass_the_quota_or_the_disk_reserve(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from polaris_key.connect.transfer_store import DEFAULT_QUOTA_BYTES, FREE_RESERVE_BYTES, StoreRefused

    assert DEFAULT_QUOTA_BYTES == 4 * 1024**3 and FREE_RESERVE_BYTES == 256 * 1024**2
    # plenty of disk: the 4 GiB quota binds, across four accepted transfers
    _usage(monkeypatch, 10**13)
    s = PartialStore(str(tmp_path / "transfers"), Clock())
    big = {**META, "size": 1024**3}
    owners = [object() for _ in range(5)]
    keys = [bytes([i]) * 32 for i in range(5)]
    for i in range(4):
        s.apply(keys[i], {"create": xfer_partial_path(keys[i], ID, SHA)}, big, owner=owners[i])
    assert s.free() == 0
    with pytest.raises(StoreRefused):
        s.apply(keys[4], {"create": xfer_partial_path(keys[4], ID, SHA)}, {**META, "size": 1}, owner=owners[4])
    # a host-set quota is honoured, and the disk reserve binds when the disk is tight
    small = PartialStore(str(tmp_path / "t2"), Clock(), quota_bytes=1000)
    assert small.free() == 1000
    with pytest.raises(StoreRefused):
        small.apply(KEY, {"create": xfer_partial_path(KEY, ID, SHA)}, {**META, "size": 1001}, owner=object())
    _usage(monkeypatch, FREE_RESERVE_BYTES + 10)
    tight = PartialStore(str(tmp_path / "t3"), Clock())
    with pytest.raises(StoreRefused):
        tight.apply(KEY, {"create": xfer_partial_path(KEY, ID, SHA)}, {**META, "size": 11}, owner=object())


@pytest.mark.skipif(sys.platform == "win32", reason="symbolic links")
def test_a_symbolic_link_in_place_of_a_partial_is_not_followed(tmp_path: Path) -> None:
    s = _make(tmp_path, Clock())
    ref = xfer_partial_path(KEY, ID, SHA)
    s.apply(KEY, {"create": ref}, META)
    target = tmp_path / "elsewhere"
    target.write_bytes(b"secret")
    os.unlink(tmp_path / "transfers" / ref)
    os.symlink(target, tmp_path / "transfers" / ref)
    with pytest.raises(OSError):
        s.apply(KEY, {"write": ref, "offset": 0, "data": b"x"})
    with pytest.raises(OSError):
        s.rehash(ref, 3)
    assert target.read_bytes() == b"secret"


def test_a_symlinked_transfer_directory_is_refused(tmp_path: Path) -> None:
    from polaris_key.connect.transfer_store import StoreRefused

    target = tmp_path / "elsewhere"
    target.mkdir()
    target.chmod(0o755)
    os.symlink(target, tmp_path / "transfers")
    s = _make(tmp_path, Clock())
    with pytest.raises(StoreRefused):
        s.apply(KEY, {"create": xfer_partial_path(KEY, ID, SHA)}, META)
    assert os.listdir(target) == []
    if sys.platform != "win32":
        assert stat.S_IMODE(target.stat().st_mode) == 0o755


def test_only_the_session_holding_a_partial_delivers_it(tmp_path: Path) -> None:
    from polaris_key.connect.transfer_store import StoreRefused

    s = _make(tmp_path, Clock())
    a, b = object(), object()
    ref = xfer_partial_path(KEY, ID, SHA)
    s.apply(KEY, {"create": ref}, META, owner=a)
    s.apply(KEY, {"write": ref, "offset": 0, "data": b"content"}, owner=a)
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(StoreRefused):
        s.deliver(ref, str(out / "x"), owner=b)
    assert list(out.iterdir()) == []
    s.deliver(ref, str(out / "x"), owner=a)
    assert (out / "x").read_bytes() == b"content"


def test_a_peer_whose_kept_transfers_cannot_be_deleted_is_logged_and_tried_again(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    import logging

    from polaris_key.connect.transfer import Transfer

    t = Transfer(lambda: str(tmp_path))
    store = t._get_store(create=True)  # noqa: SLF001 - the facade makes it on first use
    assert store is not None
    ref = xfer_partial_path(KEY, ID, SHA)
    store.apply(KEY, {"create": ref}, META)
    store.apply(KEY, {"keep": ref})

    real = PartialStore.purge
    calls: List[Any] = []

    def failing(self: PartialStore, peer_key: Any = None) -> None:
        calls.append(peer_key)
        raise PermissionError("secret-path-" + KEY.hex())

    monkeypatch.setattr(PartialStore, "purge", failing)
    with caplog.at_level(logging.WARNING, logger="polaris_key"):
        t.forget_peer(KEY)  # does not raise
    assert len(calls) == 1
    # Logged without the key or the error's text.
    assert "PermissionError" in caplog.text and KEY.hex() not in caplog.text and "secret-path" not in caplog.text
    assert len(store.partials(KEY)) == 1

    # The next start tries again, and a success is not tried a third time.
    monkeypatch.setattr(PartialStore, "purge", real)
    t.retry_forgotten()
    assert store.partials(KEY) == []
    monkeypatch.setattr(PartialStore, "purge", failing)
    t.retry_forgotten()
    assert len(calls) == 1
