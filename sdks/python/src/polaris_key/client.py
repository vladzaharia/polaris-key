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

import os
import platform as _platform
import threading
import weakref
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional

import httpx

from .commerce import CommerceClient
from .config.client import DEFAULT_ENV_PREFIX, ConfigClient
from .core.bundle import ImportBundleResult, import_bundle
from .core.cache import CacheManager
from .core.caps import (
    Detector,
    DetectorKey,
    Support,
    evaluate_support,
    supported_features,
    validate_detectors,
)
from .constants_generated import Feature, StoreDegradedReason, UnsupportedReason
from .core.context import DEFAULT_REQUEST_TIMEOUT_SECONDS, CoreContext
from .core.models import (
    ActivationSource,
    BlockedState,
    DocProfile,
    LicenseDoc,
)
from .core.store import Store, StoreStatus
from .core.sync import SyncDeps, SyncResult, sync as run_sync
from .core.events import EventBus
from .core.local_state import JsonStateFile
from .core.update_journal import UpdateJournal
from .core.token import (
    Reacquired,
    TokenManager,
    TokenSource,
    choose_reacquire_route,
)
from .core.trust import TrustManager
from .devices.client import (
    DeviceManagementUnsupportedError,
    DevicesClient,
    RegisterOk,
    RegisterResult,
)
from .devices.facts import ProbeDeclaration
from .identity.client import IdentityClient
from .distribution import DistributionClient
from .portal import PortalClient, origin_of as portal_origin
from .core.headers import canonical_platform
from .discovery import (
    DiscoveryOk,
    ServicesMap,
    discover_product,
)
from .license.client import LicenseClient
from .license.endpoints import ActivationOk, reacquire_token
from .license.gate import LicenseState
from .release.client import ReleaseClient
from .update.bootguard import BootGuard
from .update.client import UpdateClient, UpdateClientOptions

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
    ``.release`` / ``.update`` / ``.commerce``."""

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
        # ── config service inputs (override layers) ──────────────────────────────────
        local_overrides: Optional[Mapping[str, Any]] = None,
        env_prefix: str = DEFAULT_ENV_PREFIX,
        env: Optional[Mapping[str, str]] = None,
        # ── licence + devices inputs ─────────────────────────────────────────────────
        fingerprint: bool = True,
        probes: Optional[List[ProbeDeclaration]] = None,
        # ── update inputs (wire v4) ──────────────────────────────────────────────────
        update: Optional[UpdateClientOptions] = None,
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
            data_dir=data_dir,
            cache_dir=cache_dir,
            state_dir=state_dir,
            client=client,
            trust_refresh=trust_refresh,
            request_timeout=request_timeout,
            expected_services=expected_services,
            local_only=local_only,
        )
        self._trust = TrustManager(self.core)
        self._cache = CacheManager(self.core, self._trust)
        # The re-acquire path is INJECTED so Core does not depend on the license or devices
        # modules; §5's single-attempt rule lives in `TokenManager`, the route CHOICE in
        # `choose_reacquire_route`, and the two routes in `license/endpoints.py` and
        # `devices/client.py`.
        self._tokens = TokenManager(self.core, self.core.store, self._reacquire)
        self._probes: List[ProbeDeclaration] = list(probes or [])

        self.devices = DevicesClient(
            self.core,
            self._cache,
            self._tokens,
            probes=self._probes,
            fingerprint=fingerprint,
            caps=lambda: self.caps(),
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
        #: ``client.events`` (SDK parity pass §3.11): license, entitlement, config,
        #: updateAvailable, packs and store changes, to any number of subscribers.
        self.events = EventBus()
        state_dir = self.core.local_state_dir()
        self.config = ConfigClient(
            self.core,
            self._cache,
            local_overrides=local_overrides,
            env_prefix=env_prefix,
            env=env,
            tokens=self._tokens,
            local_store=JsonStateFile(
                os.path.join(state_dir, "settings.json") if state_dir else None,
                lambda: {"overrides": {}},
            ),
            events=self.events,
        )
        # Device-code sign-in raises the same acquisition event activation does: a
        # signed-in device holds a licensed token exactly as an activated one does, and
        # syncs the same way.
        self.identity = IdentityClient(
            self.core,
            self._tokens,
            self._on_license_acquired,
            deactivate=lambda: self.license.deactivate(),
            profile=lambda: self.license.get_profile(),
            on_signed_out=lambda: self._license_changed(),
        )
        self.release = ReleaseClient(self.core, self._tokens, lambda: self._discovery_doc)
        #: The public download model (``distribution/download.json``, SDK parity pass §3.8).
        self.distribution = DistributionClient(
            self.core, platform=getattr(update, "platform", None)
        )
        # Wire v4's signed decision: the pinned release keys, the outlet, the installed build's
        # format and build number, the host's methods. Validated here: a bad value, or a
        # release key that is also a trust pin, raises `invalid-options` from the constructor.
        self.update = UpdateClient(
            self.core,
            self._tokens,
            lambda: self._discovery_doc,
            cache=self._cache,
            trust=self._trust,
            discover=self.discover,
            options=update,
        )

        # Store purchases → licence flags (P6-01). The one-call claim helpers sync on success.
        self.commerce = CommerceClient(
            self.core,
            self._tokens,
            sync=lambda: self.sync(force=True),
            is_entitled=lambda flag: self.license.is_entitled(flag),
            outlet_kind=lambda: self.update.outlet.kind if self.update.outlet is not None else None,
        )

        #: Links into the customer portal (SDK parity pass §3.5).
        self.portal = PortalClient(
            product_slug,
            lambda: portal_origin(self.core.base_url, self._discovery_doc),
            platform=getattr(update, "platform", None) or canonical_platform(_platform.system()),
        )

        # `devices/report` carries the active pack set's id (plans/P4-01.md §2.11).
        self.devices.pack_set_id = self.update.packs.pack_set_id

        # The update-health journal (P6-03; SDK parity pass §3.13): decide, packs, the boot
        # guard and the install drivers record into it, and every device report carries its
        # pending events in `updates`, with `gate`, `outlet` and `packInstalls` beside them.
        self.update_journal = UpdateJournal(self.core.local_state_dir(), self._journal_context)
        self.update.journal = self.update_journal
        self.release.update = self.update
        self.update._client_ref = weakref.ref(self)
        self.update.events = self.events
        self.update.packs.on(
            lambda p: self.events.emit(
                "packs", pack=p.pack_id, phase=p.phase, done=p.done, total=p.total
            )
        )
        self._observed: Optional[Dict[str, Any]] = None
        self.config.changed = self._publish
        # The app build's boot guard (SDK parity pass §3.15), beside the token store.
        self.update.guard = BootGuard(
            self.core.local_state_dir(), lambda: self.core.version, journal=self.update_journal
        )
        self.update.packs.journal = self.update_journal
        self.devices.journal = self.update_journal
        self.devices.gate_status = lambda: self.license.status().status
        self.devices.outlet_id = self.outlet_id
        self.devices.pack_installs = self.update.packs.pack_installs

        self._discovery_doc: Optional[Dict[str, Any]] = None
        # The detectors behind the table's conditional N/As (P1b-10). Checked against the
        # generated table here, so a manifest that gains or loses one fails loudly.
        self._detectors: Dict[DetectorKey, Detector] = {
            (Feature.CORE_STORE, UnsupportedReason.DEPENDENCY): self._keyring_missing,
        }
        validate_detectors(self._detectors)
        self._refresh_interval = refresh_interval_seconds
        self._on_change = on_change
        self._timer_stop = threading.Event()
        self._timer: Optional[threading.Thread] = None

    @classmethod
    def create(cls, *, auto_discover: Optional[bool] = None, **opts: Any) -> "PolarisKeyClient":
        """Construct, :meth:`init` (no network) and, with ``auto_discover``, load the product's
        discovery document so the sub-clients follow the services the product really runs.

        ``auto_discover`` defaults to ``True`` when the host pins no ``expected_services`` (and
        the client is not local-only): a client that was told nothing should learn the truth
        rather than guess the suite default. Discovery is best-effort here: unreachable or
        refused, the client keeps its offline answer (``expected_services``, else the default)
        and :meth:`discover` can be called again later.
        """
        c = cls(**opts)
        c.init()
        if auto_discover is None:
            auto_discover = opts.get("expected_services") is None and not opts.get("local_only")
        if auto_discover:
            c.try_discover()
        return c

    def try_discover(self) -> Any:
        """:meth:`discover`, but never raising: the result, or ``None`` when the request could
        not be made (local-only, a transport failure)."""
        try:
            return self.discover()
        except Exception:
            return None

    # ── Lifecycle ───────────────────────────────────────────────────────────────────
    def init(self) -> None:
        """Load device id + token + cached documents. NO NETWORK — an offline-first host
        must be able to render its gate before it has ever reached the control plane."""
        self.core.init()
        self._tokens.load()
        self._cache.load()
        # Wire v4's update slices go through the same reload path: every committed feed and
        # record is re-verified against what this load trusts, and each channel's `seq` floor
        # comes from the feed that survives.
        self.update.reload()
        self._observed = self._observe()
        status = self.store_status()
        if status is not None and status.degraded is not None:
            self.events.emit(
                "store", reason=status.degraded.reason, detail=status.degraded.detail
            )
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

    # ── supports() and capability telemetry (P1b-10, PARITY §2.2) ───────────────────
    def supports(self, feature: str) -> Support:
        """Whether ``feature`` (a :class:`Feature` id) works here, right now.

        :class:`Supported`, or :class:`Unsupported` with ``reason`` ``runtime`` (this runtime
        cannot), ``product`` (the product runs no service for it, per :meth:`capabilities`),
        ``dependency`` (the optional ``keyring`` extra or backend is missing, for
        ``core.store``) or ``version`` (this SDK version does not implement or know it).
        Offline and side-effect free: it reads the generated capability table, the services
        this client believes in and the environment, and never calls anything."""
        return evaluate_support(
            feature,
            services_enabled=self.core.enabled,
            detectors=self._detectors,
        )

    def caps(self) -> List[str]:
        """The feature ids :meth:`supports` answers Supported for, in registry order. Sent as
        ``caps`` with every device report."""
        return supported_features(self.supports)

    def _keyring_missing(self) -> Optional[str]:
        """``core.store``'s ``dependency`` detector: the store's reason when its OS keyring
        cannot be used (the optional ``keyring`` package or a usable backend is missing).
        A host store that reports nothing is the host's business: supported."""
        store = self.core.store
        probe = getattr(store, "keyring_unavailable", None)
        if callable(probe):
            try:
                why = probe()
            except Exception:
                return None
            return why or None
        status = self.store_status()
        if (
            status is not None
            and status.degraded is not None
            and status.degraded.reason == StoreDegradedReason.KEYRING_UNAVAILABLE
        ):
            return status.degraded.detail or "the OS keyring is unavailable"
        return None

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
        self._publish()
        return result

    # ── Change events (SDK parity pass §3.11) ───────────────────────────────────────
    def subscribe(self, listener: Callable[[Any], None], kinds: Optional[Iterable[str]] = None) -> Callable[[], None]:
        """``client.events.subscribe``: call ``listener(event)`` for every change (or only
        ``kinds``). Returns the unsubscribe function."""
        return self.events.subscribe(listener, kinds)

    def on_config_change(self, key: str, listener: Callable[[Any], None]) -> Callable[[], None]:
        """Call ``listener(event)`` when ``key``'s effective value changes (``"*"``: any)."""
        return self.config.on_change(key, listener)

    def _observe(self) -> Dict[str, Any]:
        try:
            doc = self.license.doc
            names = sorted(doc.entitlements) if doc is not None else []
            return {
                "status": self.license.status().status,
                "ents": {n: self.license.entitlement_value(n) for n in names},
                "config": self.config.snapshot(),
            }
        except Exception:
            return {"status": None, "ents": {}, "config": {}}

    def _publish(self) -> None:
        """Emit the license, entitlement and config events since the last observation."""
        before = self._observed
        after = self._observe()
        self._observed = after
        if before is None:
            return
        if before["status"] != after["status"]:
            self.events.emit("license", status=after["status"], previous=before["status"])
        for name in sorted(set(before["ents"]) | set(after["ents"])):
            a, b = after["ents"].get(name), before["ents"].get(name)
            if a != b:
                self.events.emit("entitlement", name=name, value=a, previous=b)
        for key in sorted(set(before["config"]) | set(after["config"])):
            a, b = after["config"].get(key), before["config"].get(key)
            if a != b:
                self.events.emit(
                    "config", key=key, value=a, previous=b, source=self.config.get_config_source(key)
                )

    def _report_once(self) -> None:
        if not self._tokens.current:
            return
        self.devices.report()

    def crash_tags(self) -> Dict[str, str]:
        """Tags for a crash reporter (SDK parity pass §3.14), exactly the convention the
        Worker's Sentry hook maps to rollouts: ``release`` is ``<deliverable>@<version>[+<build>]``
        (``app@1.2.0+45``), ``environment`` the channel, ``pkey.outlet`` the outlet (left out
        when unknown). No crash SDK is imported: pass these to ``sentry_sdk.init(release=…,
        environment=…)`` and ``sentry_sdk.set_tag("pkey.outlet", …)``."""
        build = None
        opts = self.update._configured.opts if self.update._configured is not None else None
        if opts is not None and opts.build_number:
            build = opts.build_number
        tags = {
            "release": f"app@{self.core.version}{'+' + build if build else ''}",
            "environment": self.core.channel,
        }
        outlet = self.outlet_id()
        if outlet:
            tags["pkey.outlet"] = outlet
        return tags

    def outlet_id(self) -> Optional[str]:
        """The outlet this install resolved (``client.update.outlet``: its id, else its kind),
        or ``None`` without update options or when it is ``unknown``. Sent as the report's
        ``outlet`` and stamped on every update-health event."""
        try:
            resolved = self.update.outlet
        except Exception:
            return None
        if resolved is None:
            return None
        value = resolved.id or resolved.kind
        return value if isinstance(value, str) and value and value != "unknown" else None

    def _journal_context(self) -> Dict[str, Optional[str]]:
        return {
            "outlet": self.outlet_id(),
            "channel": self.core.channel,
            "release": self.core.version,
        }

    def _on_license_acquired(self) -> None:
        self.sync(force=True)

    def _license_changed(self) -> None:
        """The licence state may have moved without a sync (a sign-out, a deactivation)."""
        self._publish()
        if self._on_change is not None:
            try:
                self._on_change(self.license.status())
            except Exception:
                pass

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

    # ── One-call boot (SDK parity pass §3.4) ───────────────────────────────────────────
    def boot(self, **opts: Any) -> Any:
        """Discover → guard → sync (registering or enrolling when no player is needed) → gate →
        decide → required packs → ready, through the shared boot stage machine. Returns a
        :class:`~polaris_key.boot.BootOutcome`; see :func:`polaris_key.boot.run_boot` for the
        options (``on_stage``, ``consent``, ``metered``, ``answer``, ``enroll``,
        ``auto_confirm``, …). A ``needs_activation`` outcome is for the UI to render."""
        from .boot import run_boot

        return run_boot(self, **opts)

    def ensure_activated(self, *, enroll: bool = False) -> Any:
        """Register (an ``open`` product without License) or, with ``enroll=True``, enrol
        keylessly when nothing is held, then sync. Returns an
        :class:`~polaris_key.boot.ActivationOutcome` whose ``kind`` is ``needs-activation`` when
        the player must still act."""
        from .boot import ensure_activated

        return ensure_activated(self, enroll=enroll)

    # ── Offline bundles (§7) ────────────────────────────────────────────────────────
    def import_bundle(self, jws: str, now: Optional[int] = None) -> ImportBundleResult:
        """Verify and install an offline activation bundle. All-or-nothing; no token is
        created. Raises :class:`PolarisError` carrying the §7 step that refused."""
        result = import_bundle(self.core, self._cache, jws, now)
        self._publish()
        return result

    # ── Convenience passthroughs ────────────────────────────────────────────────────
    # Kept deliberately small. The suite's shape is `client.<service>.<verb>`; these exist
    # only for the calls a host makes before it knows which service it is talking to.
    def status(self, now: Optional[int] = None) -> LicenseState:
        return self.license.status(now)

    def is_licensed(self, now: Optional[int] = None) -> bool:
        return self.license.is_licensed(now)

    def store_status(self) -> Optional[StoreStatus]:
        """Where the token store keeps the token, and why if that is weaker than this
        platform's best option (P1b-09, R4-11). ``None`` when the store does not report (a
        host store without ``status()``). Never raises."""
        status = getattr(self.core.store, "status", None)
        if not callable(status):
            return None
        try:
            result = status()
        except Exception:
            return None
        return result if isinstance(result, StoreStatus) else None

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
            self.deactivate()
            return
        self.devices.deauthorize(device_id)

    def rename_device(self, device_id: str, label: Optional[str]) -> None:
        self.devices.rename(device_id, label)

    def deactivate(self) -> None:
        self.license.deactivate()
        self._license_changed()

    def _reacquire(
        self, ctx: CoreContext, current: str, source: Optional[TokenSource]
    ) -> Optional[Reacquired]:
        """The §5 single re-acquire, wired into ``TokenManager``.

        ``POST /<p>/license/token`` for a licensed device, or ``POST /<p>/devices/register``
        (keyless, no bearer) for a registered-without-licence device or a product with
        License off. ``None`` means the one attempt failed (403 ``registration_closed``,
        401, 404, 429 or transport) and the hard-401 path applies.
        """
        route = choose_reacquire_route(
            license_enabled=ctx.enabled("license"), source=source
        )
        if route == "devices-register":
            r = self.devices.request_registration()
            return Reacquired(r.token, "register") if isinstance(r, RegisterOk) else None
        a = reacquire_token(ctx, current)
        return Reacquired(a.token, "reacquire") if isinstance(a, ActivationOk) else None
