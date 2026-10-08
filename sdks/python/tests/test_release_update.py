"""The Release + Update sub-clients — the truth store and the feed over it (D-05, §R1).

Release owns what the software IS (changelog, install script, artifacts); Update owns the
FEED (version check, appcast). They are two services precisely because a product can want
a changelog without wanting Sparkle — and both are OFF in the suite default, so this suite
is also where the D-21 fail-closed refusal is exercised end to end.
"""

from __future__ import annotations

from typing import Any, Dict

import httpx
import pytest

from polaris_key.core.errors import PolarisError

from helpers import BASE_URL, PRODUCT, TOKEN, discovery_doc, make_client

CHANGELOG = {
    "entries": [
        {
            "version": "2.1.0",
            "tag": "v2.1.0",
            "date": "2026-08-01",
            "summary": "Faster",
            "url": "https://example/rel/2.1.0",
        },
        {"version": "2.0.0", "tag": "v2.0.0", "date": None, "summary": "", "url": ""},
    ]
}


def _feed_routes(**overrides: Any):
    def handler(r: httpx.Request) -> httpx.Response:
        p = f"/{PRODUCT}"
        path = r.url.path
        if path in overrides:
            value = overrides[path]
            return value(r) if callable(value) else value
        if path == f"{p}/release/changelog":
            return httpx.Response(200, json=CHANGELOG)
        if path == f"{p}/update/version":
            return httpx.Response(
                200,
                json={"version": "2.1.0", "tag": "v2.1.0", "url": "https://example/rel/2.1.0"},
            )
        return httpx.Response(404)

    return handler


# ── D-21 fail-closed ────────────────────────────────────────────────────────────────
def test_both_services_refuse_until_the_product_says_it_runs_them() -> None:
    """A client that has not been told the service exists must not probe for it."""
    c = make_client(_feed_routes())
    for call in (
        lambda: c.release.changelog(),
        lambda: c.release.install_url(),
        lambda: c.release.download_url("2.1.0", "djdl", "arm64"),
        lambda: c.update.check(),
    ):
        with pytest.raises(PolarisError) as exc:
            call()
        assert exc.value.code == "service-unavailable"
    c.close()


def test_discovery_unlocks_them() -> None:
    handler = _feed_routes(
        **{
            f"/{PRODUCT}/.well-known/polaris.json": httpx.Response(
                200, json=discovery_doc(release=True, update=True)
            )
        }
    )
    c = make_client(handler)
    c.discover()
    assert [e.version for e in c.release.changelog()] == ["2.1.0", "2.0.0"]
    assert c.update.check().version == "2.1.0"
    c.close()


# ── Release ─────────────────────────────────────────────────────────────────────────
# @pkey-feature release.changelog
def test_changelog_decodes_entries() -> None:
    c = make_client(_feed_routes(), expected_services=["release"])
    entries = c.release.changelog()
    assert entries[0].tag == "v2.1.0" and entries[0].date == "2026-08-01"
    assert entries[1].date is None
    c.close()


def test_a_changelog_body_without_entries_is_empty_not_a_crash() -> None:
    c = make_client(
        _feed_routes(**{f"/{PRODUCT}/release/changelog": httpx.Response(200, json={})}),
        expected_services=["release"],
    )
    assert c.release.changelog() == []
    c.close()


# @pkey-feature release.download
def test_install_and_download_urls_are_built_not_fetched() -> None:
    c = make_client(_feed_routes(), expected_services=["release"])
    assert c.release.install_url() == f"{BASE_URL}/{PRODUCT}/release/install.sh"
    assert (
        c.release.download_url("2.1.0", "djdl", "arm64")
        == f"{BASE_URL}/{PRODUCT}/release/dl/2.1.0/djdl-arm64"
    )
    assert (
        c.release.download_url("2.1.0", "djdl", "arm64", dmg=True)
        == f"{BASE_URL}/{PRODUCT}/release/dl/2.1.0/djdl-arm64.dmg"
    )
    assert c.release.download_url("2.1.0", "djdl", "arm64", checksum=True).endswith(
        "?checksum=sha256"
    )
    c.close()


def test_an_entitled_feed_forwards_the_device_token() -> None:
    """When Release's access mode is ``entitled`` the server refuses without a device
    token; this client forwards the bearer when one is held and a public feed ignores it."""
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        seen["auth"] = r.headers.get("authorization")
        return httpx.Response(200, json=CHANGELOG)

    c = make_client(handler, expected_services=["release"])
    c.release.changelog()
    assert seen["auth"] is None, "no credential held ⇒ no bearer invented"
    c._tokens.set(TOKEN)
    c.release.changelog()
    assert seen["auth"] == f"Bearer {TOKEN}"
    c.close()


def test_a_403_reports_the_entitlement_refusal_rather_than_retrying() -> None:
    c = make_client(
        _feed_routes(
            **{
                f"/{PRODUCT}/release/changelog": httpx.Response(
                    403, json={"error": {"code": "channel_not_allowed"}}
                )
            }
        ),
        expected_services=["release"],
    )
    with pytest.raises(PolarisError) as exc:
        c.release.changelog()
    assert exc.value.code == "channel_not_allowed"
    c.close()


# @pkey-feature release.changelog
@pytest.mark.parametrize(
    "body, code",
    [
        ({"error": {"code": "unauthorized"}}, "unauthorized"),
        ({"error": "download_auth_required"}, "download_auth_required"),
        ({}, "unauthorized"),
    ],
)
def test_a_401_surfaces_the_refusal_body_code(body: Dict[str, Any], code: str) -> None:
    """``entitled`` answers the nested v3 shape; ``authenticated``/``licensed`` keep the flat
    v2 one. Either way the host learns WHY (pinned by the release-changelog transcript)."""
    c = make_client(
        _feed_routes(**{f"/{PRODUCT}/release/changelog": httpx.Response(401, json=body)}),
        expected_services=["release"],
    )
    with pytest.raises(PolarisError) as exc:
        c.release.changelog()
    assert exc.value.code == code
    c.close()


def test_a_null_summary_stays_none() -> None:
    """The Worker answers ``summary: null`` for a release body with no prose; it must not
    become the string ``"None"``."""
    entry = {"version": "1.0.0", "tag": "v1.0.0", "date": None, "summary": None, "url": "u"}
    c = make_client(
        _feed_routes(
            **{f"/{PRODUCT}/release/changelog": httpx.Response(200, json={"entries": [entry]})}
        ),
        expected_services=["release"],
    )
    assert c.release.changelog()[0].summary is None
    c.close()


# ── Update ──────────────────────────────────────────────────────────────────────────
# @pkey-feature update.check
def test_version_check_compares_against_the_HOST_application_version() -> None:
    """``updateAvailable`` is computed from the host app's version, not the SDK's — the
    SDK ships INSIDE the thing being updated. And the comparison is the same
    ``compare_semver`` the server's build gate uses, so a version check can never tell a
    user to update to a build the gate then blocks."""
    c = make_client(_feed_routes(), expected_services=["update"])
    check = c.update.check()
    assert check.version == "2.1.0" and check.updateAvailable is True
    c.close()

    ahead = make_client(_feed_routes(), expected_services=["update"], version="9.0.0")
    assert ahead.update.check().updateAvailable is False
    ahead.close()


# @pkey-feature update.check
def test_version_check_passes_the_channel_through() -> None:
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        seen["url"] = str(r.url)
        return httpx.Response(200, json={"version": "2.1.0", "tag": "v", "url": "u"})

    c = make_client(handler, expected_services=["update"])
    c.update.check(channel="beta")
    assert "channel=beta" in seen["url"]
    c.close()


def test_version_check_403_is_an_entitlement_refusal() -> None:
    c = make_client(
        _feed_routes(
            **{
                f"/{PRODUCT}/update/version": httpx.Response(
                    403, json={"error": {"code": "channel_not_allowed"}}
                )
            }
        ),
        expected_services=["update"],
    )
    with pytest.raises(PolarisError) as exc:
        c.update.check()
    assert exc.value.code == "channel_not_allowed"
    c.close()


def test_appcast_url_is_none_before_discovery_has_run() -> None:
    """A host asking "where is my feed?" before discovery is a SEQUENCING question, not an
    error — so the fail-closed answer is expressed as a value."""
    c = make_client(_feed_routes(), expected_services=["update"])
    assert c.update.appcast_url() is None
    c.close()


def test_appcast_url_after_discovery() -> None:
    handler = _feed_routes(
        **{
            f"/{PRODUCT}/.well-known/polaris.json": httpx.Response(
                200, json=discovery_doc(update=True)
            )
        }
    )
    c = make_client(handler)
    c.discover()
    assert c.update.appcast_url() == f"{BASE_URL}/{PRODUCT}/update/appcast.xml"
    assert c.update.appcast_url(arch="x86_64").endswith("?arch=x86_64")
    assert "/update/beta/appcast.xml" in c.update.appcast_url(channel="beta")
    c.close()


# ── Wire v4: client.update.decide(), feed(), release_record() (plans/P3-01.md §2.5–§2.8) ────
# @pkey-feature update.feed release.record update.decide

import hashlib  # noqa: E402
import time  # noqa: E402

from polaris_key import (  # noqa: E402
    InMemoryStore,
    StagedUpdate,
    UpdateClientOptions,
    UpdateError,
)
from polaris_key.core import release_record as release_record_module  # noqa: E402
from polaris_key.core.jws import sign_jws  # noqa: E402
from polaris_key.core.release_record import verify_release_record  # noqa: E402

from helpers import KID, NOW, PRIVATE_PEM, PUBKEY_RAW, TRUST, new_keypair  # noqa: E402

REL_PEM, REL_PUB = new_keypair()
REL_KID = "djdl-release-test"
RELEASE_KEYS = {REL_KID: REL_PUB}
FEED_PATH = f"/{PRODUCT}/update/{{channel}}/feed.jws"
RECORDS_PREFIX = f"/{PRODUCT}/release/records/"


def record_payload(version: str = "1.3.0", seq: int = 1, **over: Any) -> Dict[str, Any]:
    p: Dict[str, Any] = {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "deliverable": "app",
        "kind": "app",
        "version": version,
        "seq": seq,
        "issuedAt": NOW - 600,
        "builds": [
            {
                "id": "macos",
                "platform": "macos",
                "arch": "universal",
                "format": "dmg",
                "artifacts": [
                    {"name": "djdl.dmg", "role": "payload", "sha256": "ab" * 32, "size": 1024}
                ],
            }
        ],
    }
    p.update(over)
    return p


def sign_record(payload: Dict[str, Any], *, pem: str = REL_PEM, kid: str = REL_KID) -> str:
    return sign_jws(payload, pem, kid, "pkey-release+jws")


def sha(jws: str) -> str:
    return hashlib.sha256(jws.encode("ascii")).hexdigest()


def feed_payload(
    record_jws: str,
    *,
    seq: int = 8,
    issued: int = NOW,
    channel: str = "stable",
    version: str = "1.3.0",
    record_seq: int = 1,
) -> Dict[str, Any]:
    return {
        "schemaVersion": 1,
        "iss": "key.plrs.im",
        "aud": PRODUCT,
        "channel": channel,
        "selector": {},
        "seq": seq,
        "issuedAt": issued,
        "expiresAt": issued + 900,
        "app": {
            "deliverable": "app",
            "versionScheme": "semver",
            "targets": [
                {
                    "platform": "macos",
                    "release": {"sha256": sha(record_jws), "seq": record_seq, "version": version},
                    "floor": None,
                    "critical": False,
                    "outlets": {
                        "direct": {
                            "kind": "direct",
                            "live": {"version": version, "seq": record_seq},
                            "halted": False,
                        }
                    },
                }
            ],
        },
    }


def sign_feed(payload: Dict[str, Any], *, pem: str = PRIVATE_PEM, kid: str = KID) -> str:
    return sign_jws(payload, pem, kid, "pkey-feed+jws")


def v4_discovery(*, feed: bool = True) -> Dict[str, Any]:
    doc = discovery_doc(release=True, distribution=True, update=True)
    base = f"{BASE_URL}/{PRODUCT}"
    if feed:
        doc["services"]["update"]["endpoints"]["feed"] = f"{base}/update/{{channel}}/feed.jws"
        doc["services"]["release"]["endpoints"] = {"record": f"{base}/release/records/{{sha256}}"}
        doc["services"]["distribution"]["endpoints"] = {
            "builds": f"{base}/distribution/builds/{{selector}}/{{buildId}}"
        }
    return doc


class Worker:
    """A fake Worker: discovery, one feed per channel name, records by hash. ``None`` for a
    feed answers 503; every request is logged."""

    def __init__(self, *, discovery: Any = None) -> None:
        self.discovery = discovery if discovery is not None else v4_discovery()
        self.feeds: Dict[str, Any] = {}
        self.records: Dict[str, str] = {}
        self.requests: list = []

    def __call__(self, r: httpx.Request) -> httpx.Response:
        path = r.url.path
        self.requests.append(str(r.url))
        if path == f"/{PRODUCT}/.well-known/polaris.json":
            return httpx.Response(200, json=self.discovery)
        prefix = f"/{PRODUCT}/update/"
        if path.startswith(prefix) and path.endswith("/feed.jws"):
            channel = path[len(prefix) : -len("/feed.jws")]
            body = self.feeds.get(channel)
            if body is None:
                return httpx.Response(503)
            return httpx.Response(200, text=body, headers={"content-type": "application/jose"})
        if path.startswith(RECORDS_PREFIX):
            body = self.records.get(path[len(RECORDS_PREFIX) :])
            if body is None:
                return httpx.Response(404, json={"error": {"code": "not_found"}})
            return httpx.Response(200, text=body, headers={"content-type": "application/jose"})
        return httpx.Response(404)

    def feed_requests(self) -> list:
        return [u for u in self.requests if u.endswith("feed.jws?platform=macos")]

    def record_requests(self) -> list:
        return [u for u in self.requests if RECORDS_PREFIX in u]


def options(**over: Any) -> UpdateClientOptions:
    base: Dict[str, Any] = {
        "pinned_release_keys": RELEASE_KEYS,
        "outlet": "direct",
        "platform": "macos",
        "arch": "arm64",
        "format": "dmg",
    }
    base.update(over)
    return UpdateClientOptions(**base)


def v4_client(worker: Worker, *, store: Any = None, **over: Any):  # type: ignore[no-untyped-def]
    return make_client(
        worker,
        store=store,
        version=over.pop("version", "1.2.0"),
        expected_services=["release", "distribution", "update"],
        update=over.pop("update", options()),
        **over,
    )


def seeded(worker: Worker, *, seq: int = 8, issued: int = NOW, channel: str = "stable") -> str:
    record = sign_record(record_payload())
    worker.records[sha(record)] = record
    feed = sign_feed(feed_payload(record, seq=seq, issued=issued, channel=channel))
    return feed


def test_decide_verifies_commits_and_decides() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker)
    store = InMemoryStore(PRODUCT)
    c = v4_client(worker, store=store)
    check = c.update.decide(channel="stable")
    assert check.to_dict()["decision"] == {
        "action": "binary",
        "method": "download",
        "release": {"version": "1.3.0", "seq": 1, "sha256": next(iter(worker.records))},
        "build": "macos",
        "mandatory": False,
        "critical": False,
        "prestage": [],
        "discardStaged": False,
    }
    assert (check.channel, check.feed, check.record, check.errors) == (
        "stable",
        "network",
        "network",
        (),
    )
    rec = store.read_cache()
    assert rec is not None
    assert rec.feeds == {"stable": worker.feeds["stable"]}
    assert set(rec.releaseRecords) == set(worker.records)
    # Signed artifacts only: no floor, no decoded document, is ever stored.
    assert set(rec.to_dict()) <= {
        "v", "docs", "etags", "lastSyncUnauthorized", "trustJws", "importedBundle",
        "blocked", "feeds", "releaseRecords",
    }
    # Discovery was loaded first (step 1), then the feed and the record.
    assert worker.requests[0].endswith("/.well-known/polaris.json")
    assert len(worker.feed_requests()) == 1 and len(worker.record_requests()) == 1
    c.close()


def test_the_same_feed_bytes_decide_from_the_cache_without_a_record_request() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker)
    c = v4_client(worker)
    c.update.decide(channel="stable")
    check = c.update.decide(channel="stable")
    assert (check.feed, check.record) == ("network", "cache")
    assert len(worker.record_requests()) == 1
    c.close()


def test_a_reload_refuses_a_lower_seq_using_the_floor_derived_from_the_cached_jws() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker, seq=8, issued=NOW - 60)
    store = InMemoryStore(PRODUCT)
    first = v4_client(worker, store=store)
    first.update.decide(channel="stable")
    first.close()

    # A restart: a new client over the same store. The Worker now answers an OLDER seq.
    worker.feeds["stable"] = seeded(worker, seq=7, issued=NOW)
    second = v4_client(worker, store=store)
    check = second.update.decide(channel="stable")
    assert [e.to_dict() for e in check.errors] == [{"code": "feed-rollback", "detail": None}]
    assert check.feed == "committed"
    assert check.decision.action == "binary"
    # The committed seq-8 feed stays; the seq-7 one was never written.
    rec = store.read_cache()
    assert rec is not None and '"seq":8' in _payload_json(rec.feeds["stable"])
    second.close()


def test_a_tampered_cached_feed_sets_no_floor() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker, seq=8, issued=NOW - 60)
    store = InMemoryStore(PRODUCT)
    first = v4_client(worker, store=store)
    first.update.decide(channel="stable")
    first.close()
    rec = store.read_cache()
    assert rec is not None
    head, payload, sig = rec.feeds["stable"].split(".")
    # A forged signature: the floor comes from a RE-VERIFIED JWS, so this one sets none.
    rec.feeds["stable"] = ".".join([head, payload, ("A" if sig[0] != "A" else "B") + sig[1:]])
    store.write_cache(rec)

    worker.feeds["stable"] = seeded(worker, seq=7, issued=NOW)
    second = v4_client(worker, store=store)
    check = second.update.decide(channel="stable")
    assert (check.feed, check.errors) == ("network", ())
    second.close()


def _payload_json(jws: str) -> str:
    from polaris_key.core.b64url import b64url_decode

    return b64url_decode(jws.split(".")[1]).decode("utf-8")


def test_an_alias_request_commits_under_the_canonical_channel() -> None:
    worker = Worker()
    worker.feeds["latest"] = seeded(worker, channel="stable")
    store = InMemoryStore(PRODUCT)
    c = v4_client(worker, store=store)
    check = c.update.decide(channel="latest")
    assert check.channel == "stable"
    rec = store.read_cache()
    assert rec is not None and set(rec.feeds) == {"stable"}
    c.close()


def _no_signature_work(monkeypatch: pytest.MonkeyPatch) -> list:
    calls: list = []

    def spy(*args: Any, **kwargs: Any) -> None:
        calls.append(args)
        return None

    monkeypatch.setattr(release_record_module, "verify_jws", spy)
    return calls


def test_a_record_with_a_mismatched_hash_is_refused_before_signature_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _no_signature_work(monkeypatch)
    record = sign_record(record_payload())
    r = verify_release_record(
        record,
        release_keys=RELEASE_KEYS,
        product_trust=TRUST,
        expected_aud=PRODUCT,
        expected_hash="0" * 64,
    )
    assert (r.ok, r.step) == (False, "hash")
    assert calls == []


def test_a_body_over_the_record_bound_is_refused_at_hash_without_signature_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _no_signature_work(monkeypatch)
    body = "a" * 88_845
    r = verify_release_record(
        body,
        release_keys=RELEASE_KEYS,
        product_trust=TRUST,
        expected_aud=PRODUCT,
        expected_hash=hashlib.sha256(body.encode("ascii")).hexdigest(),
    )
    assert (r.ok, r.step) == (False, "hash")
    assert calls == []


def test_a_record_signed_by_the_product_key_is_refused() -> None:
    record = sign_record(record_payload(), pem=PRIVATE_PEM, kid=KID)
    # Not a pinned release key: refused at step jws.
    r = verify_release_record(
        record,
        release_keys=RELEASE_KEYS,
        product_trust=TRUST,
        expected_aud=PRODUCT,
        expected_hash=sha(record),
    )
    assert (r.ok, r.step) == (False, "jws")
    # Even pinned as a release key, a product key is refused (the key-separation check).
    r = verify_release_record(
        record,
        release_keys={KID: PUBKEY_RAW},
        product_trust=TRUST,
        expected_aud=PRODUCT,
        expected_hash=sha(record),
    )
    assert (r.ok, r.step) == (False, "jws")


def test_decide_reports_a_refused_record_and_offers_nothing_self_installed() -> None:
    worker = Worker()
    record = sign_record(record_payload(), pem=PRIVATE_PEM, kid=KID)
    worker.records[sha(record)] = record
    worker.feeds["stable"] = sign_feed(feed_payload(record))
    c = v4_client(worker)
    check = c.update.decide(channel="stable")
    assert [e.to_dict() for e in check.errors] == [{"code": "record-rejected", "detail": "jws"}]
    assert check.record == "none"
    assert check.decision.to_dict() == {
        "action": "none",
        "reason": "not-available",
        "behind": False,
        "discardStaged": False,
    }
    c.close()


def test_a_stale_committed_feed_freezes_when_the_feed_cannot_be_fetched() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker, issued=NOW - 2000)
    store = InMemoryStore(PRODUCT)
    # Commit it while it was fresh.
    c = v4_client(worker, store=store)
    real = time.time
    try:
        time.time = lambda: float(NOW - 1900)  # type: ignore[assignment]
        c.update.decide(channel="stable")
    finally:
        time.time = real  # type: ignore[assignment]
    del worker.feeds["stable"]
    check = c.update.decide(channel="stable")
    # The fake Worker answers 503 for a missing feed: server-error, never network-error.
    assert [e.to_dict() for e in check.errors] == [{"code": "server-error", "detail": None}]
    assert check.feed == "committed"
    assert check.decision.to_dict() == {
        "action": "none",
        "reason": "stale",
        "behind": False,
        "discardStaged": False,
    }
    c.close()


def test_the_effective_clock_refuses_an_expired_feed_a_wound_back_clock_would_accept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker, issued=NOW - 2000)
    c = v4_client(worker)
    monkeypatch.setattr(time, "time", lambda: float(NOW - 1900))  # the system clock, wound back
    c.core.raise_floor(NOW)  # the high-water mark of what this client has verified
    with pytest.raises(UpdateError) as exc:
        c.update.decide(channel="stable")
    assert (exc.value.code, exc.value.detail) == ("feed-rejected", "freshness")
    c.close()


def test_nothing_to_decide_from_raises_the_fetch_code() -> None:
    worker = Worker()  # a missing feed answers 503
    c = v4_client(worker)
    with pytest.raises(UpdateError) as exc:
        c.update.decide(channel="stable")
    assert exc.value.code == "server-error"
    c.close()


def test_discovery_without_v4_endpoints_is_service_unavailable_before_dialling() -> None:
    worker = Worker(discovery=v4_discovery(feed=False))
    worker.feeds["stable"] = seeded(worker)
    c = v4_client(worker)
    with pytest.raises(UpdateError) as exc:
        c.update.decide(channel="stable")
    assert exc.value.code == "service-unavailable"
    assert worker.feed_requests() == []
    c.close()


def test_an_empty_pinned_release_key_map_is_not_configured() -> None:
    worker = Worker()
    c = v4_client(worker, update=options(pinned_release_keys={}))
    with pytest.raises(UpdateError) as exc:
        c.update.decide()
    assert exc.value.code == "not-configured"
    assert worker.requests == []
    c.close()


@pytest.mark.parametrize(
    "over",
    [
        {"pinned_release_keys": {"oops": PUBKEY_RAW}},  # a release key that is a trust pin
        {"outlet": "epic"},
        {"outlet": {"id": "Direct Build", "kind": "direct"}},
        {"methods": ("teleport",)},
        {"platform": "amiga"},
        {"arch": "m68k"},
        {"format": 7},
        {"detected": {"kind": "epic"}},
    ],
)
def test_bad_update_options_raise_invalid_options_at_construction(over: Dict[str, Any]) -> None:
    with pytest.raises(UpdateError) as exc:
        v4_client(Worker(), update=options(**over))
    assert exc.value.code == "invalid-options"


def test_options_may_be_a_mapping() -> None:
    c = v4_client(
        Worker(),
        update={"pinned_release_keys": RELEASE_KEYS, "outlet": {"id": "beta", "kind": "direct"}},
    )
    c.close()


def test_the_update_slices_survive_deactivate() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker)
    store = InMemoryStore(PRODUCT)
    c = v4_client(worker, store=store)
    c.update.decide(channel="stable")
    c.deactivate()
    rec = store.read_cache()
    assert rec is not None and set(rec.feeds) == {"stable"}
    assert rec.docs == {}
    c.close()


def test_feed_and_release_record() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker)
    c = v4_client(worker)
    fc = c.update.feed(channel="stable")
    assert (fc.channel, fc.source, fc.errors) == ("stable", "network", ())
    pin = fc.feed.app.targets[0].release.sha256
    rc = c.update.release_record(pin)
    assert (rc.source, rc.pinned, rc.record.version) == ("network", True, "1.3.0")
    assert c.update.release_record(pin).source == "cache"
    with pytest.raises(UpdateError) as exc:
        c.update.release_record("0" * 64)
    assert exc.value.code == "not_found"
    c.close()


def test_a_staged_code_update_and_a_skipped_version() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker)
    c = v4_client(worker)
    check = c.update.decide(channel="stable", skip_version="1.3.0")
    # A skipped version is never re-offered automatically, but the binary still is (native or
    # download are not code updates).
    assert check.decision.action == "binary"
    staged = c.update.decide(
        channel="stable", staged=StagedUpdate(version="1.3.0", channel="stable")
    )
    assert staged.decision.to_dict() == {
        "action": "code-ready",
        "release": {"version": "1.3.0", "seq": 1, "sha256": next(iter(worker.records))},
        "critical": False,
        "discardStaged": False,
    }
    c.close()


def test_build_url_uses_the_distribution_builds_route() -> None:
    worker = Worker()
    c = v4_client(worker)
    assert c.update.build_url("1.3.0", "macos") is None  # discovery not loaded
    c.discover()
    assert c.update.build_url("1.3.0+b 1", "mac/os") == (
        f"{BASE_URL}/{PRODUCT}/distribution/builds/1.3.0%2Bb%201/mac%2Fos"
    )
    c.close()


def test_check_and_appcast_url_are_unchanged_by_the_update_options() -> None:
    handler = _feed_routes(
        **{
            f"/{PRODUCT}/.well-known/polaris.json": httpx.Response(
                200, json=discovery_doc(release=True, update=True)
            )
        }
    )
    c = make_client(handler, version="2.0.0", update=options())
    c.discover()
    assert c.update.check().updateAvailable is True
    assert c.update.appcast_url() == f"{BASE_URL}/{PRODUCT}/update/appcast.xml"
    c.close()


def test_a_file_store_restart_keeps_the_floor(tmp_path: Any) -> None:
    from polaris_key import FileStore

    worker = Worker()
    worker.feeds["stable"] = seeded(worker, seq=8, issued=NOW - 60)
    first = v4_client(worker, store=FileStore(PRODUCT, str(tmp_path)))
    first.update.decide(channel="stable")
    first.close()

    worker.feeds["stable"] = seeded(worker, seq=7, issued=NOW)
    second = v4_client(worker, store=FileStore(PRODUCT, str(tmp_path)))
    check = second.update.decide(channel="stable")
    assert [e.code for e in check.errors] == ["feed-rollback"]
    assert check.record == "cache"
    second.close()
