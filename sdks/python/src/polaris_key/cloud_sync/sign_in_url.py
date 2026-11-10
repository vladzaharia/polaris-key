"""The one check a Cloud Sync sign-in URL passes before it reaches app code (the same rule as the
browser's, Node's, Swift's and Kotlin's ``safeSignInUrl``)."""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urljoin, urlsplit

__all__ = ["safe_sign_in_url", "sign_in_url_of"]


def _forbidden(ch: str) -> bool:
    o = ord(ch)
    # Whitespace and control characters (a URL parser would strip some and read the rest as another
    # host), and the backslash a browser reads as a slash.
    return o <= 0x20 or 0x7F <= o <= 0x9F or ch == "\\"


def safe_sign_in_url(url: Optional[str], origin: str) -> Optional[str]:
    """A sign-in URL fit to hand to the app: https on the Worker's ``origin`` (``https://host[:port]``),
    else ``None``. A path is resolved against ``origin``; credentials in the URL are refused."""
    if not isinstance(url, str) or any(_forbidden(c) for c in url):
        return None
    try:
        base = urlsplit(origin)
        resolved = urlsplit(urljoin(origin, url))
        if base.scheme != "https" or resolved.scheme != "https":
            return None
        if resolved.username is not None or resolved.password is not None:
            return None
        if not base.hostname or (resolved.hostname or "").lower() != base.hostname.lower():
            return None
        if (resolved.port or 443) != (base.port or 443):
            return None
        return resolved.geturl()
    except ValueError:
        return None


def sign_in_url_of(body: Any) -> Optional[str]:
    """The ``signInUrl`` of an ``account_required`` body: ``{"error": {"signInUrl"}}`` or beside the
    error. Unvetted."""
    if not isinstance(body, dict):
        return None
    nested = body.get("error")
    url = nested.get("signInUrl") if isinstance(nested, dict) else None
    if url is None:
        url = body.get("signInUrl")
    return url if isinstance(url, str) else None
