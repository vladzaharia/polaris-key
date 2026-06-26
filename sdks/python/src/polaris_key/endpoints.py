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
    "ActivationError",
    "ActivationResult",
    "activate_with_key",
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
class ActivationError:
    message: str
    kind: str = "error"


ActivationResult = Union[ActivationOk, ActivationDeviceLimit, ActivationUnauthorized, ActivationError]


def _metadata_headers() -> dict:
    return {
        HEADER_PLATFORM: platform.system().lower(),
        HEADER_ARCH: platform.machine(),
        HEADER_SDK_NAME: SDK_NAME,
        HEADER_SDK_VERSION: SDK_VERSION,
    }


def _activation_like(url: str, headers: dict, client: httpx.Client) -> ActivationResult:
    try:
        res = client.post(url, headers=headers)
    except Exception as e:
        return ActivationError(message=str(e))
    if res.status_code == 200:
        b = res.json()
        return ActivationOk(token=b["token"], schemaVersion=b["schemaVersion"])
    if res.status_code == 403:
        b = _json_or_empty(res)
        return ActivationDeviceLimit(
            limit=b.get("limit"),
            deviceCount=b.get("deviceCount"),
        )
    if res.status_code == 401:
        return ActivationUnauthorized()
    return ActivationError(message=_text_or_empty(res))


def activate_with_key(
    *, base_url: str, product: str, key: str, device_id: str, client: httpx.Client
) -> ActivationResult:
    return _activation_like(
        f"{base_url}/{product}/activate",
        {"authorization": f"Bearer {key}", HEADER_DEVICE: device_id, **_metadata_headers()},
        client,
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
