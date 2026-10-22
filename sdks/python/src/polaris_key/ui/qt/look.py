"""How the Qt kit reads a :class:`~polaris_key.ui.core.theme.Theme` (docs/design/UI-KITS.md §3.1, §3.4).

The pure half of the theme: a :class:`Theme` plus what the host says (the OS appearance, its
palette and font) in, a :class:`Look` out, with no Qt import. ``KitBridge`` reads the host from Qt
(:func:`polaris_key.ui.qt.bridge.read_host`) and hands the look to ``Theme.qml``, so every option is
testable without a window.

Per option, in this kit:

``preset``
    ``polaris-key`` is the kit's look. ``native`` keeps the structure, copy and spacing and takes the
    host's: the application's palette for the grounds, text and borders, its highlight colour as the
    accent (through the contrast resolver, as a product accent is), its default font, and no
    ambient. The kit still never sets the application palette or style.
``colors``
    Per-role overrides, per scheme, as ``#rrggbb``: ``surfacePage``, ``textStrong``, ``danger``, …
    (the names of the kit's palette, camelCase or snake_case). A status role (``danger``,
    ``warning``, ``success``) also takes its border, subtle fill and, for danger, the solid button.
    A role this kit does not have is ignored: the same value drives the terminal's roles.
``radius``
    ``sm``, ``md``, ``lg`` scale the platform's control radius by 0.5, 1 and 1.5 and its surface
    radius by 0.67, 1 and 1.33; a number is the control radius in px (surfaces 6 px more). A
    capsule control (macOS) stays a capsule for the named sizes.
``typography``
    ``family``: ``"system"`` (the platform's face), ``"inherit"`` (the application's default font)
    or a family name; ``display`` the title's face; ``monoFamily`` (or ``mono_family``) the code's;
    ``scale`` multiplies the font scale.
``density``
    ``compact``, ``comfortable``, ``spacious``: control height, card padding and spacing, never the
    component.
``ambient``
    The product ambient behind the card: the accent's tint, as two soft glows. Off under
    ``native``, and absent while the product has no accent (ink has no tint).
``service_cues``
    The small tinted service glyph tiles on the settings and updates group headers; implied by
    ``accent="service"``, which also draws a section's primary in that section's accent.
``symbols``
    Terminal only (unicode or ascii glyphs on a cell grid). A Qt Quick screen draws its glyphs as
    paths, so the option has no meaning here and is ignored.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Tuple

from .._tokens import SERVICE_ACCENTS, THEMES
from ..accent import contrast, normalize
from ..core.theme import Theme

__all__ = [
    "AMBIENT_GLOWS",
    "Host",
    "Look",
    "PALETTE_ROLES",
    "SERVICE_FOR",
    "color_overrides",
    "host_palette_colors",
    "resolve_look",
    "service_for",
]


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


#: The kit's palette roles, as ``Theme.qml`` names them.
PALETTE_ROLES: Tuple[str, ...] = tuple(_camel(key) for key in THEMES["dark"])
_ROLE_BY_FOLD = {role.lower(): role for role in PALETTE_ROLES}

#: A status colour also moves the parts drawn from it: its border, its subtle fill and, for danger,
#: the solid behind the destructive button. ``(role, kind)``; the value is mixed from the role.
_STATUS_PARTS = {
    "danger": (("dangerBorder", "same"), ("dangerSubtle", "subtle"), ("dangerSolid", "same"), ("dangerSolidOn", "on")),
    "warning": (("warningBorder", "same"), ("warningSubtle", "subtle"), ("warningOn", "on")),
    "success": (("successBorder", "same"), ("successSubtle", "subtle"), ("successOn", "on")),
}

#: The section a screen belongs to, for ``accent="service"`` and the service cues.
SERVICE_FOR: Mapping[str, str] = {
    "PolarisKeyGate": "license",
    "Boot": "license",
    "Welcome": "license",
    "Activate": "license",
    "OfflineActivation": "license",
    "DeviceLimit": "license",
    "Devices": "license",
    "StatusScreen": "license",
    "GraceBanner": "license",
    "AccountAndLicense": "license",
    "SignIn": "identity",
    "SignInHandoff": "identity",
    "LicenseChoice": "identity",
    "Settings": "config",
    "UpdatePrompt": "update",
    "UpdateProgress": "update",
    "ReleaseNotes": "update",
}

#: The ambient (UI-KITS §1.2, as the web draws it): two soft ellipses of the accent's subtle tint,
#: ``(centre x, centre y, radius x, radius y)`` as fractions of the window, fading out at 70 %.
AMBIENT_GLOWS: Tuple[Tuple[float, float, float, float], ...] = ((0.5, 0.3, 0.6, 0.55), (0.72, 0.7, 0.4, 0.4))


def service_for(component: str) -> Optional[str]:
    return SERVICE_FOR.get(component)


@dataclass(frozen=True)
class Host:
    """What the host application says, read from Qt by the bridge (or given by a test)."""

    #: ``"dark"`` or ``"light"`` from the OS (``QStyleHints.colorScheme``), ``None`` when it says nothing.
    os_scheme: Optional[str] = None
    #: The host palette's roles as ``#rrggbb``: ``window``, ``base``, ``alternate_base``, ``text``,
    #: ``placeholder``, ``highlight``. Empty when unknown.
    palette: Mapping[str, str] = field(default_factory=dict)
    #: ``QGuiApplication.font()`` and the platform's own face (``QFontDatabase.systemFont``).
    app_font: str = ""
    system_font: str = ""


@dataclass(frozen=True)
class Look:
    """The theme as the QML reads it."""

    scheme: str
    native: bool
    #: ``Theme.colorOverrides`` for ``scheme``.
    colors: Mapping[str, str]
    density: str
    radius_scale: float
    surface_scale: float
    radius_px: float
    #: Families for ``Theme.fontFamily``, ``monoFamily`` and ``displayFamily``; ``""`` keeps the kit's.
    font_family: str
    mono_family: str
    display_family: str
    #: Multiplies the view's font scale.
    text_scale: float
    ambient: bool
    service_cues: bool
    #: ``accent="service"``: a section's primary is in its own accent.
    service_accent: bool
    #: The host's highlight colour (native, when the theme names no accent).
    host_accent: Optional[str]


_RADIUS = {"sm": (0.5, 0.67), "md": (1.0, 1.0), "lg": (1.5, 1.33)}


def _hex(value: Any) -> Optional[str]:
    return normalize(value) if isinstance(value, str) else None


def _mix(fg: str, alpha: float, bg: str) -> str:
    f = [int(fg[i : i + 2], 16) for i in (1, 3, 5)]
    b = [int(bg[i : i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join("%02x" % round(f[i] * alpha + b[i] * (1 - alpha)) for i in range(3))


def _on(color: str) -> str:
    """The label for a solid ``color``: white or ink, whichever reads better."""
    white, ink = THEMES["dark"]["text_strong"], THEMES["dark"]["surface_page"]
    return white if contrast(color, white) >= contrast(color, ink) else ink


def color_overrides(theme: Theme, scheme: str) -> Dict[str, str]:
    """``theme.colors[scheme]`` as ``{palette role: "#rrggbb"}``, status parts included."""
    given = theme.colors.get(scheme) if isinstance(theme.colors, Mapping) else None
    if not isinstance(given, Mapping):
        return {}
    page = _hex(given.get("surfacePage") or given.get("surface_page")) or THEMES[scheme]["surface_page"]
    out: Dict[str, str] = {}
    for name, value in given.items():
        color = _hex(value)
        role = _ROLE_BY_FOLD.get(str(name).replace("_", "").lower())
        if color is None or role is None:
            continue
        out[role] = color
        for part, kind in _STATUS_PARTS.get(role, ()):
            out.setdefault(
                part, color if kind == "same" else _mix(color, 0.12 if scheme == "dark" else 0.1, page) if kind == "subtle" else _on(color)
            )
    # An explicit part wins over the one derived from its status colour.
    for name, value in given.items():
        color = _hex(value)
        role = _ROLE_BY_FOLD.get(str(name).replace("_", "").lower())
        if color is not None and role is not None:
            out[role] = color
    return out


def host_palette_colors(palette: Mapping[str, str], scheme: str) -> Dict[str, str]:
    """The kit's grounds, text and borders from the host's palette (the ``native`` preset)."""
    window, base, text = _hex(palette.get("window")), _hex(palette.get("base")), _hex(palette.get("text"))
    if not (window and text):
        return {}
    base = base or window
    sunken = _hex(palette.get("alternate_base"))
    if sunken is None or sunken == window:
        sunken = _mix(text, 0.06, window)
    muted = _mix(text, 0.72, window)
    subtle = _hex(palette.get("placeholder")) or _mix(text, 0.55, window)
    return {
        "surfacePage": window,
        "surfaceRaised": base,
        "surfaceOverlay": base,
        "surfaceSunken": sunken,
        "textStrong": text,
        "textDefault": text,
        "textMuted": muted,
        "textSubtle": subtle,
        "borderSubtle": _mix(text, 0.16, window),
        "borderStrong": _mix(text, 0.45, window),
        "action": text,
        "actionOn": window,
    }


def _lightness(color: str) -> float:
    return (0.2126 * int(color[1:3], 16) + 0.7152 * int(color[3:5], 16) + 0.0722 * int(color[5:7], 16)) / 255


def _typography(theme: Theme, native: bool, host: Host) -> Tuple[str, str, str, float]:
    t = theme.typography if isinstance(theme.typography, Mapping) else {}
    family = t.get("family")
    if native and not family:
        family = "inherit"
    face = ""
    if family == "system":
        face = host.system_font
    elif family == "inherit":
        face = host.app_font
    elif isinstance(family, str) and family:
        face = family
    display = t.get("display")
    mono = t.get("monoFamily", t.get("mono_family"))
    scale = t.get("scale", 1.0)
    scale = float(scale) if isinstance(scale, (int, float)) and not isinstance(scale, bool) and scale > 0 else 1.0
    return face, display if isinstance(display, str) else "", mono if isinstance(mono, str) else "", scale


def resolve_look(theme: Theme, host: Optional[Host] = None, system_scheme: str = "dark") -> Look:
    """The look of ``theme`` on ``host``. ``system_scheme`` is what ``color_scheme="system"`` means
    when the OS says nothing (Qt before 6.5, or a platform plugin with no appearance)."""
    host = host or Host()
    native = theme.preset == "native"
    palette = host.palette if native else {}
    if theme.color_scheme in ("dark", "light"):
        scheme = theme.color_scheme
    elif native and _hex(palette.get("window")):
        scheme = "dark" if _lightness(_hex(palette["window"]) or THEMES["light"]["surface_raised"]) < 0.5 else "light"
    else:
        scheme = host.os_scheme or (system_scheme if system_scheme in ("dark", "light") else "dark")
    colors: Dict[str, str] = {}
    if native:
        colors.update(host_palette_colors(palette, scheme))
    colors.update(color_overrides(theme, scheme))
    radius = theme.radius
    if isinstance(radius, bool):
        radius = "md"
    if isinstance(radius, (int, float)):
        radius_scale, surface_scale, radius_px = 1.0, 1.0, float(max(0, radius))
    else:
        radius_scale, surface_scale = _RADIUS.get(str(radius), _RADIUS["md"])
        radius_px = -1.0
    face, display, mono, scale = _typography(theme, native, host)
    service_accent = theme.accent == "service"
    return Look(
        scheme=scheme,
        native=native,
        colors=colors,
        density=theme.density if theme.density in ("compact", "comfortable", "spacious") else "comfortable",
        radius_scale=radius_scale,
        surface_scale=surface_scale,
        radius_px=radius_px,
        font_family=face,
        mono_family=mono,
        display_family=display,
        text_scale=scale,
        ambient=bool(theme.ambient) and not native,
        service_cues=bool(theme.service_cues) or service_accent,
        service_accent=service_accent,
        host_accent=_hex(palette.get("highlight")) if native else None,
    )


def section_accent(component: str, scheme: str) -> Optional[Mapping[str, str]]:
    """The ``solid``, ``on``, ``fg`` and ``subtle`` of the section ``component`` belongs to."""
    service = SERVICE_FOR.get(component)
    return SERVICE_ACCENTS[scheme].get(service) if service else None
