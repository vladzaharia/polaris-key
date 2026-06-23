"""Enrollment + lifecycle HTTP calls (key -> token, token re-acquire, deauthorize, report).

Mirrors ``endpoints.ts``. ``enroll_with_key`` and ``reacquire_token`` share the same
POST-and-classify shape; the result is a small tagged union of dataclasses.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Union

import httpx

from .models import HEADER_DEVICE

__all__ = [
    "EnrollOk",
    "EnrollMachineLimit",
    "EnrollUnauthorized",
    "EnrollError",
    "EnrollResult",
    "enroll_with_key",
    "reacquire_token",
    "deauthorize",
    "report_snapshot",
]


@dataclass(frozen=True)
class EnrollOk:
    token: str
    schemaVersion: int
    kind: str = "ok"


@dataclass(frozen=True)
class EnrollMachineLimit:
    limit: Optional[int] = None
    machineCount: Optional[int] = None
    kind: str = "machine-limit"


@dataclass(frozen=True)
class EnrollUnauthorized:
    kind: str = "unauthorized"


@dataclass(frozen=True)
class EnrollError:
    message: str
    kind: str = "error"


EnrollResult = Union[EnrollOk, EnrollMachineLimit, EnrollUnauthorized, EnrollError]


def _enroll_like(url: str, headers: dict, client: httpx.Client) -> EnrollResult:
    try:
        res = client.post(url, headers=headers)
    except Exception as e:
        return EnrollError(message=str(e))
    if res.status_code == 200:
        b = res.json()
        return EnrollOk(token=b["token"], schemaVersion=b["schemaVersion"])
    if res.status_code == 403:
        b = _json_or_empty(res)
        return EnrollMachineLimit(limit=b.get("limit"), machineCount=b.get("machineCount"))
    if res.status_code == 401:
        return EnrollUnauthorized()
    return EnrollError(message=_text_or_empty(res))


def enroll_with_key(
    *, base_url: str, product: str, key: str, device_id: str, client: httpx.Client
) -> EnrollResult:
    return _enroll_like(
        f"{base_url}/{product}/enroll",
        {"authorization": f"Bearer {key}", HEADER_DEVICE: device_id},
        client,
    )


def reacquire_token(
    *, base_url: str, product: str, device_id: str, client: httpx.Client
) -> EnrollResult:
    return _enroll_like(
        f"{base_url}/{product}/token",
        {HEADER_DEVICE: device_id},
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
