"""The Qt Quick kit's host-facing entry points: fonts, the QML view, and ``grab`` for baselines.

The kit never constructs ``QApplication``, never calls ``exec()`` and never sets the application
palette or style (UI-KITS §5.2): the host owns the loop (it runs under qasync too). Functions here
take the host's existing ``QGuiApplication``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, Tuple

from .. import FONTS_DIR, QT_DIR
from ..core.theme import Theme
from ..core.ui_loading import LOADING_DELAY_MS
from ..core.ui_view import View
from . import _binding as qt
from .bridge import KitBridge

__all__ = ["KitView", "QML_DIR", "load_fonts", "render"]

QML_DIR = QT_DIR / "kit"
_fonts_loaded = False


def load_fonts() -> None:
    """Register the bundled Rubik and JetBrains Mono (once per process)."""
    global _fonts_loaded
    qt.require()
    if _fonts_loaded:
        return
    for name in ("Rubik-Variable.ttf", "JetBrainsMono-Variable.ttf"):
        qt.QtGui.QFontDatabase.addApplicationFont(str(FONTS_DIR / name))
    _fonts_loaded = True


class KitView:
    """One kit screen in a ``QQuickView``: ``show()`` it, embed ``container()``, or ``grab()`` it."""

    def __init__(
        self,
        theme: Optional[Theme] = None,
        *,
        source: Any = None,
        size: Tuple[int, int] = (520, 640),
        font_scale: float = 1.0,
        system_scheme: str = "dark",
        loading_delay_ms: int = LOADING_DELAY_MS,
    ) -> None:
        qt.require()
        load_fonts()
        self.bridge = KitBridge(
            theme, source=source, font_scale=font_scale, system_scheme=system_scheme, loading_delay_ms=loading_delay_ms
        )
        self.view = qt.QtQuick.QQuickView()
        self.view.setResizeMode(qt.QtQuick.QQuickView.ResizeMode.SizeRootObjectToView)
        self.view.rootContext().setContextProperty("bridge", self.bridge)
        self.view.setSource(qt.QtCore.QUrl.fromLocalFile(str(QML_DIR / "KitScreen.qml")))
        if self.view.status() != qt.QtQuick.QQuickView.Status.Ready:
            errors = "; ".join(e.toString() for e in self.view.errors())
            raise RuntimeError("the Qt kit failed to load: " + errors)
        self.resize(*size)

    def resize(self, width: int, height: int) -> None:
        self.view.resize(width, height)

    def set_view(self, view: View, data: Any = None) -> None:
        """Show ``view``; ``data`` carries the rows of a settings, devices, seat-meter or account screen
        (see :meth:`KitBridge.set_view`), else the view's own ``rows`` are drawn."""
        self.bridge.set_view(view, data)

    def grab(self) -> Any:
        """Render one frame to a ``QImage`` (offscreen-safe)."""
        self.view.show()
        app = qt.QtGui.QGuiApplication.instance()
        for _ in range(3):
            if app is not None:
                app.processEvents()
        return self.view.grabWindow()

    def close(self) -> None:
        self.view.close()
        self.view.setSource(qt.QtCore.QUrl())  # tear the QML down before the bridge goes
        self.bridge.close()
        self.view.destroy()


def render(view: View, theme: Optional[Theme] = None, **kwargs: Any) -> Any:
    """One-shot: draw ``view`` and return the ``QImage``."""
    kit = KitView(theme, **kwargs)
    try:
        kit.set_view(view)
        return kit.grab()
    finally:
        kit.close()
