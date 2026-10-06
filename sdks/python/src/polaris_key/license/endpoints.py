"""The License service's HTTP surface — ``POST /<p>/license/{activate,enroll,token,
deauthorize}`` and ``GET /<p>/license/document`` (§R1, wire contract v3 §5).

Pure transport: it builds the request, maps the status taxonomy, and hands back raw bytes.
Verification, caching and the gate live elsewhere on purpose — an HTTP layer that verified
would be an HTTP layer that could be talked into not verifying.

Every call carries the seven ``X-PKey-*`` metadata headers and a deadline, both from
:meth:`polaris_key.core.context.CoreContext.headers` / :meth:`~...CoreContext.request`, so a
new endpoint cannot ship without them (R4-08).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Union

from ..constants_generated import ErrorCode
from ..core.context import DocumentResult
from ..core.errors import PolarisError

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..core.context import CoreContext

__all__ = [
    "ActivationOk",
    "ActivationDeviceLimit",
    "ActivationUnauthorized",
    "ActivationFingerprintRequired",
    "ActivationHardwareMismatch",
    "ActivationEnrollDisabled",
    "ActivationEnrollClaimed",
    "ActivationLicenseDisabled",
    "ActivationLicenseExpired",
    "ActivationAttestationRequired",
    "ActivationRateLimited",
    "ActivationRefused",
    "ActivationError",
    "ActivationResult",
    "activation_result_from",
    "activate_with_key",
    "enroll",
    "reacquire_token",
    "deauthorize",
    "fetch_license_document",
    "LICENSE_DOCUMENT_PATH",
]

#: ``GET /<p>/license/document`` — the signed grant document. The build gate lives on
#: THIS route (D-20), so it is the only document fetch that can answer ``blocked``.
LICENSE_DOCUMENT_PATH = "license/document"


@dataclass(frozen=True)
class ActivationOk:
    token: str
    schemaVersion: int = 0
    kind: str = "ok"


@dataclass(frozen=True)
class ActivationDeviceLimit:
    """403 ``device_limit``: the licence has no free seat. ``limit`` and ``deviceCount`` when
    the server sent them. The SDK builds no portal URL here (owner decision Q6): the
    "Manage devices" link is the server-supplied ``manageUrl`` once the Worker sends it."""

    limit: Optional[int] = None
    deviceCount: Optional[int] = None
    kind: str = "device-limit"
    code: str = "device_limit"


@dataclass(frozen=True)
class ActivationUnauthorized:
    kind: str = "unauthorized"
    code: str = "unauthorized"


@dataclass(frozen=True)
class ActivationFingerprintRequired:
    """The tier requires a hardware fingerprint this host could not produce."""

    kind: str = "fingerprint-required"
    code: str = "fingerprint_required"


@dataclass(frozen=True)
class ActivationEnrollDisabled:
    """The product does not offer keyless enrollment."""

    kind: str = "enroll-disabled"
    code: str = "enroll_disabled"


@dataclass(frozen=True)
class ActivationHardwareMismatch:
    """Hardware drifted past the tier's tolerance; the binding was retired. Retrying
    activation re-binds the new hardware and consumes a seat."""

    drift: Optional[int] = None
    changed: Optional[List[str]] = None
    kind: str = "hardware-mismatch"
    code: str = "hardware_mismatch"


@dataclass(frozen=True)
class ActivationEnrollClaimed:
    """403 ``enroll_claimed``: this machine's free licence now belongs to an account. Signing
    in (``client.identity``) reaches it; enrolling again never will."""

    kind: str = "enroll-claimed"
    code: str = "enroll_claimed"


@dataclass(frozen=True)
class ActivationLicenseDisabled:
    """403 ``license_disabled``: an operator disabled the licence."""

    kind: str = "license-disabled"
    code: str = "license_disabled"


@dataclass(frozen=True)
class ActivationLicenseExpired:
    """403 ``license_expired``: the licence has expired."""

    kind: str = "license-expired"
    code: str = "license_expired"


@dataclass(frozen=True)
class ActivationAttestationRequired:
    """403 ``attestation_required``: the product's device-trust policy wants an attested
    device. CPython has no attestation service (``devices.attest`` is a runtime N/A), so this
    is final here."""

    kind: str = "attestation-required"
    code: str = "attestation_required"


@dataclass(frozen=True)
class ActivationRateLimited:
    """429: too many attempts. ``retryAfterSeconds`` from ``Retry-After`` when sent."""

    retryAfterSeconds: Optional[int] = None
    kind: str = "rate-limited"
    code: str = "rate_limited"


@dataclass(frozen=True)
class ActivationRefused:
    """Any other 4xx: the server's own ``code`` (a registry code, or one this SDK predates),
    the HTTP ``status`` and the server's ``message``. Never collapsed into another kind, so a
    code the Worker gains later is reported as itself."""

    code: str
    status: int
    message: str = ""
    kind: str = "refused"


@dataclass(frozen=True)
class ActivationError:
    """No usable answer: a transport failure (``code`` ``network``, ``status`` ``None``, as in
    the other SDKs; SDK parity pass §3.1) or a 5xx / malformed 200 (``server-error``, with the
    status)."""

    message: str
    kind: str = "error"
    code: str = ErrorCode.NETWORK
    status: Optional[int] = None


ActivationResult = Union[
    ActivationOk,
    ActivationDeviceLimit,
    ActivationUnauthorized,
    ActivationFingerprintRequired,
    ActivationHardwareMismatch,
    ActivationEnrollDisabled,
    ActivationEnrollClaimed,
    ActivationLicenseDisabled,
    ActivationLicenseExpired,
    ActivationAttestationRequired,
    ActivationRateLimited,
    ActivationRefused,
    ActivationError,
]

#: The ``server-error`` code an ``ActivationError`` carries for a 5xx or an unusable 200.
_SERVER_ERROR = ErrorCode.SERVER_ERROR


def _wire_code(body: Dict[str, Any]) -> Optional[str]:
    """The body's error code: the flat ``{"error": "x"}`` or the nested
    ``{"error": {"code": "x"}}``."""
    raw = body.get("error")
    if isinstance(raw, str) and raw:
        return raw
    if isinstance(raw, dict) and isinstance(raw.get("code"), str) and raw["code"]:
        return raw["code"]
    return None


def _field(body: Dict[str, Any], name: str) -> Any:
    """A detail field at the top level (where the Worker puts it) or inside a nested error."""
    if name in body:
        return body[name]
    nested = body.get("error")
    return nested.get(name) if isinstance(nested, dict) else None


def _int_or_none(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _retry_after(res: Any) -> Optional[int]:
    try:
        raw = res.headers.get("retry-after")
    except Exception:
        return None
    if raw is None:
        return None
    try:
        n = int(str(raw).strip())
    except ValueError:
        return None
    return n if n >= 0 else None


def activation_result_from(status: int, body: Dict[str, Any], res: Any = None) -> ActivationResult:
    """Map one non-200 activation answer to its kind (spec §3.1).

    The body's ``error`` code decides, never the status alone: an unknown 403 is
    :class:`ActivationRefused` with the server's code, never ``device-limit``. Two tolerances
    for older bodies: a 403 with no code but a numeric ``limit`` is ``device-limit``, a 404
    with no code is ``enroll-disabled``, and a 409 with no code is ``hardware-mismatch``.
    """
    code = _wire_code(body)
    message = body.get("message") if isinstance(body.get("message"), str) else ""
    if status >= 500:
        return ActivationError(
            message=message or f"activation failed with status {status}",
            code=_SERVER_ERROR,
            status=status,
        )
    if code == "device_limit" or (
        code is None and status == 403 and _int_or_none(_field(body, "limit")) is not None
    ):
        return ActivationDeviceLimit(
            limit=_int_or_none(_field(body, "limit")),
            deviceCount=_int_or_none(_field(body, "deviceCount")),
        )
    if code == "hardware_mismatch" or (code is None and status == 409):
        changed = _field(body, "changed")
        return ActivationHardwareMismatch(
            drift=_int_or_none(_field(body, "drift")),
            changed=[c for c in changed if isinstance(c, str)] if isinstance(changed, list) else None,
        )
    if code == "fingerprint_required":
        return ActivationFingerprintRequired()
    if code == "enroll_claimed":
        return ActivationEnrollClaimed()
    if code == "license_disabled":
        return ActivationLicenseDisabled()
    if code == "license_expired":
        return ActivationLicenseExpired()
    if code == "attestation_required":
        return ActivationAttestationRequired()
    if code == "enroll_disabled" or (code is None and status == 404):
        return ActivationEnrollDisabled()
    if code == "rate_limited" or status == 429:
        return ActivationRateLimited(retryAfterSeconds=_retry_after(res) if res is not None else None)
    if code == "unauthorized" or (code is None and status == 401):
        return ActivationUnauthorized()
    return ActivationRefused(
        # A refusal that names no code is the registry's `http-error`.
        code=code if code is not None else "http-error",
        status=status,
        message=message,
    )


def _activation_like(
    ctx: "CoreContext",
    path: str,
    headers: Dict[str, str],
    fingerprint: Optional[dict] = None,
    device_name: Optional[str] = None,
) -> ActivationResult:
    """The three mint/rotate endpoints share a response ladder, so they share a reader
    (:func:`activation_result_from`).

    Codes are read from BOTH the v3 nested body (``{"error":{"code":…}}``) and the flat v2
    shape, because a 403 that says "device limit" and a 403 that says "fingerprint
    required" are different outcomes for the caller and guessing between them would be
    worse than either.
    """
    # Resolving the transport OUTSIDE the try is deliberate: local-only mode raises here,
    # and that is a CONFIGURATION error the host can fix — not a transport outcome.
    # Swallowing it into `ActivationError` would make it indistinguishable from a dropped
    # connection, so the caller could never branch on the one thing it can actually fix.
    ctx.http()
    try:
        body: Dict[str, object] = {}
        if fingerprint:
            body["fingerprint"] = fingerprint
        if device_name:
            # PX-W13 §8 Q2: activation only (never enroll or token rotation).
            body["deviceName"] = device_name
        if body:
            res = ctx.request("POST", ctx.url(path), headers=headers, json=body)
        else:
            # No body at all when there is neither a fingerprint nor a label, so a host that
            # opted out sends a byte-identical request to one that has nothing to report.
            res = ctx.request("POST", ctx.url(path), headers=headers)
    except PolarisError:
        raise
    except Exception as e:
        return ActivationError(message=str(e))

    if res.status_code == 200:
        b = _json_or_empty(res)
        token = b.get("token")
        if not isinstance(token, str):
            return ActivationError(
                message="activation response carried no token", code=_SERVER_ERROR, status=200
            )
        schema_version = b.get("schemaVersion")
        return ActivationOk(
            token=token,
            schemaVersion=schema_version if isinstance(schema_version, int) else 0,
        )
    return activation_result_from(res.status_code, _json_or_empty(res), res)


def enroll(
    ctx: "CoreContext", fingerprint: Optional[dict] = None
) -> ActivationResult:
    """``POST /<p>/license/enroll`` — obtain a licence with no key and no sign-in.

    Returns the same shape :func:`activate_with_key` does, so callers need no new
    branching; a product that has not opted in answers 404 → ``enroll-disabled``.
    """
    return _activation_like(ctx, "license/enroll", ctx.headers(), fingerprint)


def activate_with_key(
    ctx: "CoreContext", key: str, fingerprint: Optional[dict] = None
) -> ActivationResult:
    """``POST /<p>/license/activate`` — exchange a licence key for a per-device ``pkeyt_``
    token."""
    return _activation_like(
        ctx,
        "license/activate",
        ctx.headers({"authorization": f"Bearer {key}"}),
        fingerprint,
        ctx.device_label(),
    )


def reacquire_token(ctx: "CoreContext", token: str) -> ActivationResult:
    """``POST /<p>/license/token`` — rotate the current device token. The §5 single
    re-acquire."""
    return _activation_like(
        ctx, "license/token", ctx.headers({"authorization": f"Bearer {token}"})
    )


def deauthorize(ctx: "CoreContext", token: str) -> None:
    """``POST /<p>/license/deauthorize`` — release this device's seat.

    Best-effort: the LOCAL wipe is what the caller actually depends on, and a device that
    deactivates on a plane must not be left holding credentials because the server was
    unreachable.
    """
    try:
        ctx.request(
            "POST",
            ctx.url("license/deauthorize"),
            headers=ctx.headers({"authorization": f"Bearer {token}"}),
        )
    except Exception:
        # best-effort; the local wipe is what matters (including local-only mode's refusal)
        pass


def fetch_license_document(
    ctx: "CoreContext", token: str, etag: Optional[str] = None
) -> DocumentResult:
    """``GET /<p>/license/document`` — the signed grant document, with ETag/304 (§5)."""
    return ctx.get_document(LICENSE_DOCUMENT_PATH, token, etag)


def _json_or_empty(res: Any) -> Dict[str, Any]:
    try:
        body = res.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}
