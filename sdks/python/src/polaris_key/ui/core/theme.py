"""The one theme value every kit takes (docs/design/UI-KITS.md §3.1), cased for Python.

Everything is optional; an empty :class:`Theme` is the Polaris Key look in the product's accent.
Each kit honours the fields that mean something on its surface and documents the rest (the
terminal's page lists them: a cell grid has no radius, type family or ambient).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Mapping, Optional, Union

from .identity import ProductIdentity

__all__ = ["Theme", "PRESETS", "COLOR_SCHEMES", "MOTIONS"]

PRESETS = ("polaris-key", "native")
COLOR_SCHEMES = ("system", "dark", "light")
MOTIONS = ("system", "reduced", "none")


@dataclass(frozen=True)
class Theme:
    """UI-KITS §3.1. ``accent`` is ``"product"``, ``"core"``, ``"service"`` or a ``"#rrggbb"``."""

    preset: str = "polaris-key"
    color_scheme: str = "system"
    accent: str = "product"
    service_cues: bool = False
    #: Per-role overrides, per scheme, as hex colours: ``{"dark": {"success": "#rrggbb"}, "light":
    #: {…}}``, the one value language of every kit. In the terminal the roles are the ANSI roles
    #: (``accent``, ``success``, ``warning``, ``danger``, ``info``, ``muted``, ``strong``, ``link``),
    #: drawn only where the terminal draws truecolor and never under ``preset="native"``.
    colors: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    radius: Union[str, int] = "md"
    typography: Mapping[str, Any] = field(default_factory=dict)
    density: str = "comfortable"
    motion: str = "system"
    ambient: bool = True
    product: Optional[ProductIdentity] = None
    #: Partial copy overrides (``{locale: {key: value}}`` or ``{key: value}``) and/or ``locale``.
    copy: Mapping[str, Any] = field(default_factory=dict)
    powered_by: Union[bool, str] = False
    platform: str = "auto"
    #: Terminal only: ``"auto"`` (Unicode unless ``TERM=dumb``), ``"unicode"`` or ``"ascii"``.
    symbols: str = "auto"

    def __post_init__(self) -> None:
        if self.preset not in PRESETS:
            raise ValueError(f"theme.preset must be one of {PRESETS}, not {self.preset!r}")
        if self.color_scheme not in COLOR_SCHEMES:
            raise ValueError(f"theme.color_scheme must be one of {COLOR_SCHEMES}, not {self.color_scheme!r}")
        if self.motion not in MOTIONS:
            raise ValueError(f"theme.motion must be one of {MOTIONS}, not {self.motion!r}")
        if self.symbols not in ("auto", "unicode", "ascii"):
            raise ValueError(f"theme.symbols must be auto, unicode or ascii, not {self.symbols!r}")

    @property
    def locale(self) -> Optional[str]:
        v = self.copy.get("locale") if isinstance(self.copy, Mapping) else None
        return v if isinstance(v, str) else None

    @property
    def copy_overrides(self) -> Mapping[str, Any]:
        return {k: v for k, v in self.copy.items() if k != "locale"}

    def with_(self, **changes: Any) -> "Theme":
        """A copy with ``changes`` applied."""
        return replace(self, **changes)
