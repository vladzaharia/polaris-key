"""The Python transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/.

Drives ``PolarisKeyClient`` through every recorded conversation ``sdks/python/parity.json``
makes applicable, against a fake server (``transcript_replay.ReplayServer``, an
``httpx.MockTransport`` handler) that serves the Worker's recorded answers and asserts every
request.

Which transcripts run is DATA: a transcript for a feature this SDK has not implemented
(register-reregister-401, until P1b-06) is skipped, and starts running the moment the manifest
claims it. The SDK clock is ``time.time`` pinned to each step's ``now``: the recorded documents
were signed at a fixed instant and expire an hour later.
"""

# @pkey-feature core.discover core.sync core.cache license.activate license.enroll
# @pkey-feature license.deactivate devices.register devices.report
# @pkey-feature config.schema release.changelog release.download

from __future__ import annotations

import copy
import dataclasses
import time
from typing import Any, Dict, Optional

import httpx
import pytest

from polaris_key import PolarisError, PolarisKeyClient
from polaris_key.core.store import CacheRecord

from transcript_replay import (
    ReplayError,
    ReplayServer,
    applies,
    doctor,
    load_manifest,
    load_transcripts,
)

MANIFEST = load_manifest("sdks/python/parity.json")
TRANSCRIPTS = load_transcripts()

#: A fixed hashed fingerprint, so the replay does not depend on what this host can read.
FINGERPRINT = {
    "components": {"machineUuid": "REPLAYmachineUuid00000"},
    "hwid": "REPLAYhwid0000000000000000000000",
}


class TranscriptStore:
    """The store the replay starts from: the transcript's device id and token."""

    def __init__(self, device_id: str, token: Optional[str]) -> None:
        self._device_id = device_id
        self.token = token
        self._cache: Optional[CacheRecord] = None

    def get_token(self) -> Optional[str]:
        return self.token

    def set_token(self, token: str) -> None:
        self.token = token

    def clear_token(self) -> None:
        self.token = None

    def get_device_id(self) -> str:
        return self._device_id

    def read_cache(self) -> Optional[CacheRecord]:
        return self._cache

    def write_cache(self, rec: CacheRecord) -> None:
        self._cache = rec

    def clear_cache(self) -> None:
        self._cache = None


def _act(client: PolarisKeyClient, store: TranscriptStore, step: Dict[str, Any]) -> Dict[str, Any]:
    """THE mapping from transcript verbs and ``expect`` keys onto the Python SDK."""
    out: Dict[str, Any] = {}
    action = step["action"]
    args = step["args"]
    if action == "discover":
        out["result"] = client.discover().kind
    elif action == "sync":
        r = client.sync(force=args.get("force") is True)
        out["applied"] = r.applied
        out["unauthorized"] = r.unauthorized
        out["blocked"] = r.blocked
        out["documents"] = {
            slice_: outcome.kind
            for slice_, outcome in r.documents.items()
            if outcome.kind != "skipped"
        }
    elif action == "activate":
        out["result"] = client.license.activate_with_key(args["key"]).kind
    elif action == "enroll":
        out["result"] = client.license.enroll().kind
    elif action == "register":
        out["result"] = client.devices.register().kind
    elif action == "deactivate":
        client.license.deactivate()
    elif action == "report":
        out["result"] = client.devices.report()
    elif action == "fetchSchema":
        out["catalog"] = client.config.fetch_schema()
    elif action == "changelog":
        try:
            out["entries"] = [dataclasses.asdict(e) for e in client.release.changelog()]
            out["result"] = "ok"
        except PolarisError as e:
            out["result"] = "error"
            out["code"] = e.code
    elif action == "installUrl":
        out["url"] = client.release.install_url()
    elif action == "downloadUrl":
        out["url"] = client.release.download_url(
            args["version"],
            args["binary"],
            args["arch"],
            checksum=args.get("checksum") is True,
            dmg=args.get("dmg") is True,
        )
    else:
        raise AssertionError(f"unknown action {action}")
    out["services"] = {
        slug: bool(s.get("enabled")) for slug, s in client.capabilities().items()
    }
    out["licenseStatus"] = client.status().status
    out["tokenHeld"] = store.token is not None
    return out


def replay(t: Dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": float(t["now"])}
    monkeypatch.setattr(time, "time", lambda: clock["now"])
    server = ReplayServer(t)
    store = TranscriptStore(t["initial"]["deviceId"], t["initial"].get("token"))
    kwargs: Dict[str, Any] = {}
    if t["initial"].get("services") is not None:
        kwargs["expected_services"] = t["initial"]["services"]
    client = PolarisKeyClient(
        product_slug=t["product"],
        version=t["initial"]["version"],
        trust=t["trust"],
        base_url=t["baseUrl"],
        store=store,
        client=httpx.Client(transport=httpx.MockTransport(server)),
        request_timeout=None,
        **kwargs,
    )
    client.devices.fingerprint = lambda: FINGERPRINT  # type: ignore[method-assign]
    client.init()
    try:
        for i, _ in enumerate(t["steps"]):
            step = server.begin_step(i)
            clock["now"] = float(step.get("now", t["now"]))
            observed = _act(client, store, step)
            server.end_step()
            for key, want in step["expect"].items():
                assert observed.get(key) == want, (
                    f"{t['id']} step {i} ({step['action']}): {key}: "
                    f"expected {want!r}, got {observed.get(key)!r}"
                )
    finally:
        client.close()


def test_the_transcript_set_is_present() -> None:
    assert TRANSCRIPTS


@pytest.mark.parametrize("t", TRANSCRIPTS, ids=[t["id"] for t in TRANSCRIPTS])
def test_replay(t: Dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    if not applies(t, MANIFEST):
        pytest.skip(f"{t['id']}: sdks/python/parity.json does not claim {t['features']}")
    replay(t, monkeypatch)


# ── The replayer fails on a doctored transcript ─────────────────────────────────────

BASE = next(t for t in TRANSCRIPTS if t["id"] == "sync-etag-304")


def test_an_extra_request_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    t = doctor(
        BASE,
        0,
        lambda items: [x for x in items if not x["request"]["path"].endswith("/devices/report")],
    )
    with pytest.raises(ReplayError, match=r"unexpected request: POST /djdl/devices/report"):
        replay(t, monkeypatch)


def test_an_omitted_request_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    t = doctor(BASE, 0, lambda items: [*items, copy.deepcopy(items[0])])
    with pytest.raises(
        ReplayError,
        match=r"expected request not sent: GET /djdl/\.well-known/polaris-trust\.jws",
    ):
        replay(t, monkeypatch)


def test_a_dropped_required_header_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def edit(items):
        for x in items:
            if x["request"]["path"].endswith("/license/document"):
                x["request"]["requiredHeaders"].append("x-pkey-doctored")
        return items

    t = doctor(BASE, 0, edit)
    with pytest.raises(ReplayError, match=r"required header x-pkey-doctored: missing"):
        replay(t, monkeypatch)


def test_a_different_outcome_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    t = copy.deepcopy(BASE)
    t["steps"][1]["expect"]["documents"] = {"license": "applied", "config": "applied"}
    with pytest.raises(AssertionError, match=r"step 1 \(sync\): documents"):
        replay(t, monkeypatch)
