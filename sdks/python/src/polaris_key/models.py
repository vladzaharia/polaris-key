"""The Polaris Key wire contract types — pure data, no crypto, no I/O.

Mirrors ``@polaris-key/protocol`` (packages/shared-protocol/src/index.ts). Times are
epoch SECONDS (ints), never millis. The dataclasses are frozen so a verified document
can't be mutated in place. ``from_dict``/``to_dict`` round-trip the exact JSON shape the
Worker signs — drift here silently breaks cross-platform verification.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Literal, Optional

__all__ = [
    "PROTOCOL_VERSION",
    "ISSUER",
    "DOC_EXPIRY_SECONDS",
    "SECONDS_PER_DAY",
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
    "ManagedEntry",
    "ManagedPayload",
    "DocProfile",
    "ManagedConfigDoc",
    "AllowedRange",
]

# Bumped on any wire-breaking change to the document shape or HTTP contract.
PROTOCOL_VERSION = 2
# The `iss` every Polaris Key document carries — the control-plane origin host.
ISSUER = "key.plrs.im"
# Short signed-token lifetime (seconds).
DOC_EXPIRY_SECONDS = 3600
# Seconds per day, for the offline-grace computation.
SECONDS_PER_DAY = 86_400

# Client→Worker request headers.
HEADER_DEVICE = "X-PKey-Device"
HEADER_VERSION = "X-PKey-Version"
HEADER_CHANNEL = "X-PKey-Channel"
HEADER_PLATFORM = "X-PKey-Platform"
HEADER_ARCH = "X-PKey-Arch"
HEADER_SDK_NAME = "X-PKey-SDK"
HEADER_SDK_VERSION = "X-PKey-SDK-Version"

# A JSON-serialisable value — the type every managed entry carries.
JSONValue = Any


# ── Wire-shape validation (audit finding R4-13) ─────────────────────────────────────
# ``from_dict`` used to require only that a key be *present*, so a signed-but-malformed
# document with ``"issuedAt": "5"`` decoded cleanly and then raised
# ``TypeError: '<=' not supported between instances of 'str' and 'int'`` out of
# ``verify_doc`` -> ``refresh()``, uncaught. Node coerces via JS ``<=``; Swift's
# ``JSONDecoder`` rejects at decode. Python now rejects at decode too: these raise
# ``ValueError``, which the ``except Exception`` in ``verify_jws_doc`` turns into "no
# document". Never a crash, never a coerced comparison.


def _req_int(d: Dict[str, Any], key: str) -> int:
    v = d[key]
    # bool is a subclass of int — `True` is not a timestamp.
    if not isinstance(v, int) or isinstance(v, bool):
        raise ValueError(f"{key} must be an integer, got {type(v).__name__}")
    return v


def _req_str(d: Dict[str, Any], key: str) -> str:
    v = d[key]
    if not isinstance(v, str):
        raise ValueError(f"{key} must be a string, got {type(v).__name__}")
    return v


def _req_dict(d: Dict[str, Any], key: str) -> Dict[str, Any]:
    v = d[key]
    if not isinstance(v, dict):
        raise ValueError(f"{key} must be an object, got {type(v).__name__}")
    return v


ManagementState = Literal["default", "enforced", "hidden"]
LicenseStatus = Literal[
    "ok",
    "grace",
    "expired",
    "revoked",
    "needs-activation",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
]
BlockReason = Literal["version-too-old", "version-too-new", "channel-not-entitled"]


@dataclass(frozen=True)
class ManagedEntry:
    """A managed value plus its per-key management state.

    ``state`` is one of ``default`` (advisory; a local override may win), ``enforced``
    (the remote value is authoritative and cannot be overridden), or ``hidden`` (an
    enforced value that is also withheld from user-facing config listings).
    ``updated_at`` is epoch SECONDS; the wire key is camelCase ``updatedAt``.
    """

    state: ManagementState
    value: JSONValue
    updated_at: int = 0

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ManagedEntry":
        if not isinstance(d, dict):
            raise ValueError("managed entry must be an object")
        updated_at = d.get("updatedAt", 0)
        if not isinstance(updated_at, int) or isinstance(updated_at, bool):
            raise ValueError("updatedAt must be an integer")
        return ManagedEntry(
            state=_req_str(d, "state"),  # type: ignore[arg-type]
            value=d.get("value"),
            updated_at=updated_at,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "value": self.value,
            "updatedAt": self.updated_at,
        }


@dataclass(frozen=True)
class ManagedPayload:
    """The three payload kinds, each routed to a different store on arrival."""

    config: Dict[str, ManagedEntry]
    secrets: Dict[str, ManagedEntry]
    entitlements: Dict[str, ManagedEntry]

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ManagedPayload":
        if not isinstance(d, dict):
            raise ValueError("payload must be an object")

        def section(name: str) -> Dict[str, ManagedEntry]:
            raw = d.get(name) or {}
            if not isinstance(raw, dict):
                raise ValueError(f"payload.{name} must be an object")
            return {k: ManagedEntry.from_dict(v) for k, v in raw.items()}

        return ManagedPayload(
            config=section("config"),
            secrets=section("secrets"),
            entitlements=section("entitlements"),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "config": {k: v.to_dict() for k, v in self.config.items()},
            "secrets": {k: v.to_dict() for k, v in self.secrets.items()},
            "entitlements": {k: v.to_dict() for k, v in self.entitlements.items()},
        }


@dataclass(frozen=True)
class DocProfile:
    """The signed profile block for the client's offline, tamper-proof greeting."""

    name: str
    firstName: str
    email: str
    activatedAt: int

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "DocProfile":
        if not isinstance(d, dict):
            raise ValueError("profile must be an object")
        return DocProfile(
            name=_req_str(d, "name"),
            firstName=_req_str(d, "firstName"),
            email=_req_str(d, "email"),
            activatedAt=_req_int(d, "activatedAt"),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "firstName": self.firstName,
            "email": self.email,
            "activatedAt": self.activatedAt,
        }


@dataclass(frozen=True)
class ManagedConfigDoc:
    """The JWS payload — the whole object the Worker signs and every client verifies.

    ``aud`` (product slug) + ``iss`` scope the document to one product/tenant; clients
    MUST assert ``aud == their configured product``.
    """

    schemaVersion: int
    aud: str
    iss: str
    licenseId: str
    deviceId: str
    issuedAt: int
    expiresAt: int
    graceUntil: int
    profile: DocProfile
    payload: ManagedPayload

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ManagedConfigDoc":
        if not isinstance(d, dict):
            raise ValueError("document must be an object")
        return ManagedConfigDoc(
            schemaVersion=_req_int(d, "schemaVersion"),
            aud=_req_str(d, "aud"),
            iss=_req_str(d, "iss"),
            licenseId=_req_str(d, "licenseId"),
            deviceId=_req_str(d, "deviceId"),
            issuedAt=_req_int(d, "issuedAt"),
            expiresAt=_req_int(d, "expiresAt"),
            graceUntil=_req_int(d, "graceUntil"),
            profile=DocProfile.from_dict(_req_dict(d, "profile")),
            payload=ManagedPayload.from_dict(_req_dict(d, "payload")),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schemaVersion": self.schemaVersion,
            "aud": self.aud,
            "iss": self.iss,
            "licenseId": self.licenseId,
            "deviceId": self.deviceId,
            "issuedAt": self.issuedAt,
            "expiresAt": self.expiresAt,
            "graceUntil": self.graceUntil,
            "profile": self.profile.to_dict(),
            "payload": self.payload.to_dict(),
        }


@dataclass(frozen=True)
class AllowedRange:
    """The version window a blocked client may run within."""

    min: Optional[str] = None
    max: Optional[str] = None

    @staticmethod
    def from_dict(d: Optional[Dict[str, Any]]) -> Optional["AllowedRange"]:
        if not d:
            return None
        return AllowedRange(min=d.get("min"), max=d.get("max"))
