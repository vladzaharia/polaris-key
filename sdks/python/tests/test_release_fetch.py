# @pkey-feature release.fetch release.distribution
# @pkey-feature release.download
# @pkey-feature update.decide
"""``release.fetch``, ``update.feed_url()``, ``client.distribution`` and the discovery-based
download URLs (SDK parity pass §3.6–§3.8, SP-P07)."""

from __future__ import annotations

import hashlib
import os
import threading

import httpx
import pytest

from polaris_key.core.caps import Unsupported
from polaris_key.core.errors import PolarisError

from helpers import BASE_URL, PRODUCT, TOKEN, discovery_doc, make_client
from test_release_update import Worker, feed_payload, record_payload, sha, sign_feed, sign_record, v4_client

PAYLOAD = os.urandom(300_000)
PAYLOAD_SHA = hashlib.sha256(PAYLOAD).hexdigest()
BUILD_PATH = f"/{PRODUCT}/distribution/builds/1.3.0/macos"


class BytesWorker(Worker):
    def __init__(self, payload: bytes = PAYLOAD, **kw) -> None:
        super().__init__(**kw)
        self.payload = payload
        self.byte_requests: list = []
        self.cut_after = None  # serve only this many bytes once, then fail
        self.redirect_to = None

    def __call__(self, r: httpx.Request) -> httpx.Response:
        if r.url.path == BUILD_PATH or r.url.host == "dl.example":
            self.byte_requests.append(r)
            if self.redirect_to and r.url.host != "dl.example":
                return httpx.Response(302, headers={"location": self.redirect_to})
            start = 0
            rng = r.headers.get("range")
            if rng:
                start = int(rng.split("=")[1].split("-")[0])
            body = self.payload[start:]
            if self.cut_after is not None:
                n = self.cut_after
                self.cut_after = None

                def stream():
                    yield body[:n]
                    raise httpx.ReadError("cut")

                return httpx.Response(206 if start else 200, headers={"etag": '"e1"'}, content=stream())
            return httpx.Response(206 if start else 200, headers={"etag": '"e1"'}, content=body)
        return super().__call__(r)


def _seed(worker: BytesWorker, size: int = len(PAYLOAD), digest: str = PAYLOAD_SHA) -> None:
    payload = record_payload()
    payload["builds"][0]["artifacts"] = [
        {"name": "djdl.dmg", "role": "payload", "sha256": digest, "size": size}
    ]
    record = sign_record(payload)
    worker.records[sha(record)] = record
    worker.feeds["stable"] = sign_feed(feed_payload(record))


def _client(worker):
    c = v4_client(worker)
    c._tokens.set(TOKEN)
    c.discover()
    return c


def test_fetch_downloads_and_verifies_a_decision(tmp_path) -> None:
    worker = BytesWorker()
    _seed(worker)
    c = _client(worker)
    check = c.update.decide(channel="stable")
    progress = []
    dest = str(tmp_path / "djdl.dmg")
    got = c.release.fetch(check, to=dest, on_progress=lambda d, t: progress.append((d, t)))
    assert (got.path, got.size, got.sha256) == (dest, len(PAYLOAD), PAYLOAD_SHA)
    assert open(dest, "rb").read() == PAYLOAD
    assert progress[-1] == (len(PAYLOAD), len(PAYLOAD))
    req = worker.byte_requests[0]
    assert req.headers["authorization"] == f"Bearer {TOKEN}"
    assert req.headers["x-pkey-device"] and req.headers["accept-encoding"] == "identity"
    assert not os.path.exists(dest + ".part")
    events = [e["event"] for e in c.update_journal.events()]
    assert events == ["update_offered", "update_downloaded"]
    c.close()


def test_a_mismatch_never_leaves_a_file(tmp_path) -> None:
    worker = BytesWorker()
    _seed(worker, digest="00" * 32)
    c = _client(worker)
    dest = str(tmp_path / "x.dmg")
    with pytest.raises(PolarisError) as e:
        c.release.fetch(c.update.decide(channel="stable"), to=dest)
    assert e.value.code == "payload-mismatch"
    assert not os.path.exists(dest) and not os.path.exists(dest + ".part")
    c.close()


def test_a_body_longer_than_the_record_is_refused(tmp_path) -> None:
    worker = BytesWorker()
    _seed(worker, size=1000)
    c = _client(worker)
    with pytest.raises(PolarisError) as e:
        c.release.fetch(c.update.decide(channel="stable"), to=str(tmp_path / "x"))
    assert e.value.code == "payload-mismatch"
    assert not os.path.exists(str(tmp_path / "x.part"))
    c.close()


def test_an_interrupted_download_resumes_with_range(tmp_path) -> None:
    worker = BytesWorker()
    _seed(worker)
    c = _client(worker)
    check = c.update.decide(channel="stable")
    dest = str(tmp_path / "x")
    worker.cut_after = 100_000
    with pytest.raises(PolarisError) as e:
        c.release.fetch(check, to=dest)
    assert e.value.code == "network-error"
    assert os.path.getsize(dest + ".part") > 0
    got = c.release.fetch(check, to=dest)
    assert got.resumed and open(dest, "rb").read() == PAYLOAD
    second = worker.byte_requests[-1]
    assert second.headers["range"].startswith("bytes=") and second.headers["if-range"] == '"e1"'
    c.close()


def test_cancel_keeps_the_part(tmp_path) -> None:
    worker = BytesWorker()
    _seed(worker)
    c = _client(worker)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(PolarisError) as e:
        c.release.fetch(c.update.decide(channel="stable"), to=str(tmp_path / "x"), cancel=cancel)
    assert e.value.code == "cancelled"
    c.close()


def test_the_bearer_is_dropped_on_a_cross_origin_redirect(tmp_path) -> None:
    worker = BytesWorker()
    worker.redirect_to = "https://dl.example/blob"
    _seed(worker)
    c = _client(worker)
    c.release.fetch(c.update.decide(channel="stable"), to=str(tmp_path / "x"))
    first, second = worker.byte_requests[0], worker.byte_requests[1]
    assert "authorization" in first.headers and "authorization" not in second.headers
    assert "x-pkey-device" not in second.headers
    c.close()


def test_a_redirect_to_plain_http_is_refused(tmp_path) -> None:
    worker = BytesWorker()
    worker.redirect_to = "http://evil.example/blob"
    _seed(worker)
    c = _client(worker)
    with pytest.raises(PolarisError) as e:
        c.release.fetch(c.update.decide(channel="stable"), to=str(tmp_path / "x"))
    assert e.value.code == "insecure-redirect"
    c.close()


def test_a_non_binary_decision_has_nothing_to_fetch(tmp_path) -> None:
    worker = BytesWorker()
    _seed(worker)
    c = v4_client(worker, version="1.3.0")
    c.discover()
    with pytest.raises(PolarisError) as e:
        c.release.fetch(c.update.decide(channel="stable"), to=str(tmp_path / "x"))
    assert e.value.code == "invalid-options"
    c.close()


# ── feed_url ────────────────────────────────────────────────────────────────────────
# @pkey-feature update.check
def test_feed_url_expands_discovery_templates() -> None:
    base = f"{BASE_URL}/{PRODUCT}"
    doc = discovery_doc(update=True)
    doc["services"]["update"]["endpoints"].update(
        {
            "winsparkle": f"{base}/update/{{channel}}/winsparkle.xml",
            "velopack": f"{base}/update/{{channel}}/velopack/releases.{{velopackChannel}}.json",
            "zsync": f"{base}/update/{{channel}}/{{buildId}}.AppImage.zsync",
        }
    )
    c = make_client(lambda r: httpx.Response(200, json=doc), expected_services=["update"])
    assert isinstance(c.update.feed_url("winsparkle"), Unsupported)  # discovery not loaded
    c.discover()
    assert c.update.feed_url("winsparkle", channel="beta") == f"{base}/update/beta/winsparkle.xml"
    assert c.update.feed_url("velopack", velopack_channel="win-x64") == (
        f"{base}/update/stable/velopack/releases.win-x64.json"
    )
    assert c.update.feed_url("zsync", build_id="linux") == f"{base}/update/stable/linux.AppImage.zsync"
    assert c.update.feed_url("appcast", channel="beta", arch="x86_64") == (
        f"{base}/update/beta/appcast.xml?arch=x86_64"
    )
    missing = c.update.feed_url("appInstaller")
    assert isinstance(missing, Unsupported) and missing.reason == "product"
    assert c.update.feed_url("velopack") == f"{base}/update/stable/velopack/"
    with pytest.raises(PolarisError):
        c.update.feed_url("nope")
    c.close()


# ── download_url / install_url follow discovery ──────────────────────────────────────
def test_download_and_install_urls_use_distribution_when_advertised() -> None:
    base = f"{BASE_URL}/{PRODUCT}"
    doc = discovery_doc(release=True, distribution=True)
    doc["services"]["distribution"]["endpoints"] = {
        "download": f"{base}/distribution/dl",
        "install": f"{base}/distribution/install.sh",
    }
    c = make_client(lambda r: httpx.Response(200, json=doc), expected_services=["release", "distribution"])
    assert c.release.download_url("1.2.0", "djdl", "arm64") == f"{base}/release/dl/1.2.0/djdl-arm64"
    c.discover()
    assert c.release.download_url("1.2.0", "djdl", "arm64", checksum=True) == (
        f"{base}/distribution/dl/1.2.0/djdl-arm64?checksum=sha256"
    )
    assert c.release.install_url() == f"{base}/distribution/install.sh"
    c.close()


# ── distribution model ─────────────────────────────────────────────────────────────
MODEL = {
    "schemaVersion": 1,
    "product": {"slug": PRODUCT, "name": "djdl"},
    "channel": "stable",
    "pageUrl": "https://dl.example/djdl",
    "listing": {"name": "djdl"},
    "release": {"releaseId": "r1", "version": "1.3.0"},
    "platforms": [
        {"platform": "macos", "label": "macOS", "primary": "download:direct:macos", "actions": ["download:direct:macos", "app-store:mas"], "builds": [{"buildId": "macos"}]},
        {"platform": "windows", "label": "Windows", "primary": None, "actions": [], "builds": []},
    ],
    "actions": [
        {"id": "download:direct:macos", "kind": "download"},
        {"id": "app-store:mas", "kind": "app-store"},
    ],
    "keys": [],
}


def test_download_model_and_this_platform() -> None:
    seen = []

    def h(r):
        seen.append(r.url.path)
        return httpx.Response(200, json=MODEL)

    c = make_client(h, expected_services=["distribution"])
    c.distribution._platform = "macos"
    m = c.distribution.download_model()
    assert seen == [f"/{PRODUCT}/distribution/download.json"]
    assert m.release["version"] == "1.3.0" and m.pageUrl == "https://dl.example/djdl"
    assert [s["kind"] for s in m.stores] == ["app-store"]
    here = c.distribution.this_platform(m)
    assert here.primary == "download:direct:macos" and len(here.builds) == 1
    c.close()


def test_download_model_refusals() -> None:
    c = make_client(lambda r: httpx.Response(404, json={"error": "not_found"}), expected_services=["distribution"])
    with pytest.raises(PolarisError) as e:
        c.distribution.download_model()
    assert e.value.code == "not_found"
    c.close()
    c = make_client(lambda r: httpx.Response(404), expected_services=["license"])
    with pytest.raises(PolarisError) as e:
        c.distribution.download_model()
    assert e.value.code == "service-unavailable"
    c.close()
