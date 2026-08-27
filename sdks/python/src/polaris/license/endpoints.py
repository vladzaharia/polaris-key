"""Activation + lifecycle HTTP calls (key -> token, token re-acquire, deauthorize, report).

Mirrors ``endpoints.ts``. ``activate_with_key`` and ``reacquire_token`` share the same
POST-and-classify shape; the result is a small tagged union of dataclasses.
"""

from __future__ import annotations

from dataclasses import dataclass
import platform
from typing import Any, Optional, Union

import httpx

from .models import (
    HEADER_ARCH,
    HEADER_DEVICE,
    HEADER_PLATFORM,
    HEADER_SDK_NAME,
    HEADER_SDK_VERSION,
)
from ._version import SDK_NAME, SDK_VERSION

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
    "report_snapshot",
]


@dataclass(frozen=True)
class ActivationOk:
    token: str
    schemaVersion: int
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
    changed: Optional[list] = None
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


def _metadata_headers() -> dict:
    return {
        HEADER_PLATFORM: platform.system().lower(),
        HEADER_ARCH: platform.machine(),
        HEADER_SDK_NAME: SDK_NAME,
        HEADER_SDK_VERSION: SDK_VERSION,
    }


def _activation_like(
    url: str,
    headers: dict,
    client: httpx.Client,
    fingerprint: Optional[dict] = None,
) -> ActivationResult:
    try:
        if fingerprint:
            res = client.post(url, headers=headers, json={"fingerprint": fingerprint})
        else:
            # No body at all when there is no fingerprint, so the call stays byte-identical
            # to the pre-fingerprint contract against an older Worker.
            res = client.post(url, headers=headers)
    except Exception as e:
        return ActivationError(message=str(e))
    if res.status_code == 200:
        b = res.json()
        return ActivationOk(token=b["token"], schemaVersion=b["schemaVersion"])
    if res.status_code == 409:
        b = _json_or_empty(res)
        return ActivationHardwareMismatch(drift=b.get("drift"), changed=b.get("changed"))
    if res.status_code == 403:
        b = _json_or_empty(res)
        if b.get("error") == "fingerprint_required":
            return ActivationFingerprintRequired()
        return ActivationDeviceLimit(
            limit=b.get("limit"),
            deviceCount=b.get("deviceCount"),
        )
    if res.status_code == 401:
        return ActivationUnauthorized()
    if res.status_code == 404:
        return ActivationEnrollDisabled()
    return ActivationError(message=_text_or_empty(res))


def activate_with_key(
    *,
    base_url: str,
    product: str,
    key: str,
    device_id: str,
    client: httpx.Client,
    fingerprint: Optional[dict] = None,
) -> ActivationResult:
    return _activation_like(
        f"{base_url}/{product}/activate",
        {"authorization": f"Bearer {key}", HEADER_DEVICE: device_id, **_metadata_headers()},
        client,
        fingerprint,
    )


def enroll(
    *,
    base_url: str,
    product: str,
    device_id: str,
    client: httpx.Client,
    fingerprint: Optional[dict] = None,
) -> ActivationResult:
    """``POST /<product>/enroll`` — obtain a license with no key and no sign-in.

    Returns the same tagged union ``activate_with_key`` does, so callers need no new
    branching. A product that hasn't opted in answers 404 → ``ActivationEnrollDisabled``.
    """
    return _activation_like(
        f"{base_url}/{product}/enroll",
        {HEADER_DEVICE: device_id, **_metadata_headers()},
        client,
        fingerprint,
    )


def reacquire_token(
    *, base_url: str, product: str, token: str, device_id: str, client: httpx.Client
) -> ActivationResult:
    return _activation_like(
        f"{base_url}/{product}/token",
        {"authorization": f"Bearer {token}", HEADER_DEVICE: device_id, **_metadata_headers()},
        client,
    )


def deauthorize(*, base_url: str, product: str, token: str, client: httpx.Client) -> None:
    """Best-effort server-side deauthorize; the local wipe is what matters."""
    try:
        client.post(
            f"{base_url}/{product}/deauthorize",
            headers={"authorization": f"Bearer {token}"},
        )
    except Exception:
        pass


def report_snapshot(
    *, base_url: str, product: str, token: str, snapshot: Any, client: httpx.Client
) -> bool:
    """POST a non-secret config snapshot. Returns True on a 2xx, False otherwise."""
    try:
        res = client.post(
            f"{base_url}/{product}/config/report",
            headers={
                "authorization": f"Bearer {token}",
                "content-type": "application/json",
                **_metadata_headers(),
            },
            json=snapshot,
        )
        return res.is_success
    except Exception:
        return False


def _json_or_empty(res: httpx.Response) -> dict:
    try:
        body = res.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


def _text_or_empty(res: httpx.Response) -> str:
    try:
        return res.text
    except Exception:
        return ""
