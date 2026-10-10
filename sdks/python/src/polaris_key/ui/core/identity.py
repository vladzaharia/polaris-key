"""Product identity: who the kit's screens are about (docs/design/UI-KITS.md §1.2).

Every kit resolves one :class:`ResolvedIdentity` in the same order:

1. the integrator's :class:`ProductIdentity` (the theme's ``product``),
2. the product's registered presentation, read through the SDK's presentation source
   (``client.presentation_source``, a ``polaris_key.presentation.PresentationSource``),
3. the bundle (what the host knows about itself: the product slug, its name),
4. the accent derived from the icon's pixels when no colour is given (§3.3),
5. ink: no accent at all, never Polaris violet.

The kit never fetches discovery or an icon itself: the client parses ``core.presentation`` after
each discovery and verifies and caches the icon (HA-13). With no presentation source it falls
through to the bundle. A test may feed any object with ``current()`` returning
``{"name", "developerName", "accent", "accentDark"}``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

from ..accent import ResolvedAccent, derive_accent, normalize, resolve_accent
from .._tokens import SERVICE_ACCENTS

__all__ = [
    "ProductIdentity",
    "ResolvedIdentity",
    "presentation_source",
    "resolve_identity",
]


@dataclass(frozen=True)
class ProductIdentity:
    """What an integrator (or the bundle) says about the product. Every field is optional."""

    name: Optional[str] = None
    #: Used in inline sentences only when the integrator sets it.
    short_name: Optional[str] = None
    developer: Optional[str] = None
    #: The accent for both schemes, or the light one when ``accent_dark`` is set too.
    accent: Optional[str] = None
    accent_dark: Optional[str] = None
    #: The icon's pixels as flat RGBA bytes, for the derived accent (§3.3). Terminals draw no icon.
    icon_rgba: Optional[Sequence[int]] = None
    #: The device-code page the product advertises (``driftkart.gg/tv``); else ``key.plrs.im/device``.
    device_code_url: Optional[str] = None


@dataclass(frozen=True)
class ResolvedIdentity:
    """The identity a kit draws: a name, an optional developer, and where the accent came from."""

    name: str
    short_name: Optional[str]
    developer: Optional[str]
    #: ``"integrator"``, ``"product"`` (presentation), ``"icon"`` (derived), ``"core"`` or ``"ink"``.
    accent_source: str
    accent_light: Optional[str]
    accent_dark: Optional[str]
    device_code_url: Optional[str]

    def accent(self, scheme: str) -> Optional[ResolvedAccent]:
        """The resolved accent for ``scheme`` (``"dark"`` or ``"light"``), or ``None`` for ink."""
        dark = scheme == "dark"
        raw = (self.accent_dark or self.accent_light) if dark else (self.accent_light or self.accent_dark)
        if raw is None:
            return None
        return resolve_accent(raw, dark)

    @property
    def inline_name(self) -> str:
        """The name for inline sentences: ``short_name`` when the integrator set it."""
        return self.short_name or self.name


class _CallableSource:
    def __init__(self, fn: Any) -> None:
        self._fn = fn

    def current(self) -> Any:
        return self._fn()


def presentation_source(client: Any) -> Optional[Any]:
    """The SDK's presentation source for ``client``: ``client.presentation_source`` (the
    ``PresentationSource`` seam), else a client whose ``presentation()`` returns the member (a thin
    adapter, plans/HA-13.md D1, until UK-12's kit core imports the seam). ``None`` when the client
    has neither, and the kit falls through to the bundle."""
    if client is None:
        return None
    src = getattr(client, "presentation_source", None)
    if src is not None and hasattr(src, "current"):
        return src
    fn = getattr(client, "presentation", None)
    if callable(fn):
        return _CallableSource(fn)
    return None


_CONTROLS = re.compile("[\x00-\x1f\x7f-\x9f]")


def _text(v: Optional[str]) -> Optional[str]:
    """A display string without control characters (a name is drawn, never interpreted)."""
    if not isinstance(v, str):
        return None
    v = _CONTROLS.sub("", v).strip()
    return v or None


def _field(p: Any, *names: str) -> Optional[str]:
    for n in names:
        v = _text(p.get(n) if isinstance(p, Mapping) else getattr(p, n, None))
        if v:
            return v
    return None


def resolve_identity(
    *,
    integrator: Optional[ProductIdentity] = None,
    source: Optional[Any] = None,
    bundle: Optional[ProductIdentity] = None,
    slug: Optional[str] = None,
    accent: Any = "product",
) -> ResolvedIdentity:
    """Resolve the identity (order in the module docstring). ``accent`` is the theme's field:
    ``"product"`` (the default), ``"core"`` (Polaris violet, only when asked), ``"service"``
    (treated as ``"product"`` on screens without service cues) or a colour."""
    me = integrator or ProductIdentity()
    pres: Any = None
    if source is not None:
        try:
            pres = source.current()
        except Exception:  # a broken source never breaks the kit; the bundle still names it
            pres = None
    own = bundle or ProductIdentity()
    name = me.name or (_field(pres, "name") if pres is not None else None) or own.name or slug or ""
    developer = (
        me.developer
        or (_field(pres, "developerName", "developer_name", "developer") if pres is not None else None)
        or own.developer
    )

    light = dark = None
    src = "ink"
    explicit = normalize(accent) if isinstance(accent, str) and accent.startswith("#") else None
    if explicit:
        light = dark = explicit
        src = "integrator"
    elif accent == "core":
        light = SERVICE_ACCENTS["light"]["core"]["solid"]
        dark = SERVICE_ACCENTS["dark"]["core"]["solid"]
        src = "core"
    elif me.accent or me.accent_dark:
        light = normalize(me.accent) if me.accent else None
        dark = normalize(me.accent_dark) if me.accent_dark else None
        src = "integrator"
    elif pres is not None and (_field(pres, "accent") or _field(pres, "accentDark", "accent_dark")):
        a = _field(pres, "accent")
        d = _field(pres, "accentDark", "accent_dark")
        light = normalize(a) if a else None
        dark = normalize(d) if d else None
        src = "product"
    else:
        rgba = me.icon_rgba or own.icon_rgba
        derived = derive_accent(rgba) if rgba else None
        if derived:
            light = dark = derived
            src = "icon"
    return ResolvedIdentity(
        name=_text(name) or "",
        short_name=_text(me.short_name),
        developer=_text(developer),
        accent_source=src if (light or dark) else "ink",
        accent_light=light,
        accent_dark=dark,
        device_code_url=me.device_code_url or own.device_code_url,
    )
