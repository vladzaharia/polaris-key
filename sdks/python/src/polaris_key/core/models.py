"""The Polaris Key wire contract v3 types — pure data, no crypto, no I/O.

Mirrors ``@polaris-key/protocol`` (``packages/shared-protocol/src/{core,license,config,trust}.ts``)
and the constants ``@polaris-key/client-core`` re-declares in ``claims.ts``. Times are epoch
SECONDS (ints), never millis.

WHAT CHANGED FROM v2 (docs/security/WIRE-CONTRACT-V3.md §2, §8):

* the single ``pkey-config+jws`` document SPLIT into ``pkey-license+jws`` (grants) and
  ``pkey-config+jws`` (config + secrets), sharing one envelope;
* ``iss`` is the fixed ``key.plrs.im``, never derived from the base URL;
* the client metadata headers are ``X-PKey-*``;
* ``pkey-bundle+jws`` joined the family, with its own raised payload cap (§1).

DECODING IS TOTAL, VALIDATION IS THE VERIFIER'S. ``from_dict`` here type-checks exactly
the claims ``@polaris-key/client-core``'s ``verify.ts`` checks and nothing more, so a document
Node accepts is a document this SDK accepts. Nested managed maps and the profile block
decode LENIENTLY (never raising) because the reference implementation does not inspect
them either — a Python that rejected there would be a fifth implementation disagreeing
with the other four. Malformed ENVELOPE fields still reject: that is R4-13, and it is a
shape rule the contract states.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

__all__ = [
    "PROTOCOL_VERSION",
    "ISSUER",
    "DOC_EXPIRY_SECONDS",
    "SECONDS_PER_DAY",
    "CLOCK_SKEW_SECONDS",
    "MAX_GRACE_SECONDS",
    "REFRESH_MARGIN_SECONDS",
    "MAX_HEADER_BYTES",
    "MAX_DOC_BYTES",
    "MAX_BUNDLE_BYTES",
    "TYP_LICENSE",
    "TYP_CONFIG",
    "TYP_TRUST",
    "TYP_BUNDLE",
    "JWS_TYPS",
    "TOKEN_PREFIX",
    "HEADER_DEVICE",
    "HEADER_VERSION",
    "HEADER_CHANNEL",
    "HEADER_PLATFORM",
    "HEADER_ARCH",
    "HEADER_SDK_NAME",
    "HEADER_SDK_VERSION",
    "JSONValue",
    "ManagementState",
    "LicenseStatus",
    "BlockReason",
    "ActivationSource",
    "AllowedRange",
    "BlockedState",
    "ManagedEntry",
    "DocProfile",
    "DocClaims",
    "LicenseDoc",
    "ConfigDoc",
]

# ── Version + identity (§8) ─────────────────────────────────────────────────────────
#: Bumped on any wire-breaking change to the document shape or the HTTP contract.
PROTOCOL_VERSION = 3
#: The ``iss`` every Polaris Key document carries. A fixed string (Amendment A1), never
#: derived from the base URL or the serving host; any other issuer is refused.
ISSUER = "key.plrs.im"
#: Short signed-document lifetime (seconds).
DOC_EXPIRY_SECONDS = 3600
#: Seconds per day, for the offline-grace computation.
SECONDS_PER_DAY = 86_400
#: The device credential prefix (§6). The withdrawn ``plrst_`` spelling is not accepted.
TOKEN_PREFIX = "pkeyt_"

# ── Claim-validation limits (§2, §3) ────────────────────────────────────────────────
#: Tolerance applied to every clock comparison. v1 had none anywhere, so a device 61
#: minutes fast flipped a freshly-signed document straight to ``grace`` (R2-08).
CLOCK_SKEW_SECONDS = 300
#: Upper bound on a signed offline window: ``graceUntil <= issuedAt + MAX_GRACE_SECONDS``.
#: Enforced at VERIFY time, not only in the gate (§3.3), so an over-generous offline
#: bundle is refused before it can reach the cache.
MAX_GRACE_SECONDS = 365 * SECONDS_PER_DAY
#: How close to ``expiresAt`` a cached document may drift before a 304 must be escalated
#: to an unconditional re-fetch (§5). Half of ``DOC_EXPIRY_SECONDS``; applied PER
#: DOCUMENT in v3, because license and config carry independent ETags.
REFRESH_MARGIN_SECONDS = 1800

# ── Size limits (§1) ────────────────────────────────────────────────────────────────
#: Hard cap on the decoded protected header. A legitimate header is ~60 bytes; without
#: this the payload cap is trivially bypassed by moving the blob into the header (R2-04).
MAX_HEADER_BYTES = 1024
#: Hard cap on the decoded JWS payload before JSON parsing.
MAX_DOC_BYTES = 65_536
#: The ONE raised cap: ``pkey-bundle+jws`` wraps up to three inner compact JWSs (§1/§7).
#: The verifier takes this from here rather than from a caller, so no host chooses how
#: big a bundle may be.
MAX_BUNDLE_BYTES = 262_144

# ── Document-type domain separators (§2) ────────────────────────────────────────────
# Unknown OR MISSING ``typ`` is rejected in v3 — the v2 tolerance window is over.
TYP_LICENSE = "pkey-license+jws"
TYP_CONFIG = "pkey-config+jws"
TYP_TRUST = "pkey-trust+jws"
TYP_BUNDLE = "pkey-bundle+jws"
JWS_TYPS = (TYP_LICENSE, TYP_CONFIG, TYP_TRUST, TYP_BUNDLE)

# ── Client metadata headers (§5) ────────────────────────────────────────────────────
HEADER_DEVICE = "X-PKey-Device"
HEADER_VERSION = "X-PKey-Version"
HEADER_CHANNEL = "X-PKey-Channel"
HEADER_PLATFORM = "X-PKey-Platform"
HEADER_ARCH = "X-PKey-Arch"
HEADER_SDK_NAME = "X-PKey-SDK"
HEADER_SDK_VERSION = "X-PKey-SDK-Version"

#: A JSON-serialisable value — the type every managed entry carries.
JSONValue = Any
#: ``default`` (advisory) | ``enforced`` (locked) | ``hidden`` (locked + withheld).
ManagementState = str
#: v3 adds ``not-applicable``: a product that does not run the license service at all.
LicenseStatus = str
BlockReason = str
#: How an install became activated (§7). ``token`` supersedes ``bundle``.
ActivationSource = str


# ── Envelope shape helpers ──────────────────────────────────────────────────────────
def _int_or_none(value: Any) -> Optional[int]:
    """An int that is not a bool. ``True`` is not a timestamp."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _is_plain_object(value: Any) -> bool:
    """A JSON object — not a list, not ``None``. Managed maps must be exactly this."""
    return isinstance(value, dict)


@dataclass(frozen=True)
class AllowedRange:
    """The version window a blocked client may run within."""

    min: Optional[str] = None
    max: Optional[str] = None

    @staticmethod
    def from_dict(d: Optional[Dict[str, Any]]) -> Optional["AllowedRange"]:
        if not d or not isinstance(d, dict):
            return None
        return AllowedRange(min=d.get("min"), max=d.get("max"))

    def to_dict(self) -> Dict[str, Any]:
        return {
            k: v for k, v in (("min", self.min), ("max", self.max)) if v is not None
        }


@dataclass(frozen=True)
class BlockedState:
    """The unsigned 403 hint recorded from the last ``/license/document`` fetch.

    Unsigned is safe because it can only ever make the gate STRICTER (§4.1): clearing it
    gains an attacker nothing that deleting the whole cache file would not.
    """

    reason: BlockReason
    allowedRange: Optional[AllowedRange] = None


@dataclass(frozen=True)
class ManagedEntry:
    """A managed value plus its per-key management state.

    ``updated_at`` is epoch SECONDS; the wire key is camelCase ``updatedAt``.
    """

    state: ManagementState
    value: JSONValue
    updated_at: int = 0

    @staticmethod
    def from_any(v: Any) -> "ManagedEntry":
        """Total decode — never raises.

        ``@polaris-key/client-core`` checks that the managed MAP is an object and stops there;
        it never inspects an entry. Coercing here rather than rejecting is what keeps
        the accept/reject decision byte-identical across the four SDKs. Nothing security-
        relevant reads ``state``/``updated_at``: the gate reads timestamps off the
        envelope, and config resolution treats an unrecognised state as ``default``.
        """
        if not isinstance(v, dict):
            return ManagedEntry(state="default", value=None, updated_at=0)
        state = v.get("state")
        updated_at = _int_or_none(v.get("updatedAt"))
        return ManagedEntry(
            state=state if isinstance(state, str) else "default",
            value=v.get("value"),
            updated_at=updated_at if updated_at is not None else 0,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {"state": self.state, "value": self.value, "updatedAt": self.updated_at}


def _managed_map(raw: Any) -> Dict[str, ManagedEntry]:
    if not isinstance(raw, dict):
        return {}
    return {k: ManagedEntry.from_any(v) for k, v in raw.items()}


@dataclass(frozen=True)
class DocProfile:
    """The signed profile block for the client's offline, tamper-proof greeting."""

    name: str = ""
    firstName: str = ""
    email: str = ""
    activatedAt: int = 0

    @staticmethod
    def from_any(v: Any) -> Optional["DocProfile"]:
        """``None`` when the value is not an object — which is the ONE thing
        ``@polaris-key/client-core`` refuses about a profile (a smuggled scalar)."""
        if not isinstance(v, dict):
            return None

        def s(key: str) -> str:
            raw = v.get(key)
            return raw if isinstance(raw, str) else ""

        activated = _int_or_none(v.get("activatedAt"))
        return DocProfile(
            name=s("name"),
            firstName=s("firstName"),
            email=s("email"),
            activatedAt=activated if activated is not None else 0,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "firstName": self.firstName,
            "email": self.email,
            "activatedAt": self.activatedAt,
        }


@dataclass(frozen=True)
class DocClaims:
    """The shared envelope every per-service document carries (§2).

    Validated in ONE place (:func:`polaris_key.core.verify.validate_envelope`) so license and
    config can never drift apart on ``iss``, ``aud``, device binding, the grace ceiling
    or the freshness split.
    """

    iss: str
    aud: str
    deviceId: str
    issuedAt: int
    expiresAt: int
    graceUntil: int

    @staticmethod
    def parse(d: Dict[str, Any]) -> Optional["DocClaims"]:
        """Decode the envelope, or ``None`` when any field is the wrong SHAPE (R4-13).

        This is the strict half: a document with ``"issuedAt": "5"`` is not a document,
        and it must become "no document" rather than a ``TypeError`` escaping into the
        caller's sync loop.
        """
        iss = d.get("iss")
        aud = d.get("aud")
        device_id = d.get("deviceId")
        issued_at = _int_or_none(d.get("issuedAt"))
        expires_at = _int_or_none(d.get("expiresAt"))
        grace_until = _int_or_none(d.get("graceUntil"))
        if not isinstance(iss, str) or not isinstance(aud, str):
            return None
        if not isinstance(device_id, str):
            return None
        if issued_at is None or expires_at is None or grace_until is None:
            return None
        return DocClaims(
            iss=iss,
            aud=aud,
            deviceId=device_id,
            issuedAt=issued_at,
            expiresAt=expires_at,
            graceUntil=grace_until,
        )


@dataclass(frozen=True)
class LicenseDoc:
    """``pkey-license+jws`` (§2.1) — grants, and nothing else.

    ``entitlements`` is the SOLE carrier of grant data (D-20): admin/tier policy is
    injected here as enforced entitlements alongside catalog-declared flags. License
    STATE (``ok``/``grace``/…) is never carried in the document; the client gate derives
    it (§5).
    """

    iss: str
    aud: str
    deviceId: str
    issuedAt: int
    expiresAt: int
    graceUntil: int
    licenseId: str
    entitlements: Dict[str, ManagedEntry] = field(default_factory=dict)
    profile: Optional[DocProfile] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> Optional["LicenseDoc"]:
        if not _is_plain_object(d):
            return None
        claims = DocClaims.parse(d)
        if claims is None:
            return None
        license_id = d.get("licenseId")
        if not isinstance(license_id, str) or license_id == "":
            return None
        if not _is_plain_object(d.get("entitlements")):
            return None
        raw_profile = d.get("profile")
        profile: Optional[DocProfile] = None
        if raw_profile is not None:
            # Present but not an object ⇒ a smuggled scalar ⇒ not a document.
            profile = DocProfile.from_any(raw_profile)
            if profile is None:
                return None
        return LicenseDoc(
            iss=claims.iss,
            aud=claims.aud,
            deviceId=claims.deviceId,
            issuedAt=claims.issuedAt,
            expiresAt=claims.expiresAt,
            graceUntil=claims.graceUntil,
            licenseId=license_id,
            entitlements=_managed_map(d.get("entitlements")),
            profile=profile,
        )

    def claims(self) -> DocClaims:
        return DocClaims(
            iss=self.iss,
            aud=self.aud,
            deviceId=self.deviceId,
            issuedAt=self.issuedAt,
            expiresAt=self.expiresAt,
            graceUntil=self.graceUntil,
        )


@dataclass(frozen=True)
class ConfigDoc:
    """``pkey-config+jws`` (§2.2) — config + secrets, and NO license fields.

    A product with Config enabled and License disabled issues these to any registered
    device — the wire-level guarantee of service independence (D-08).
    """

    iss: str
    aud: str
    deviceId: str
    issuedAt: int
    expiresAt: int
    graceUntil: int
    schemaVersion: int
    config: Dict[str, ManagedEntry] = field(default_factory=dict)
    secrets: Dict[str, ManagedEntry] = field(default_factory=dict)

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> Optional["ConfigDoc"]:
        if not _is_plain_object(d):
            return None
        claims = DocClaims.parse(d)
        if claims is None:
            return None
        # §3 asks for `schemaVersion` to be checked "unknown ⇒ fail closed", but on a
        # CONFIG document this field carries the PRODUCT CATALOG version, not a wire
        # discriminator — it increments on every catalog edit and is unbounded per
        # product, so an allow-list would reject every product that ever revised its
        # catalog. What is enforceable, and what R2-08's `schemaVersion: 999` payload
        # actually violated, is the SHAPE. (Contrast the trust manifest's, which IS
        # allow-listed — see `polaris_key.core.trust`.)
        schema_version = _int_or_none(d.get("schemaVersion"))
        if schema_version is None or schema_version < 1:
            return None
        if not _is_plain_object(d.get("config")):
            return None
        if not _is_plain_object(d.get("secrets")):
            return None
        return ConfigDoc(
            iss=claims.iss,
            aud=claims.aud,
            deviceId=claims.deviceId,
            issuedAt=claims.issuedAt,
            expiresAt=claims.expiresAt,
            graceUntil=claims.graceUntil,
            schemaVersion=schema_version,
            config=_managed_map(d.get("config")),
            secrets=_managed_map(d.get("secrets")),
        )

    def claims(self) -> DocClaims:
        return DocClaims(
            iss=self.iss,
            aud=self.aud,
            deviceId=self.deviceId,
            issuedAt=self.issuedAt,
            expiresAt=self.expiresAt,
            graceUntil=self.graceUntil,
        )
