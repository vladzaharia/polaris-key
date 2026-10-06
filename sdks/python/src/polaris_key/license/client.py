"""The License sub-client — activation, entitlements, and the gate (wire contract v3 §5).

WHAT THE GATE READS, AND WHERE EACH INPUT COMES FROM

:meth:`LicenseClient.status` is a pure call into :func:`polaris_key.license.gate.license_state`;
everything interesting is in assembling its inputs, and each one comes from exactly one
owner:

  ``license_service_enabled``  Core's resolved capabilities (discovery → expected_services
                               → default). FALSE short-circuits the machine to
                               ``not-applicable`` with usable TRUE, which is how a
                               config-only product boots usable instead of sitting on
                               ``needs-activation`` forever (D-08).
  ``activation``               ``"token"`` if a ``pkeyt_`` credential is held, else
                               ``"bundle"`` if a verified offline import left a licence
                               document, else ``None``. A token SUPERSEDES a bundle (§7).
  ``doc`` / ``high_water_mark`` the re-verified cache and the monotonic floor, both Core's.
  ``blocked`` / ``last_sync…`` unsigned hints that can only ever make the gate STRICTER.

Activation itself does not call ``sync()`` directly. It stores the token and RAISES AN
EVENT; the facade wires that to ``core.sync()``. The pre-suite client called refresh
inline, which meant every activation path had to remember to, and a config-only product
had no way to say "there is no licence here, sync anyway".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Literal, Optional, Tuple

from ..core.cache import CacheManager
from ..core.context import CoreContext, now_sec
from ..core.models import ActivationSource, DocProfile, LicenseDoc
from ..core.token import TokenManager
from .endpoints import (
    ActivationOk,
    ActivationResult,
    activate_with_key,
    deauthorize,
    enroll,
)
from .gate import LicenseState, is_usable, license_state

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..devices.client import DevicesClient
# The floor every licence holds (WIRE-CONTRACT-V3 §5.1), and the answer when a licence carries
# no ``channels`` entitlement. Re-exported for hosts that imported it from here.
from ..constants_generated import CHANNEL_STABLE

__all__ = ["LicenseClient", "LicenseAcquiredListener", "LicenseInfo", "CHANNEL_STABLE"]


@dataclass(frozen=True)
class LicenseInfo:
    """A summary of the verified licence document for an account or "About" screen (SDK parity
    pass §3.3), read from the enforced entitlements the Worker writes (``license.tier``,
    ``license.tierLabel``, ``deviceLimit``, ``channels``) and the signed ``profile``.

    ``deviceCount`` and ``expiresAt`` are ``None`` today: the licence document carries neither
    (the per-licence expiry arrives with licence document v2, LX-18); the fields exist so a UI
    written now renders them when they do."""

    licenseId: str
    tier: Optional[str] = None
    tierLabel: Optional[str] = None
    deviceLimit: Optional[int] = None
    deviceCount: Optional[int] = None
    expiresAt: Optional[int] = None
    profile: Optional[DocProfile] = None
    entitledChannels: Tuple[str, ...] = ("stable",)


#: Raised after a credential is minted, so the facade can sync without every activation
#: path having to remember to.
LicenseAcquiredListener = Callable[[ActivationSource], None]


class LicenseClient:
    def __init__(
        self,
        ctx: CoreContext,
        cache: CacheManager,
        tokens: TokenManager,
        devices: "DevicesClient",
        on_acquired: LicenseAcquiredListener,
        *,
        fingerprint: bool = True,
    ) -> None:
        self._ctx = ctx
        self._cache = cache
        self._tokens = tokens
        self._devices = devices
        self._on_acquired = on_acquired
        self._fingerprint_enabled = fingerprint

    # ── Gate ────────────────────────────────────────────────────────────────────────
    def activation(self) -> Optional[ActivationSource]:
        """How this install became activated, or ``None``. §7: a token supersedes a
        bundle."""
        if self._tokens.current is not None:
            return "token"
        # A bundle activates ONLY if its licence document actually verified — a
        # config-only bundle imports settings and grants nothing.
        state = self._cache.state
        if state.importedBundle is not None and state.license is not None:
            return "bundle"
        return None

    def status(self, now: Optional[int] = None) -> LicenseState:
        state = self._cache.state
        return license_state(
            license_service_enabled=self._ctx.enabled("license"),
            activation=self.activation(),
            doc=self._cache.license_doc(),
            now=now_sec() if now is None else now,
            high_water_mark=self._ctx.high_water_mark,
            last_sync_unauthorized=state.lastSyncUnauthorized,
            blocked=state.blocked,
            last_verified_at=state.lastVerifiedAt,
        )

    def is_licensed(self, now: Optional[int] = None) -> bool:
        return is_usable(self.status(now))

    # ── Reads off the licence document ──────────────────────────────────────────────
    @property
    def doc(self) -> Optional[LicenseDoc]:
        return self._cache.license_doc()

    def is_entitled(self, name: str, now: Optional[int] = None) -> bool:
        """Whether the licence grants the boolean flag ``name``.

        ``False`` whenever the gate is not usable (S-19 G11): a revoked, expired, blocked or
        never-activated install answers ``False`` even while a previously verified document
        still names the flag. Before this, a revoked device kept its unlocks until the cache
        was cleared.
        """
        doc = self.doc
        if doc is None or not self.is_licensed(now):
            return False
        entry = doc.entitlements.get(name)
        return bool(entry is not None and entry.value is True)

    def entitlement_value(self, name: str, now: Optional[int] = None) -> Any:
        """The raw value of entitlement ``name`` (a string, number, list or bool), or ``None``
        when the document does not carry it or the gate is not usable (S-19 G11)."""
        doc = self.doc
        if doc is None or not self.is_licensed(now):
            return None
        entry = doc.entitlements.get(name)
        return entry.value if entry is not None else None

    def license_info(self) -> Optional[LicenseInfo]:
        """The verified licence's summary (:class:`LicenseInfo`), or ``None`` without one.
        Read regardless of the gate, so an account screen can show WHICH licence was revoked."""
        doc = self.doc
        if doc is None:
            return None

        def raw(name: str) -> Any:
            entry = doc.entitlements.get(name)
            return entry.value if entry is not None else None

        tier = raw("license.tier")
        label = raw("license.tierLabel")
        limit = raw("deviceLimit")
        return LicenseInfo(
            licenseId=doc.licenseId,
            tier=tier if isinstance(tier, str) else None,
            tierLabel=label if isinstance(label, str) else None,
            deviceLimit=limit if isinstance(limit, int) and not isinstance(limit, bool) else None,
            profile=doc.profile,
            entitledChannels=tuple(self.entitled_channels()),
        )

    def get_entitlements(self) -> Dict[str, Any]:
        doc = self.doc
        if doc is None:
            return {}
        return {k: v.value for k, v in doc.entitlements.items()}

    def entitled_channels(self) -> List[str]:
        """The channels this licence grants: the ``channels`` entitlement's string values,
        in order, as granted — or ``["stable"]`` when the entitlement is absent or not an
        array. This is the Worker's own answer (``entitledChannels`` in
        core/entitlements.ts) and the same list every SDK returns for the same document.

        The grants are RAW: ``staging`` is not rewritten to ``beta`` here. Whether a grant
        covers a channel is the entitlement rule's question (WIRE-CONTRACT-V3 §5.1 rule 4),
        not this list's.
        """
        doc = self.doc
        entry = doc.entitlements.get("channels") if doc is not None else None
        if entry is None or not isinstance(entry.value, list):
            return [CHANNEL_STABLE]
        return [v for v in entry.value if isinstance(v, str)]

    def get_profile(self) -> Optional[DocProfile]:
        """The signed greeting block, or ``None``. Signed so it cannot be spoofed
        locally."""
        doc = self.doc
        return doc.profile if doc is not None else None

    def get_license_id(self) -> Optional[str]:
        doc = self.doc
        return doc.licenseId if doc is not None else None

    # ── Activation ──────────────────────────────────────────────────────────────────
    def _fingerprint(self) -> Optional[dict]:
        return self._devices.fingerprint() if self._fingerprint_enabled else None

    def enroll(self) -> ActivationResult:
        """Obtain a licence with no key and no sign-in, when the product offers a free
        tier."""
        r = enroll(self._ctx, self._fingerprint())
        if isinstance(r, ActivationOk):
            self._acquire(r.token, "enroll")
        return r

    def activate_with_key(self, key: str) -> ActivationResult:
        r = activate_with_key(self._ctx, key, self._fingerprint())
        if isinstance(r, ActivationOk):
            self._acquire(r.token, "activate")
        return r

    def _acquire(self, token: str, source: Literal["activate", "enroll"]) -> None:
        self._tokens.set(token, source)
        self._on_acquired("token")

    def deactivate(self) -> None:
        """Deauthorize this device and wipe every local credential and artifact.

        The network call is best-effort and the local wipe is not: a device deactivating
        on a plane must not be left holding a token because the control plane was
        unreachable.
        """
        token = self._tokens.current
        if token:
            # `deauthorize` swallows transport failures, including local-only's refusal.
            deauthorize(self._ctx, token)
        self._tokens.clear()
        self._cache.clear()
