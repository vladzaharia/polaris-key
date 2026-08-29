"""``sync()`` — the single Core loop that replaces v2's ``refresh()``.

THE ORCHESTRATION, IN ORDER (mirrors ``packages/sdk-node/src/core/sync.ts``)

1. no token ⇒ return immediately, ZERO network calls. An unactivated client that polls
   must not generate traffic, and an offline-first ``init()`` must not either.
2. re-arm the single re-acquire budget for this pass (``TokenManager.begin_pass``).
3. TRUST REFRESH on Core's own cadence (§4.2) — before the documents, independent of
   them. v2 rode this on the ``/config`` fetch, which meant a product that fetched no
   config advanced no clock. Errors are swallowed: a manifest we could not fetch is a
   manifest we keep, not a reason to fail the sync.
4. the ENABLED documents. License and Config are independent services with independent
   ETags, and a product that runs only one must not pay for the other at all. (Node runs
   them concurrently through ``Promise.all``; this SDK's transport is the SYNCHRONOUS
   ``httpx.Client``, so they run one after the other. What the contract actually requires
   — independent ETags, independent anti-replay floors, independent outcomes, and ONE
   cache write — is preserved exactly; only the wall-clock overlap is absent.)
5. verify each against the effective trust set, with the per-TYPE anti-replay floor taken
   from the document currently held (§3).
6. ONE cache write folding every slice that changed plus the unsigned hints.
7. the floor rises from whatever verified (done inside ``CacheManager.apply_*``).
8. telemetry to ``POST /<p>/devices/report``, best-effort.

WHY THE CACHE WRITE IS SINGULAR

Two document outcomes settling in one pass would otherwise each read-modify-write the
record, and the loser's slice would vanish. Each document's outcome is collected as a
plain value; the record is touched exactly once, after both have settled.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Optional

from .cache import CacheManager
from .context import (
    CoreContext,
    DocumentBlocked,
    DocumentDeviceCap,
    DocumentError,
    DocumentNotModified,
    DocumentOk,
    DocumentResult,
    DocumentUnauthorized,
)
from .models import REFRESH_MARGIN_SECONDS, BlockedState
from .token import TokenManager
from .trust import TrustManager
from .verify import verify_config_doc, verify_license_doc

__all__ = ["DocOutcome", "SyncResult", "SyncDeps", "sync"]


@dataclass(frozen=True)
class DocOutcome:
    """What happened to one document this pass."""

    kind: str  # applied | unchanged | unauthorized | blocked | device-cap | skipped | error
    blocked: Optional[BlockedState] = None
    limit: Optional[int] = None
    deviceCount: Optional[int] = None


_SKIPPED = DocOutcome(kind="skipped")


@dataclass(frozen=True)
class SyncResult:
    #: True when ANY document's content changed and was applied.
    applied: bool = False
    #: Set when a document fetch ended on a hard 401 after the single re-acquire.
    unauthorized: bool = False
    #: Set when ``/license/document`` answered 403 with a version/channel block.
    blocked: bool = False
    #: Set when the server refused on the device cap.
    deviceCap: bool = False
    #: Per-service detail, for callers that fetch more than one document.
    documents: Dict[str, DocOutcome] = field(default_factory=dict)


@dataclass
class SyncDeps:
    """Everything ``sync()`` needs. Passed as a bag rather than a class so the loop stays
    a function: it has no state of its own, and every piece of state it touches is owned
    by one of these four managers."""

    ctx: CoreContext
    trust: TrustManager
    cache: CacheManager
    tokens: TokenManager
    #: Best-effort device telemetry (``POST /<p>/devices/report``).
    report: Callable[[], None]


def sync(deps: SyncDeps, *, force: bool = False) -> SyncResult:
    ctx, trust, cache, tokens = deps.ctx, deps.trust, deps.cache, deps.tokens
    # §5 — nothing to authenticate with means nothing to fetch. Returning here is what
    # makes "offline init performs zero network calls" a structural property rather than
    # a habit.
    if tokens.current is None:
        return SyncResult()

    tokens.begin_pass()

    # ── 3. Trust, on Core's own cadence ─────────────────────────────────────────────
    trust_jws: Optional[str] = None
    if ctx.trust_refresh_enabled:
        try:
            trust_jws = trust.refresh()
        except Exception:
            trust_jws = None

    # ── 4/5. The enabled documents ──────────────────────────────────────────────────
    want_license = ctx.enabled("license")
    want_config = ctx.enabled("config")
    license_outcome = _sync_license(deps, force) if want_license else _SKIPPED
    config_outcome = _sync_config(deps, force) if want_config else _SKIPPED

    # ── 6. One write ────────────────────────────────────────────────────────────────
    patch: Dict[str, object] = {}
    if trust_jws:
        patch["trust_jws"] = trust_jws

    outcomes = (license_outcome, config_outcome)
    unauthorized = any(o.kind == "unauthorized" for o in outcomes)
    blocked_outcome = next((o for o in outcomes if o.kind == "blocked"), None)
    cap_outcome = next((o for o in outcomes if o.kind == "device-cap"), None)
    applied = any(o.kind == "applied" for o in outcomes)
    # A successful authenticated exchange — 200 OR 304 — clears both unsigned hints. They
    # can only ever tighten the gate (§4.1), so clearing them on evidence of a healthy
    # session is safe; SETTING them requires the server to have said so.
    healthy = any(o.kind in ("applied", "unchanged") for o in outcomes)
    if unauthorized:
        patch["last_sync_unauthorized"] = True
    elif healthy:
        patch["last_sync_unauthorized"] = False
    if blocked_outcome is not None:
        patch["blocked"] = blocked_outcome.blocked
    elif healthy:
        patch["blocked"] = None

    touched = any(o.kind in ("applied", "unchanged") for o in outcomes)
    if patch or touched:
        cache.flush(**patch)

    documents: Dict[str, DocOutcome] = {}
    if want_license:
        documents["license"] = license_outcome
    if want_config:
        documents["config"] = config_outcome

    result = SyncResult(
        applied=applied,
        unauthorized=unauthorized,
        blocked=blocked_outcome is not None,
        deviceCap=cap_outcome is not None,
        documents=documents,
    )

    # ── 8. Telemetry ────────────────────────────────────────────────────────────────
    # Skipped only on a hard 401 with nothing applied: reporting with a credential the
    # server has just rejected is noise, and the report is best-effort in every other
    # respect.
    if applied or not unauthorized:
        try:
            deps.report()
        except Exception:
            pass
    return result


def _sync_document(
    deps: SyncDeps,
    slice_name: str,
    force: bool,
    fetch: Callable[[str, Optional[str]], DocumentResult],
    verify: Callable[[str, Optional[str]], bool],
    current_expires_at: Callable[[], Optional[int]],
    allow_reacquire: bool = True,
) -> DocOutcome:
    """One document's fetch → verify → stage cycle, including the §5 half-life escalation
    and the single 401 re-acquire.

    Written once, generic over the two documents, because the two rules that matter — "a
    304 renews freshness but not the signed window" and "exactly one re-acquire" — are
    contract-level and must not be able to differ per service.
    """
    cache, tokens = deps.cache, deps.tokens
    token = tokens.current
    if not token:
        return _SKIPPED

    res = fetch(token, None if force else cache.etag(slice_name))

    if isinstance(res, DocumentNotModified):
        # §5 — a 304 means "content unchanged, freshness RENEWED". The ETag deliberately
        # excludes the timestamps, so a content-stable document 304s forever; left alone a
        # continuously online, continuously authenticated client coasts into `grace` at
        # `expiresAt` and `expired` at `graceUntil` (R2-11). Past the half-life we re-ask
        # UNCONDITIONALLY so the server re-signs the validity window. The boundary runs at
        # `effectiveNow` — the same clock every gate comparison uses — so a system-clock
        # rollback below the floor cannot also disable the defense.
        # A 304 with NO document held is unreachable by construction — a slice that failed
        # verification drops its ETag with it, so no conditional request is sent for a
        # document we do not have. It is spelled out rather than escalated on so this
        # branch stays byte-identical to `packages/sdk-node/src/core/sync.ts`.
        expires_at = current_expires_at()
        if (
            not force
            and expires_at is not None
            and deps.ctx.now() > expires_at - REFRESH_MARGIN_SECONDS
        ):
            return _sync_document(
                deps,
                slice_name,
                True,
                fetch,
                verify,
                current_expires_at,
                allow_reacquire,
            )
        cache.mark_verified()
        return DocOutcome(kind="unchanged")

    if isinstance(res, DocumentUnauthorized):
        if allow_reacquire and tokens.reacquire_once():
            # One retry, with re-acquire now spent for this pass.
            return _sync_document(
                deps, slice_name, force, fetch, verify, current_expires_at, False
            )
        return DocOutcome(kind="unauthorized")

    if isinstance(res, DocumentDeviceCap):
        return DocOutcome(
            kind="device-cap", limit=res.limit, deviceCount=res.deviceCount
        )

    if isinstance(res, DocumentBlocked):
        return DocOutcome(
            kind="blocked",
            blocked=BlockedState(reason=res.reason, allowedRange=res.allowedRange),
        )

    if isinstance(res, DocumentOk):
        # A document that fails verification is simply not applied — and, crucially,
        # nothing about the previous one is disturbed. The anti-replay floor `verify` uses
        # is DERIVED from the document currently held, never from an on-disk counter
        # (R4-03).
        if not verify(res.jws, res.etag):
            return DocOutcome(kind="error")
        cache.mark_verified()
        return DocOutcome(kind="applied")

    assert isinstance(res, DocumentError)
    return DocOutcome(kind="error")


def _sync_license(deps: SyncDeps, force: bool) -> DocOutcome:
    from ..license.endpoints import fetch_license_document

    ctx, cache, trust = deps.ctx, deps.cache, deps.trust

    def verify(jws: str, etag: Optional[str]) -> bool:
        held = cache.license_doc()
        doc = verify_license_doc(
            jws,
            trust.effective,
            expected_aud=ctx.product,
            device_id=ctx.device_id,
            last_accepted_issued_at=held.issuedAt if held else None,
        )
        if doc is None:
            return False
        cache.apply_license(jws, doc, etag)
        return True

    def expires_at() -> Optional[int]:
        held = cache.license_doc()
        return held.expiresAt if held else None

    return _sync_document(
        deps,
        "license",
        force,
        lambda token, etag: fetch_license_document(ctx, token, etag),
        verify,
        expires_at,
    )


def _sync_config(deps: SyncDeps, force: bool) -> DocOutcome:
    from ..config.fetch import fetch_config_document

    ctx, cache, trust = deps.ctx, deps.cache, deps.trust

    def verify(jws: str, etag: Optional[str]) -> bool:
        held = cache.config_doc()
        doc = verify_config_doc(
            jws,
            trust.effective,
            expected_aud=ctx.product,
            device_id=ctx.device_id,
            last_accepted_issued_at=held.issuedAt if held else None,
        )
        if doc is None:
            return False
        cache.apply_config(jws, doc, etag)
        return True

    def expires_at() -> Optional[int]:
        held = cache.config_doc()
        return held.expiresAt if held else None

    return _sync_document(
        deps,
        "config",
        force,
        lambda token, etag: fetch_config_document(ctx, token, etag),
        verify,
        expires_at,
    )
