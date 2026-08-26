"""The Polaris Key client: a small, product-agnostic facade over activate/fetch/verify/
cache/gate.

Offline-first — ``__init__``/``create`` apply the cached doc with no network;
``refresh()`` re-pulls (with a single ``/token`` re-acquire on 401) and re-applies.
Mirrors ``client.ts`` at wire contract v2 (docs/security/WIRE-CONTRACT-V2.md).

TRUST MODEL (§1). Three tiers in strictly decreasing authority:

* **pinned** — ``trust=`` compiled into the host application. Terminal: a pinned ``kid``
  can never be overridden, and is never pruned.
* **manifest** — keys learned from a ``polaris-trust.jws`` that verified against the
  pinned set. Replaced wholesale on every refresh, so absence is revocation.
* *(nothing else — the cache is no longer a key source.)*

The v1 merge was ``{**pinned, **cache}``, i.e. cache wins, so one write to
``managed.json`` substituted the key bytes behind a kid the application had explicitly
pinned in source (R2-01/R4-02, CRITICAL). Every downstream defence reasoning "the kid
must be one I pinned" still passed. The merge is now ``{**manifest, **pinned}`` and the
cache holds only the signed manifest, re-verified against the pins on every load.

DERIVED STATE (§4). ``lastAcceptedIssuedAt``, ``lastTrustIssuedAt``, ``lastVerifiedAt``
and the monotonic clock floor are **recomputed from re-verified content** on every load.
None of them is read from disk, so none of them can be poisoned there.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

import httpx

from .endpoints import (
    ActivationOk,
    ActivationResult,
    deauthorize,
    activate_with_key,
    enroll,
    reacquire_token,
    report_snapshot,
)
from .fetch import (
    FetchBlocked,
    FetchDeviceCap,
    FetchError,
    FetchNotModified,
    FetchOk,
    FetchUnauthorized,
    fetch_managed_config,
)
from .license import (
    BlockedState,
    LicenseState,
    channel_for_version,
    is_usable,
    license_state,
)
from .facts import ProbeDeclaration, collect_facts
from .fingerprint import collect_fingerprint
from .models import DocProfile, ManagedConfigDoc, ManagedEntry
from .store import CacheRecord, KeyringStore, Store
from .trust import merge_trust, verify_trust_manifest
from .verify import TrustSet, verify_doc

__all__ = [
    "PolarisKeyClient",
    "RefreshResult",
    "DeviceInfo",
    "DeviceManagementUnsupportedError",
]

DEFAULT_BASE = "https://key.plrs.im"

# How close to `expiresAt` a cached document may drift before a 304 must be escalated to
# a full re-request (§5) — half of DOC_EXPIRY_SECONDS, matching
# `packages/sdk-node/src/claims.ts`. The content-only ETag is deliberately blind to the
# time fields, so a stable config 304s forever and a CONTINUOUSLY ONLINE client silently
# ages into `grace` and then `expired` (R2-11). A 304 means "content unchanged, freshness
# renewed": when the signed window is more than half gone, ask for a fresh signature.
REFRESH_MARGIN_SECONDS = 1800

# Sentinel distinguishing "leave unchanged" from "clear to None" in patch_cache.
_UNSET = object()


def _now_sec() -> int:
    return int(time.time())


def _now_ms() -> int:
    return int(time.time() * 1000)


def _default_config_dir() -> str:
    return os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config"
    )


@dataclass(frozen=True)
class RefreshResult:
    applied: bool
    unauthorized: bool = False
    blocked: bool = False
    deviceCap: bool = False


@dataclass(frozen=True)
class DeviceInfo:
    id: str
    current: bool
    status: str
    licenseId: Optional[str] = None
    profile: Optional[DocProfile] = None
    lastVerifiedAt: Optional[int] = None


class DeviceManagementUnsupportedError(RuntimeError):
    code = "device-management-unsupported"


class PolarisKeyClient:
    """Product-agnostic license + managed-config client."""

    def __init__(
        self,
        *,
        product_slug: str,
        version: str,
        trust: TrustSet,
        base_url: Optional[str] = None,
        channel: Optional[str] = None,
        store: Optional[Store] = None,
        config_dir: Optional[str] = None,
        client: Optional[httpx.Client] = None,
        local_overrides: Optional[dict] = None,
        env_prefix: str = "PKEY_CONFIG_",
        env: Optional[Mapping[str, str]] = None,
        trust_refresh: bool = True,
        fingerprint: bool = True,
        probes: Optional[List[ProbeDeclaration]] = None,
        refresh_interval_seconds: Optional[float] = None,
        on_change: Optional[Callable[[LicenseState], None]] = None,
    ) -> None:
        self.product = product_slug
        self._base_url = (base_url or DEFAULT_BASE).rstrip("/")
        self._version = version
        self._channel = channel or channel_for_version(version)
        # `_pinned` is the host application's root of trust and is NEVER mutated.
        # `_manifest_keys` is replaced wholesale by each verified manifest (§1.2.4:
        # pruning is mandatory — absence is revocation). `_trust` is the resolved set,
        # with the pins terminal.
        self._pinned: TrustSet = dict(trust)
        self._manifest_keys: Dict[str, str] = {}
        self._trust: TrustSet = dict(trust)
        self._trust_refresh = trust_refresh
        self._fingerprint_enabled = fingerprint
        self._probes: List[ProbeDeclaration] = list(probes or [])
        self._refresh_interval = refresh_interval_seconds
        self._on_change = on_change
        self._timer_stop = threading.Event()
        self._timer: Optional[threading.Thread] = None
        self._store: Store = store or KeyringStore(
            product_slug, config_dir or _default_config_dir()
        )
        # An injected transport/client (tests) or a lazily-created default.
        self._client = client
        self._owns_client = client is None

        # Layered-config inputs: local overrides win over env over remote-default,
        # but an ``enforced``/``hidden`` remote entry always wins over both.
        self._local_overrides: Dict[str, Any] = dict(local_overrides or {})
        self._env_prefix = env_prefix
        self._env: Mapping[str, str] = os.environ if env is None else env

        self._token: Optional[str] = None
        self._device_id = ""
        self._cache: Optional[CacheRecord] = None
        # ── Derived security state (§4). Recomputed from re-verified signed artifacts
        #    on every load; never read from disk. ──────────────────────────────────
        self._doc: Optional[ManagedConfigDoc] = None
        self._last_accepted_issued_at: Optional[int] = None
        self._last_trust_issued_at: Optional[int] = None
        self._last_verified_at: Optional[int] = None
        # The monotonic time floor (§4.3): `max` over the `issuedAt` of every signed
        # artifact re-verified here — the config document AND the trust manifest. Both
        # sources are load-bearing; see `_raise_floor`.
        self._high_water_mark = 0

    @classmethod
    def create(cls, **opts: Any) -> "PolarisKeyClient":
        c = cls(**opts)
        c.init()
        return c

    @property
    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=30.0)
        return self._client

    def close(self) -> None:
        """Stop the refresh thread and release the HTTP client. Safe to call more than once."""
        self._timer_stop.set()
        timer = self._timer
        if timer is not None:
            timer.join(timeout=1.0)
            self._timer = None
        if self._owns_client and self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "PolarisKeyClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ── Init ────────────────────────────────────────────────────────────────────
    def init(self) -> None:
        """Load token + device id + cached doc (no network)."""
        self._device_id = self._store.get_device_id()
        self._token = self._store.get_token()
        self._cache = self._store.read_cache()
        self._load_cached_artifacts()
        self._start_timer()

    def _load_cached_artifacts(self) -> None:
        """Re-verify the cached JWS artifacts and DERIVE all state from them (§4.2).

        1. Re-verify ``trustJws`` against the **pinned** keys only. On failure discard
           it and fall back to the pins alone — never to whatever the file claimed.
        2. Build the trust set per §1.
        3. Re-verify ``configJws`` against that trust set, with the full §3 claim checks.
        4. Derive ``lastAcceptedIssuedAt`` / ``lastTrustIssuedAt`` / the clock floor from
           the verified content.
        5. Any failure => treat as no cache => ``needs-activation``. Fail closed, never
           fall back to a partially-trusted state.
        """
        self._manifest_keys = {}
        self._trust = dict(self._pinned)
        self._doc = None
        self._last_accepted_issued_at = None
        self._last_trust_issued_at = None
        self._last_verified_at = None
        self._high_water_mark = 0

        rec = self._cache
        if rec is None:
            return
        now = _now_sec()

        # Freshness is NOT asserted on reload: a manifest is only minutes-fresh by design,
        # and refusing a stale one would strand every offline client that has rotated keys.
        # Its signature, `typ`, `aud`/`iss` binding and pinned-substitution guard all apply.
        if rec.trustJws and not self._apply_trust_manifest(
            rec.trustJws, now=now, persist=False, check_freshness=False
        ):
            # Drop it in memory too, so a later _patch_cache can't write it back.
            rec.trustJws = None

        if rec.configJws:
            doc = verify_doc(
                rec.configJws,
                self._trust,
                expected_aud=self.product,
                device_id=self._device_id,
                now=now,
                # §3.1 correction 2 — a cached doc is EXPECTED to be past its short
                # `expiresAt`; that is what offline operation is. Its signed outer bound
                # here is `graceUntil`, enforced by the gate against the monotonic floor.
                # Asserting freshness on reload would delete offline grace outright.
                check_freshness=False,
            )
            if doc is None:
                rec.configJws = None
                rec.etag = None
            else:
                self._accept_doc(doc)
                # Derived, not stored: offline, the server's own statement of when this
                # document was minted is the only trustworthy "last verified" signal.
                self._last_verified_at = doc.issuedAt * 1000

    def _accept_doc(self, doc: ManagedConfigDoc) -> None:
        """Install a freshly verified document and re-derive the counters it anchors."""
        self._doc = doc
        self._last_accepted_issued_at = doc.issuedAt
        self._raise_floor(doc.issuedAt)

    def _raise_floor(self, issued_at: int) -> None:
        """Raise the §4.3 clock floor to ``issued_at``.

        Monotonic by construction — it only ever rises, and only from content whose
        signature was just checked against the pins, so there is no unsigned field an
        attacker could edit to move it either way.

        The floor has TWO sources: ``configDoc.issuedAt`` and ``trustManifest.issuedAt``.
        Both are required. Derived from the document alone it is inert (R4-04): with one
        cached document the mark equals ``doc.issuedAt``, which is below that same
        document's ``graceUntil`` by construction, so it can never push ``effective_now``
        past the end of grace and a rolled-back clock still extends offline operation
        indefinitely. The manifest is the second, independently-advancing signed clock —
        ``trust_refresh`` is on by default, so it moves even while a content-stable config
        document sits behind an unchanged ETag.
        """
        if issued_at > self._high_water_mark:
            self._high_water_mark = issued_at

    def _effective_now(self, now: Optional[int] = None) -> int:
        """``max(systemClock, highWaterMark)`` — the §4.3 monotonic time floor.

        The greatest ``issuedAt`` we have ever verified is a signed statement that time
        had at least reached that point. Taking the max makes clock rollback (R4-04)
        inert without requiring a trusted local clock, and costs nothing when the clock
        is honest.
        """
        wall = _now_sec() if now is None else now
        return wall if wall > self._high_water_mark else self._high_water_mark

    def _start_timer(self) -> None:
        """Start the optional refresh loop.

        OFF unless ``refresh_interval_seconds`` is set — enabling it by default would add
        network traffic and wakeups to every already-shipped integration. The thread is a
        daemon so it can never hold a CLI open.
        """
        interval = self._refresh_interval
        if not interval or interval <= 0 or self._timer is not None:
            return

        def loop() -> None:
            while not self._timer_stop.wait(interval):
                try:
                    self.refresh()
                except Exception:
                    # A transient network failure must not kill the loop.
                    pass

        self._timer = threading.Thread(
            target=loop, name="polaris-key-refresh", daemon=True
        )
        self._timer.start()

    # ── Gate / reads ────────────────────────────────────────────────────────────
    def status(self, now: Optional[int] = None) -> LicenseState:
        cache = self._cache
        return license_state(
            has_token=self._token is not None,
            doc=self._doc,
            now=_now_sec() if now is None else now,
            high_water_mark=self._high_water_mark,
            last_sync_unauthorized=cache.lastSyncUnauthorized if cache else False,
            blocked=cache.blocked if cache else None,
            last_verified_at=self._last_verified_at,
        )

    def is_licensed(self, now: Optional[int] = None) -> bool:
        return is_usable(self.status(now).status)

    def get_config(self, key: str, fallback: Any = None) -> Any:
        """Resolve a config key through the layered precedence.

        For an ``enforced``/``hidden`` remote entry, the remote value wins. Otherwise
        ``local_overrides`` > env (``env_prefix + key`` with ``.`` -> ``__``) > remote
        ``value`` > ``fallback``.
        """
        value, _source = self._resolve_config(key, fallback)
        return value

    def _config_entry(self, key: str) -> Optional[ManagedEntry]:
        doc = self._doc
        if not doc:
            return None
        return doc.payload.config.get(key)

    def _env_value(self, key: str) -> Any:
        """Read ``env[env_prefix + key.replace('.','__')]``; JSON-parse if it parses."""
        env_key = self._env_prefix + key.replace(".", "__")
        if env_key not in self._env:
            return _UNSET
        raw = self._env[env_key]
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw

    def _resolve_config(self, key: str, fallback: Any = None) -> Tuple[Any, str]:
        """Return ``(value, source)`` per the layered-config precedence."""
        entry = self._config_entry(key)
        if entry is not None and entry.state in ("enforced", "hidden"):
            return entry.value, ("hidden" if entry.state == "hidden" else "enforced")
        if key in self._local_overrides:
            return self._local_overrides[key], "local"
        env_val = self._env_value(key)
        if env_val is not _UNSET:
            return env_val, "env"
        if entry is not None:
            return entry.value, "remote-default"
        return fallback, "fallback"

    def get_config_source(self, key: str) -> str:
        """One of ``enforced|hidden|local|env|remote-default|fallback``."""
        _value, source = self._resolve_config(key)
        return source

    def list_user_config(self) -> List[Dict[str, Any]]:
        """User-facing config: every key except ``hidden`` ones, resolved per layering.

        Each item is ``{key, value, enforced}`` where ``enforced`` reflects whether the
        remote entry locks the value (an ``enforced`` state).
        """
        doc = self._doc
        if not doc:
            return []
        out: List[Dict[str, Any]] = []
        for key, entry in doc.payload.config.items():
            if entry.state == "hidden":
                continue
            value, _source = self._resolve_config(key)
            out.append(
                {"key": key, "value": value, "enforced": entry.state == "enforced"}
            )
        return out

    def get_secret(self, key: str) -> Optional[str]:
        doc = self._doc
        if not doc:
            return None
        e = doc.payload.secrets.get(key)
        if e is not None and isinstance(e.value, str):
            return e.value
        return None

    def is_entitled(self, name: str) -> bool:
        doc = self._doc
        if not doc:
            return False
        e = doc.payload.entitlements.get(name)
        return bool(e is not None and e.value is True)

    def get_entitlements(self) -> Dict[str, Any]:
        doc = self._doc
        if not doc:
            return {}
        return {k: v.value for k, v in doc.payload.entitlements.items()}

    def get_profile(self) -> Optional[DocProfile]:
        doc = self._doc
        return doc.profile if doc else None

    def current_device(self) -> DeviceInfo:
        doc = self._doc
        return DeviceInfo(
            id=self._device_id,
            current=True,
            status=self.status().status,
            licenseId=doc.licenseId if doc else None,
            profile=doc.profile if doc else None,
            lastVerifiedAt=self._last_verified_at,
        )

    def list_devices(self) -> List[DeviceInfo]:
        raise DeviceManagementUnsupportedError(
            "Remote device management is not supported by this backend."
        )

    def deauthorize_device(self, device_id: str) -> None:
        if device_id == self._device_id:
            self.deactivate()
            return
        raise DeviceManagementUnsupportedError(
            "Remote device deauthorization is not supported by this backend."
        )

    # ── Activation ──────────────────────────────────────────────────────────────
    def _fingerprint(self) -> Optional[dict]:
        """This machine's hashed hardware components, or None when collection is disabled or
        nothing could be read. Raw hardware values never leave the device."""
        if not self._fingerprint_enabled:
            return None
        try:
            return collect_fingerprint(self.product)
        except Exception:
            # Fingerprinting is best-effort: a host that refuses every probe still
            # activates, and the server records it as unverified.
            return None

    def enroll(self) -> ActivationResult:
        """Obtain a license with no key and no sign-in, when the product offers a free tier."""
        r = enroll(
            base_url=self._base_url,
            product=self.product,
            device_id=self._device_id,
            client=self._http,
            fingerprint=self._fingerprint(),
        )
        if isinstance(r, ActivationOk):
            self._token = r.token
            self._store.set_token(r.token)
            self.refresh(force=True)
        return r

    def activate_with_key(self, key: str) -> ActivationResult:
        r = activate_with_key(
            base_url=self._base_url,
            product=self.product,
            key=key,
            device_id=self._device_id,
            client=self._http,
            fingerprint=self._fingerprint(),
        )
        if isinstance(r, ActivationOk):
            self._token = r.token
            self._store.set_token(r.token)
            self.refresh(force=True)
        return r

    def deactivate(self) -> None:
        if self._token:
            deauthorize(
                base_url=self._base_url,
                product=self.product,
                token=self._token,
                client=self._http,
            )
        self._token = None
        self._cache = None
        self._store.clear_token()
        self._store.clear_cache()
        # Drop every derived artifact too: keys learned from a manifest, the doc, and the
        # counters anchored to it. Only the compiled-in pins survive a deactivation.
        self._manifest_keys = {}
        self._trust = dict(self._pinned)
        self._doc = None
        self._last_accepted_issued_at = None
        self._last_trust_issued_at = None
        self._last_verified_at = None
        self._high_water_mark = 0

    # ── Refresh ─────────────────────────────────────────────────────────────────
    def refresh(self, force: bool = False) -> RefreshResult:
        if not self._token:
            return RefreshResult(applied=False)
        # compute_etag() deliberately excludes issuedAt/expiresAt/graceUntil, so the tag is
        # stable across a pure re-sign and differs iff the CONTENT changed. That makes it the
        # change signal — no payload diffing, no new wire field.
        before_etag = self._cache.etag if self._cache else None
        result = self._fetch_and_apply(allow_reacquire=True, force=force)
        if (
            self._on_change is not None
            and result.applied
            and self._cache is not None
            and self._cache.etag is not None
            and self._cache.etag != before_etag
        ):
            self._on_change(self.status())
        if result.applied or not result.unauthorized:
            report_snapshot(
                base_url=self._base_url,
                product=self.product,
                token=self._token,
                snapshot=self._report_snapshot_body(),
                client=self._http,
            )
        return result

    def _fetch_and_apply(
        self, allow_reacquire: bool, force: bool = False
    ) -> RefreshResult:
        if not self._token:
            return RefreshResult(applied=False)
        if self._trust_refresh:
            try:
                self._refresh_trust()
            except Exception:
                pass
        res = fetch_managed_config(
            base_url=self._base_url,
            product=self.product,
            token=self._token,
            device_id=self._device_id,
            version=self._version,
            channel=self._channel,
            etag=None if force else (self._cache.etag if self._cache else None),
            client=self._http,
        )

        if isinstance(res, FetchNotModified):
            # A 304 is a successful, authenticated verification: clear the fail-closed
            # hints. But the ETag covers CONTENT only, so a stable config would 304 until
            # the signed window ran out — §5 forbids letting a continuously online client
            # drift into `grace`. Escalate to a full re-request once the doc is past its
            # half-life (or missing entirely), exactly once, so this cannot loop.
            if not force and self._needs_fresh_signature():
                return self._fetch_and_apply(
                    allow_reacquire=allow_reacquire, force=True
                )
            # A 304 IS a successful authenticated verification.
            self._last_verified_at = _now_ms()
            self._patch_cache(blocked=None, last_sync_unauthorized=False)
            return RefreshResult(applied=False)

        if isinstance(res, FetchUnauthorized):
            if allow_reacquire:
                re = reacquire_token(
                    base_url=self._base_url,
                    product=self.product,
                    token=self._token,
                    device_id=self._device_id,
                    client=self._http,
                )
                if isinstance(re, ActivationOk):
                    self._token = re.token
                    self._store.set_token(re.token)
                    return self._fetch_and_apply(
                        allow_reacquire=False, force=force
                    )
            self._patch_cache(last_sync_unauthorized=True)
            return RefreshResult(applied=False, unauthorized=True)

        if isinstance(res, FetchDeviceCap):
            return RefreshResult(applied=False, deviceCap=True)

        if isinstance(res, FetchBlocked):
            self._patch_cache(
                blocked=BlockedState(reason=res.reason, allowedRange=res.allowedRange)
            )
            return RefreshResult(applied=False, blocked=True)

        if isinstance(res, FetchOk):
            doc = verify_doc(
                res.jws,
                self._trust,
                expected_aud=self.product,
                device_id=self._device_id,
                # Derived from the doc we last verified — never from an on-disk counter.
                last_accepted_issued_at=self._last_accepted_issued_at,
            )
            if doc is None:
                return RefreshResult(applied=False)
            self._accept_doc(doc)
            self._last_verified_at = _now_ms()
            # Persist the SIGNED ARTIFACT, not the decoded document. Everything the gate
            # later reads is re-derived from this string by re-verifying it (§4.1).
            self._patch_cache(
                config_jws=res.jws,
                etag=res.etag,
                blocked=None,
                last_sync_unauthorized=False,
            )
            return RefreshResult(applied=True)

        # FetchError
        return RefreshResult(applied=False)

    def _needs_fresh_signature(self, now: Optional[int] = None) -> bool:
        """True when a 304 must be escalated to a full re-request (§5 / R2-11)."""
        if self._doc is None:
            return True
        wall = _now_sec() if now is None else now
        return wall > self._doc.expiresAt - REFRESH_MARGIN_SECONDS

    def _refresh_trust(self) -> bool:
        res = self._http.get(
            f"{self._base_url}/{self.product}/.well-known/polaris-trust.jws",
            headers={"accept": "application/jose"},
        )
        if res.status_code != 200:
            return False
        return self._apply_trust_manifest(res.text, now=_now_sec(), persist=True)

    def _apply_trust_manifest(
        self, jws: str, *, now: int, persist: bool, check_freshness: bool = True
    ) -> bool:
        """Verify a trust manifest and REPLACE the learned key set with its contents.

        The rules live in :mod:`polaris_key.trust` so this SDK and the Node one can be
        driven by the same ``trustCases`` corpus section. Returns ``True`` when the
        manifest was accepted and installed; on ``False`` the previous trust set is left
        exactly as it was.
        """
        result = verify_trust_manifest(
            jws,
            pinned=self._pinned,
            expected_aud=self.product,
            last_trust_issued_at=self._last_trust_issued_at,
            now=now,
            check_freshness=check_freshness,
        )
        if result.doc is None:
            return False
        # §1.2 rule 4 — PRUNE. The trust set becomes exactly `pinned ∪ {manifest keys
        # whose status != revoked}`; a kid absent from the new manifest and not pinned is
        # dropped. Absence is revocation. The v1 code merged and never removed, so a
        # compromised kid stayed trusted forever, on disk, across restarts (R2-02).
        self._manifest_keys = result.discovered
        self._trust = merge_trust(self._pinned, result.discovered)
        self._last_trust_issued_at = result.doc["issuedAt"]
        # §4.3 — the manifest is the floor's second source, and the one that actually
        # advances. A stale cached manifest still counts: its ``issuedAt`` is a signed
        # LOWER BOUND on real time regardless of whether it is fresh enough to publish
        # keys, which is why raising the floor here does not re-introduce the freshness
        # check ``check_freshness=False`` deliberately skipped above.
        self._raise_floor(result.doc["issuedAt"])
        if persist:
            self._patch_cache(trust_jws=jws)
        return True

    def _patch_cache(
        self,
        *,
        config_jws: Any = _UNSET,
        trust_jws: Any = _UNSET,
        etag: Any = _UNSET,
        blocked: Any = _UNSET,
        last_sync_unauthorized: Any = _UNSET,
    ) -> None:
        """Update the cache record, creating it only when there is something to keep.

        ``_UNSET`` means "leave that field unchanged". When there is no record yet, a
        no-op patch (e.g. clearing already-clear fail-closed hints) must not create an
        empty file — the gate tolerates an absent cache.
        """
        if self._cache is None:
            meaningful = (
                (config_jws is not _UNSET and config_jws is not None)
                or (trust_jws is not _UNSET and trust_jws is not None)
                or (blocked is not _UNSET and blocked is not None)
                or last_sync_unauthorized is True
            )
            if not meaningful:
                return
            self._cache = CacheRecord()

        rec = self._cache
        if config_jws is not _UNSET:
            rec.configJws = config_jws
        if trust_jws is not _UNSET:
            rec.trustJws = trust_jws
        if etag is not _UNSET:
            rec.etag = etag
        if blocked is not _UNSET:
            rec.blocked = blocked
        if last_sync_unauthorized is not _UNSET:
            rec.lastSyncUnauthorized = last_sync_unauthorized
        self._store.write_cache(rec)

    def _report_snapshot_body(self) -> Dict[str, Any]:
        doc = self._doc
        config: Dict[str, Any] = {}
        entitlements: Dict[str, Any] = {}
        if doc:
            for k, v in doc.payload.config.items():
                config[k] = v.value
            for k, v in doc.payload.entitlements.items():
                entitlements[k] = v.value
        # Software facts ride alongside the config/entitlement snapshot on the SAME report
        # call — no extra round trip, and the Worker's allowlist keeps the payload bounded.
        facts: Dict[str, Any] = {}
        try:
            facts = collect_facts(self._probes)
        except Exception:
            # Facts are diagnostic; failing to gather them must never break a refresh.
            facts = {}
        return {**facts, "config": config, "entitlements": entitlements}
