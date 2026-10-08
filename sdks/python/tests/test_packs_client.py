# @pkey-feature packs.state packs.handlers packs.record packs.revoke update.content packs.delegation packs.provides packs.delta.feed
"""``client.update.packs`` end to end against a fake byte server (P4-07 acceptance; a port of
``@polaris-key/node``'s ``test/packs.test.ts``): a ``files.tree`` pack installed from its pinned
record into the platform data directory, updated by the file strategy, resumed after a dropped
connection, served from an embedded baseline, and its ``packSetId`` reported through
``devices/report`` as ``content``. Plus the directory store's own guarantees: a torn or
unreadable ``state.json``, an unreadable payload, and a listing that never answers partially.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from typing import Any, Dict, Iterator, List, Optional, Tuple

import httpx
import pytest

from helpers import BASE_URL, TOKEN, make_client
from pack_fixtures import (
    PRODUCT,
    PROBE_BASE,
    PROBE_FRAME,
    PROBE_TARGET,
    content_key_pair,
    delegation_for,
    PRODUCT_TRUST,
    RELEASE_KEYS,
    TreePack,
    marker_for,
    revocation_for,
    sign_feed_doc,
    sign_release_doc,
    sha,
    stamp_for,
    tree_pack,
)
from polaris_key.devices.store import InMemoryStore
from polaris_key.update import UpdateClientOptions
from polaris_key.update.packs import PackError, PackHandler, pack_set_id
from polaris_key.update.packs.client import EmbeddedPack, PacksOptions
from polaris_key.update.packs.storage import DirPackStorage, measure_file

V1_FILES = {
    "fr/strings.json": '{"hello":"bonjour"}',
    "fr/menu.json": '{"play":"jouer"}',
    "big.bin": "x" * 60000,
}

_IS_ROOT = hasattr(os, "getuid") and os.getuid() == 0


class _Dropping(httpx.SyncByteStream):
    def __init__(self, data: bytes, n: int) -> None:
        self._data = data
        self._n = n

    def __iter__(self) -> Iterator[bytes]:
        yield self._data[: self._n]
        raise httpx.ReadError("connection reset")


class FakeServer:
    """A Worker stand-in: discovery, records by hash, blobs by hash (Range, If-Range) and
    ``devices/report``. ``drop_on`` cuts the n-th blob body after ``drop_at`` bytes."""

    def __init__(self) -> None:
        self.packs: List[TreePack] = []
        self.seen: List[Dict[str, Any]] = []
        self.reports: List[Any] = []
        self.blob_count = 0
        self.drop_on: Optional[int] = None
        self.drop_at = 0
        self.blob_status: Optional[int] = None
        #: When set, the record route answers this status instead of the record.
        self.record_status: Optional[int] = None
        #: The signed channel feed ``update/{channel}/feed.jws`` answers, and extra records.
        self.feed: Optional[str] = None
        self.records: Dict[str, str] = {}

    def discovery(self) -> Dict[str, Any]:
        b = BASE_URL
        return {
            "version": 2,
            "protocolVersion": 4,
            "product": PRODUCT,
            "baseUrl": b,
            "services": {
                "license": {"enabled": False},
                "config": {"enabled": False},
                "release": {"enabled": True, "endpoints": {"record": f"{b}/{PRODUCT}/release/records/{{sha256}}"}},
                "distribution": {
                    "enabled": True,
                    "endpoints": {"blobs": f"{b}/{PRODUCT}/distribution/blobs/sha256/{{sha256}}"},
                },
                "update": {"enabled": True, "endpoints": {"feed": f"{b}/{PRODUCT}/update/{{channel}}/feed.jws"}},
                "identity": {"enabled": False},
            },
        }

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        self.seen.append(
            {
                "path": path,
                "range": req.headers.get("range"),
                "ifRange": req.headers.get("if-range"),
                "auth": req.headers.get("authorization"),
            }
        )
        if path == f"/{PRODUCT}/.well-known/polaris.json":
            return httpx.Response(200, json=self.discovery())
        if re.fullmatch(r"/djdl/update/[a-z0-9-]+/feed\.jws", path):
            if self.feed is None:
                return httpx.Response(404)
            return httpx.Response(200, content=self.feed.encode(), headers={"content-type": "application/jose"})
        m = re.fullmatch(r"/djdl/release/records/([0-9a-f]{64})", path)
        if m and self.record_status is not None:
            return httpx.Response(self.record_status, json={"error": {"code": "internal_error"}})
        if m and m.group(1) in self.records:
            return httpx.Response(
                200, content=self.records[m.group(1)].encode(), headers={"content-type": "application/jose"}
            )
        if m:
            p = next((x for x in self.packs if x.record_sha256 == m.group(1)), None)
            if p is None:
                return httpx.Response(404)
            return httpx.Response(200, content=p.jws.encode(), headers={"content-type": "application/jose"})
        m = re.fullmatch(r"/djdl/distribution/blobs/sha256/([0-9a-f]{64})", path)
        if m:
            h = m.group(1)
            self.blob_count += 1
            if self.blob_status is not None:
                return httpx.Response(self.blob_status, json={"error": {"code": "delivery_gate_missing"}})
            data = next((p.objects[h] for p in self.packs if h in p.objects), None)
            if data is None:
                return httpx.Response(404)
            etag = f'"{h}"'
            rng, if_range = req.headers.get("range"), req.headers.get("if-range")
            start, status = 0, 200
            if rng and (if_range is None or if_range == etag):
                start = int(re.fullmatch(r"bytes=(\d+)-", rng).group(1))  # type: ignore[union-attr]
                status = 206
            body = data[start:]
            headers = {"etag": etag, "accept-ranges": "bytes"}
            if status == 206:
                headers["content-range"] = f"bytes {start}-{len(data) - 1}/{len(data)}"
            if self.drop_on is not None and self.blob_count == self.drop_on:
                self.drop_on = None
                return httpx.Response(status, headers=headers, stream=_Dropping(body, self.drop_at))
            return httpx.Response(status, headers=headers, content=body)
        if path == f"/{PRODUCT}/devices/report" and req.method == "POST":
            self.reports.append(json.loads(req.content))
            return httpx.Response(200, json={})
        return httpx.Response(404)

    def blob_requests(self) -> List[Dict[str, Any]]:
        return [s for s in self.seen if "/distribution/blobs/" in s["path"]]


@pytest.fixture
def srv() -> FakeServer:
    return FakeServer()


def client(
    srv: FakeServer,
    work: Any,
    stamp: List[TreePack],
    *,
    embedded: Optional[List[Any]] = None,
    token: bool = True,
    stamp_doc: Optional[Dict[str, Any]] = None,
    store: Optional[InMemoryStore] = None,
    handlers: Optional[List[Any]] = None,
) -> Any:
    stamp_path = work / f"stamp-{'-'.join(p.version for p in stamp)}.json"
    body = stamp_doc if stamp_doc is not None else stamp_for(*stamp)
    stamp_path.write_text(json.dumps({"format": "pkey-content/1", **body}))
    if store is None:
        store = InMemoryStore(PRODUCT)
    if token:
        store.set_token(TOKEN)
    c = make_client(
        srv,
        store=store,
        trust=PRODUCT_TRUST,
        data_dir=str(work / "data"),
        expected_services=["release", "distribution", "update"],
        update=UpdateClientOptions(
            pinned_release_keys=RELEASE_KEYS,
            outlet="direct",
            packs=PacksOptions(
                content_stamp=str(stamp_path),
                embedded=embedded or (),
                exclude_from_backup=False,
                handlers=handlers or (),
            ),
        ),
    )
    c.discover()
    return c


def tree_on_disk(root: str, files: Dict[str, bytes]) -> bool:
    for p, b in files.items():
        with open(os.path.join(root, *p.split("/")), "rb") as f:
            if f.read() != b:
                return False
    return True


def test_installs_from_fake_byte_server_and_reports_pack_set_id(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    c = client(srv, tmp_path, [v1])
    phases: List[str] = []
    c.update.packs.on(lambda e: phases.append(e.phase))
    (install,) = c.update.packs.ensure(["djdl.l10n"])
    assert install["recordSha256"] == v1.record_sha256
    d = c.update.packs.path("djdl.l10n")
    assert d == os.path.join(str(tmp_path / "data"), PRODUCT, "packs", "store", "djdl.l10n", v1.tree_digest)
    assert tree_on_disk(d, v1.files)
    assert "done" in phases
    # The device bearer goes to the control plane's own origin.
    assert all(s["auth"] == f"Bearer {TOKEN}" for s in srv.blob_requests())
    assert c.devices.report() is True
    want = pack_set_id([{"packId": "djdl.l10n", "releaseSha256": v1.record_sha256}])
    assert [r.get("content") for r in srv.reports] == [{"packSetId": want}]
    assert c.update.packs.state().active["djdl.l10n"]["version"] == "1.0.0"
    assert c.update.packs.zstd().patch_methods == ["zstd-patch-from"]
    c.close()


def test_file_strategy_after_relaunch_and_resume_with_range(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    v2 = tree_pack(
        "djdl.l10n", "1.1.0", 2, {**V1_FILES, "fr/strings.json": '{"hello":"salut"}', "big2.bin": "y" * 40000}
    )
    srv.packs = [v1, v2]
    c = client(srv, tmp_path, [v1])
    c.update.packs.ensure(["djdl.l10n"])
    c.close()

    # A relaunch on the v2 build: the second blob after the index drops after 1,000 bytes.
    c = client(srv, tmp_path, [v2])
    srv.blob_count = 0
    srv.drop_on, srv.drop_at = 2, 1000
    with pytest.raises(PackError) as ex:
        c.update.packs.ensure(["djdl.l10n"])
    assert ex.value.code == "network-error"
    c.close()

    srv.seen.clear()
    c = client(srv, tmp_path, [v2])
    (install,) = c.update.packs.ensure(["djdl.l10n"])
    assert install["version"] == "1.1.0"
    assert tree_on_disk(c.update.packs.path("djdl.l10n"), v2.files)
    resumed = next(s for s in srv.blob_requests() if s["range"] is not None)
    assert resumed["range"] == "bytes=1000-"
    assert re.fullmatch(r'"[0-9a-f]{64}"', resumed["ifRange"])
    assert not any(s["path"].endswith(v2.full_sha256) for s in srv.blob_requests())
    assert c.update.packs.state().previous["djdl.l10n"]["version"] == "1.0.0"
    c.close()


def test_a_403_from_the_blob_route_is_a_failed_fetch(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    srv.blob_status = 403
    c = client(srv, tmp_path, [v1])
    with pytest.raises(PackError) as ex:
        c.update.packs.ensure(["djdl.l10n"])
    assert ex.value.code == "network-error"
    c.close()


def test_embedded_baseline_fetches_nothing(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    emb = tmp_path / "app" / "pkey_packs" / "djdl.l10n"
    for p, b in v1.files.items():
        target = emb.joinpath(*p.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b)
    (emb / ".pkey").mkdir(parents=True, exist_ok=True)
    (emb / ".pkey" / "pack.json").write_text(marker_for(v1))
    c = client(srv, tmp_path, [v1], embedded=[EmbeddedPack(path=str(emb))])
    assert c.update.packs.refused_embedded() == []
    (install,) = c.update.packs.ensure(["djdl.l10n"])
    assert install["embedded"] is True
    assert c.update.packs.path("djdl.l10n") == str(emb)
    assert srv.blob_requests() == []
    c.close()


def test_not_configured_without_stamp_and_content_stamp_invalid(srv: FakeServer, tmp_path: Any) -> None:
    c = make_client(
        srv,
        trust=PRODUCT_TRUST,
        data_dir=str(tmp_path / "data"),
        expected_services=["release", "distribution", "update"],
        update=UpdateClientOptions(pinned_release_keys=RELEASE_KEYS, outlet="direct"),
    )
    with pytest.raises(PackError) as ex:
        c.update.packs.ensure(["djdl.l10n"])
    assert ex.value.code == "not-configured"
    assert c.update.packs.pack_set_id() is None
    c.close()
    bad = make_client(
        srv,
        trust=PRODUCT_TRUST,
        data_dir=str(tmp_path / "data"),
        expected_services=["release", "distribution", "update"],
        update=UpdateClientOptions(
            pinned_release_keys=RELEASE_KEYS,
            outlet="direct",
            packs=PacksOptions(content_stamp=b'{"format":"pkey-content/2"}'),
        ),
    )
    with pytest.raises(PackError) as ex:
        bad.update.packs.ensure(["djdl.l10n"])
    assert ex.value.code == "content-stamp-invalid"
    bad.close()


def test_embedded_single_file_reads_from_the_file_itself(tmp_path: Any) -> None:
    f = tmp_path / "levels.pck"
    f.write_bytes(b"payload bytes")
    storage = DirPackStorage(str(tmp_path / "packs"))
    m = measure_file(str(f))
    install = {
        "packId": "djdl.levels",
        "record": "x",
        "recordSha256": m["sha256"],
        "version": "1.0.0",
        "seq": 1,
        "type": "custom.blob",
        "variant": "",
        "layout": "container",
        "payloadSha256": m["sha256"],
        "payloadSize": m["size"],
        "activation": "restart",
        "location": str(f),
        "embedded": True,
        "installedAt": 1,
    }
    got = storage.installed(install)
    assert got is not None and got.payload is not None and got.payload.size == m["size"]
    assert storage.verify(install) is True
    assert storage.verify(dict(install, payloadSize=m["size"] + 1)) is False
    storage.remove(str(f))  # outside the store: refused
    assert measure_file(str(f))["size"] == m["size"]


def test_record_body_is_capped_at_the_bound(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    huge = TreePack(**{**v1.__dict__, "jws": v1.jws + "A" * 200_000})
    srv.packs = [huge]
    c = client(srv, tmp_path, [v1])
    with pytest.raises(PackError) as ex:
        c.update.packs.ensure(["djdl.l10n"])
    assert (ex.value.code, ex.value.detail) == ("record-rejected", "hash")
    c.close()


@pytest.mark.parametrize("status, code", [(503, "server-error"), (404, "network-error")])
def test_a_failed_record_fetch_names_server_error_for_a_5xx_and_network_error_otherwise(
    srv: FakeServer, tmp_path: Any, status: int, code: str
) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    srv.record_status = status
    c = client(srv, tmp_path, [v1])
    assert c.update.packs._fetch_record(v1.record_sha256) == {"ok": False, "code": code}
    with pytest.raises(PackError) as ex:
        c.update.packs.ensure(["djdl.l10n"])
    assert ex.value.code == code
    c.close()


def test_torn_state_json_is_held_across_loads(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    c = client(srv, tmp_path, [v1])
    c.update.packs.ensure(["djdl.l10n"])
    root = tmp_path / "data" / PRODUCT / "packs"
    d = c.update.packs.path("djdl.l10n")
    c.close()
    (root / "state.json").write_text('{"v":1,"active":{"djdl')
    for _ in range(2):
        c = client(srv, tmp_path, [v1])
        assert c.update.packs.state().state_issue == "torn"
        assert tree_on_disk(d, v1.files)
        c.close()
    assert (root / "state.json.torn").read_text().startswith('{"v":1')
    assert json.loads((root / "state.json.torn.list").read_text())["locations"] == [d]


def test_unreadable_state_json_refuses_to_write_or_install(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    c = client(srv, tmp_path, [v1])
    c.update.packs.ensure(["djdl.l10n"])
    root = tmp_path / "data" / PRODUCT / "packs"
    good = (root / "state.json").read_text()
    c.close()
    # A directory where the file should be: reading it fails (EISDIR), not ENOENT.
    (root / "state.json").unlink()
    (root / "state.json").mkdir()
    c = client(srv, tmp_path, [v1])
    with pytest.raises(PackError) as ex:
        c.update.packs.ensure(["djdl.l10n"])
    assert ex.value.code == "pack-state-unreadable"
    assert c.update.packs.state().state_issue == "unreadable"
    c.close()
    (root / "state.json").rmdir()
    (root / "state.json").write_text(good)
    c = client(srv, tmp_path, [v1])
    assert c.update.packs.state().active["djdl.l10n"]["version"] == "1.0.0"
    c.close()


@pytest.mark.skipif(_IS_ROOT or os.name == "nt", reason="needs POSIX permissions and a non-root user")
def test_an_unreadable_payload_is_kept_across_two_loads(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    c = client(srv, tmp_path, [v1])
    c.update.packs.ensure(["djdl.l10n"])
    d = c.update.packs.path("djdl.l10n")
    c.close()
    os.chmod(d, 0o000)
    try:
        for _ in range(2):
            c = client(srv, tmp_path, [v1])
            s = c.update.packs.state()
            assert "djdl.l10n" not in s.active
            assert "djdl.l10n" not in s.running
            c.close()
    finally:
        os.chmod(d, 0o755)
    c = client(srv, tmp_path, [v1])
    assert c.update.packs.state().active["djdl.l10n"]["location"] == d
    assert tree_on_disk(d, v1.files)
    c.close()


@pytest.mark.skipif(_IS_ROOT or os.name == "nt", reason="needs POSIX permissions and a non-root user")
def test_list_never_answers_a_partial_listing(srv: FakeServer, tmp_path: Any) -> None:
    a = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    b = tree_pack("djdl.extra", "1.0.0", 1, {"x.txt": "x"})
    srv.packs = [a, b]
    c = client(srv, tmp_path, [a, b])
    c.update.packs.ensure(["djdl.l10n", "djdl.extra"])
    dir_a = c.update.packs.path("djdl.l10n")
    c.close()
    root = tmp_path / "data" / PRODUCT / "packs"
    (root / "state.json").write_text('{"v":1,"act')
    pack_dir = root / "store" / "djdl.l10n"
    os.chmod(pack_dir, 0o000)
    try:
        with pytest.raises(PermissionError):
            DirPackStorage(str(root)).list()
        c = client(srv, tmp_path, [b])
        assert c.update.packs.state().state_issue == "torn"
        c.update.packs.ensure(["djdl.extra"])
        c.close()
    finally:
        os.chmod(pack_dir, 0o755)
    assert tree_on_disk(dir_a, a.files)


# ── client.update.decide() with packs (plans/P4-13.md §2.5, §2.6) ──────────────────────────


def test_decide_learns_a_revocation_blocks_required_content_and_refuses_the_release(
    srv: FakeServer, tmp_path: Any
) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    app_jws = sign_release_doc(
        {
            "schemaVersion": 1,
            "aud": PRODUCT,
            "deliverable": "app",
            "kind": "app",
            "version": "1.0.0",
            "seq": 10,
            "issuedAt": 1_759_000_000,
            "builds": [
                {
                    "id": "macos-dmg",
                    "platform": "macos",
                    "arch": "universal",
                    "format": "dmg",
                    "artifacts": [{"name": "a.dmg", "role": "payload", "sha256": "a" * 64, "size": 1}],
                }
            ],
        }
    )
    app_sha = hashlib.sha256(app_jws.encode()).hexdigest()
    rev = revocation_for(v1)
    srv.records = {app_sha: app_jws, rev["record"]: rev["jws"]}
    now = int(time.time())
    platform = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
    srv.feed = sign_feed_doc(
        {
            "schemaVersion": 1,
            "iss": "key.plrs.im",
            "aud": PRODUCT,
            "channel": "stable",
            "selector": {},
            "seq": 1,
            "issuedAt": now - 10,
            "expiresAt": now + 800,
            "app": {
                "deliverable": "app",
                "versionScheme": "semver",
                "targets": [
                    {
                        "platform": platform,
                        "release": {"sha256": app_sha, "seq": 10, "version": "1.0.0"},
                        "floor": None,
                        "critical": False,
                        "outlets": {
                            "direct": {"kind": "direct", "live": {"version": "1.0.0", "seq": 10}, "halted": False}
                        },
                    }
                ],
            },
            "revocations": [rev["entry"]],
        }
    )
    c = client(srv, tmp_path, [v1])
    c.update.packs.ensure(["djdl.l10n"])
    check = c.update.decide()
    assert check.decision.action == "blocked"
    assert check.decision.reason == "revoked-content"
    # Persisted beside the pack state, the flag first; the release no longer runs.
    root = os.path.join(str(tmp_path / "data"), PRODUCT, "packs")
    with open(os.path.join(root, "revocations.json"), encoding="utf-8") as f:
        assert list(json.load(f)["revoked"]) == [v1.record_sha256]
    with open(os.path.join(root, "state.json"), encoding="utf-8") as f:
        assert json.load(f)["revocationsStored"] is True
    assert "djdl.l10n" not in c.update.packs.state().running
    with pytest.raises(PackError) as ex:
        c.update.packs.ensure(["djdl.l10n"])
    assert ex.value.code == "pack-revoked"
    c.close()


def test_decide_without_revocations_writes_nothing(srv: FakeServer, tmp_path: Any) -> None:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    srv.packs = [v1]
    c = client(srv, tmp_path, [v1])
    c.update.packs.ensure(["djdl.l10n"])
    content = c.update.packs.content_input()
    assert content is not None
    assert content.holds == []
    assert content.active["djdl.l10n"].sha256 == v1.record_sha256
    assert content.revoked == {} and list(content.relearn) == []
    root = os.path.join(str(tmp_path / "data"), PRODUCT, "packs")
    assert not os.path.exists(os.path.join(root, "revocations.json"))
    with open(os.path.join(root, "state.json"), encoding="utf-8") as f:
        assert "revocationsStored" not in json.load(f)
    c.close()


def test_is_available_and_pack_for_through_the_client(srv: FakeServer, tmp_path: Any) -> None:
    # P4-20 save compatibility: the facade answers from the running set and the stamp's pins.
    l10n = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES, record_extra={"provides": ["l10n.fr"]})
    foes = tree_pack("djdl.foes", "1.0.0", 1, {"f.txt": "f"}, record_extra={"provides": ["foe.goblin"]})
    srv.packs = [l10n, foes]
    c = client(srv, tmp_path, [l10n, foes])
    c.update.packs.ensure(["djdl.l10n"])
    assert c.update.packs.is_available("l10n.fr") is True
    assert c.update.packs.is_available("foe.goblin") is False
    blobs = len(srv.blob_requests())
    got = c.update.packs.pack_for("foe.goblin")
    assert got is not None and got.to_dict() == {
        "packId": "djdl.foes",
        "release": {"sha256": foes.record_sha256, "seq": 1, "version": "1.0.0"},
    }
    assert len(srv.blob_requests()) == blobs
    assert c.update.packs.pack_for("foe.dragon") is None
    c.close()

    # Without a content stamp: no packs, so nothing is available and nothing provides.
    bare = make_client(
        srv,
        trust=PRODUCT_TRUST,
        data_dir=str(tmp_path / "bare"),
        expected_services=["release", "distribution", "update"],
        update=UpdateClientOptions(pinned_release_keys=RELEASE_KEYS, outlet="direct"),
    )
    assert bare.update.packs.is_available("l10n.fr") is False
    assert bare.update.packs.pack_for("l10n.fr") is None
    bare.close()


def test_a_held_release_signed_under_a_delegation_is_refused_through_the_packs_client(
    srv: FakeServer, tmp_path: Any
) -> None:
    """plans/P4-19.md §2.4: the packs client hands the stamp's holds to the engine, so a release
    the stamp holds never takes the delegated path, even when a decision targets it and its
    delegation is valid (``record-rejected``, detail ``jws``). Without the hold it installs."""
    ck = content_key_pair()
    d = delegation_for("djdl.events", ck["pub"])
    held = tree_pack(
        "djdl.events.halloween",
        "1.0.0",
        1,
        {"a.json": "{}"},
        issued_at=1759250000,
        signer={"pem": ck["pem"], "kid": d["kid"]},
    )
    srv.packs = [held]
    srv.records = {d["sha256"]: d["jws"]}
    release = {"sha256": held.record_sha256, "seq": held.seq, "version": held.version}
    expects = [{"pack": held.pack_id, "required": True, "delivery": "essential"}]
    target = {"pack": held.pack_id, "release": release}

    work = tmp_path / "held"
    work.mkdir()
    c = client(
        srv,
        work,
        [held],
        stamp_doc={
            "contentApi": 1,
            "pins": [],
            "expects": expects,
            "holds": [{"pack": held.pack_id, "release": release, "reason": "held in a test"}],
        },
    )
    with pytest.raises(PackError) as ex:
        c.update.packs.ensure_releases([target])
    assert ex.value.code == "record-rejected"
    assert ex.value.detail == "jws"
    c.close()

    free = tmp_path / "free"
    free.mkdir()
    c = client(srv, free, [held], stamp_doc={"contentApi": 1, "pins": [], "expects": expects})
    (install,) = c.update.packs.ensure_releases([target])
    assert install["delegation"] == d["jws"]
    c.close()


# ── plans/P4-29.md §2.4: the feed's delta menu through the client ───────────────────────────

_FD_PACK = "djdl.levels"
_BLOB = PackHandler(type="custom.blob", layout="container", activation="hot", supports=lambda fv: fv == 1)


class _Container:
    """A one-file container release over ``payload``, with no record delta (``FakeServer``
    serves it like a ``TreePack``)."""

    def __init__(self, version: str, seq: int, payload: bytes) -> None:
        def h(b: bytes) -> str:
            return hashlib.sha256(b).hexdigest()

        index = json.dumps(
            {
                "format": "pkey-files/1",
                "layout": "container",
                "payload": {"size": len(payload), "sha256": h(payload)},
                "files": [
                    {
                        "path": "data.bin",
                        "offset": 0,
                        "size": len(payload),
                        "sha256": h(payload),
                        "blob": {"sha256": h(payload), "bytes": len(payload), "codec": "none"},
                    }
                ],
            },
            separators=(",", ":"),
        ).encode()
        gaps = b""
        self.pack_id, self.version, self.seq = _FD_PACK, version, seq
        self.jws = sign_release_doc(
            {
                "schemaVersion": 1,
                "aud": PRODUCT,
                "deliverable": _FD_PACK,
                "kind": "pack",
                "version": version,
                "seq": seq,
                "issuedAt": 1759300000 + seq,
                "type": "custom.blob",
                "formatVersion": 1,
                "handler": {"activation": "hot"},
                "variants": [
                    {
                        "variant": {},
                        "payload": {"size": len(payload), "sha256": h(payload)},
                        "full": {
                            "sha256": h(payload),
                            "bytes": len(payload),
                            "size": len(payload),
                            "codec": "none",
                        },
                        "files": {
                            "format": "pkey-files/1",
                            "layout": "container",
                            "sha256": h(index),
                            "bytes": len(index),
                            "size": len(index),
                            "codec": "none",
                            "gaps": {"sha256": h(gaps), "bytes": 0, "size": 0, "codec": "none"},
                        },
                    }
                ],
            }
        )
        self.record_sha256 = h(self.jws.encode())
        self.objects = {h(payload): payload, h(index): index, h(gaps): gaps}


def _feed_with_menu() -> str:
    now = int(time.time())
    platform = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
    return sign_feed_doc(
        {
            "schemaVersion": 1,
            "iss": "key.plrs.im",
            "aud": PRODUCT,
            "channel": "stable",
            "selector": {},
            "seq": 1,
            "issuedAt": now - 10,
            "expiresAt": now + 800,
            "app": {
                "deliverable": "app",
                "versionScheme": "semver",
                "targets": [
                    {
                        "platform": platform,
                        "release": {"sha256": "a" * 64, "seq": 10, "version": "1.0.0"},
                        "floor": None,
                        "critical": False,
                        "outlets": {
                            "direct": {"kind": "direct", "live": {"version": "1.0.0", "seq": 10}, "halted": False}
                        },
                    }
                ],
            },
            "deltas": {
                sha(PROBE_TARGET): [
                    {
                        "from": sha(PROBE_BASE),
                        "method": "zstd-patch-from",
                        "scope": "payload",
                        "memBytes": len(PROBE_BASE) + len(PROBE_TARGET),
                        "artifact": {"sha256": sha(PROBE_FRAME), "bytes": len(PROBE_FRAME)},
                    }
                ]
            },
        }
    )


def _feed_delta_setup(srv: FakeServer) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    v1 = _Container("1.0.0", 1, PROBE_BASE)
    v2 = _Container("1.1.0", 2, PROBE_TARGET)
    v2.objects[sha(PROBE_FRAME)] = PROBE_FRAME
    srv.packs = [v1, v2]  # type: ignore[list-item]
    srv.feed = _feed_with_menu()
    stamp_doc = {
        "contentApi": 1,
        "pins": [{"pack": _FD_PACK, "release": {"sha256": v1.record_sha256, "seq": 1, "version": "1.0.0"}}],
        "expects": [{"pack": _FD_PACK, "required": True, "delivery": "essential"}],
    }
    v2_target = {"pack": _FD_PACK, "release": {"sha256": v2.record_sha256, "seq": 2, "version": "1.1.0"}}
    return stamp_doc, v2_target


def _blob_paths(srv: FakeServer) -> List[str]:
    return [s["path"].rsplit("/", 1)[-1] for s in srv.blob_requests()]


def test_plans_the_committed_feeds_lazy_delta_after_update_feed(srv: FakeServer, tmp_path: Any) -> None:
    stamp_doc, v2_target = _feed_delta_setup(srv)
    c = client(srv, tmp_path, [], stamp_doc=stamp_doc, handlers=[_BLOB])
    c.update.packs.ensure([_FD_PACK])
    c.update.feed()
    srv.seen = []
    (install,) = c.update.packs.ensure_releases([v2_target])
    assert install["payloadSha256"] == sha(PROBE_TARGET)
    assert _blob_paths(srv) == [sha(PROBE_FRAME)]
    c.close()


def test_reads_the_committed_feeds_menu_from_the_cache_when_the_engine_starts(
    srv: FakeServer, tmp_path: Any
) -> None:
    # Before any check (offline).
    stamp_doc, v2_target = _feed_delta_setup(srv)
    store = InMemoryStore(PRODUCT)
    first = client(srv, tmp_path, [], stamp_doc=stamp_doc, handlers=[_BLOB], store=store)
    first.update.packs.ensure([_FD_PACK])
    first.update.feed()
    first.close()
    # The Worker's feed is gone; the next process has only the committed feed.
    srv.feed = None
    srv.seen = []
    again = client(srv, tmp_path, [], stamp_doc=stamp_doc, handlers=[_BLOB], store=store)
    (install,) = again.update.packs.ensure_releases([v2_target])
    assert install["payloadSha256"] == sha(PROBE_TARGET)
    assert _blob_paths(srv) == [sha(PROBE_FRAME)]
    again.close()
