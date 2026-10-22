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
from ..core.ui_loading import LOADING_DELAY_MS
from ..core.ui_view import View, bidi_isolate
from . import _binding as qt
from .layout import ScreenSpec, build_spec
from .rows import RowData, row_data

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
        #: A text entry changed: the field's catalog key and its text.
        edited = qt.Signal(str, str)
        #: A row's button or radio: the catalog key, the action (``rename``, ``remove``, ``reset``,
        #: ``save``, ``cancel``, ``select`` ...) and the row's id (a device's id, a setting's key).
        row_invoked = qt.Signal(str, str, str)

    def __init__(
        self,
        theme: Optional[Theme] = None,
        *,
        source: Any = None,
        system_scheme: str = "dark",
        font_scale: float = 1.0,
        loading_delay_ms: int = LOADING_DELAY_MS,
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
        #: What the list-shaped screens draw as rows: given by the host (an input or a rich model), else
        #: the view's own ``rows``. The chosen row of a radio list and the advanced toggle are UI state.
        self._data: Any = None
        self._selected: Optional[str] = None
        self._advanced = False
        # DL7: a load shows nothing for its first 250 ms, then the identity, a label and the shimmer.
        self._loading_delay = max(0, int(loading_delay_ms))
        self._loading_shown = True
        self._loading_key: Optional[tuple] = None
        self._loading_timer = qt.QtCore.QTimer(self)
        self._loading_timer.setSingleShot(True)
        self._loading_timer.timeout.connect(self._show_loading)
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

    def set_view(self, view: View, data: Any = None) -> None:
        """Render ``view``. ``data`` is the row data of the settings, devices, seat-meter and account
        screens when the view does not carry it: a ui-matrix input, or a ``SettingsView``,
        ``DevicesView``, ``GateView`` or ``ActivateView`` of ``polaris_key.ui.core.models``."""
        if self._view is None or (view.component, view.state) != (self._view.component, self._view.state):
            self._selected = None  # a new screen starts at its own preselection
        self._view = view
        self._data = data
        self.refresh()

    def _rows(self) -> RowData:
        if self._data is not None:
            return row_data(self._data)
        return row_data(self._view.rows) if self._view is not None and self._view.rows else RowData()

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
                data=self._rows(),
                selected_id=self._selected,
                advanced=self._advanced,
            )
            self._arm_loading()
        self.changed.emit()

    def _arm_loading(self) -> None:
        """Start the DL7 delay when a load begins; a re-render of the same load keeps its clock."""
        if not self._spec.loading or self._loading_delay == 0:
            self._loading_timer.stop()
            self._loading_key = None
            self._loading_shown = True
            return
        key = (self._spec.component, self._spec.state)
        if key != self._loading_key:
            self._loading_key = key
            self._loading_shown = False
            self._loading_timer.start(self._loading_delay)

    def _show_loading(self) -> None:
        self._loading_shown = True
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
        self._loading_timer.stop()
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

    def _get_monogram(self) -> str:
        """The product's initial for the monogram tile (UI-KITS 1.2): no icon never means no mark."""
        name = self._identity.name.strip()
        return name[:1].upper() if name else ""

    def _get_loading_shown(self) -> bool:
        return self._loading_shown

    def _get_icon_label(self) -> str:
        return self._copy("a11y.productIcon", product=self._identity.name)

    def _get_animate(self) -> bool:
        return self._theme.motion == "system"

    @qt.Slot(str, str)
    def invoke(self, key: str, action: str) -> None:
        self.invoked.emit(key, action)

    @qt.Slot(str, str)
    def edit(self, key: str, text: str) -> None:
        self.edited.emit(key, text)

    @qt.Slot(str, str, str)
    def invoke_row(self, key: str, action: str, row: str) -> None:
        """A row's own button: its catalog key, the action and which row (a device's id, a setting's key)."""
        self.row_invoked.emit(key, action, row)
        self.invoked.emit(key, action)

    @qt.Slot(str)
    def select(self, row: str) -> None:
        """Choose a row of a radio list (Replace a device): the confirm under it names it."""
        if row == self._selected:
            return
        self._selected = row
        self.refresh()
        self.row_invoked.emit("", "select", row)

    @qt.Slot(bool)
    def set_advanced(self, shown: bool) -> None:
        """Show or hide the advanced settings."""
        if shown != self._advanced:
            self._advanced = shown
            self.refresh()

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
        monogram = qt.Property(str, _get_monogram, notify=changed)
        loadingShown = qt.Property(bool, _get_loading_shown, notify=changed)
        fontScale = qt.Property(float, lambda s: s._font_scale, notify=changed)
        animate = qt.Property(bool, _get_animate, notify=changed)
