"""The Core substrate's shared state and transport primitives — wire contract v3 §4–§6.

Polaris Key is a suite of opt-in services over an always-on Core. On the client that division
is the same one the Worker makes: Core owns the device principal, the credential, the
trust set, the verified cache, the monotonic clock floor and the sync loop; a service
module owns its own routes and the reads they feed. :class:`CoreContext` is the object
every one of them is handed.

WHY THE OPTIONS SPLIT

:class:`CoreOptions` carries what Core needs and ONLY that. The pinned trust set lives
here rather than in the license module because it verifies config documents, trust
manifests and offline bundles too — a product that has disabled License still needs pins.
Conversely ``env_prefix`` / ``env`` / ``local_overrides`` are absent: they are inputs to
config RESOLUTION, which is the config service's job, so they ride
``ConfigClientOptions``. The pre-suite client fused all of these into one 20-field bag,
which is exactly how ``trust`` ended up looking like a licensing concern.

WHY THE TRANSPORT LIVES HERE

Every product-scoped request carries the same seven ``X-PKey-*`` headers and the same
deadline, and gets the same treatment when the network simply fails. Putting that in one
place is what keeps a new service from shipping a call with no timeout on it (R4-08).
This is the second half of the Python parity gap: the pre-suite client set a timeout only
on the client it CONSTRUCTED, so an injected ``httpx.Client`` (which is how every host
that wants connection pooling, retries or a proxy supplies one) ran with whatever deadline
it happened to carry — possibly none. :meth:`CoreContext.request` passes ``timeout=`` on
EVERY call, which httpx honours per-request regardless of who built the client.
"""

from __future__ import annotations

import os
import platform
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional, Union
from urllib.parse import urlsplit

import httpx

from ..constants_generated import ErrorCode, UnsupportedReason
from .caps import Unsupported, UnsupportedError
from .clock import effective_now
from .errors import InsecureBaseUrlError, PolarisError
from .models import (
    HEADER_ARCH,
    HEADER_CHANNEL,
    HEADER_DEVICE,
    HEADER_PLATFORM,
    HEADER_SDK_NAME,
    HEADER_SDK_VERSION,
    HEADER_VERSION,
    AllowedRange,
    BlockReason,
)
from .semver import channel_for_version
from .dirs import ProductDirs, default_dir_bases, resolve_dirs
from .store import Store
from .._version import SDK_NAME, SDK_VERSION
from .headers import canonical_arch, canonical_platform
from ..discovery import (
    DEFAULT_SERVICES,
    ServicesMap,
    copy_services,
    services_from_list,
)

__all__ = [
    "DEFAULT_BASE",
    "DEFAULT_REQUEST_TIMEOUT_SECONDS",
    "LOOPBACK_HOSTS",
    "normalize_base_url",
    "now_sec",
    "now_ms",
    "CoreContext",
    "DocumentResult",
    "DocumentOk",
    "DocumentNotModified",
    "DocumentUnauthorized",
    "DocumentDeviceCap",
    "DocumentBlocked",
    "DocumentError",
]

#: Where the SDK talks to when the host does not say.
DEFAULT_BASE = "https://key.plrs.im"

#: Per-request deadline in SECONDS. Without an explicit one a slowloris on any endpoint
#: stalls ``sync()`` forever (R4-08). ``0`` disables it.
DEFAULT_REQUEST_TIMEOUT_SECONDS = 15.0

#: Loopback hosts keep ``http:`` usable for ``wrangler dev`` / integration tests; nothing
#: else may carry the bearer token unencrypted.
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})


def now_sec() -> int:
    return int(time.time())


def now_ms() -> int:
    return int(time.time() * 1000)


def normalize_base_url(raw: str) -> str:
    """Refuse a base URL that would carry the device bearer token in the clear.

    A plaintext control plane makes trust-set injection (R4-02) a coffee-shop attack
    rather than a local one, so only ``https:`` — or ``http:`` on a loopback host — is
    accepted. Raises :class:`InsecureBaseUrlError`; returns the URL with trailing slashes
    stripped.
    """
    if not isinstance(raw, str) or not raw:
        raise InsecureBaseUrlError(f"base_url is not a valid URL: {raw!r}")
    parts = urlsplit(raw)
    if not parts.scheme or not parts.netloc:
        raise InsecureBaseUrlError(f"base_url is not a valid URL: {raw}")
    host = (parts.hostname or "").lower()
    loopback = parts.scheme == "http" and host in LOOPBACK_HOSTS
    if parts.scheme != "https" and not loopback:
        raise InsecureBaseUrlError(
            f"base_url must be https: (got {parts.scheme}://{parts.netloc}); "
            "plaintext http:// is only accepted for localhost/127.0.0.1."
        )
    return raw.rstrip("/")


def _default_config_dir() -> str:
    return default_dir_bases().config


# ── The §5 status taxonomy every signed-document GET collapses to ───────────────────
@dataclass(frozen=True)
class DocumentOk:
    jws: str
    etag: Optional[str] = None
    kind: str = "ok"


@dataclass(frozen=True)
class DocumentNotModified:
    kind: str = "not-modified"


@dataclass(frozen=True)
class DocumentUnauthorized:
    kind: str = "unauthorized"


@dataclass(frozen=True)
class DocumentDeviceCap:
    limit: Optional[int] = None
    deviceCount: Optional[int] = None
    kind: str = "device-cap"


@dataclass(frozen=True)
class DocumentBlocked:
    reason: BlockReason = "version-too-old"
    allowedRange: Optional[AllowedRange] = None
    kind: str = "blocked"


@dataclass(frozen=True)
class DocumentError:
    status: int
    message: str
    kind: str = "error"


DocumentResult = Union[
    DocumentOk,
    DocumentNotModified,
    DocumentUnauthorized,
    DocumentDeviceCap,
    DocumentBlocked,
    DocumentError,
]


class CoreContext:
    """Core's live state: identity, credential wiring, transport, and the clock floor.

    Constructed once per client. :meth:`init` reads the device id off the store; nothing
    in the constructor touches the disk or the network, so a client that raises
    :class:`InsecureBaseUrlError` has done nothing else first.
    """

    def __init__(
        self,
        *,
        product_slug: str,
        version: str,
        trust: Dict[str, str],
        base_url: Optional[str] = None,
        channel: Optional[str] = None,
        store: Optional[Store] = None,
        config_dir: Optional[str] = None,
        data_dir: Optional[str] = None,
        cache_dir: Optional[str] = None,
        state_dir: Optional[str] = None,
        client: Optional[httpx.Client] = None,
        trust_refresh: bool = True,
        request_timeout: Optional[float] = DEFAULT_REQUEST_TIMEOUT_SECONDS,
        expected_services: Optional[Iterable[str]] = None,
        local_only: bool = False,
    ) -> None:
        self.product = product_slug
        self._explicit_state_dir = state_dir is not None
        #: This product's config, data, cache and state directories (P1b-09). Every option
        #: is a BASE with ``<product>`` appended; resolved, never created.
        self.dirs: ProductDirs = resolve_dirs(
            product_slug,
            config_dir=config_dir,
            data_dir=data_dir,
            cache_dir=cache_dir,
            state_dir=state_dir,
        )
        # `is None`, not falsy: an EMPTY `base_url` is a misconfiguration the host should
        # hear about, not a request for the default. Node's `??` draws the same line.
        self.base_url = normalize_base_url(
            base_url if base_url is not None else DEFAULT_BASE
        )
        self.version = version
        self.channel = channel or channel_for_version(version)
        #: Tier 1 — compiled into the host application, never mutated at runtime.
        self.pinned_trust: Dict[str, str] = dict(trust)
        self.trust_refresh_enabled = trust_refresh
        #: Set by ``polaris_key.local`` — every network-requiring call refuses instead of
        #: dialling out.
        self.local_only = local_only
        self.request_timeout = request_timeout

        if store is None:
            # Imported lazily: `polaris_key.devices` pulls in the devices sub-client, which
            # imports this module. Deferring to construction time keeps the package
            # import graph acyclic.
            from ..devices.store import KeyringStore

            store = KeyringStore(product_slug, config_dir or _default_config_dir())
        self.store: Store = store

        self._client = client
        self._owns_client = client is None
        # `is not None`, not truthiness: an EMPTY list means "this build expects no
        # services" and turns every sub-client off, which is deliberately distinct from
        # saying nothing and inheriting the suite default. (JS's `[]` is truthy, so this
        # is what keeps the two SDKs answering the same way.)
        self._expected_services = (
            list(expected_services) if expected_services is not None else None
        )
        self._discovered: Optional[ServicesMap] = None
        self._device_id = ""
        # §4.2 monotonic time floor: `max(issuedAt)` over EVERY artifact this client has
        # re-VERIFIED — both documents AND the trust manifest. Recomputed from the cached
        # JWSs at load, never read from an unsigned field, so there is nothing on disk to
        # edit in either direction (R4-04).
        self._floor = 0

    def local_state_dir(self) -> Optional[str]:
        """Where the SDK's small unsigned state files go (the update-health journal, the boot
        guard's slots, persisted config overrides): the product's state directory when the
        host named a ``state_dir`` or the store persists to disk (``store.persistent``), else
        ``None`` (in memory), so a client on ``InMemoryStore`` never writes to the home
        directory."""
        if self._explicit_state_dir or getattr(self.store, "persistent", False) is True:
            return self.dirs.state
        return None

    # ── Lifecycle ───────────────────────────────────────────────────────────────────
    def init(self) -> None:
        self._device_id = self.store.get_device_id()

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            self._client.close()
            self._client = None

    @property
    def device_id(self) -> str:
        return self._device_id

    # ── The §4.2 clock floor ────────────────────────────────────────────────────────
    @property
    def high_water_mark(self) -> int:
        return self._floor

    def now(self, system_now: Optional[int] = None) -> int:
        """The time every gate comparison runs at: ``max(systemClock, floor)``."""
        wall = now_sec() if system_now is None else system_now
        return effective_now(wall, self._floor)

    def raise_floor(self, issued_at: int) -> None:
        """Raise the floor. Monotonic by construction — it only ever rises, and only from
        content whose signature has just been checked against the pins."""
        if issued_at > self._floor:
            self._floor = issued_at

    def reset_floor(self) -> None:
        """Drop the floor to zero. Only ``deactivate()`` does this, and only alongside
        wiping every artifact the floor was derived from — a floor without its sources is
        a bare counter."""
        self._floor = 0

    # ── Capabilities (D-21) ─────────────────────────────────────────────────────────
    def services(self) -> ServicesMap:
        """Which services this product runs, resolved WITHOUT a network call.

        Precedence: a discovery document loaded this session > ``expected_services`` >
        the suite default (license + config). Release, Update and Identity are OFF in
        that default, so a client that has never seen discovery and named no expectation
        refuses their sub-clients — the fail-closed half of D-21. License and Config are
        ON, because every product has run them since before the suite existed and an
        offline-first client must not lose its licence gate to an unreachable control
        plane.

        A fresh map every call: the exported ``DEFAULT_SERVICES`` is a shared constant,
        and a caller that mutated a slice of it would silently change every client in the
        process.
        """
        if self._discovered is not None:
            return copy_services(self._discovered)
        if self._expected_services is not None:
            return services_from_list(self._expected_services)
        return copy_services(DEFAULT_SERVICES)

    def set_services(self, services: ServicesMap) -> None:
        """Install a discovery-derived capability map. Once set it wins over every
        fallback."""
        self._discovered = copy_services(services)

    def enabled(self, slug: str) -> bool:
        return bool(self.services().get(slug, {}).get("enabled", False))

    def require_service(self, slug: str, feature: str) -> None:
        """Refuse a sub-client whose service this product does not run (D-21).

        The refusal is the typed ``product`` N/A (PARITY §2.2, P1b-10): an
        :class:`~polaris_key.core.caps.UnsupportedError` with ``feature``, ``reason="product"``
        and ``detail``, as ``client.supports(feature)`` reports it, keeping the code
        ``service-unavailable`` that callers already match on."""
        if not self.enabled(slug):
            raise UnsupportedError(
                Unsupported(
                    feature,
                    UnsupportedReason.PRODUCT,
                    f"the product does not run the {slug} service",
                ),
                ErrorCode.SERVICE_UNAVAILABLE,
            )

    # ── Transport ───────────────────────────────────────────────────────────────────
    def http(self) -> httpx.Client:
        """The HTTP client, or a refusal in local-only mode.

        Refusing HERE rather than at each call site is deliberate: a transportless client
        must fail on the attempt to dial, before a URL is built or a header is assembled,
        so there is no path by which a local-only build performs a request its operator
        did not sanction.
        """
        if self.local_only:
            raise PolarisError(
                "local-only",
                "This client is in local-only mode; network calls are refused.",
            )
        if self._client is None:
            self._client = httpx.Client()
            self._owns_client = True
        return self._client

    @property
    def timeout(self) -> Optional[float]:
        """The deadline for one request. ``0`` (or ``None``) means "no deadline"."""
        if self.request_timeout is None or self.request_timeout == 0:
            return None
        return self.request_timeout

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Issue one request with the per-request deadline attached.

        EVERY Core/service call goes through here, including calls made on an httpx
        client the host injected: ``timeout=`` is a per-request argument in httpx, so the
        deadline applies regardless of how the client was built.
        """
        kwargs.setdefault("timeout", self.timeout)
        return self.http().request(method, url, **kwargs)

    def headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """The ``X-PKey-*`` client metadata every product-scoped call carries (§5).

        Platform and arch are the canonical values of WIRE-CONTRACT-V3 §5.2, mapped from
        ``platform.system()`` and ``platform.machine()``; a spelling with no value omits its
        header rather than inventing one."""
        out = {
            HEADER_DEVICE: self._device_id,
            HEADER_VERSION: self.version,
            HEADER_CHANNEL: self.channel,
            HEADER_SDK_NAME: SDK_NAME,
            HEADER_SDK_VERSION: SDK_VERSION,
        }
        platform_value = canonical_platform(platform.system())
        if platform_value is not None:
            out[HEADER_PLATFORM] = platform_value
        arch_value = canonical_arch(platform.machine())
        if arch_value is not None:
            out[HEADER_ARCH] = arch_value
        if extra:
            out.update(extra)
        return out

    def url(self, path: str) -> str:
        """``<base_url>/<product>/<path>``."""
        return f"{self.base_url}/{self.product}/{path}"

    # ── Signed documents ────────────────────────────────────────────────────────────
    def get_document(
        self, path: str, token: str, etag: Optional[str] = None
    ) -> DocumentResult:
        """GET one signed document with conditional-request support, mapping the whole §5
        status taxonomy.

        Shared verbatim by ``/license/document`` and ``/config/document``, so the two can
        never drift on what a 403, a 429 or a dropped connection means — and so that
        adding a third signed document later is a route string, not another status ladder.

        Verification is emphatically NOT here: this returns the raw compact JWS and lets
        ``sync()`` hand it to the verifier with the right trust set and anti-replay floor.
        An HTTP layer that verified would be an HTTP layer that could be talked into not
        verifying.
        """
        headers = self.headers({"authorization": f"Bearer {token}"})
        if etag:
            headers["if-none-match"] = etag
        try:
            res = self.request("GET", self.url(path), headers=headers)
        except PolarisError:
            # local-only is a configuration error the host can fix, not a transport
            # outcome — let it propagate rather than flattening it into `error`.
            raise
        except Exception as e:  # network error
            return DocumentError(status=0, message=str(e))

        status = res.status_code
        if status == 304:
            return DocumentNotModified()
        if status == 401:
            return DocumentUnauthorized()
        if status == 429:
            body = _json_or_empty(res)
            return DocumentDeviceCap(
                limit=body.get("limit"), deviceCount=body.get("deviceCount")
            )
        if status == 403:
            # v3 nests the machine-readable code and keeps `allowedRange` at the top
            # level (§5/R4). `reason` rides inside the error object so a client can still
            # tell too-old from too-new; a body that predates the nesting is read at the
            # top level too, and a body that says nothing at all falls back to the
            # stricter of the two.
            body = _json_or_empty(res)
            error = body.get("error") if isinstance(body.get("error"), dict) else {}
            reason = error.get("reason") or body.get("reason")
            if not reason:
                reason = (
                    "channel-not-entitled"
                    if error.get("code") == "channel_not_allowed"
                    else "version-too-old"
                )
            return DocumentBlocked(
                reason=reason,
                allowedRange=AllowedRange.from_dict(body.get("allowedRange")),
            )
        if status == 200:
            return DocumentOk(jws=res.text, etag=res.headers.get("etag"))
        return DocumentError(status=status, message=_text_or_empty(res))


def _json_or_empty(res: httpx.Response) -> Dict[str, Any]:
    try:
        body = res.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


def _text_or_empty(res: httpx.Response) -> str:
    try:
        return res.text
    except Exception:
        return ""
