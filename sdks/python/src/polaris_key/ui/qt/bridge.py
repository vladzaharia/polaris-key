"""The Python half of the Qt Quick kit: a ``QObject`` the QML reads (``bridge``) and the view models
feed.

``KitBridge`` holds one :class:`~.layout.ScreenSpec`, the resolved identity and the theme. It owns no
event loop and never touches ``QApplication``: the host does (UI-KITS §5.2). Calls from another
thread marshal onto the bridge's thread (:meth:`KitBridge.post`).
"""

from __future__ import annotations

import base64
from typing import Any, Callable, Dict, Mapping, Optional

from .._tokens import POWERED_BY
from ..core.copy import Copy
from ..core.identity import ProductIdentity, ResolvedIdentity, resolve_identity
from ..core.theme import Theme
from ..core.ui_view import View, bidi_isolate
from . import _binding as qt
from .layout import ScreenSpec, build_spec

__all__ = ["KitBridge", "platform_variant"]


def platform_variant(theme: Theme, os_name: Optional[str] = None) -> str:
    """The Theme.qml platform variant: ``macos``, ``windows`` or ``gnome`` (the Linux look)."""
    chosen = theme.platform
    if chosen in ("macos", "windows", "gnome"):
        return chosen
    if chosen == "linux":
        return "gnome"
    import sys

    name = os_name or sys.platform
    return "macos" if name == "darwin" else "windows" if name.startswith("win") else "gnome"


def _scheme(theme: Theme, system: str = "dark") -> str:
    return theme.color_scheme if theme.color_scheme in ("dark", "light") else system


_Base: Any = qt.QtCore.QObject if qt.BINDING else object


class KitBridge(_Base):  # type: ignore[misc]
    """What ``KitScreen.qml`` binds to. ``set_view`` renders a view model; ``invoked`` fires with the
    catalog key and the model's action name when a control is activated."""

    if qt.BINDING:
        changed = qt.Signal()
        invoked = qt.Signal(str, str)

    def __init__(
        self,
        theme: Optional[Theme] = None,
        *,
        source: Any = None,
        system_scheme: str = "dark",
        font_scale: float = 1.0,
        parent: Any = None,
    ) -> None:
        qt.require()
        super().__init__(parent)
        self._theme = theme or Theme()
        self._source = source
        self._system_scheme = system_scheme
        self._font_scale = font_scale
        self._copy = Copy(self._theme.locale, self._theme.copy_overrides, platform="desktop")
        self._view: Optional[View] = None
        self._spec = ScreenSpec("", "hidden", "neutral", "")
        self._identity = self._resolve()
        self._unsub: Optional[Callable[[], None]] = None
        self._poster = qt.QtCore.QTimer(self)
        self._pending: list = []
        self._poster.setSingleShot(True)
        self._poster.timeout.connect(self._drain)
        sub = getattr(source, "subscribe", None)
        if callable(sub):
            self._unsub = sub(lambda _member: self.post(self.refresh))

    # ── model side ──────────────────────────────────────────────────────────────────────────
    def _resolve(self) -> ResolvedIdentity:
        return resolve_identity(
            integrator=self._theme.product, source=self._source, accent=self._theme.accent
        )

    def set_view(self, view: View) -> None:
        self._view = view
        self.refresh()

    def set_theme(self, theme: Theme) -> None:
        self._theme = theme
        self._copy = Copy(theme.locale, theme.copy_overrides, platform="desktop")
        self.refresh()

    def refresh(self) -> None:
        self._identity = self._resolve()
        if self._view is not None:
            self._spec = build_spec(
                self._view,
                self._copy,
                product=bidi_isolate(self._identity.name) if self._identity.name else "",
                developer=self._identity.developer or "",
                powered_by=self._powered_by(),
            )
        self.changed.emit()

    def post(self, fn: Callable[[], None]) -> None:
        """Run ``fn`` on the bridge's thread (the UI thread): the delivery hook for stage events."""
        self._pending.append(fn)
        qt.QtCore.QMetaObject.invokeMethod(self._poster, "start", qt.QtCore.Qt.ConnectionType.QueuedConnection)

    def _drain(self) -> None:
        todo, self._pending = self._pending, []
        for fn in todo:
            fn()

    def close(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    @property
    def screen_spec(self) -> ScreenSpec:
        return self._spec

    # ── what QML reads ──────────────────────────────────────────────────────────────────────
    def _get_spec(self) -> Dict[str, Any]:
        return self._spec.as_dict()

    def _get_scheme(self) -> str:
        return _scheme(self._theme, self._system_scheme)

    def _get_platform(self) -> str:
        return platform_variant(self._theme)

    def _accent(self, field: str) -> str:
        resolved = self._identity.accent(self._get_scheme())
        return getattr(resolved, field) if resolved is not None else ""

    def _get_icon(self) -> str:
        data = None
        icon = getattr(self._source, "icon", None)
        if callable(icon):
            try:
                data = icon(48, 2.0)
            except Exception:
                data = None
        if not data:
            return ""
        return "data:image/png;base64," + base64.b64encode(bytes(data)).decode("ascii")

    def _powered_by(self) -> str:
        v = self._theme.powered_by
        return "" if not v else ("badge" if v == "badge" else "line")

    def _svg_uri(self, field: str) -> str:
        svg = POWERED_BY[field][self._get_scheme()]
        return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")

    def _get_powered_by_mark(self) -> str:
        return self._svg_uri("mark_svg")

    def _get_powered_by_badge(self) -> str:
        return self._svg_uri("badge_svg")

    def _get_developer_line(self) -> str:
        dev = self._identity.developer
        return self._copy("common.byDeveloper", developer=bidi_isolate(dev)) if dev else ""

    def _get_icon_label(self) -> str:
        return self._copy("a11y.productIcon", product=self._identity.name)

    def _get_animate(self) -> bool:
        return self._theme.motion == "system"

    @qt.Slot(str, str)
    def invoke(self, key: str, action: str) -> None:
        self.invoked.emit(key, action)

    if qt.BINDING:
        spec = qt.Property("QVariant", _get_spec, notify=changed)
        scheme = qt.Property(str, _get_scheme, notify=changed)
        platform = qt.Property(str, _get_platform, notify=changed)
        accent = qt.Property(str, lambda s: s._accent("solid"), notify=changed)
        accentOn = qt.Property(str, lambda s: s._accent("on"), notify=changed)
        accentFg = qt.Property(str, lambda s: s._accent("fg"), notify=changed)
        accentSubtle = qt.Property(str, lambda s: s._accent("subtle"), notify=changed)
        focusRing = qt.Property(str, lambda s: s._accent("focus"), notify=changed)
        iconSource = qt.Property(str, _get_icon, notify=changed)
        iconLabel = qt.Property(str, _get_icon_label, notify=changed)
        poweredByMark = qt.Property(str, _get_powered_by_mark, notify=changed)
        poweredByBadge = qt.Property(str, _get_powered_by_badge, notify=changed)
        developerLine = qt.Property(str, _get_developer_line, notify=changed)
        fontScale = qt.Property(float, lambda s: s._font_scale, notify=changed)
        animate = qt.Property(bool, _get_animate, notify=changed)
