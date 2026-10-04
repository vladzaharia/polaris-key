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
from typing import Any, Dict, List, Optional, Tuple

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
    "TYP_FEED",
    "TYP_RELEASE",
    "JWS_TYPS",
    "MAX_WIRE_INTEGER",
    "MAX_JSON_DEPTH",
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
    "FeedFloor",
    "ReleasePin",
    "FeedRollout",
    "FeedLive",
    "FeedOutletEntry",
    "FeedTargetFloor",
    "FeedTarget",
    "FeedApp",
    "ChannelFeedDoc",
    "ReleaseRecordArtifact",
    "ReleaseRecordBuild",
    "ReleaseRecordDoc",
    "InstalledBuild",
    "UpdateOutlet",
    "StagedUpdate",
    "UpdateDecisionInput",
    "UpdateContentInput",
    "ContentRevocationInput",
    "PackTarget",
    "DecisionRelease",
    "UpdateDecision",
    "UpdateCheckError",
    "UpdateCheck",
]

# ── Version + identity (§8) ─────────────────────────────────────────────────────────
#: Bumped on any wire-breaking change to the document shape or the HTTP contract.
PROTOCOL_VERSION = 4
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
#: Wire contract v4 §2.3: the channel feed, signed by the product key.
TYP_FEED = "pkey-feed+jws"
#: Wire contract v4 §2.4: the release record, signed by a CI-held release key.
TYP_RELEASE = "pkey-release+jws"
JWS_TYPS = (TYP_LICENSE, TYP_CONFIG, TYP_TRUST, TYP_BUNDLE, TYP_FEED, TYP_RELEASE)

# ── Wire contract v4 limits (WIRE-CONTRACT-V4 §1.2, §3) ─────────────────────────────
#: The largest integer claim, 2^53 − 1.
MAX_WIRE_INTEGER = 9_007_199_254_740_991
#: The deepest a signed header or payload may nest, the top-level object as level 1.
MAX_JSON_DEPTH = 64

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


def _wire_int(value: Any, minimum: int) -> Optional[int]:
    """WIRE-CONTRACT-V4 §3: an integer claim, or ``None``.

    ``json.loads`` returns an ``int`` exactly for a plain integer token and a ``float`` for any
    other (``7.0``, ``17e8``, ``1700000000.00000001``), so "an ``int`` that is never a
    ``bool``" IS the token rule, and the comparisons with the claim's minimum and with
    2^53 − 1 are exact. Every integer claim goes through here, with its minimum (0 for every
    timestamp, 1 for ``schemaVersion``); ``_int_or_none`` stays for the values that are not
    claims.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < minimum or value > MAX_WIRE_INTEGER:
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
        the accept/reject decision byte-identical across the five SDKs. Nothing security-
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
        # V4 §3: every timestamp is an integer claim, minimum 0.
        issued_at = _wire_int(d.get("issuedAt"), 0)
        expires_at = _wire_int(d.get("expiresAt"), 0)
        grace_until = _wire_int(d.get("graceUntil"), 0)
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
        profile: Optional[DocProfile] = None
        if "profile" in d:
            # V4 §3 presence: an optional member is absent or of its type, so a present
            # ``null`` is refused like any other non-object (Node and Godot always did).
            raw_profile = d["profile"]
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
        schema_version = _wire_int(d.get("schemaVersion"), 1)
        if schema_version is None:
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


# ── Wire v4: the channel feed (WIRE-CONTRACT-V4 §2.3, plans/P3-01.md §2.3) ─────────────────
# These decode a payload that has ALREADY passed ``feed_claims`` (or a decoded document a
# caller built, such as an ``update-matrix.json`` row), so they validate nothing: the claims
# functions in ``feed.py`` and ``release_record.py`` are the validation. ``raw`` keeps the
# verified payload verbatim, reserved members (``packSets``, ``deltas``, …) included, so a
# later package that reads them needs no second decode.


@dataclass(frozen=True)
class FeedFloor:
    """The ``seq`` floor of one canonical channel: the committed feed's ``seq`` and
    ``issuedAt``. Derived on the reload path and by each commit, never stored."""

    seq: int
    issuedAt: int


@dataclass(frozen=True)
class ReleasePin:
    """What a target pins: the record's hash, ``seq`` and version."""

    sha256: str
    seq: int
    version: str

    def to_dict(self) -> Dict[str, Any]:
        return {"sha256": self.sha256, "seq": self.seq, "version": self.version}


@dataclass(frozen=True)
class FeedRollout:
    bp: int
    #: 32 lowercase hex, hashed as text.
    salt: str


@dataclass(frozen=True)
class FeedLive:
    """The newest release of the app live on one outlet for one platform."""

    version: str
    seq: int


@dataclass(frozen=True)
class FeedOutletEntry:
    kind: str
    live: Optional[FeedLive]
    halted: bool
    rollout: Optional[FeedRollout] = None
    listingUrl: Optional[str] = None
    #: Any subset of the six capability fields: it narrows, never widens.
    capabilities: Optional[Dict[str, Any]] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "FeedOutletEntry":
        live = d.get("live")
        rollout = d.get("rollout")
        caps = d.get("capabilities")
        return FeedOutletEntry(
            kind=d["kind"],
            live=None if live is None else FeedLive(version=live["version"], seq=live["seq"]),
            halted=d["halted"],
            rollout=(
                FeedRollout(bp=rollout["bp"], salt=rollout["salt"])
                if isinstance(rollout, dict)
                else None
            ),
            listingUrl=d.get("listingUrl") if isinstance(d.get("listingUrl"), str) else None,
            capabilities=dict(caps) if isinstance(caps, dict) else None,
        )


@dataclass(frozen=True)
class FeedTargetFloor:
    minVersion: str


@dataclass(frozen=True)
class FeedTarget:
    platform: str
    #: The pin.
    release: ReleasePin
    #: This platform's floor, never above its own pin. Required on the wire; may be null.
    floor: Optional[FeedTargetFloor]
    critical: bool
    #: Keyed by the product's outlet id.
    outlets: Dict[str, FeedOutletEntry]

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "FeedTarget":
        r = d["release"]
        floor = d.get("floor")
        return FeedTarget(
            platform=d["platform"],
            release=ReleasePin(sha256=r["sha256"], seq=r["seq"], version=r["version"]),
            floor=None if floor is None else FeedTargetFloor(minVersion=floor["minVersion"]),
            critical=d["critical"],
            outlets={k: FeedOutletEntry.from_dict(v) for k, v in d["outlets"].items()},
        )


@dataclass(frozen=True)
class FeedApp:
    deliverable: str
    versionScheme: str
    targets: Tuple[FeedTarget, ...]


@dataclass(frozen=True)
class ChannelFeedDoc:
    """A ``pkey-feed+jws`` payload. ``channel`` is the CANONICAL channel, which keys the
    client's ``seq`` floor and the ``feeds`` cache slice. Never ``latest``."""

    schemaVersion: int
    iss: str
    aud: str
    channel: str
    selector: Dict[str, Any]
    seq: int
    issuedAt: int
    expiresAt: int
    app: FeedApp
    raw: Dict[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ChannelFeedDoc":
        app = d["app"]
        return ChannelFeedDoc(
            schemaVersion=d["schemaVersion"],
            iss=d["iss"],
            aud=d["aud"],
            channel=d["channel"],
            selector=dict(d["selector"]),
            seq=d["seq"],
            issuedAt=d["issuedAt"],
            expiresAt=d["expiresAt"],
            app=FeedApp(
                deliverable=app["deliverable"],
                versionScheme=app["versionScheme"],
                targets=tuple(FeedTarget.from_dict(t) for t in app["targets"]),
            ),
            raw=d,
        )

    def to_dict(self) -> Dict[str, Any]:
        """The verified payload, as signed."""
        return self.raw


# ── Wire v4: the release record (WIRE-CONTRACT-V4 §2.4, plans/P3-01.md §2.4) ───────────────


@dataclass(frozen=True)
class ReleaseRecordArtifact:
    name: str
    #: v4 reads only ``payload``.
    role: str
    sha256: str
    size: int
    contentType: Optional[str] = None


@dataclass(frozen=True)
class ReleaseRecordBuild:
    id: str
    platform: str
    arch: str
    format: str
    #: Empty for a store-only build.
    artifacts: Tuple[ReleaseRecordArtifact, ...]
    buildNumber: Optional[str] = None
    minOS: Optional[str] = None
    #: ``engine`` (a string) and ``minBinary`` (a version) are read by the decision; the rest
    #: is reserved for P4. Kept verbatim: a build whose values lack those shapes is never
    #: eligible, which the decision decides, not the decoder.
    requires: Optional[Dict[str, Any]] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ReleaseRecordBuild":
        raw_artifacts = d.get("artifacts")
        artifacts: List[ReleaseRecordArtifact] = []
        if isinstance(raw_artifacts, list):
            for a in raw_artifacts:
                if isinstance(a, dict):
                    artifacts.append(
                        ReleaseRecordArtifact(
                            name=a.get("name", ""),
                            role=a.get("role", ""),
                            sha256=a.get("sha256", ""),
                            size=a.get("size", 0),
                            contentType=a.get("contentType"),
                        )
                    )
        requires = d.get("requires")
        return ReleaseRecordBuild(
            id=d["id"],
            platform=d["platform"],
            arch=d["arch"],
            format=d["format"],
            artifacts=tuple(artifacts),
            buildNumber=d.get("buildNumber"),
            minOS=d.get("minOS"),
            requires=dict(requires) if isinstance(requires, dict) else None,
        )


@dataclass(frozen=True)
class ReleaseRecordDoc:
    """A ``pkey-release+jws`` payload. There is no ``iss``: the pinned ``kid`` names the
    signer, and ``aud`` binds the record to one product."""

    schemaVersion: int
    aud: str
    deliverable: str
    kind: str
    version: str
    seq: int
    issuedAt: int
    #: Required for ``kind: "app"``; ``None`` when absent (a reserved kind).
    builds: Optional[Tuple[ReleaseRecordBuild, ...]] = None
    minSupportedSeq: Optional[int] = None
    tag: Optional[str] = None
    channel: Optional[str] = None
    title: Optional[str] = None
    notes: Optional[str] = None
    provenance: Optional[Dict[str, Any]] = None
    raw: Dict[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ReleaseRecordDoc":
        builds = d.get("builds")
        provenance = d.get("provenance")
        return ReleaseRecordDoc(
            schemaVersion=d["schemaVersion"],
            aud=d["aud"],
            deliverable=d["deliverable"],
            kind=d["kind"],
            version=d["version"],
            seq=d["seq"],
            issuedAt=d["issuedAt"],
            builds=(
                tuple(ReleaseRecordBuild.from_dict(b) for b in builds)
                if isinstance(builds, list)
                else None
            ),
            minSupportedSeq=d.get("minSupportedSeq"),
            tag=d.get("tag"),
            channel=d.get("channel"),
            title=d.get("title"),
            notes=d.get("notes"),
            provenance=dict(provenance) if isinstance(provenance, dict) else None,
            raw=d,
        )

    def to_dict(self) -> Dict[str, Any]:
        """The verified payload, as signed."""
        return self.raw


# ── Wire v4: the update decision (plans/P3-01.md §2.8) ──────────────────────────────────────


@dataclass(frozen=True)
class InstalledBuild:
    """The install the decision is about."""

    version: str
    platform: str
    arch: str
    buildNumber: Optional[str] = None
    format: Optional[str] = None
    #: ``godot-<major>.<minor>``; ``None`` outside Godot.
    engine: Optional[str] = None
    #: The executable's version when it differs from ``version``; defaults to ``version``.
    binaryVersion: Optional[str] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "InstalledBuild":
        return InstalledBuild(
            version=d["version"],
            platform=d["platform"],
            arch=d["arch"],
            buildNumber=d.get("buildNumber"),
            format=d.get("format"),
            engine=d.get("engine"),
            binaryVersion=d.get("binaryVersion"),
        )


@dataclass(frozen=True)
class UpdateOutlet:
    """The install's outlet: the product's outlet id and its kind (``unknown`` for none)."""

    id: Optional[str]
    kind: str


@dataclass(frozen=True)
class StagedUpdate:
    """An update the host staged and verified, under the ``UpdateCheck.channel`` it was
    staged on."""

    version: str
    channel: str


def _pin(d: Any) -> Optional[ReleasePin]:
    if not isinstance(d, dict):
        return None
    return ReleasePin(sha256=d["sha256"], seq=d["seq"], version=d["version"])


@dataclass(frozen=True)
class PackTarget:
    """One pack release a decision names: ``packs.install`` and ``binary.prestage`` entries
    (plans/P4-13.md §2.6)."""

    pack: str
    release: ReleasePin

    def to_dict(self) -> Dict[str, Any]:
        return {"pack": self.pack, "release": self.release.to_dict()}


@dataclass(frozen=True)
class ContentRevocationInput:
    """One stored, verified revocation as the decision reads it (plans/P4-13.md §2.6): one
    entry per target (the winner of ``newer_revocation``). ``replacementUsable`` is false while
    the replacement is still unfetched (§2.5 step 12 retries it)."""

    target: str
    pack: str
    replacement: Optional[ReleasePin]
    replacementUsable: bool

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ContentRevocationInput":
        return ContentRevocationInput(
            target=d["target"],
            pack=d["pack"],
            replacement=_pin(d.get("replacement")),
            replacementUsable=d.get("replacementUsable") is True,
        )


@dataclass(frozen=True)
class UpdateContentInput:
    """The content decision's input (plans/P4-13.md §2.6): ``stamp`` is the running build's
    content stamp (``contentApi``, ``pins``, ``expects``) with ``holds`` (``holds_of``; ``None``
    when unusable); ``active`` the pack state's active installs by pack id, embedded baselines
    included; ``axes`` the host's variant preferences; ``revocations`` the stored, verified
    revocations; ``buckets`` the rollout bucket of every gate salt (``None`` is out)."""

    stamp: Dict[str, Any]
    active: Dict[str, ReleasePin] = field(default_factory=dict)
    axes: Dict[str, List[str]] = field(default_factory=dict)
    revocations: Tuple[ContentRevocationInput, ...] = ()
    buckets: Dict[str, Optional[int]] = field(default_factory=dict)

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "UpdateContentInput":
        active: Dict[str, ReleasePin] = {}
        for k, v in (d.get("active") or {}).items():
            pin = _pin(v)
            if pin is not None:
                active[k] = pin
        return UpdateContentInput(
            stamp=dict(d["stamp"]),
            active=active,
            axes={k: list(v) for k, v in (d.get("axes") or {}).items()},
            revocations=tuple(
                ContentRevocationInput.from_dict(r) for r in (d.get("revocations") or ())
            ),
            buckets=dict(d.get("buckets") or {}),
        )


@dataclass(frozen=True)
class UpdateDecisionInput:
    now: int
    feed: ChannelFeedDoc
    record: Optional[ReleaseRecordDoc]
    installed: InstalledBuild
    outlet: UpdateOutlet
    subkind: Optional[str] = None
    staged: Optional[StagedUpdate] = None
    skipVersion: Optional[str] = None
    bucket: Optional[int] = None
    methods: Tuple[str, ...] = ()
    #: The content decision's input (plans/P4-13.md §2.6). ``None``: every answer is P3-01's.
    content: Optional[UpdateContentInput] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "UpdateDecisionInput":
        """Decode an ``update-matrix.json`` row's ``input`` (a decoded feed and record)."""
        record = d.get("record")
        staged = d.get("staged")
        outlet = d["outlet"]
        return UpdateDecisionInput(
            now=d["now"],
            feed=ChannelFeedDoc.from_dict(d["feed"]),
            record=None if record is None else ReleaseRecordDoc.from_dict(record),
            installed=InstalledBuild.from_dict(d["installed"]),
            outlet=UpdateOutlet(id=outlet.get("id"), kind=outlet["kind"]),
            subkind=d.get("subkind"),
            staged=(
                None
                if staged is None
                else StagedUpdate(version=staged["version"], channel=staged["channel"])
            ),
            skipVersion=d.get("skipVersion"),
            bucket=d.get("bucket"),
            methods=tuple(d.get("methods") or ()),
            content=(
                UpdateContentInput.from_dict(d["content"])
                if isinstance(d.get("content"), dict)
                else None
            ),
        )


@dataclass(frozen=True)
class DecisionRelease:
    version: str
    seq: int
    #: On ``code-ready`` and ``binary`` only.
    sha256: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"version": self.version, "seq": self.seq}
        if self.sha256 is not None:
            out["sha256"] = self.sha256
        return out


#: The members each action carries, in the order ``to_dict`` emits them (§2.8's output table).
_DECISION_MEMBERS: Dict[str, Tuple[str, ...]] = {
    "none": ("reason", "behind", "discardStaged"),
    "code-ready": ("release", "critical", "discardStaged"),
    "binary": ("method", "release", "build", "mandatory", "critical", "prestage", "discardStaged"),
    "store": ("release", "listingUrl", "mandatory", "critical", "discardStaged"),
    "platform": ("release", "mandatory", "critical", "discardStaged"),
    "blocked": ("reason", "discardStaged"),
    "packs": ("install", "revoke", "set", "discardStaged"),
}

#: The actions that may carry ``contentBlock`` (plans/P4-13.md §2.6), emitted only when set.
_CONTENT_BLOCK_ACTIONS = ("binary", "store", "platform", "blocked")


@dataclass(frozen=True)
class UpdateDecision:
    """What an installed app should do next (plans/P3-01.md §2.8).

    One class for the six actions; each action uses exactly the members §2.8 lists for it and
    the rest stay ``None``. :meth:`to_dict` emits exactly that action's members, so a decision
    compares by value with ``update-matrix.json`` and with every other SDK's.
    """

    action: str
    discardStaged: bool = False
    #: ``none`` (a ``NONE_REASONS`` value) and ``blocked`` (``app-floor``).
    reason: Optional[str] = None
    #: ``none`` only: true for ``behind``.
    behind: Optional[bool] = None
    release: Optional[DecisionRelease] = None
    #: ``binary`` only: ``native``, ``download`` or ``sidecar-pck``.
    method: Optional[str] = None
    #: ``binary`` only: the record's build id.
    build: Optional[str] = None
    #: ``store`` only (may be ``None``).
    listingUrl: Optional[str] = None
    #: ``binary``, ``store`` and ``platform``: the install is below its platform's floor, so the
    #: host shows a prompt the player cannot dismiss.
    mandatory: Optional[bool] = None
    critical: Optional[bool] = None
    #: ``binary`` only: the new level's required and essential pack releases the binary
    #: download should carry (plans/P4-13.md §2.6); empty without a content decision.
    prestage: Optional[Tuple[PackTarget, ...]] = None
    #: ``packs`` only: the pack releases to install, sorted by pack-id bytes.
    install: Optional[Tuple[PackTarget, ...]] = None
    #: ``packs`` only: the packs revoked without a fix to unmount (never a required pack).
    revoke: Optional[Tuple[str, ...]] = None
    #: ``packs`` only: the effective set, ``{"pack", "sha256"}`` over every known pack.
    set: Optional[Tuple[Dict[str, str], ...]] = None
    #: ``binary``, ``store``, ``platform`` and ``blocked {app-floor}``: the content block that
    #: made the answer mandatory (``content-floor`` or ``revoked-content``), when there is one.
    contentBlock: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"action": self.action}
        for name in _DECISION_MEMBERS.get(self.action, ()):
            value = getattr(self, name)
            if name == "release":
                value = value.to_dict() if value is not None else None
            elif name in ("prestage", "install"):
                value = [t.to_dict() if isinstance(t, PackTarget) else t for t in (value or ())]
            elif name == "revoke":
                value = list(value or ())
            elif name == "set":
                value = [dict(e) for e in (value or ())]
            out[name] = value
        if self.action in _CONTENT_BLOCK_ACTIONS and self.contentBlock is not None:
            out["contentBlock"] = self.contentBlock
        return out


@dataclass(frozen=True)
class UpdateCheckError:
    """One entry of ``UpdateCheck.errors`` (plans/P3-01.md §2.5's error map)."""

    code: str
    detail: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {"code": self.code, "detail": self.detail}


@dataclass(frozen=True)
class UpdateCheck:
    """What ``client.update.decide()`` returns in every SDK (plans/P3-01.md §2.5)."""

    #: The canonical channel: the ``channel`` claim of the feed the decision used. A host that
    #: stages an update records it as ``StagedUpdate.channel``.
    channel: str
    decision: UpdateDecision
    #: ``"network"`` (the fetched copy was committed, or equals the committed one) or
    #: ``"committed"`` (the decision used the earlier copy).
    feed: str
    #: ``"network"``, ``"cache"`` or ``"none"``.
    record: str
    errors: Tuple[UpdateCheckError, ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "channel": self.channel,
            "decision": self.decision.to_dict(),
            "feed": self.feed,
            "record": self.record,
            "errors": [e.to_dict() for e in self.errors],
        }
