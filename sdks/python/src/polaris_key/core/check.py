"""``client.update.decide()``'s core — plans/P3-01.md §2.5 steps 2–18 and "After a refusal".

A port of ``@polaris-key/client-core``'s ``check.ts``. Five SDKs must behave the same after a
refusal, so the order, the fallback and the error map live here once for this SDK. The
function does no I/O of its own: the caller hands it the two fetches (the feed for a requested
channel, a record by hash) and the cache slices, and gets back the ``UpdateCheck`` plus the
slices to write. Step 1 (discovery), the options refusals (``not-configured``,
``invalid-options``) and the write itself stay with the update client.

It never raises. A failure with nothing to decide from comes back as ``ok=False`` with the
``error`` the caller raises.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Mapping, Optional, Sequence

from ..constants_generated import ErrorCode
from .decide import boot_decision, decide_update, feed_target, outlet_entry, rollout_bucket
from .feed import (
    CommittedFeed,
    bound_channels,
    commit_feed,
    reload_feeds,
    verify_feed,
)
from .jws import TrustSet
from .models import (
    ChannelFeedDoc,
    InstalledBuild,
    ReleaseRecordDoc,
    StagedUpdate,
    UpdateCheck,
    UpdateCheckError,
    UpdateDecisionInput,
    UpdateOutlet,
)
from .release_record import ReleaseRecordPin, reload_release_records, verify_release_record

__all__ = ["FetchOutcome", "UpdateCheckResult", "run_update_check"]


@dataclass(frozen=True)
class FetchOutcome:
    """One fetch's outcome: ``ok`` with the ``body``, or the ``code`` of a transport failure or
    a non-2xx answer (``network-error``, or the Worker's wire code when the answer names one,
    such as ``feed_not_composable``)."""

    ok: bool
    body: Optional[str] = None
    code: Optional[str] = None


@dataclass(frozen=True)
class UpdateCheckResult:
    ok: bool
    check: Optional[UpdateCheck] = None
    #: The stage machine's ``decide.done`` for the decision (``boot_decision``).
    boot: Optional[str] = None
    #: The verified feed and record the decision used.
    feed: Optional[ChannelFeedDoc] = None
    record: Optional[ReleaseRecordDoc] = None
    #: The slices to write back (Core's read-modify-write). Only verified, committed
    #: artifacts: a cached entry that failed the reload path is gone.
    feeds: Dict[str, str] = field(default_factory=dict)
    release_records: Dict[str, str] = field(default_factory=dict)
    #: Nothing to decide from: the error to raise.
    error: Optional[UpdateCheckError] = None


def _safe_fetch(fetcher: Callable[[], FetchOutcome], fallback_code: str) -> FetchOutcome:
    try:
        out = fetcher()
    except Exception:
        return FetchOutcome(ok=False, code=fallback_code)
    if isinstance(out, FetchOutcome):
        if out.ok and isinstance(out.body, str):
            return out
        if not out.ok and isinstance(out.code, str):
            return out
    return FetchOutcome(ok=False, code=fallback_code)


def _feed_error(reason: str) -> Optional[UpdateCheckError]:
    """The step-3–8 refusal's entry in ``errors``, or ``None`` for ``not-newer`` (nothing is
    reported)."""
    if reason == "not-newer":
        return None
    if reason == "rollback":
        return UpdateCheckError(code=ErrorCode.FEED_ROLLBACK, detail=None)
    return UpdateCheckError(code=ErrorCode.FEED_REJECTED, detail=reason)


def run_update_check(
    *,
    channel: str,
    expected_aud: str,
    trust: TrustSet,
    release_keys: TrustSet,
    now: int,
    install_id: Optional[str],
    installed: InstalledBuild,
    outlet: UpdateOutlet,
    subkind: Optional[str],
    methods: Sequence[str],
    cache_feeds: Optional[Mapping[str, str]],
    cache_release_records: Optional[Mapping[str, str]],
    fetch_feed: Callable[[str], FetchOutcome],
    fetch_record: Callable[[str], FetchOutcome],
    staged: Optional[StagedUpdate] = None,
    skip_version: Optional[str] = None,
) -> UpdateCheckResult:
    """Steps 2–18 of plans/P3-01.md §2.5 with its refusal rules:

    * the committed feeds are re-verified first (the reload path), which gives the floors;
    * a fetched body equal to a committed feed that step 5 binds to the request changes
      nothing;
    * otherwise the fetched feed is verified (steps 3–8) and, when accepted, committed under
      its claim, removing the requested name's entry after an alias answer (step 9);
    * after a transport failure, ``not-newer`` or a refusal at steps 3–8, the decision uses the
      first committed feed among ``feeds[claim]`` (only when the fetched feed passed step 5),
      ``feeds[requested]`` and ``feeds[CHANNEL_ALIASES[requested]]``; with none, ``ok=False``;
    * the record comes from the cache or the network, hash before signature, and a record that
      cannot be fetched or is refused is ``None`` for this call.

    ``channel`` is the REQUESTED name; ``trust`` the EFFECTIVE product trust set;
    ``release_keys`` the pinned release keys (never empty here); ``now`` the effective clock;
    ``install_id`` the device id (``None`` leaves the bucket ``None``, out of every rollout).
    """
    requested = channel
    platform = installed.platform
    errors: List[UpdateCheckError] = []

    # The reload path: the committed feeds that still verify, and the floors they set.
    committed = reload_feeds(
        cache_feeds, trust=trust, expected_aud=expected_aud, platform=platform
    )
    feeds: Dict[str, str] = {k: c.jws for k, c in committed.feeds.items()}
    # The decoded twin of `feeds`, so the records can be pruned to what a committed feed pins.
    feed_docs: Dict[str, ChannelFeedDoc] = {k: c.feed for k, c in committed.feeds.items()}

    def fallback(claim: Optional[str] = None) -> Optional[CommittedFeed]:
        keys = ([claim] if claim is not None else []) + bound_channels(requested)
        for k in keys:
            if k in committed.feeds:
                return committed.feeds[k]
        return None

    # Steps 2–9.
    feed: Optional[ChannelFeedDoc] = None
    feed_source = "network"
    fetched = _safe_fetch(lambda: fetch_feed(requested), ErrorCode.NETWORK_ERROR)
    if fetched.ok:
        body = fetched.body or ""
        # Step 2: an unchanged body decides from the committed copy.
        for k in bound_channels(requested):
            c = committed.feeds.get(k)
            if c is not None and c.jws == body:
                feed = c.feed
                break
        if feed is None:
            v = verify_feed(
                body,
                trust=trust,
                expected_aud=expected_aud,
                channel=requested,
                platform=platform,
                now=now,
                check_freshness=True,
                floors=committed.floors,
            )
            if v.ok and v.feed is not None:
                feed = v.feed
                feeds = commit_feed(feeds, requested=requested, claim=v.feed.channel, jws=body)
                if v.feed.channel != requested:
                    feed_docs.pop(requested, None)
                feed_docs[v.feed.channel] = v.feed
            else:
                reason = v.reason or "jws"
                err = _feed_error(reason)
                prior = fallback(v.channel)
                if prior is None:
                    return UpdateCheckResult(
                        ok=False,
                        error=err or UpdateCheckError(code=ErrorCode.FEED_REJECTED, detail=reason),
                    )
                if err is not None:
                    errors.append(err)
                feed = prior.feed
                feed_source = "committed"
    else:
        code = fetched.code or ErrorCode.NETWORK_ERROR
        prior = fallback()
        if prior is None:
            return UpdateCheckResult(ok=False, error=UpdateCheckError(code=code, detail=None))
        errors.append(UpdateCheckError(code=code, detail=None))
        feed = prior.feed
        feed_source = "committed"

    # Steps 10–16.
    target = feed_target(feed.app.targets, platform)
    cached_records: Mapping[str, str] = cache_release_records or {}
    record: Optional[ReleaseRecordDoc] = None
    record_source = "none"
    record_jws: Optional[str] = None
    if target is not None:
        pin = target.release
        expected = pin.sha256
        rpin = ReleaseRecordPin(deliverable="app", version=pin.version, seq=pin.seq)

        def verify(jws: str):  # type: ignore[no-untyped-def]
            return verify_release_record(
                jws,
                release_keys=release_keys,
                product_trust=trust,
                expected_aud=expected_aud,
                expected_hash=expected,
                pin=rpin,
            )

        cached = cached_records.get(expected)
        if isinstance(cached, str):
            r = verify(cached)
            if r.ok:
                record, record_source, record_jws = r.record, "cache", cached
        if record is None:
            got = _safe_fetch(lambda: fetch_record(expected), ErrorCode.NETWORK_ERROR)
            if not got.ok:
                errors.append(UpdateCheckError(code=got.code or ErrorCode.NETWORK_ERROR, detail=None))
            else:
                r = verify(got.body or "")
                if r.ok:
                    record, record_source, record_jws = r.record, "network", got.body
                elif r.step == "cross-check":
                    errors.append(UpdateCheckError(code=ErrorCode.RECORD_MISMATCH, detail=None))
                else:
                    errors.append(UpdateCheckError(code=ErrorCode.RECORD_REJECTED, detail=r.step))

    # A record is kept only while a committed feed's target for this platform pins it.
    pinned = set()
    for doc in feed_docs.values():
        t = feed_target(doc.app.targets, platform)
        if t is not None:
            pinned.add(t.release.sha256)
    candidates: Dict[str, str] = dict(cached_records)
    if record_jws is not None and target is not None:
        candidates[target.release.sha256] = record_jws
    kept = reload_release_records(
        candidates,
        release_keys=release_keys,
        product_trust=trust,
        expected_aud=expected_aud,
        pinned=pinned,
    )
    release_records = {h: c.jws for h, c in kept.items()}

    # Steps 17–18.
    entry = outlet_entry(target, outlet)
    bucket = (
        rollout_bucket(entry.rollout.salt, install_id)
        if entry is not None and entry.rollout is not None and install_id is not None
        else None
    )
    decision = decide_update(
        UpdateDecisionInput(
            now=now,
            feed=feed,
            record=record,
            installed=installed,
            outlet=outlet,
            subkind=subkind,
            staged=staged,
            skipVersion=skip_version,
            bucket=bucket,
            methods=tuple(methods),
        )
    )
    return UpdateCheckResult(
        ok=True,
        check=UpdateCheck(
            channel=feed.channel,
            decision=decision,
            feed=feed_source,
            record=record_source,
            errors=tuple(errors),
        ),
        boot=boot_decision(decision),
        feed=feed,
        record=record,
        feeds=feeds,
        release_records=release_records,
    )
