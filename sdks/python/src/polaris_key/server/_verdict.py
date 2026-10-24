"""The backend verdict (WIRE-CONTRACT-V4 §14.2): six steps, the first that fails decides.

Mirrors ``@polaris-key/client-core``'s ``backend.ts``; ``conformance/corpus/v2/backend-matrix.json``
pins it. Nothing here does I/O or logs: the trust sets come in from the caller, and the header,
the document and the holder never reach a log line, an exception message or a ``repr``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, NamedTuple, Optional, Sequence, Tuple, Union

from ..core.jws import verify_jws
from ..core.models import (
    CLOCK_SKEW_SECONDS,
    HEADER_DEVICE,
    ISSUER,
    TYP_LICENSE,
    LicenseDoc,
    license_user,
)
from ..core.verify import validate_envelope
from ..license.gate import is_usable, license_state

__all__ = [
    "HEADER_LICENSE",
    "AUTH_SCHEME",
    "LICENSE_MAX_BYTES",
    "REFUSAL_STATUS",
    "POLARIS_REQUEST_HEADERS",
    "Requirement",
    "Holder",
    "PolarisLicense",
    "PolarisUser",
    "Verdict",
    "header_elements",
    "backend_verdict",
    "parse_credential",
    "Refusal",
    "judge",
    "check_requirements",
    "entitlement",
    "tier",
    "signin",
    "sign_in",
    "as_requirements",
]

HEADER_LICENSE = "X-PKey-License"
AUTH_SCHEME = "PKey-License"
LICENSE_MAX_BYTES = 16384
#: A field value longer than this is never split (an element is at most LICENSE_MAX_BYTES).
RAW_FIELD_MAX = LICENSE_MAX_BYTES + 4096
#: The two request headers an app's CORS allow-list needs (§14.1).
POLARIS_REQUEST_HEADERS: Tuple[str, str] = (HEADER_LICENSE, HEADER_DEVICE)

#: Each refusal's HTTP status (§14.2). ``not_entitled`` is the existing wire code.
REFUSAL_STATUS: Mapping[str, int] = {
    "license_required": 401,
    "license_invalid": 401,
    "license_stale": 401,
    "not_entitled": 403,
    "sign_in_required": 403,
}

_SEGMENTS = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
_ASCII_UPPER = {c: c + 32 for c in range(ord("A"), ord("Z") + 1)}

HeadersLike = Union[Mapping[str, str], Iterable[Tuple[str, str]]]


@dataclass(frozen=True)
class Requirement:
    """One requirement of a route (step 6). ``test`` receives a valued entitlement's value."""

    kind: str  # "entitlement" | "tier" | "signIn"
    name: str = ""
    test: Optional[Callable[[Any], bool]] = field(default=None, compare=False)
    tiers: Tuple[str, ...] = ()


def entitlement(name: str, test: Optional[Callable[[Any], bool]] = None) -> Requirement:
    """Boolean entitlement ``name`` is granted, or ``test(value)`` accepts a valued entitlement."""
    if not isinstance(name, str) or not name:
        raise TypeError('entitlement(): name the entitlement, for example entitlement("export.pdf")')
    return Requirement("entitlement", name, test)


def tier(*tiers: str) -> Requirement:
    """The ``license.tier`` entitlement is one of ``tiers``, for example ``tier("pro", "team")``."""
    if not tiers or not all(isinstance(t, str) and t for t in tiers):
        raise TypeError('tier(): name at least one tier, for example tier("pro", "team")')
    return Requirement("tier", tiers=tuple(tiers))


def signin() -> Requirement:
    """A person is signed in on the device (``profile.user.subject``)."""
    return Requirement("signIn")


def sign_in() -> Requirement:
    """:func:`signin` with the underscore, matching ``require_sign_in``."""
    return signin()


def as_requirements(requirements: Sequence[Any], who: str) -> Tuple[Requirement, ...]:
    """The requirements a route lists, each checked to be one of the builders' results."""
    for r in requirements:
        if not isinstance(r, Requirement):
            raise TypeError(
                f"{who}: {r!r} is not a requirement; build one with entitlement(name), tier(*tiers) or signin()"
            )
    return tuple(requirements)


class Holder:
    """The signed profile's name and email. Never printed: ``repr`` and ``str`` are redacted."""

    __slots__ = ("name", "email")

    def __init__(self, name: str, email: str) -> None:
        self.name = name
        self.email = email

    def __repr__(self) -> str:
        return "Holder(<redacted>)"

    __str__ = __repr__

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Holder) and (self.name, self.email) == (other.name, other.email)

    __hash__ = None  # type: ignore[assignment]


class PolarisUser:
    """The signed-in account's pairwise subject (``ps_...``). ``repr`` is redacted."""

    __slots__ = ("subject",)

    def __init__(self, subject: str) -> None:
        self.subject = subject

    def __repr__(self) -> str:
        return "PolarisUser(<redacted>)"

    __str__ = __repr__

    def __eq__(self, other: object) -> bool:
        return isinstance(other, PolarisUser) and self.subject == other.subject

    def __hash__(self) -> int:
        return hash(self.subject)


class PolarisLicense:
    """What a passing document attaches to the request (§14.2)."""

    __slots__ = ("product", "id", "device_id", "tier", "issued_at", "age_seconds", "holder", "_doc")

    def __init__(
        self,
        product: str,
        id: str,
        device_id: str,
        tier: Optional[str],
        issued_at: int,
        age_seconds: int,
        holder: Optional[Holder],
        doc: LicenseDoc,
    ) -> None:
        self.product = product
        self.id = id
        self.device_id = device_id
        self.tier = tier
        self.issued_at = issued_at
        self.age_seconds = age_seconds
        self.holder = holder
        self._doc = doc

    def is_entitled(self, name: str) -> bool:
        """True when the boolean entitlement ``name`` is true in the signed document."""
        entry = self._doc.entitlements.get(name)
        return entry is not None and entry.value is True

    def value(self, name: str) -> Any:
        """The entitlement's value, or ``None`` when the document does not carry it."""
        entry = self._doc.entitlements.get(name)
        return None if entry is None else entry.value

    def to_dict(self) -> Dict[str, Any]:
        """The matrix shape. Carries the holder: never log it."""
        return {
            "product": self.product,
            "id": self.id,
            "deviceId": self.device_id,
            "tier": self.tier,
            "issuedAt": self.issued_at,
            "ageSeconds": self.age_seconds,
            "holder": None if self.holder is None else {"name": self.holder.name, "email": self.holder.email},
        }

    def __repr__(self) -> str:
        return f"PolarisLicense(product={self.product!r}, tier={self.tier!r}, age_seconds={self.age_seconds})"


@dataclass(frozen=True)
class Verdict:
    """The verdict: 200 with ``code`` None when every step passes. ``license`` and ``user`` are
    set whenever steps 1 to 5 pass (step 6's refusals included)."""

    status: int
    code: Optional[str]
    license: Optional[PolarisLicense] = None
    user: Optional[PolarisUser] = None
    #: The step that refused (1 to 6), for metrics only; 0 when the request passes. Never in a body.
    step: int = 0

    def context(self) -> Optional[Dict[str, Any]]:
        if self.license is None:
            return None
        return {
            "license": self.license.to_dict(),
            "user": None if self.user is None else {"subject": self.user.subject},
        }


def _refused(
    code: str, step: int, lic: Optional[PolarisLicense] = None, user: Optional[PolarisUser] = None
) -> Verdict:
    return Verdict(REFUSAL_STATUS[code], code, lic, user, step)


class Refusal(NamedTuple):
    """A refusal from steps 1 to 3."""

    code: str
    step: int


def _pairs(headers: HeadersLike) -> List[Tuple[str, str]]:
    if isinstance(headers, Mapping):
        return list(headers.items())
    return list(headers)


def header_elements(headers: Iterable[Tuple[str, str]], name: str) -> List[str]:
    """§14.1: every field named ``name`` (ASCII case folding), each value split at ``,``, each
    element trimmed of spaces and tabs, empty ones dropped."""
    want = name.translate(_ASCII_UPPER)
    out: List[str] = []
    for n, v in headers:
        if n.translate(_ASCII_UPPER) != want:
            continue
        if len(v) > RAW_FIELD_MAX:
            # No element can be this long: keep it whole so the size check refuses it, rather
            # than splitting and trimming an arbitrarily large value.
            out.append(v)
            continue
        for element in v.split(","):
            e = element.strip(" \t")
            if e:
                out.append(e)
    return out


def parse_credential(
    headers: HeadersLike,
    now: int,
    products: Sequence[str],
    trust: Mapping[str, Mapping[str, str]],
) -> Union[Refusal, Tuple[str, LicenseDoc, Dict[str, Any]]]:
    """Steps 1 to 3: a :class:`Refusal`, or ``(product, document, raw payload)``."""
    pairs = _pairs(headers)
    lic = header_elements(pairs, HEADER_LICENSE)
    if not lic:
        return Refusal("license_required", 1)
    if len(lic) != 1:
        return Refusal("license_invalid", 2)
    jws = lic[0]
    if len(jws) > LICENSE_MAX_BYTES or not jws.isascii() or not _SEGMENTS.fullmatch(jws):
        return Refusal("license_invalid", 2)
    device = header_elements(pairs, HEADER_DEVICE)
    if len(device) > 1:
        return Refusal("license_invalid", 3)
    for product in products:
        pins = trust.get(product)
        if pins is None:
            continue
        verified = verify_jws(jws, dict(pins), typ=TYP_LICENSE)
        if verified is None or not isinstance(verified.payload, dict):
            continue
        payload: Dict[str, Any] = verified.payload
        if payload.get("aud") != product:
            continue
        device_id = payload.get("deviceId")
        if not isinstance(device_id, str) or device_id == "":
            continue
        doc = LicenseDoc.from_dict(payload)
        if doc is None:
            continue
        if not validate_envelope(
            doc.claims(),
            expected_aud=product,
            expected_iss=ISSUER,
            device_id=device[0] if device else device_id,
            last_accepted_issued_at=None,
            now=now,
            check_freshness=False,
        ):
            continue
        if doc.issuedAt > now + CLOCK_SKEW_SECONDS:
            continue
        return product, doc, payload
    return Refusal("license_invalid", 3)


def _holder(payload: Mapping[str, Any]) -> Optional[Holder]:
    profile = payload.get("profile")
    if isinstance(profile, dict):
        name, email = profile.get("name"), profile.get("email")
        if isinstance(name, str) and isinstance(email, str):
            return Holder(name, email)
    return None


def check_requirements(
    license: PolarisLicense, user: Optional[PolarisUser], require: Sequence[Requirement]
) -> Optional[str]:
    """Step 6: the first requirement that fails, as a code, in the order the route lists them."""
    for r in require:
        if r.kind == "entitlement":
            if r.test is None:
                ok = license.is_entitled(r.name)  # api-allow: server verdict object (L4), not the client namespace
            else:
                entry = license._doc.entitlements.get(r.name)
                try:
                    ok = entry is not None and bool(r.test(entry.value))
                except Exception:
                    ok = False
            if not ok:
                return "not_entitled"
        elif r.kind == "tier":
            if license.tier is None or license.tier not in r.tiers:
                return "not_entitled"
        elif user is None:
            return "sign_in_required"
    return None


def judge(
    product: str,
    doc: LicenseDoc,
    payload: Mapping[str, Any],
    now: int,
    max_age_seconds: Optional[int],
    require: Sequence[Requirement],
) -> Verdict:
    """Steps 4 to 6 for a verified document."""
    if max_age_seconds is None:
        if now > doc.expiresAt + CLOCK_SKEW_SECONDS:
            return _refused("license_stale", 4)
    elif now - doc.issuedAt > max_age_seconds + CLOCK_SKEW_SECONDS or now > doc.graceUntil:
        return _refused("license_stale", 4)
    state = license_state(license_service_enabled=True, activation="token", doc=doc, now=now)
    if not is_usable(state):
        return _refused("license_stale", 5)
    tier_entry = doc.entitlements.get("license.tier")
    tier = tier_entry.value if tier_entry is not None and isinstance(tier_entry.value, str) else None
    lic = PolarisLicense(
        product, doc.licenseId, doc.deviceId, tier, doc.issuedAt, max(0, now - doc.issuedAt), _holder(payload), doc
    )
    found = license_user(payload)
    user = PolarisUser(found.subject) if found is not None else None
    failed = check_requirements(lic, user, require)
    if failed is not None:
        return _refused(failed, 6, lic, user)
    return Verdict(200, None, lic, user)


def backend_verdict(
    headers: HeadersLike,
    now: int,
    products: Sequence[str],
    trust: Mapping[str, Mapping[str, str]],
    max_age_seconds: Optional[int] = None,
    require: Sequence[Requirement] = (),
) -> Verdict:
    """§14.2: decide a request to a product backend. Never raises on request input."""
    if not products or not all(isinstance(p, str) and p for p in products):
        raise TypeError("backend_verdict: products names no product")
    if max_age_seconds is not None and (
        isinstance(max_age_seconds, bool) or not isinstance(max_age_seconds, int) or max_age_seconds < 0
    ):
        raise TypeError("backend_verdict: max_age_seconds is not a non-negative integer")
    parsed = parse_credential(headers, now, products, trust)
    if isinstance(parsed, Refusal):
        return _refused(parsed.code, parsed.step)
    product, doc, payload = parsed
    return judge(product, doc, payload, now, max_age_seconds, require)
