"""GET /<product>/config with the documented status taxonomy (httpx).

Verification + anti-replay happen in the client (verify.py); this is purely the HTTP
layer. Mirrors ``fetch.ts``. The result is a small tagged union of dataclasses.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Union

import httpx

from .models import (
    HEADER_CHANNEL,
    HEADER_DEVICE,
    HEADER_VERSION,
    AllowedRange,
    BlockReason,
)

__all__ = [
    "FetchOk",
    "FetchNotModified",
    "FetchUnauthorized",
    "FetchDeviceCap",
    "FetchBlocked",
    "FetchError",
    "FetchResult",
    "fetch_managed_config",
]


@dataclass(frozen=True)
class FetchOk:
    jws: str
    etag: Optional[str]
    kind: str = "ok"


@dataclass(frozen=True)
class FetchNotModified:
    kind: str = "not-modified"


@dataclass(frozen=True)
class FetchUnauthorized:
    kind: str = "unauthorized"


@dataclass(frozen=True)
class FetchDeviceCap:
    limit: Optional[int] = None
    machineCount: Optional[int] = None
    kind: str = "device-cap"


@dataclass(frozen=True)
class FetchBlocked:
    reason: BlockReason = "version-too-old"
    allowedRange: Optional[AllowedRange] = None
    kind: str = "blocked"


@dataclass(frozen=True)
class FetchError:
    status: int
    message: str
    kind: str = "error"


FetchResult = Union[
    FetchOk,
    FetchNotModified,
    FetchUnauthorized,
    FetchDeviceCap,
    FetchBlocked,
    FetchError,
]


def fetch_managed_config(
    *,
    base_url: str,
    product: str,
    token: str,
    device_id: str,
    version: str,
    channel: str,
    etag: Optional[str] = None,
    client: httpx.Client,
) -> FetchResult:
    """Fetch the signed config doc, mapping HTTP status -> the result union."""
    headers = {
        "authorization": f"Bearer {token}",
        HEADER_DEVICE: device_id,
        HEADER_VERSION: version,
        HEADER_CHANNEL: channel,
    }
    if etag:
        headers["if-none-match"] = etag
    url = f"{base_url}/{product}/config"

    try:
        res = client.get(url, headers=headers)
    except Exception as e:  # network error
        return FetchError(status=0, message=str(e))

    status = res.status_code
    if status == 304:
        return FetchNotModified()
    if status == 401:
        return FetchUnauthorized()
    if status == 429:
        body = _json_or_empty(res)
        return FetchDeviceCap(limit=body.get("limit"), machineCount=body.get("machineCount"))
    if status == 403:
        body = _json_or_empty(res)
        return FetchBlocked(
            reason=body.get("reason") or "version-too-old",
            allowedRange=AllowedRange.from_dict(body.get("allowedRange")),
        )
    if status == 200:
        return FetchOk(jws=res.text, etag=res.headers.get("etag"))
    return FetchError(status=status, message=_text_or_empty(res))


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
