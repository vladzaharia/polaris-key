"""The Python transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/.

Drives ``PolarisKeyClient`` through every recorded conversation ``sdks/python/parity.json``
makes applicable, against a fake server (``transcript_replay.ReplayServer``, an
``httpx.MockTransport`` handler) that serves the Worker's recorded answers and asserts every
request.

Which transcripts run is DATA: a transcript for a feature this SDK has not implemented is
skipped, and starts running the moment the manifest claims it. The SDK clock is ``time.time`` pinned to each step's ``now``: the recorded documents
were signed at a fixed instant and expire an hour later.

``updateDecide`` (plans/P3-01.md §5, §6) is ``client.update.decide(channel=…, staged=…,
skip_version=…)``, and its ``expect`` keys are the ``UpdateCheck``'s own (``channel``,
``decision``, ``feed``, ``record``, ``errors``). ``initial.update`` is the host's configuration:
``pinnedReleaseKeys``, ``outlet``, ``platform``, ``arch``, the ``installed`` build (its ``version``
is the client's ``version``) and ``methods`` become ``UpdateClientOptions``, and ``cache`` (the
``feeds`` and ``releaseRecords`` slices) seeds the store's cache record. A transcript with
``initial.update`` and no ``initial.services`` runs with Release, Distribution and Update
expected. The client loads discovery itself when the session has not; a transcript that never
runs a ``discover`` step, and records no discovery exchange in the step, has it answered here with
the Worker's standard templates (the fallback the Node and React replayers use), so the recording
only has to hold the feed and record traffic.

``chunkRange`` (P4-32, plans/P4-32.md §5) is ``chunk_range_fetch`` over the packs client's own
object fetch (``client.update.packs._fetch_object``), against the blobs template the last
discover returned. ``range`` is the fetch's status; ``bytes`` the body it returned, as a string.
"""

# @pkey-feature core.discover core.sync core.cache license.activate license.enroll
# @pkey-feature license.deactivate license.reregister devices.register devices.report
# @pkey-feature config.schema release.changelog release.download
# @pkey-feature identity.devicecode config.mint
# @pkey-feature update.feed release.record update.decide
# @pkey-feature packs.apply.chunk commerce.receipt

from __future__ import annotations

import copy
import dataclasses
import json
import time
from typing import Any, Dict, Optional

import httpx
import pytest

from polaris_key import PolarisError, PolarisKeyClient, StagedUpdate, UpdateClientOptions
from polaris_key.core.store import CacheRecord
from polaris_key.update.packs import chunk_range_fetch

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


def _act(
    client: PolarisKeyClient,
    store: TranscriptStore,
    step: Dict[str, Any],
    session: Dict[str, Any],
) -> Dict[str, Any]:
    """THE mapping from transcript verbs and ``expect`` keys onto the Python SDK.

    ``session`` carries the prompt the last ``beginSignIn`` returned between steps."""
    out: Dict[str, Any] = {}
    action = step["action"]
    args = step["args"]
    if action == "beginSignIn":
        p = client.identity.begin_sign_in(device_name=args.get("deviceName"))
        session["prompt"] = p
        out["prompt"] = {
            "userCode": p.userCode,
            "verificationUri": p.verificationUri,
            "verificationUriComplete": p.verificationUriComplete,
            "expiresIn": p.expiresIn,
            "interval": p.interval,
        }
    elif action == "pollSignIn":
        poll = client.identity.poll_sign_in(session["prompt"])
        out["result"] = poll.status
        if poll.status == "slow-down":
            out["interval"] = poll.interval
    elif action == "waitForSignIn":
        out["result"] = client.identity.wait_for_sign_in(session["prompt"]).status
    elif action == "mintToken":
        try:
            minted = client.config.mint_token(args["recipeId"])
        except PolarisError as e:
            out["result"] = e.code
        else:
            out["result"] = "ok"
            out["token"] = minted.token
            out["expiresAt"] = minted.expiresAt
    elif action == "commerceBinding":
        try:
            b = client.commerce.binding()
        except PolarisError as e:
            out["result"] = e.code
        else:
            out["result"] = "ok"
            out["bindingId"] = b.bindingId
            out["products"] = [dataclasses.asdict(p) for p in b.products]
    elif action == "commerceClaim":
        r = client.commerce.claim(args["store"], args["payload"])
        if r.kind == "ok":
            out["result"] = "ok"
            out["flag"] = r.flag
            out["state"] = r.state
            out["granted"] = r.granted
        else:
            out["result"] = r.code
            if r.reason is not None:
                out["reason"] = r.reason
    elif action == "discover":
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
    elif action == "chunkRange":
        fetch_range = chunk_range_fetch(client.update.packs._fetch_object)
        r = fetch_range(args["bundle"], int(args["offset"]), int(args["length"]))
        out["range"] = r.status
        if r.status == "ok":
            out["bytes"] = b"".join(bytes(c) for c in r.chunks).decode("latin-1")
    elif action == "updateDecide":
        staged = args.get("staged")
        try:
            check = client.update.decide(
                channel=args.get("channel"),
                staged=(
                    StagedUpdate(version=staged["version"], channel=staged["channel"])
                    if isinstance(staged, dict)
                    else None
                ),
                skip_version=args.get("skipVersion"),
            )
        except PolarisError as e:
            out["result"] = "error"
            out["code"] = e.code
        else:
            out["result"] = "ok"
            out.update(check.to_dict())
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


def _standard_discovery(t: Dict[str, Any]) -> Dict[str, Any]:
    """The Worker's standard discovery document, for a transcript that loads none itself."""
    base = f"{t['baseUrl']}/{t['product']}"
    return {
        "product": t["product"],
        "services": {
            "release": {"enabled": True, "endpoints": {"record": f"{base}/release/records/{{sha256}}"}},
            "distribution": {
                "enabled": True,
                "endpoints": {"builds": f"{base}/distribution/builds/{{selector}}/{{buildId}}"},
            },
            "update": {"enabled": True, "endpoints": {"feed": f"{base}/update/{{channel}}/feed.jws"}},
        },
    }


def _update_options(u: Dict[str, Any]) -> UpdateClientOptions:
    installed = u.get("installed") or {}
    return UpdateClientOptions(
        pinned_release_keys=u["pinnedReleaseKeys"],
        outlet=u.get("outlet"),
        platform=u["platform"],
        arch=u["arch"],
        build_number=installed.get("buildNumber"),
        format=installed.get("format"),
        engine=installed.get("engine"),
        binary_version=installed.get("binaryVersion"),
        methods=tuple(u.get("methods") or ("download",)),
    )


def replay(t: Dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": float(t["now"])}
    monkeypatch.setattr(time, "time", lambda: clock["now"])
    server = ReplayServer(t)
    store = TranscriptStore(t["initial"]["deviceId"], t["initial"].get("token"))
    u = t["initial"].get("update")
    kwargs: Dict[str, Any] = {}
    services = t["initial"].get("services")
    if services is None and u is not None:
        services = ["release", "distribution", "update"]
    if services is not None:
        kwargs["expected_services"] = services
    if u is not None:
        kwargs["update"] = _update_options(u)
        cache = u.get("cache") or {}
        store.write_cache(
            CacheRecord(
                feeds=dict(cache.get("feeds") or {}),
                releaseRecords=dict(cache.get("releaseRecords") or {}),
            )
        )

    # The standard discovery answer, for a transcript that loads discovery nowhere itself.
    discovery_path = f"/{t['product']}/.well-known/polaris.json"
    discovered = {"done": any(s["action"] == "discover" for s in t["steps"])}

    def transport(request: httpx.Request) -> httpx.Response:
        step = server._step
        if (
            not discovered["done"]
            and request.url.raw_path.decode("ascii") == discovery_path
            and step is not None
            and not any(x["request"]["path"] == discovery_path for x in step["exchanges"]["items"])
        ):
            discovered["done"] = True
            return httpx.Response(
                200,
                headers={"content-type": "application/json"},
                content=json.dumps(_standard_discovery(t)).encode("utf-8"),
            )
        return server(request)

    client = PolarisKeyClient(
        product_slug=t["product"],
        version=(u or {}).get("installed", {}).get("version") or t["initial"]["version"],
        trust=t["trust"],
        base_url=t["baseUrl"],
        store=store,
        client=httpx.Client(transport=httpx.MockTransport(transport)),
        request_timeout=None,
        **kwargs,
    )
    client.devices.fingerprint = lambda: FINGERPRINT  # type: ignore[method-assign]
    client.init()
    session: Dict[str, Any] = {}
    try:
        for i, _ in enumerate(t["steps"]):
            step = server.begin_step(i)
            clock["now"] = float(step.get("now", t["now"]))
            observed = _act(client, store, step, session)
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


def test_a_different_update_outcome_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """The rollback transcript passes only when floors are keyed by the feed's own channel
    claim; an expectation that the older feed was committed must fail."""
    t = copy.deepcopy(next(x for x in TRANSCRIPTS if x["id"] == "update-feed-rollback"))
    t["steps"][0]["expect"]["feed"] = "network"
    with pytest.raises(AssertionError, match=r"step 0 \(updateDecide\): feed"):
        replay(t, monkeypatch)


def test_an_update_step_without_its_record_request_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    t = doctor(
        next(x for x in TRANSCRIPTS if x["id"] == "update-record-by-hash"),
        0,
        lambda items: [x for x in items if "/release/records/" not in x["request"]["path"]],
    )
    with pytest.raises(ReplayError, match=r"unexpected request: GET /djdl/release/records/"):
        replay(t, monkeypatch)


def test_a_chunk_range_with_another_content_range_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """``packs-chunk-range`` passes only when the SDK reads the exact run: a recorded
    Content-Range altered to another range must be refused, so the step's ``range`` fails."""

    def edit(items):
        for x in items:
            x["response"]["headers"]["content-range"] = "bytes 17-40/64"
        return items

    t = doctor(next(x for x in TRANSCRIPTS if x["id"] == "packs-chunk-range"), 1, edit)
    with pytest.raises(AssertionError, match=r"step 1 \(chunkRange\): range"):
        replay(t, monkeypatch)
