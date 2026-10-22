"""The product page link (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md), pinned by
``conformance/corpus/v2/portal-matrix.json``.

Discovery's ``core.portal`` is UNSIGNED display data: whether the product's customer portal is on
and, while it is, the product page ``<customer origin>/activate?product=<slug>``. A port of
``@polaris-key/client-core/portal``:

    parse_portal    the member as a whole (``parseCases``): ``None`` for unknown,
                    ``{"enabled": False}``, or ``{"enabled": True, "activate": <link> | None}``
    portal_link     the one link a terminal kit draws (``linkCases``): the response's own link,
                    then discovery's member, then the legacy guess against a Worker that sends
                    none. ``None`` means no link: the kit draws "Contact {developer}"
    PortalStore     the client's holder: the member from this session's discovery, else the last
                    one persisted as ``portal.json`` (when the client has a cache directory)

A link that fails §5.3 rule 4 is no link, never repaired and never replaced by a guess once the
Worker has answered. A client never adds ``#key=`` to it.
"""

from __future__ import annotations

import copy
import json
import os
import secrets
import threading
from typing import Any, Dict, Optional

from ..constants_generated import CUSTOMER_ORIGIN_DEFAULT
from .manage import is_manage_url
from .models import ISSUER

__all__ = ["PORTAL_MEMBER_FILE", "PortalStore", "parse_portal", "portal_link"]

#: The persisted member's file name, directly in the product's cache directory.
PORTAL_MEMBER_FILE = "portal.json"
_FILE_VERSION = 1

#: RFC 3986 unreserved characters stay; every other UTF-8 byte is ``%XX``.
_UNRESERVED = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")


def parse_portal(core: Any) -> Optional[Dict[str, Any]]:
    """``core.portal`` of a discovery document's ``core`` block, or ``None`` when it says nothing
    usable (an older Worker, or a malformed member): "unknown", which is not "off"."""
    if not isinstance(core, dict):
        return None
    p = core.get("portal")
    if not isinstance(p, dict):
        return None
    enabled = p.get("enabled")
    if not isinstance(enabled, bool):
        return None
    if not enabled:
        return {"enabled": False}
    activate = p.get("activate")
    return {"enabled": True, "activate": activate if is_manage_url(activate) else None}


def _encode_slug(value: str) -> str:
    return "".join(chr(b) if b in _UNRESERVED else "%%%02X" % b for b in value.encode("utf-8"))


def portal_link(
    served: Optional[str],
    portal: Optional[Dict[str, Any]],
    base_url: str,
    product: str,
) -> Optional[str]:
    """The product page link, or ``None`` (no link: the kit draws "Contact {developer}"). First
    match: a valid ``served`` link; the discovered member (off, or no usable link, is ``None``,
    never the guess); the legacy ``<origin>/activate?product=<slug>`` where the Worker said
    nothing."""
    if is_manage_url(served):
        return served
    if portal is not None:
        return portal.get("activate") if portal.get("enabled") else None
    if not product:
        return None
    base = base_url.rstrip("/")
    origin = CUSTOMER_ORIGIN_DEFAULT if base == "https://" + ISSUER else base
    link = f"{origin}/activate?product={_encode_slug(product)}"
    return link if is_manage_url(link) else None


def _wire(m: Dict[str, Any]) -> Dict[str, Any]:
    """The member as the wire spells it, so a stored value can be parsed again."""
    if m["enabled"] and m.get("activate") is not None:
        return {"enabled": True, "activate": m["activate"]}
    return {"enabled": bool(m["enabled"])}


class PortalStore:
    """The client's holder of ``core.portal``. ``cache_dir`` is the product's cache directory
    (``portal.json`` lives directly in it), or ``None`` to keep the member in memory only."""

    def __init__(self, product: str, base_url: str, cache_dir: Optional[str]) -> None:
        self.product = product
        self.base_url = base_url
        self.cache_dir = cache_dir
        self._current: Optional[Dict[str, Any]] = None
        self._discovered = False
        self._lock = threading.Lock()

    @property
    def _path(self) -> Optional[str]:
        return os.path.join(self.cache_dir, PORTAL_MEMBER_FILE) if self.cache_dir else None

    def current(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._current)

    def load_cached(self) -> None:
        """Cold start: the member ``portal.json`` holds, unless this session already discovered
        one. A file that does not parse, names another product or base, or does not read back as
        the parser normalises it is deleted."""
        with self._lock:
            if self._discovered:
                return
        m = self._read()
        if m is not None:
            with self._lock:
                if not self._discovered:
                    self._current = m

    def accept(self, manifest: Any) -> None:
        """A successful discovery's document: parse, store and persist. No member (or an invalid
        one) clears it."""
        m = parse_portal(manifest.get("core")) if isinstance(manifest, dict) else None
        with self._lock:
            self._discovered = True
            self._current = copy.deepcopy(m)
        self._write(m)

    def _write(self, m: Optional[Dict[str, Any]]) -> None:
        path = self._path
        if path is None:
            return
        if m is None:
            _remove(path)
            return
        body = json.dumps(
            {"v": _FILE_VERSION, "product": self.product, "baseUrl": self.base_url, "portal": _wire(m)},
            ensure_ascii=True,
            separators=(",", ":"),
        )
        tmp = f"{path}.tmp-{secrets.token_hex(6)}"
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(body.encode("utf-8"))
            os.replace(tmp, path)
        except OSError:
            _remove(tmp)

    def _read(self) -> Optional[Dict[str, Any]]:
        path = self._path
        if path is None or not os.path.isfile(path):
            return None
        m: Optional[Dict[str, Any]] = None
        try:
            with open(path, "rb") as f:
                value = json.loads(f.read().decode("utf-8"))
        except (OSError, ValueError):
            value = None
        if (
            isinstance(value, dict)
            and value.get("v") == _FILE_VERSION
            and value.get("product") == self.product
            and value.get("baseUrl") == self.base_url
        ):
            m = parse_portal({"portal": value.get("portal")})
            if m is not None and _wire(m) != value.get("portal"):
                m = None
        if m is None:
            _remove(path)
        return m


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
