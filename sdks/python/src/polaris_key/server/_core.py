"""The server core: configuration, trust, the verified-document cache and ``authenticate``.

Every adapter is a thin layer over :class:`PolarisKey`. The verdict itself is the pure
:func:`~polaris_key.server._verdict.backend_verdict` path; this module adds the I/O around it
(the signed trust manifest) and the request-shaped result. Nothing here logs the header, the
document or the holder; debug lines carry the ``kid``, the product and the step only.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from ..core.jws import TrustSet
from ..core.models import CLOCK_SKEW_SECONDS, HEADER_DEVICE, HEADER_SDK_NAME, HEADER_SDK_VERSION
from ..core.trust import TRUST_MANIFEST_PATH, jws_header_kid, merge_trust, usable_pins, verify_trust_manifest
from ._problem import Problem, backend_problem
from ._verdict import (
    HEADER_LICENSE,
    LICENSE_MAX_BYTES,
    HeadersLike,
    PolarisLicense,
    PolarisUser,
    Refusal,
    Requirement,
    Verdict,
    _pairs,
    check_requirements,
    header_elements,
    judge,
    parse_credential,
)

__all__ = ["PolarisKey", "PolarisAuth", "PolarisKeyError", "TRUST_REFRESH_SECONDS", "UNKNOWN_KID_SECONDS"]

log = logging.getLogger("polaris_key.server")

#: §14.4: the signed trust manifest is refetched every 900 s, and at most once per 60 s on an
#: unknown ``kid``, so junk headers cannot be amplified into requests to Polaris Key.
TRUST_REFRESH_SECONDS = 900
UNKNOWN_KID_SECONDS = 60
_FETCH_TIMEOUT = 5.0
#: A signed trust manifest is a few KiB; the read stops here.
MANIFEST_MAX_BYTES = 262_144


class PolarisKeyError(Exception):
    """A refusal raised into the framework's error pipeline (``errors="raise"``)."""

    status: int
    code: str
    headers: Dict[str, str]
    problem: Problem

    def __init__(self, problem: Problem) -> None:
        Exception.__init__(self, problem.code)
        self.problem = problem
        self.status = problem.status
        self.code = problem.code
        self.headers = dict(problem.headers)


@dataclass(frozen=True)
class PolarisAuth:
    """What the request carries after the licence check. ``problem`` is set whenever ``license``
    is None, and also when the licence passed but the route's requirement did not."""

    license: Optional[PolarisLicense]
    user: Optional[PolarisUser]
    problem: Optional[Problem]

    def __repr__(self) -> str:
        return f"PolarisAuth(license={self.license!r}, signed_in={self.user is not None}, problem={self.problem.code if self.problem else None})"


def _config_fields(config: Any) -> Tuple[str, str, Dict[str, str], Optional[List[str]]]:
    """``(slug, base_url, pins, expected_services)`` from the config ``pkey sdk`` writes: the
    ``polaris_config`` module, its ``CONFIG`` mapping, or any mapping with the same keys."""
    if isinstance(config, Mapping):
        src: Mapping[str, Any] = config
    else:
        mapping = getattr(config, "CONFIG", None)
        if isinstance(mapping, Mapping):
            src = mapping
        else:
            src = {
                "product_slug": getattr(config, "PRODUCT_SLUG", None),
                "base_url": getattr(config, "BASE_URL", None),
                "trust": getattr(config, "PINNED_KEYS", None),
                "expected_services": getattr(config, "EXPECTED_SERVICES", None),
            }
    slug, base, pins = src.get("product_slug"), src.get("base_url"), src.get("trust")
    if not isinstance(slug, str) or not slug or not isinstance(base, str) or not isinstance(pins, Mapping):
        raise TypeError("PolarisKey: config needs product_slug, base_url and trust (the pkey sdk output)")
    services = src.get("expected_services")
    return slug, base.rstrip("/"), dict(pins), list(services) if services is not None else None


class _Trust:
    """One product's pins plus the last verified trust manifest's keys."""

    def __init__(self, slug: str, base_url: str, pins: Dict[str, str]) -> None:
        self.slug = slug
        self.base_url = base_url
        self.pins = pins
        self.tombstones: set = set()
        self.discovered: TrustSet = {}
        self.effective: TrustSet = dict(pins)
        self.floor: Optional[int] = None
        self.version = 0
        self.last_attempt = 0
        self.last_unknown = 0
        self.lock = threading.Lock()
        self.refresh_lock = threading.Lock()

    def install(self, discovered: TrustSet, revoked: Iterable[str], issued_at: Optional[int]) -> bool:
        """Install a verified manifest's keys; False (nothing changes) unless it is newer than the floor."""
        if issued_at is not None and self.floor is not None and issued_at <= self.floor:
            return False
        self.tombstones.update(revoked)
        self.discovered = discovered
        self.effective = merge_trust(usable_pins(self.pins, self.tombstones), discovered)
        if issued_at is not None:
            self.floor = issued_at if self.floor is None else max(self.floor, issued_at)
        self.version += 1
        return True


class PolarisKey:
    """The server core. Build it once at start-up and share it across requests.

    ``config`` is the ``polaris_config`` module ``pkey sdk`` writes, its ``CONFIG`` mapping, or
    ``products=[...]`` of several for a backend that serves more than one product (the document's
    ``aud`` selects the trust set). ``max_age_seconds`` tightens freshness to the document's age.
    ``errors`` is ``"respond"`` (the adapter answers) or ``"raise"`` (a :class:`PolarisKeyError`
    goes into the framework's error pipeline). ``on_refusal(problem, ctx)`` returns the
    framework's own response. ``on_verdict(code, step)`` reports every verdict for metrics and
    carries no header and no document. ``trust_refresh=False`` runs on the pins alone.
    """

    def __init__(
        self,
        config: Any = None,
        *,
        products: Optional[Sequence[Any]] = None,
        max_age_seconds: Optional[int] = None,
        errors: str = "respond",
        on_refusal: Optional[Callable[..., Any]] = None,
        on_verdict: Optional[Callable[[Optional[str], int], None]] = None,
        trust_refresh: bool = True,
        http_client: Any = None,
        clock: Optional[Callable[[], float]] = None,
        cache_size: int = 1000,
    ) -> None:
        configs = list(products) if products is not None else ([config] if config is not None else [])
        if not configs:
            raise TypeError("PolarisKey: pass config= (or products=[...])")
        if errors == "throw":
            errors = "raise"
        if errors not in ("respond", "raise"):
            raise ValueError('PolarisKey: errors is "respond" or "raise"')
        if max_age_seconds is not None and (
            isinstance(max_age_seconds, bool) or not isinstance(max_age_seconds, int) or max_age_seconds < 0
        ):
            raise ValueError("PolarisKey: max_age_seconds is a non-negative integer")
        self._trust: Dict[str, _Trust] = {}
        for c in configs:
            slug, base, pins, services = _config_fields(c)
            # A misconfiguration fails at start, not as a refusal of every request later.
            if services is not None and "license" not in services:
                raise ValueError(f"PolarisKey: product {slug!r} does not enable the license service")
            self._trust[slug] = _Trust(slug, base, pins)
        self.products: Tuple[str, ...] = tuple(self._trust)
        self.max_age_seconds = max_age_seconds
        self.errors = errors
        self.on_refusal = on_refusal
        self.on_verdict = on_verdict
        self.trust_refresh = trust_refresh
        self._http = http_client
        self._clock: Callable[[], float] = clock if clock is not None else (lambda: time.time())
        self._cache: "OrderedDict[str, Tuple[str, Any, Dict[str, Any], int]]" = OrderedDict()
        self._cache_size = cache_size
        self._cache_lock = threading.Lock()
        self._bg = threading.Event()
        # Claims of the periodic and unknown-kid fetch slots are taken under this lock.
        self._slots = threading.Lock()
        # Bumped, with the cache cleared, whenever a trust set is installed.
        self._generation = 0

    def __repr__(self) -> str:
        return f"PolarisKey(products={list(self.products)!r}, max_age_seconds={self.max_age_seconds!r})"

    @property
    def realm(self) -> str:
        """The challenge's realm: the first configured product's slug."""
        return self.products[0]

    # -- trust ----------------------------------------------------------------------------

    def _trust_sets(self) -> Dict[str, TrustSet]:
        return {slug: t.effective for slug, t in self._trust.items()}

    def _client(self) -> Any:
        with self._slots:
            if self._http is None:
                import httpx

                self._http = httpx.Client(timeout=_FETCH_TIMEOUT)
            return self._http

    def refresh_trust(self, signer: Optional[str] = None) -> bool:
        """Fetch and verify each product's signed trust manifest now. True if any installed.
        A failed fetch keeps the last verified set; pinned keys always verify."""
        if not self.trust_refresh:
            return False
        any_ok = False
        for t in self._trust.values():
            # One refresh per product at a time, across fetch, verify and install, so an older
            # manifest can never land after a newer one.
            with t.refresh_lock:
                if self._refresh_one(t):
                    any_ok = True
        return any_ok

    def _refresh_one(self, t: "_Trust") -> bool:
        now = int(self._clock())
        t.last_attempt = now
        try:
            url = f"{t.base_url}/{t.slug}/{TRUST_MANIFEST_PATH}"
            with self._client().stream(
                "GET",
                url,
                headers={
                    "accept": "application/jose",
                    HEADER_SDK_NAME: "python-server",
                    HEADER_SDK_VERSION: _sdk_version(),
                },
            ) as res:
                if res.status_code != 200:
                    return False
                body = bytearray()
                for chunk in res.iter_bytes():
                    body += chunk
                    if len(body) > MANIFEST_MAX_BYTES:
                        raise ValueError("trust manifest over the size bound")
            with t.lock:
                tombstones, floor = set(t.tombstones), t.floor
            result = verify_trust_manifest(
                body.decode("ascii"),
                pinned=t.pins,
                tombstones=tombstones,
                expected_aud=t.slug,
                last_trust_issued_at=floor,
                now=now,
            )
        except Exception:
            log.debug("trust manifest fetch failed for %s", t.slug)
            return False
        if result.doc is None:
            log.debug("trust manifest for %s was not accepted", t.slug)
            return False
        issued = result.doc.get("issuedAt")
        # Install and invalidate together: a verification that began under the older set
        # must not put its result in the cache afterwards.
        with self._cache_lock:
            with t.lock:
                installed = t.install(
                    result.discovered, result.revokedPins, issued if isinstance(issued, int) else None
                )
            if installed:
                self._generation += 1
                self._cache.clear()
        return installed

    def _trust_version(self) -> int:
        return sum(t.version for t in self._trust.values())

    def _periodic(self, now: int) -> None:
        """Kick the 900 s refresh off the request path (a daemon thread, one at a time)."""
        if not self.trust_refresh:
            return
        with self._slots:
            if self._bg.is_set() or all(
                now - t.last_attempt < TRUST_REFRESH_SECONDS for t in self._trust.values()
            ):
                return
            self._bg.set()

        def run() -> None:
            try:
                self.refresh_trust()
            finally:
                self._bg.clear()

        threading.Thread(target=run, name="polaris-key-trust", daemon=True).start()

    def _unknown_kid(self, headers: List[Tuple[str, str]], now: int) -> Optional[str]:
        """The header's ``kid`` when no trust set holds it and the 60 s throttle allows a fetch."""
        if not self.trust_refresh:
            return None
        lic = header_elements(headers, HEADER_LICENSE)
        if len(lic) != 1 or len(lic[0]) > LICENSE_MAX_BYTES:
            return None
        kid = jws_header_kid(lic[0])
        if kid is None or any(kid in t.effective for t in self._trust.values()):
            return None
        # Claim the slot before fetching, under the lock, so N concurrent junk kids cost one fetch.
        with self._slots:
            if all(now - t.last_unknown < UNKNOWN_KID_SECONDS for t in self._trust.values()):
                return None
            for t in self._trust.values():
                t.last_unknown = now
        return kid

    # -- the verdict -----------------------------------------------------------------------

    def _credential(self, headers: List[Tuple[str, str]], now: int) -> Any:
        lic = header_elements(headers, HEADER_LICENSE)
        dev = header_elements(headers, HEADER_DEVICE)
        key = None
        generation = 0
        if len(lic) == 1 and len(dev) <= 1 and len(lic[0]) <= LICENSE_MAX_BYTES:
            key = hashlib.sha256((lic[0] + "\n" + (dev[0] if dev else "")).encode("utf-8", "replace")).hexdigest()
            with self._cache_lock:
                generation = self._generation
                hit = self._cache.get(key)
                if hit is not None:
                    self._cache.move_to_end(key)
            # Step 3 holds for as long as the trust set does; the clock-dependent bound is rechecked.
            if hit is not None and hit[3] >= now and hit[1].issuedAt <= now + CLOCK_SKEW_SECONDS:
                return hit[0], hit[1], hit[2]
        with self._cache_lock:
            generation = self._generation
        parsed = parse_credential(headers, now, self.products, self._trust_sets())
        if key is not None and not isinstance(parsed, Refusal):
            with self._cache_lock:
                if generation != self._generation:
                    return parsed  # verified under an older trust set: use it, never keep it
                # Each entry lives until its own freshness deadline.
                self._cache[key] = (parsed[0], parsed[1], parsed[2], parsed[1].graceUntil + CLOCK_SKEW_SECONDS)
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
        return parsed

    def verdict(self, headers: HeadersLike, now: Optional[int] = None, require: Sequence[Requirement] = ()) -> Verdict:
        """The six steps against the current trust. No I/O."""
        pairs = _pairs(headers)
        at = int(self._clock()) if now is None else now
        parsed = self._credential(pairs, at)
        if isinstance(parsed, Refusal):
            return Verdict(_status(parsed.code), parsed.code, None, None, parsed.step)
        return judge(parsed[0], parsed[1], parsed[2], at, self.max_age_seconds, require)

    def _auth(self, v: Verdict, accept_language: Optional[str]) -> PolarisAuth:
        if self.on_verdict is not None:
            try:
                self.on_verdict(v.code, v.step)
            except Exception:
                log.debug("on_verdict raised")
        problem = backend_problem(v.code, self.realm, accept_language) if v.code else None
        if problem is not None:
            log.debug("refused %s at step %s", v.code, v.step)
        return PolarisAuth(v.license, v.user, problem)

    def authenticate(
        self,
        headers: HeadersLike,
        accept_language: Optional[str] = None,
        *,
        require: Sequence[Requirement] = (),
        now: Optional[int] = None,
    ) -> PolarisAuth:
        """Check a request's headers. May fetch the trust manifest once on an unknown ``kid``."""
        pairs = _pairs(headers)
        at = int(self._clock()) if now is None else now
        self._periodic(at)
        v = self.verdict(pairs, at, require)
        if v.code == "license_invalid" and self._unknown_kid(pairs, at) is not None:
            before = self._trust_version()
            self.refresh_trust()
            if self._trust_version() != before:
                v = self.verdict(pairs, at, require)
        return self._auth(v, accept_language)

    async def aauthenticate(
        self,
        headers: HeadersLike,
        accept_language: Optional[str] = None,
        *,
        require: Sequence[Requirement] = (),
        now: Optional[int] = None,
    ) -> PolarisAuth:
        """:meth:`authenticate` for an event loop: the trust fetch runs in a worker thread."""
        pairs = _pairs(headers)
        at = int(self._clock()) if now is None else now
        self._periodic(at)
        v = self.verdict(pairs, at, require)
        if v.code == "license_invalid" and self._unknown_kid(pairs, at) is not None:
            before = self._trust_version()
            await asyncio.to_thread(self.refresh_trust)
            if self._trust_version() != before:
                v = self.verdict(pairs, at, require)
        return self._auth(v, accept_language)

    def check(self, auth: PolarisAuth, require: Sequence[Requirement], accept_language: Optional[str] = None) -> PolarisAuth:
        """Apply a route's requirements (step 6) to an auth already made, for adapters that
        authenticate once in middleware and gate per route."""
        if auth.license is None:
            return auth
        failed = check_requirements(auth.license, auth.user, require)
        if failed is None:
            return PolarisAuth(auth.license, auth.user, None)
        if self.on_verdict is not None:
            try:
                self.on_verdict(failed, 6)
            except Exception:
                log.debug("on_verdict raised")
        return PolarisAuth(auth.license, auth.user, backend_problem(failed, self.realm, accept_language))

    def refusal(self, problem: Problem) -> PolarisKeyError:
        return PolarisKeyError(problem)


def _status(code: str) -> int:
    from ._verdict import REFUSAL_STATUS

    return REFUSAL_STATUS[code]


def _sdk_version() -> str:
    from .. import _version

    return str(_version.SDK_VERSION)
