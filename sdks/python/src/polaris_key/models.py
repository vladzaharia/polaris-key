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
PROTOCOL_VERSION = 1
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

# A JSON-serialisable value — the type every managed entry carries.
JSONValue = Any

ManagementState = Literal["default", "enforced", "hidden"]
LicenseStatus = Literal[
    "ok",
    "grace",
    "expired",
    "revoked",
    "needs-enroll",
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
        return ManagedEntry(
            state=d["state"],
            value=d.get("value"),
            updated_at=d.get("updatedAt", 0),
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
        def section(name: str) -> Dict[str, ManagedEntry]:
            raw = d.get(name) or {}
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
    enrolledAt: int

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "DocProfile":
        return DocProfile(
            name=d["name"],
            firstName=d["firstName"],
            email=d["email"],
            enrolledAt=d["enrolledAt"],
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "firstName": self.firstName,
            "email": self.email,
            "enrolledAt": self.enrolledAt,
        }


@dataclass(frozen=True)
class ManagedConfigDoc:
    """The JWS payload — the whole object the Worker signs and every client verifies.

    ``aud`` (product slug) + ``iss`` scope the document to one product/tenant; clients
    MUST assert ``aud == their configured product``. ``aud``/``iss`` are optional in the
    type so the legacy djdl baseline vector (which predates them) still round-trips.
    """

    schemaVersion: int
    licenseId: str
    deviceId: str
    issuedAt: int
    expiresAt: int
    graceUntil: int
    profile: DocProfile
    payload: ManagedPayload
    aud: Optional[str] = None
    iss: Optional[str] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ManagedConfigDoc":
        return ManagedConfigDoc(
            schemaVersion=d["schemaVersion"],
            aud=d.get("aud"),
            iss=d.get("iss"),
            licenseId=d["licenseId"],
            deviceId=d["deviceId"],
            issuedAt=d["issuedAt"],
            expiresAt=d["expiresAt"],
            graceUntil=d["graceUntil"],
            profile=DocProfile.from_dict(d["profile"]),
            payload=ManagedPayload.from_dict(d["payload"]),
        )

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"schemaVersion": self.schemaVersion}
        if self.aud is not None:
            out["aud"] = self.aud
        if self.iss is not None:
            out["iss"] = self.iss
        out.update(
            {
                "licenseId": self.licenseId,
                "deviceId": self.deviceId,
                "issuedAt": self.issuedAt,
                "expiresAt": self.expiresAt,
                "graceUntil": self.graceUntil,
                "profile": self.profile.to_dict(),
                "payload": self.payload.to_dict(),
            }
        )
        return out


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
