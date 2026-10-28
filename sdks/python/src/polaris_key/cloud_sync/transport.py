"""The Cloud Sync host's transport: one bearer HTTP exchange per request the machine queued.

A port of ``packages/sdk-node/src/cloudSync/transport.ts``. It sends only what the machine produced,
only to the product's own ``/sync`` routes on the product origin (``CoreContext.url`` joins them to
the base URL, so the device bearer never goes anywhere else), with the SDK's ``X-PKey-*`` headers. It
never follows a redirect, so the bearer cannot be handed to another origin; a 3xx is an answer the
machine does not act on. The host adds no request of its own (S3). Any failure to get an answer is
``{"error": "transport"}``, which the machine reads as "nothing was processed" and retries on its next
trigger.

The body is read as a stream under a byte cap (SEC-SYNC-HOST 5).
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict

from ..core.bounded_body import MAX_BODY_BYTES, read_capped_text
from ..core.context import CoreContext
from ..core.token import TokenManager

__all__ = ["MAX_RESPONSE_BYTES", "is_sync_path", "send_sync"]

MAX_RESPONSE_BYTES = MAX_BODY_BYTES

_TRANSPORT: Dict[str, Any] = {"error": "transport"}
_QUERY = re.compile(r"[A-Za-z0-9_=&.%-]*\Z")


def is_sync_path(product: str, path: str) -> bool:
    """Whether ``path`` is one of the machine's two routes for ``product`` (a pull or a push)."""
    base = f"/{product}/sync"
    if path == f"{base}/ops":
        return True
    if not path.startswith(f"{base}?"):
        return False
    return _QUERY.match(path[len(base) + 1 :]) is not None


def _no_constant(_: str) -> Any:
    raise ValueError("not JSON")


def send_sync(ctx: CoreContext, tokens: TokenManager, req: Dict[str, Any]) -> Dict[str, Any]:
    """Send one machine request; the answer is ``{"status", "body"?}`` or ``{"error": "transport"}``."""
    token = tokens.current
    path = req.get("path")
    if not token or not isinstance(path, str) or not is_sync_path(ctx.product, path):
        return _TRANSPORT
    headers = ctx.headers({"authorization": f"Bearer {token}", "accept": "application/json"})
    kwargs: Dict[str, Any] = {}
    if req.get("method") == "POST":
        headers["content-type"] = "application/json"
        kwargs["content"] = json.dumps(req.get("body"), separators=(",", ":")).encode("utf-8")
    try:
        with ctx.http().stream(
            str(req["method"]),
            f"{ctx.base_url}{path}",
            headers=headers,
            timeout=ctx.timeout,
            follow_redirects=False,
            **kwargs,
        ) as res:
            text = read_capped_text(res, MAX_RESPONSE_BYTES)
            status = res.status_code
    except Exception:  # noqa: BLE001 - any failure to get an answer is "nothing was processed"
        return _TRANSPORT
    if text is None:
        return _TRANSPORT
    if text == "":
        return {"status": status}
    try:
        return {"status": status, "body": json.loads(text, parse_constant=_no_constant)}
    except (ValueError, RecursionError):
        # A 2xx the machine cannot read is not an answer; an error page keeps its status.
        return _TRANSPORT if 200 <= status < 300 else {"status": status}
