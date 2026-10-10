"""``polaris_key.ui.terminal``: the Python terminal kit (docs/design/UI-KITS.md §1.4 Terminal, UK-13).

The ``polaris-key`` CLI draws every verb with it, and a host CLI gets the same look by mounting the
verbs (``polaris_key.cli.register_argparse``, ``polaris_click_group``, ``polaris_typer_app``). Three
layers, as in every kit (§1.3):

* **(a) drop-in flows** (:mod:`.flows`): one call per verb over a client (``flows.activate``,
  ``flows.sign_in``, ``flows.status`` …), interactive on a terminal (masked key entry, the sign-in
  wait, Replace a device in the browser, live progress) and plain or ``--json`` anywhere else;
* **(b) styled parts and screens** (:class:`Kit`, :mod:`.screens`): the product chip, the
  continuous rail, step glyphs, key hints, the seat meter, the progress bar, the user code, the
  half-block QR and OSC 8 links, restyled through :class:`~polaris_key.ui.core.Theme`
  (``colors``, ``symbols``, ``preset="native"``);
* **(c) headless models** (``polaris_key.ui.core.models``): SDK results in, a component and a
  state out.

The exit codes are :data:`EXIT` (:mod:`.exit`): the ``cli`` family's table in the corpus's
``ui-matrix.json``, as the Node kit's ``EXIT``.

Colour is ANSI-16 for status roles, truecolor only for the product accent; ``NO_COLOR``, pipes and
``TERM=dumb`` get plain lines. rich (``pip install polaris-key[cli]``) renders when installed;
without it the kit writes the same bytes itself. The optional Textual app is
``polaris_key.ui.terminal.textual_app`` (``pip install polaris-key[tui]``).
"""

from __future__ import annotations

from . import flows, screens
from .device import Device, rich_available
from .env import TermEnv, detect
from .exit import EXIT
from .flows import JSON_VERSION, Outcome, Terminal
from .parts import Kit
from .text import Line, Palette, Span, to_ansi

__all__ = [
    "Device",
    "EXIT",
    "JSON_VERSION",
    "Kit",
    "Line",
    "Outcome",
    "Palette",
    "Span",
    "TermEnv",
    "Terminal",
    "detect",
    "flows",
    "rich_available",
    "screens",
    "to_ansi",
]
