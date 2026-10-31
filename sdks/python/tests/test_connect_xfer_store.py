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
    monkeypatch.setattr(shutil, "disk_usage", lambda p: U(10**9, 0, 10**8))
    s = _make(tmp_path, Clock())
    assert s.free() == 10**8 - 64 * 1024 * 1024
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
