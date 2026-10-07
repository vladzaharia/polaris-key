"""``polaris_key.ui.core``: the framework-free half of every Python UI kit (docs/design/UI-KITS.md
§1.3 layer c, §5.1 "Python ui-core").

* :class:`Copy`: the generated kit copy (``kit_copy_generated``) with the locale fallback, the
  integrator's overrides and the ICU-subset formatter (§4.7).
* :class:`ProductIdentity` and :func:`resolve_identity`: the product as the hero, from the
  integrator, the SDK's presentation source, the bundle, the derived accent, then ink (§1.2).
* :class:`Theme`: the one theme value (§3.1).
* ``models``: SDK results in, a component, a state and its data out; the terminal kit draws them
  (UK-13), and the Qt kit's view models (UK-12) build on the same functions.

No GUI or terminal dependency.
"""

from __future__ import annotations

from . import models
from .copy import LOCALES, Copy, format_message, plural_category, resolve_locale
from .identity import ProductIdentity, ResolvedIdentity, presentation_source, resolve_identity
from .theme import Theme

__all__ = [
    "Copy",
    "LOCALES",
    "ProductIdentity",
    "ResolvedIdentity",
    "Theme",
    "format_message",
    "models",
    "plural_category",
    "presentation_source",
    "resolve_identity",
    "resolve_locale",
]
