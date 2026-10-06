"""Refusal links (PX-W8, WIRE-CONTRACT-V4 §5.3).

The ``manageUrl`` the Worker puts on the ``device_limit`` (and, with Identity,
``key_entry_limit``) refusal, and the two things a client may add to it. Pure functions: no
I/O, no signing, no change to any error type. The link is never an auth failure, so nothing
here wipes state or asks for a retry; a host opens it only behind a user action ("Free up a
device").

The same table of cases is pinned in every SDK (client-core ``test/manage.test.ts``), so the
links each one builds are byte-identical.
"""

from __future__ import annotations

import re
from typing import Any, Optional, Tuple
from urllib.parse import urlsplit

__all__ = [
    "MANAGE_URL_MAX_LENGTH",
    "is_manage_url",
    "manage_form_encode",
    "read_manage_url",
    "with_manage_key",
    "with_manage_return",
]

#: The longest ``manageUrl`` a client keeps (characters); a longer one is ignored.
MANAGE_URL_MAX_LENGTH = 2048

_LOOPBACK = {"localhost", "127.0.0.1", "[::1]", "::1"}
_SAFE = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._")


def _parse(raw: str) -> Optional[Any]:
    if not raw or len(raw) > MANAGE_URL_MAX_LENGTH:
        return None
    if any(c.isspace() or ord(c) < 0x20 or ord(c) == 0x7F for c in raw):
        return None
    # The shared rule (client-core ``parseManage``): ``<scheme>://`` and no ``@`` or ``\\`` in
    # the authority.
    sep = raw.find("://")
    if sep <= 0:
        return None
    authority = re.split(r"[/?#]", raw[sep + 3 :], maxsplit=1)[0]
    if "@" in authority or "\\" in authority:
        return None
    try:
        parts = urlsplit(raw)
        host = parts.hostname
    except ValueError:
        return None
    if not parts.netloc or host is None:
        return None
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return None
    scheme = parts.scheme.lower()
    if scheme == "https":
        return parts
    if scheme == "http" and host in _LOOPBACK:
        return parts
    return None


def is_manage_url(raw: Any) -> bool:
    """Is ``raw`` a link a client may show: an absolute ``https`` URL (or ``http`` to a
    loopback host), with no userinfo, at most ``MANAGE_URL_MAX_LENGTH`` characters?"""
    return isinstance(raw, str) and _parse(raw) is not None


def read_manage_url(body: Any) -> Optional[str]:
    """The ``manageUrl`` of a refusal body, or ``None``.

    Reads the top-level member (the flat refusal bodies) and, failing that, one nested under
    ``error``. Anything that is not a valid link is dropped, never repaired.
    """
    if not isinstance(body, dict):
        return None
    top = body.get("manageUrl")
    if is_manage_url(top):
        return top
    nested = body.get("error")
    if isinstance(nested, dict):
        inner = nested.get("manageUrl")
        if is_manage_url(inner):
            return inner
    return None


def manage_form_encode(value: str) -> str:
    """The WHATWG ``application/x-www-form-urlencoded`` byte serializer: UTF-8, then
    ``A-Z a-z 0-9 * - . _`` as themselves, space as ``+``, every other byte as ``%XX``."""
    out = []
    for byte in value.encode("utf-8"):
        if byte in _SAFE:
            out.append(chr(byte))
        elif byte == 0x20:
            out.append("+")
        else:
            out.append("%%%02X" % byte)
    return "".join(out)


def _append_param(target: str, name: str, encoded: str) -> str:
    path, sep, query = target.partition("?")
    pairs = [
        p for p in (query.split("&") if sep else []) if p and p != name and not p.startswith(name + "=")
    ]
    pairs.append("%s=%s" % (name, encoded))
    return "%s?%s" % (path, "&".join(pairs))


def _split_fragment(url: str) -> Tuple[str, Optional[str]]:
    base, sep, fragment = url.partition("#")
    return (base, fragment if sep else None)


def with_manage_return(url: str, return_url: str) -> str:
    """Add the app's return URL as ``return=``: inside the fragment's query when the fragment
    holds a portal route (``#/…``), else in the URL's query. An earlier ``return`` is replaced
    and every other byte is kept. ``url`` comes back unchanged when it is not a valid link or
    ``return_url`` is empty."""
    if _parse(url) is None or not return_url:
        return url
    encoded = manage_form_encode(return_url)
    base, fragment = _split_fragment(url)
    if fragment is not None and fragment.startswith("/"):
        return "%s#%s" % (base, _append_param(fragment, "return", encoded))
    with_query = _append_param(base, "return", encoded)
    return with_query if fragment is None else "%s#%s" % (with_query, fragment)


def with_manage_key(url: str, key: str) -> str:
    """Add the licence key as the fragment ``#key=<key>`` on an ``/activate`` link. Any other
    link (the free-device route) or an invalid one comes back unchanged: the key is never put
    anywhere else, and a fragment never reaches a server."""
    parts = _parse(url)
    if parts is None or not key:
        return url
    if parts.path.rstrip("/") != "/activate":
        return url
    base, fragment = _split_fragment(url)
    if fragment is not None and fragment.startswith("/"):
        return url
    return "%s#key=%s" % (base, manage_form_encode(key))
