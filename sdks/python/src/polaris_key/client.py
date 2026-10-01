"""``PolarisKeyClient`` — the suite facade: Core plus one sub-client per service.

The pre-suite ``PolarisKeyClient`` was a 770-line god object that fused the device
principal, the credential, the trust set, the cache, the gate, config resolution, device
management and the refresh loop into one class with a 20-field option bag. Every one of
those is now owned by exactly one module, and this file does nothing but compose them and
wire the two things that genuinely need a whole-client view:

* ``on_license_acquired`` → ``sync()``. Activation used to call refresh inline, so every
  mint path had to remember to, and a config-only product had no way to say "there is no
  licence here, sync anyway". Now the licence client raises an EVENT and the facade
  decides.
* :meth:`PolarisKeyClient.get_sync_state` — the bridge contract, one snapshot of everything a
  UI layer renders from, assembled from the managers that own each piece. Field-for-field
  with ``@polaris-key/node``'s ``SyncState``.

SECURITY (wire contract v3): every security-relevant value the client holds is DERIVED
from a signature it has just checked. The cache stores compact JWSs and nothing else; the
trust set is ``{**manifest_keys, **pinned_keys}`` with the pins terminal; the per-type
anti-replay floors, the monotonic clock floor and ``lastVerifiedAt`` are recomputed on
every load. There is no unsigned field left for a local attacker to poison.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional

import httpx

from .config.client import DEFAULT_ENV_PREFIX, ConfigClient
from .core.bundle import ImportBundleResult, import_bundle
from .core.cache import CacheManager
from .core.context import DEFAULT_REQUEST_TIMEOUT_SECONDS, CoreContext
from .core.models import (
    ActivationSource,
    BlockedState,
    DocProfile,
    LicenseDoc,
)
from .core.store import Store
from .core.sync import SyncDeps, SyncResult, sync as run_sync
from .core.telemetry import build_snapshot, report_snapshot
from .core.token import TokenManager
from .core.trust import TrustManager
from .devices.client import (
    DeviceManagementUnsupportedError,
    DevicesClient,
    RegisterResult,
)
from .devices.facts import ProbeDeclaration
from .identity.client import IdentityClient
from .discovery import (
    DiscoveryOk,
    ServicesMap,
    discover_product,
)
from .license.client import LicenseClient
from .license.endpoints import ActivationOk, reacquire_token
from .license.gate import LicenseState
from .release.client import ReleaseClient
from .update.client import UpdateClient

__all__ = [
    "PolarisKeyClient",
    "SyncState",
    "DeviceInfo",
    "DeviceManagementUnsupportedError",
]


@dataclass(frozen=True)
class SyncState:
    """The bridge contract — one snapshot of everything a UI layer renders from.

    ``doc`` is the LICENCE document because that is what a gate UI renders; config values
    are read through ``client.config``, which has its own accessors and no reason to hand
    out a whole doc.
    """

    activation: Optional[ActivationSource]
    doc: Optional[LicenseDoc]
    lastSyncUnauthorized: bool
    blocked: Optional[BlockedState]
    #: Epoch MILLIseconds, or ``None``. Offline this is derived from the newest document's
    #: signed ``issuedAt``, so it is never a value an attacker chose (R4-04).
    lastVerifiedAt: Optional[int]
    #: §4.2's monotonic floor, in epoch SECONDS.
    highWaterMark: int


@dataclass(frozen=True)
class DeviceInfo:
    """One device as the facade reports it, blending the roster with locally-derived
    state."""

    id: str
    current: bool
    status: str
    licenseId: Optional[str] = None
    profile: Optional[DocProfile] = None
    lastVerifiedAt: Optional[int] = None
    label: Optional[str] = None
    platform: Optional[str] = None
    arch: Optional[str] = None
    appVersion: Optional[str] = None
    sdkName: Optional[str] = None
    sdkVersion: Optional[str] = None


class PolarisKeyClient:
    """Core plus ``client.license`` / ``.config`` / ``.devices`` / ``.identity`` /
    ``.release`` / ``.update``."""

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
        client: Optional[httpx.Client] = None,
        trust_refresh: bool = True,
        request_timeout: Optional[float] = DEFAULT_REQUEST_TIMEOUT_SECONDS,
        expected_services: Optional[Iterable[str]] = None,
        local_only: bool = False,
        # ── config service inputs (override layers) ──────────────────────────────────
        local_overrides: Optional[Mapping[str, Any]] = None,
        env_prefix: str = DEFAULT_ENV_PREFIX,
        env: Optional[Mapping[str, str]] = None,
        # ── licence + devices inputs ─────────────────────────────────────────────────
        fingerprint: bool = True,
        probes: Optional[List[ProbeDeclaration]] = None,
        # ── lifecycle ────────────────────────────────────────────────────────────────
        refresh_interval_seconds: Optional[float] = None,
        on_change: Optional[Callable[[LicenseState], None]] = None,
    ) -> None:
        self.product = product_slug
        self.core = CoreContext(
            product_slug=product_slug,
            version=version,
            trust=trust,
            base_url=base_url,
            channel=channel,
            store=store,
            config_dir=config_dir,
            client=client,
            trust_refresh=trust_refresh,
            request_timeout=request_timeout,
            expected_services=expected_services,
            local_only=local_only,
        )
        self._trust = TrustManager(self.core)
        self._cache = CacheManager(self.core, self._trust)
        # The re-acquire path is INJECTED so Core does not depend on the license module;
        # §5's single-attempt rule lives in `TokenManager` and the ROUTE lives in
        # `license/endpoints.py`.
        self._tokens = TokenManager(self.core, self.core.store, _reacquire)
        self._probes: List[ProbeDeclaration] = list(probes or [])

        self.devices = DevicesClient(
            self.core,
            self._cache,
            self._tokens,
            probes=self._probes,
            fingerprint=fingerprint,
        )
        self.license = LicenseClient(
            self.core,
            self._cache,
            self._tokens,
            self.devices,
            # The activation event: mint a credential, then sync. Only LICENCE
            # acquisition fires it — `devices.register()` deliberately does not, because
            # a keyless registration is a provisioning step a host may want to take long
            # before it wants documents (an installer that registers at setup and syncs on
            # first launch). The CLI's `register` verb syncs explicitly for exactly that
            # reason; the SDK does not decide it for the host.
            lambda _source: self._on_license_acquired(),
            fingerprint=fingerprint,
        )
        self.config = ConfigClient(
            self.core,
            self._cache,
            local_overrides=local_overrides,
            env_prefix=env_prefix,
            env=env,
            tokens=self._tokens,
        )
        # Device-code sign-in raises the same acquisition event activation does: a
        # signed-in device holds a licensed token exactly as an activated one does, and
        # syncs the same way.
        self.identity = IdentityClient(self.core, self._tokens, self._on_license_acquired)
        self.release = ReleaseClient(self.core, self._tokens)
        self.update = UpdateClient(self.core, self._tokens, lambda: self._discovery_doc)

        self._discovery_doc: Optional[Dict[str, Any]] = None
        self._refresh_interval = refresh_interval_seconds
        self._on_change = on_change
        self._timer_stop = threading.Event()
        self._timer: Optional[threading.Thread] = None

    @classmethod
    def create(cls, **opts: Any) -> "PolarisKeyClient":
        c = cls(**opts)
        c.init()
        return c

    # ── Lifecycle ───────────────────────────────────────────────────────────────────
    def init(self) -> None:
        """Load device id + token + cached documents. NO NETWORK — an offline-first host
        must be able to render its gate before it has ever reached the control plane."""
        self.core.init()
        self._tokens.load()
        self._cache.load()
        self._start_timer()

    def close(self) -> None:
        """Stop the refresh thread and release the HTTP client. Safe to call twice."""
        self._timer_stop.set()
        timer = self._timer
        if timer is not None:
            timer.join(timeout=1.0)
            self._timer = None
        self.core.close()

    def __enter__(self) -> "PolarisKeyClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _start_timer(self) -> None:
        """Start the optional refresh loop.

        OFF unless ``refresh_interval_seconds`` is set — enabling it by default would add
        network traffic and wakeups to every already-shipped integration. Never started in
        local-only mode: a transportless client must not have a thread whose whole job is
        to attempt a request. The thread is a daemon so it can never hold a CLI open.
        """
        interval = self._refresh_interval
        if not interval or interval <= 0 or self._timer is not None:
            return
        if self.core.local_only:
            return

        def loop() -> None:
            while not self._timer_stop.wait(interval):
                try:
                    self.sync()
                except Exception:
                    # A transient network failure must not kill the loop.
                    pass

        self._timer = threading.Thread(target=loop, name="polaris-sync", daemon=True)
        self._timer.start()

    # ── Capabilities (D-21) ─────────────────────────────────────────────────────────
    def discover(self) -> Any:
        """Fetch ``/.well-known/polaris.json`` and install the product's real capability
        map.

        Explicit rather than automatic, because it is a NETWORK read and ``sync()`` must
        stay predictable: a client that has never called this resolves capabilities from
        ``expected_services`` or the suite default. Once a document is loaded it wins over
        both — discovery is the authority when it is available.
        """
        # `http()` is called EAGERLY, and its local-only refusal is allowed to propagate:
        # a transportless client must not open a socket to the control plane, which is the
        # one thing `polaris_key.local` exists to make impossible.
        client = self.core.http()
        result = discover_product(
            base_url=self.core.base_url,
            product=self.product,
            client=client,
            timeout=self.core.timeout,
        )
        if isinstance(result, DiscoveryOk):
            self._discovery_doc = result.manifest
            self.core.set_services(result.services)
        return result

    def capabilities(self) -> ServicesMap:
        """What this client currently believes the product runs."""
        return self.core.services()

    # ── Sync ────────────────────────────────────────────────────────────────────────
    def sync(self, *, force: bool = False) -> SyncResult:
        """One Core pass: trust refresh → enabled documents → verify → cache → floor →
        report. See :mod:`polaris_key.core.sync` for the full ordering rationale."""
        before_license = self._cache.etag("license")
        before_config = self._cache.etag("config")
        result = run_sync(
            SyncDeps(
                ctx=self.core,
                trust=self._trust,
                cache=self._cache,
                tokens=self._tokens,
                report=self._report_once,
            ),
            force=force,
        )
        # The ETags are the change signal: they exclude the per-request timestamps, so a
        # differing tag means the CONTENT changed rather than that the document was merely
        # re-signed.
        changed = (
            self._cache.etag("license") != before_license
            or self._cache.etag("config") != before_config
        )
        if self._on_change is not None and result.applied and changed:
            self._on_change(self.license.status())
        return result

    def _report_once(self) -> None:
        token = self._tokens.current
        if not token:
            return
        report_snapshot(self.core, token, build_snapshot(self._cache, self._probes))

    def _on_license_acquired(self) -> None:
        self.sync(force=True)

    def get_sync_state(self) -> SyncState:
        state = self._cache.state
        return SyncState(
            activation=self.license.activation(),
            doc=self._cache.license_doc(),
            lastSyncUnauthorized=state.lastSyncUnauthorized,
            blocked=state.blocked,
            lastVerifiedAt=state.lastVerifiedAt,
            highWaterMark=self.core.high_water_mark,
        )

    # ── Offline bundles (§7) ────────────────────────────────────────────────────────
    def import_bundle(self, jws: str, now: Optional[int] = None) -> ImportBundleResult:
        """Verify and install an offline activation bundle. All-or-nothing; no token is
        created. Raises :class:`PolarisError` carrying the §7 step that refused."""
        return import_bundle(self.core, self._cache, jws, now)

    # ── Convenience passthroughs ────────────────────────────────────────────────────
    # Kept deliberately small. The suite's shape is `client.<service>.<verb>`; these exist
    # only for the calls a host makes before it knows which service it is talking to.
    def status(self, now: Optional[int] = None) -> LicenseState:
        return self.license.status(now)

    def is_licensed(self, now: Optional[int] = None) -> bool:
        return self.license.is_licensed(now)

    def get_config(self, key: str, fallback: Any = None) -> Any:
        return self.config.get_config(key, fallback)

    def register(self) -> RegisterResult:
        return self.devices.register()

    def current_device(self) -> DeviceInfo:
        state = self._cache.state
        return DeviceInfo(
            id=self.core.device_id,
            current=True,
            status=self.license.status().status,
            licenseId=self.license.get_license_id(),
            profile=self.license.get_profile(),
            lastVerifiedAt=state.lastVerifiedAt,
        )

    def list_devices(self) -> List[DeviceInfo]:
        """The device roster, blended with this device's locally-derived state.

        Without a credential there is no roster to fetch, so the answer is this device
        alone — which is the honest offline answer, not an error.
        """
        current = self.current_device()
        try:
            roster = self.devices.list()
        except DeviceManagementUnsupportedError:
            return [current]
        return [
            DeviceInfo(
                id=d.id,
                current=d.current,
                status=current.status if d.current else d.status,
                licenseId=d.licenseId
                or (current.licenseId if d.current else None),
                profile=current.profile if d.current else None,
                lastVerifiedAt=current.lastVerifiedAt if d.current else None,
                label=d.label,
                platform=d.platform,
                arch=d.arch,
                appVersion=d.appVersion,
                sdkName=d.sdkName,
                sdkVersion=d.sdkVersion,
            )
            for d in roster
        ]

    def deauthorize_device(self, device_id: str) -> None:
        """Deauthorizing THIS device is a full local deactivation; any other device is a
        roster operation that needs a credential."""
        if device_id == self.core.device_id:
            self.license.deactivate()
            return
        self.devices.deauthorize(device_id)

    def rename_device(self, device_id: str, label: Optional[str]) -> None:
        self.devices.rename(device_id, label)

    def deactivate(self) -> None:
        self.license.deactivate()


def _reacquire(ctx: CoreContext, current: str) -> Optional[str]:
    """§5's single ``POST /<p>/license/token`` attempt, wired into ``TokenManager``."""
    r = reacquire_token(ctx, current)
    return r.token if isinstance(r, ActivationOk) else None
