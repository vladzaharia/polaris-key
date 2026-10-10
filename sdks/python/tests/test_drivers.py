# @pkey-feature update.driver
"""Install drivers and ``client.update.install()`` (SDK parity pass §3.16, SP-P09)."""

from __future__ import annotations

import os

import pytest

from polaris_key.core.models import DecisionRelease, UpdateDecision
from polaris_key.update.drivers import SelfReplaceDriver, StoreLinkDriver, VelopackDriver

from helpers import BASE_URL, PRODUCT, TOKEN, discovery_doc, make_client
from test_release_fetch import PAYLOAD, BytesWorker, _client, _seed

import httpx


def test_a_store_decision_opens_the_listing_without_a_driver() -> None:
    opened = []
    c = make_client(lambda r: httpx.Response(404))
    d = UpdateDecision(action="store", release=DecisionRelease("1.3.0", 1), listingUrl="https://apps.apple.com/app/id1")
    c.update.set_driver(StoreLinkDriver(opened.append))
    out = c.update.install(d)
    assert out.kind == "store-opened" and opened == ["https://apps.apple.com/app/id1"]
    c.close()


def test_without_a_driver_a_binary_is_unsupported_dependency() -> None:
    c = make_client(lambda r: httpx.Response(404))
    out = c.update.install(UpdateDecision(action="binary", release=DecisionRelease("1.3.0", 1, "ab" * 32), build="macos"))
    assert out.kind == "unsupported" and out.reason == "dependency"
    assert c.update.install(UpdateDecision(action="none", reason="current")).reason == "product"
    c.close()


def test_self_replace_installs_the_verified_build_and_can_roll_back(tmp_path) -> None:
    exe = tmp_path / "djdl"
    exe.write_bytes(b"old binary")
    os.chmod(exe, 0o755)
    worker = BytesWorker()
    _seed(worker)
    c = _client(worker)
    driver = SelfReplaceDriver(str(exe))
    c.update.set_driver(driver)
    out = c.update.install(c.update.decide(channel="stable"))
    assert out.kind == "restart-required" and out.version == "1.3.0"
    assert exe.read_bytes() == PAYLOAD and os.access(exe, os.X_OK)
    assert (tmp_path / "djdl.old").read_bytes() == b"old binary"
    events = [e["event"] for e in c.update_journal.events()]
    assert events[-2:] == ["update_downloaded", "update_applied"]
    # The boot guard rolls back through the driver.
    assert c.update.guard.rollback is not None
    assert driver.rollback() is True
    assert exe.read_bytes() == b"old binary"
    c.close()


def test_self_replace_needs_a_frozen_executable() -> None:
    c = make_client(lambda r: httpx.Response(404))
    out = SelfReplaceDriver(None).install(c, UpdateDecision(action="binary", release=DecisionRelease("1", 1, "a" * 64)))
    assert out.kind == "unsupported" and out.reason == "runtime"
    c.close()


class FakeManager:
    def __init__(self, url, channel, *, update=True):
        self.url, self.channel, self.update = url, channel, update
        self.calls = []

    def check_for_updates(self):
        self.calls.append("check")
        return {"version": "1.3.0"} if self.update else None

    def download_updates(self, info, progress=None):
        self.calls.append("download")
        if progress:
            progress(100)

    def apply_updates_and_restart(self, info):
        self.calls.append("apply-restart")

    def wait_exit_then_apply_updates(self, info):
        self.calls.append("apply-on-exit")


def _velopack_client():
    base = f"{BASE_URL}/{PRODUCT}"
    doc = discovery_doc(update=True)
    doc["services"]["update"]["endpoints"]["velopack"] = (
        f"{base}/update/{{channel}}/velopack/releases.{{velopackChannel}}.json"
    )
    c = make_client(lambda r: httpx.Response(200, json=doc), expected_services=["update"])
    c.discover()
    return c


@pytest.mark.parametrize("restart", [True, False])
@pytest.mark.parametrize("version", ["1.3.0", "1.4.0"])
def test_velopack_refuses_unverifiable_packages_before_manager_creation(restart, version) -> None:
    made = []

    def factory(url, channel):
        m = FakeManager(url, channel)
        made.append(m)
        return m

    c = _velopack_client()
    c.update.set_driver(VelopackDriver("win-x64", restart=restart, manager_factory=factory))
    out = c.update.install(UpdateDecision(action="binary", release=DecisionRelease(version, 1, "a" * 64), build="win"))
    assert out.kind == "unsupported" and out.reason == "runtime"
    assert "signed release record" in out.detail
    assert made == []
    assert list(c.update_journal.events()) == []
    c.close()


def test_velopack_without_a_feed_is_unsupported_product() -> None:
    c = make_client(lambda r: httpx.Response(200, json=discovery_doc(update=True)), expected_services=["update"])
    c.discover()
    out = VelopackDriver("win-x64", manager_factory=lambda u, ch: FakeManager(u, ch)).install(
        c, UpdateDecision(action="binary", release=DecisionRelease("1.3.0", 1, "a" * 64))
    )
    assert out.kind == "unsupported" and out.reason == "product"
    c.close()
