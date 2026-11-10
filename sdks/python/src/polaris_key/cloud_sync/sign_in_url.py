"""The one check a Cloud Sync sign-in URL passes before it reaches app code.

The rule is the same in every SDK and pinned by the corpus's ``signInUrlCases``
(``tools/sync-scenarios.ts``): it uses no URL library, so no parser's quirks can differ between
languages. :func:`safe_sign_in_url` answers the URL on the Worker's origin, normalised, or ``None``.
"""

from __future__ import annotations

import re
from typing import Any, Optional, Tuple
from urllib.parse import urlsplit

__all__ = ["from_worker_origin", "safe_sign_in_url", "sign_in_url_of"]

#: Any character outside 0x21..0x7E (control, space, DEL, C1, non-ASCII), and the backslash a browser
#: reads as a slash.
_FORBIDDEN = re.compile(r"[^\x21-\x7e]|\\")
_ORIGIN = re.compile(r"https://([a-z0-9.-]+)(?::([0-9]{1,5}))?\Z")
_HTTPS = re.compile(r"https://", re.IGNORECASE)
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:")


def _parse_origin(origin: str) -> Optional[Tuple[str, str]]:
    """``https://host[:port]`` as ``(host, port)``: lower-case host, port ``"443"`` when none."""
    m = _ORIGIN.match(origin.lower())
    if m is None:
        return None
    return m.group(1), str(int(m.group(2) or "443"))


def safe_sign_in_url(url: Optional[str], origin: str) -> Optional[str]:
    """A sign-in URL fit to hand to the app: https on the Worker's ``origin`` (``https://host[:port]``),
    normalised, else ``None``. ``https://`` or ``//`` start an authority that must be exactly the
    Worker's host (and port; 443 is the default); any other ``scheme:``, userinfo, a trailing dot, a
    lookalike host, a backslash, whitespace or a control or non-ASCII character answers ``None``.
    Anything else is a path on the origin. There is no path restriction."""
    if not isinstance(url, str) or url == "" or not isinstance(origin, str):
        return None
    if _FORBIDDEN.search(url) is not None:
        return None
    base = _parse_origin(origin)
    if base is None:
        return None
    host, port = base
    rest: Optional[str] = None
    if _HTTPS.match(url):
        rest = url[8:]
    elif url.startswith("//"):
        rest = url[2:]
    if rest is not None:
        end = next((i for i, c in enumerate(rest) if c in "/?#"), -1)
        authority = (rest if end < 0 else rest[:end]).lower()
        allowed = (host, f"{host}:443") if port == "443" else (f"{host}:{port}",)
        if authority not in allowed:
            return None
        tail = "" if end < 0 else rest[end:]
    elif _SCHEME.match(url):
        return None
    else:
        tail = url
    if not tail.startswith("/"):
        tail = "/" + tail
    return f"https://{host}{'' if port == '443' else ':' + port}{tail}"


def from_worker_origin(res: Any, base_url: str) -> bool:
    """Whether ``res`` came from the Worker itself: not redirected, and on the origin of ``base_url``.
    An ``account_required`` answer is honoured only then; from anywhere else it is an ordinary 403."""
    try:
        if getattr(res, "history", None):
            return False
        base = urlsplit(base_url)
        try:
            u = urlsplit(str(res.url))
        except RuntimeError:
            return True  # a constructed response with no request was never fetched
        return (
            u.scheme == "https"
            and u.scheme == base.scheme
            and u.username is None
            and (u.hostname or "").lower() == (base.hostname or "").lower()
            and (u.port or 443) == (base.port or 443)
        )
    except (ValueError, AttributeError):
        return False


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
