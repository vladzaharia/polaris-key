"""``client.portal.url(flow, …)`` — links into the customer portal (SDK parity pass §3.5).

The portal is the single-page app at the root of the control plane's host. Its routes are the
SHIPPED ones in ``packages/admin/src/portal/router.ts``:

==============  ==========================================================  ===================
``flow``        URL                                                         when
==============  ==========================================================  ===================
``library``     ``<origin>/#/``                                             the player's products
``account``     ``<origin>/#/account``                                      profile, sign-in methods
``activate``    ``<origin>/#/?activate=<key>&product=<slug>``               finish activating a key
``devices``     ``<origin>/#/p/<slug>/devices``                             the device list
``freeDevice``  ``<origin>/#/p/<slug>/free-device?for=&return=``            "Manage devices" on
                                                                            ``device-limit``
``download``    ``<origin>/#/p/<slug>/download?platform=&return=``          get the app
==============  ==========================================================  ===================

``return_to`` is where a focused flow sends the player back. The portal follows it only when it
matches an origin or app scheme the product declares, so this helper drops it — rather than
fail — when it cannot be one (a script or data scheme, embedded credentials, control
characters, longer than 2048 characters, or not in ``allowed_returns`` when the host passes its
declared targets). When the Worker starts sending a server-built ``manageUrl`` / ``portalUrl``
(PX-W8), that URL wins over the built one.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, Iterable, Optional
from urllib.parse import quote, urlencode, urlsplit

__all__ = ["PortalClient", "PORTAL_FLOWS", "allowed_return"]

PORTAL_FLOWS = ("library", "account", "activate", "devices", "freeDevice", "download")
MAX_RETURN_LENGTH = 2048
_NEVER = {"javascript", "data", "vbscript", "file", "blob", "about", "filesystem"}
_CONTROL = re.compile(r"[\x00- \x7f-\x9f]")


def allowed_return(raw: Optional[str], targets: Optional[Iterable[str]] = None) -> Optional[str]:
    """``raw`` when it can be a portal return target, else ``None``. ``targets`` are the
    product's declared origins (``https://app.example``) and app schemes (``tidewater``)."""
    if not raw:
        return None
    value = raw.strip()
    if not value or len(value) > MAX_RETURN_LENGTH or _CONTROL.search(value):
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if not scheme or scheme in _NEVER or parts.username or parts.password:
        return None
    if targets is not None:
        allowed = list(targets)
        if scheme in ("http", "https"):
            origin = f"{scheme}://{parts.netloc.lower()}"
            if origin not in [t.rstrip("/").lower() for t in allowed if "://" in t]:
                return None
        elif scheme not in [t.lower().rstrip(":") for t in allowed if "://" not in t]:
            return None
    return value


class PortalClient:
    def __init__(self, product: str, origin: Callable[[], str], *, platform: Optional[str] = None) -> None:
        self._product = product
        self._origin = origin
        self._platform = platform

    def url(
        self,
        flow: str,
        *,
        for_: Optional[str] = None,
        return_to: Optional[str] = None,
        key: Optional[str] = None,
        platform: Optional[str] = None,
        license_id: Optional[str] = None,
        allowed_returns: Optional[Iterable[str]] = None,
    ) -> str:
        """The portal URL for ``flow`` (one of :data:`PORTAL_FLOWS`). ``for_`` labels the
        device a ``freeDevice`` flow frees a seat for; ``key`` pre-fills ``activate``;
        ``platform`` picks the ``download`` platform (default: this install's)."""
        if flow not in PORTAL_FLOWS:
            raise ValueError(f"flow must be one of {', '.join(PORTAL_FLOWS)}")
        origin = self._origin().rstrip("/")
        slug = quote(self._product, safe="")
        back = allowed_return(return_to, allowed_returns)
        params: Dict[str, str] = {}
        if flow == "library":
            path = "#/"
        elif flow == "account":
            path = "#/account"
        elif flow == "activate":
            path = "#/"
            params = {"activate": key or "", "product": self._product}
        elif flow == "devices":
            path = f"#/p/{slug}/devices"
        elif flow == "freeDevice":
            path = f"#/p/{slug}/free-device"
            if for_:
                params["for"] = for_
            if license_id:
                params["license"] = license_id
            if back:
                params["return"] = back
        else:
            path = f"#/p/{slug}/download"
            plat = platform or self._platform
            if plat:
                params["platform"] = plat
            if back:
                params["return"] = back
        query = urlencode(params)
        return f"{origin}/{path}{'?' + query if query else ''}"


def origin_of(base_url: str, discovery: Optional[Dict[str, Any]] = None) -> str:
    """The portal's origin: discovery's ``baseUrl`` when loaded, else the client's base URL."""
    raw = discovery.get("baseUrl") if isinstance(discovery, dict) else None
    url = raw if isinstance(raw, str) and raw.startswith("https://") else base_url
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"
