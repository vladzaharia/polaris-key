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
    "ActivationError",
    "ActivationResult",
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
    limit: Optional[int] = None
    deviceCount: Optional[int] = None
    kind: str = "device-limit"


@dataclass(frozen=True)
class ActivationUnauthorized:
    kind: str = "unauthorized"


@dataclass(frozen=True)
class ActivationFingerprintRequired:
    """The tier requires a hardware fingerprint this host could not produce."""

    kind: str = "fingerprint-required"


@dataclass(frozen=True)
class ActivationEnrollDisabled:
    """The product does not offer keyless enrollment."""

    kind: str = "enroll-disabled"


@dataclass(frozen=True)
class ActivationHardwareMismatch:
    """Hardware drifted past the tier's tolerance; the binding was retired. Retrying
    activation re-binds the new hardware and consumes a seat."""

    drift: Optional[int] = None
    changed: Optional[List[str]] = None
    kind: str = "hardware-mismatch"


@dataclass(frozen=True)
class ActivationError:
    message: str
    kind: str = "error"


ActivationResult = Union[
    ActivationOk,
    ActivationDeviceLimit,
    ActivationUnauthorized,
    ActivationFingerprintRequired,
    ActivationHardwareMismatch,
    ActivationEnrollDisabled,
    ActivationError,
]


def _activation_like(
    ctx: "CoreContext",
    path: str,
    headers: Dict[str, str],
    fingerprint: Optional[dict] = None,
    device_name: Optional[str] = None,
) -> ActivationResult:
    """The three mint/rotate endpoints share a response ladder, so they share a reader.

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
            return ActivationError(message="activation response carried no token")
        schema_version = b.get("schemaVersion")
        return ActivationOk(
            token=token,
            schemaVersion=schema_version if isinstance(schema_version, int) else 0,
        )
    if res.status_code == 409:
        b = _json_or_empty(res)
        nested = b.get("error") if isinstance(b.get("error"), dict) else {}
        return ActivationHardwareMismatch(
            drift=b.get("drift", nested.get("drift")),
            changed=b.get("changed", nested.get("changed")),
        )
    if res.status_code == 403:
        b = _json_or_empty(res)
        raw_error = b.get("error")
        nested = raw_error if isinstance(raw_error, dict) else {}
        code = raw_error if isinstance(raw_error, str) else nested.get("code")
        if code == "fingerprint_required":
            return ActivationFingerprintRequired()
        return ActivationDeviceLimit(
            limit=b.get("limit", nested.get("limit")),
            deviceCount=b.get("deviceCount", nested.get("deviceCount")),
        )
    if res.status_code == 401:
        return ActivationUnauthorized()
    if res.status_code == 404:
        return ActivationEnrollDisabled()
    return ActivationError(message=_text_or_empty(res))


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


def _text_or_empty(res: Any) -> str:
    try:
        return res.text
    except Exception:
        return ""
