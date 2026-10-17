"""The Qt kit's screen layout as plain data (no Qt import): a :class:`~polaris_key.ui.core.ui_view.View`
in, one :class:`ScreenSpec` out (heading, body lines, buttons with their role, progress).

The QML screen (``kit/KitScreen.qml``) draws exactly this, so the layout is testable headless and a
host can draw the same spec in its own toolkit. Every string is a catalog key resolved through the
kit's :class:`~polaris_key.ui.core.copy.Copy`, with presentation text isolated in FSI...PDI
(HA-12 Q5).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

from ..core.copy import Copy
from ..core.ui_contract import ACTION_KEYS
from ..core.ui_view import View, bidi_isolate

__all__ = ["Button", "ScreenSpec", "build_spec", "button_role", "is_button_key"]

_HEADING = re.compile(r"\.(title|heading)$|^(gate\.error\.title|part\.status\.blocked)$")
_ACTION_KEYS = frozenset(key for keys in ACTION_KEYS.values() for key in keys)
#: The last catalog segment of every key that is a control, not a sentence.
_VERBS = frozenset(
    (
        "tryAgain notNow reconnect download continueOffline dismiss cancel signOut manage save back paste "
        "signIn useKey trial continueFree restore offline submit install later checkNow skipVersion "
        "restartNow restartWhenReady openStore resume remove rename reset update renew contact "
        "switchChannel useAnotherLicense openBrowser undo copyCode loadFile primary allChanges whatsNew "
        "appStore googlePlay steam altstore testflight"
    ).split()
)
#: Quiet text buttons (the mockup's "Start a free trial", "Activate offline").
_QUIET = frozenset(
    ("welcome.trial", "welcome.offline", "welcome.restore", "welcome.continueFree", "common.notNow",
     "common.dismiss", "update.later", "update.skipVersion", "common.cancel", "common.back")
)
#: Keys that read as status chips or meters, not paragraphs.
_NOT_BUTTONS = frozenset(("update.title", "update.current", "update.platform", "update.blockedTitle"))
_PROGRESS = frozenset(("a11y.progress", "boot.fetchingProgress", "updateProgress.downloading"))
_A11Y = re.compile(r"^a11y\.")


def is_button_key(key: str, primary: Optional[str] = None) -> bool:
    if key == primary or key in _ACTION_KEYS:
        return True
    if key in _NOT_BUTTONS or key.startswith("update.platform.") or _HEADING.search(key):
        return False
    return key.rsplit(".", 1)[-1] in _VERBS


def button_role(key: str, primary: Optional[str]) -> str:
    """``primary`` (one filled, DL3), ``quiet`` (text) or ``secondary`` (outlined)."""
    if key == primary:
        return "primary"
    return "quiet" if key in _QUIET else "secondary"


@dataclass(frozen=True)
class Button:
    key: str
    text: str
    role: str
    action: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {"key": self.key, "text": self.text, "role": self.role, "action": self.action or ""}


@dataclass(frozen=True)
class ScreenSpec:
    component: str
    state: str
    tone: str
    title: str
    body: List[str] = field(default_factory=list)
    buttons: List[Button] = field(default_factory=list)
    #: ``None`` hides the bar; ``-1`` is indeterminate; else a 0..1 fraction (never invented).
    progress: Optional[float] = None
    busy: bool = False
    product: str = ""
    developer: str = ""
    focus: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "component": self.component,
            "state": self.state,
            "tone": self.tone,
            "title": self.title,
            "body": list(self.body),
            "buttons": [b.as_dict() for b in self.buttons],
            "progress": -2.0 if self.progress is None else float(self.progress),
            "busy": self.busy,
            "product": self.product,
            "developer": self.developer,
            "focus": self.focus,
            "hidden": self.state == "hidden" or not (self.title or self.body or self.buttons),
        }


def _args(view: View) -> Mapping[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in view.args.items():
        out[key] = bidi_isolate(str(value)) if key in view.isolate and isinstance(value, str) else value
    return out


def _open(text: str) -> bool:
    """A message still holding a ``{placeholder}``: its data is not in the view (a row, a size)."""
    return "{" in text


def build_spec(view: View, copy: Copy, *, product: str = "", developer: str = "") -> ScreenSpec:
    """Lay one view out. Heading, then sentences, then the buttons in catalog order with the
    model's primary first among equals; at most one filled button.

    The identity fills ``{product}``/``{app}``/``{developer}``. A sentence whose data the view does not
    carry (a file size, a row's name) is left out rather than drawn with its braces: rows and meters
    come from the rich models in ``polaris_key.ui.core.models``."""
    args = {**({"product": product, "app": product} if product else {}), **_args(view)}
    if developer:
        args.setdefault("developer", bidi_isolate(developer))
    primary = view.decisions.primary
    title = ""
    body: List[str] = []
    buttons: List[Button] = []
    progress: Optional[float] = None
    busy = False
    for key in view.copy:
        if key == "common.byDeveloper":  # the identity header draws it
            continue
        if key.startswith("a11y."):
            busy = busy or key in ("a11y.busy", "a11y.progress")
            continue
        if key in _PROGRESS and args.get("fraction") is None and not args.get("total"):
            progress = -1.0
        if _HEADING.search(key):
            if not title:
                title = copy(key, **args)
                title = "" if _open(title) else title
            continue
        if is_button_key(key, primary):
            text = copy(key, **args)
            if not _open(text):
                buttons.append(Button(key, text, button_role(key, primary)))
            continue
        text = copy(key, **args)
        if not _open(text):
            body.append(text)
    if progress is None and (
        busy
        or (view.component == "Boot" and view.state in ("progress", "fetching"))
        or (view.component == "UpdateProgress" and view.state in ("queued", "downloading", "installing"))
    ):
        progress = -1.0  # honest: no percentage is invented
    fraction = args.get("fraction")
    if isinstance(fraction, (int, float)) and not isinstance(fraction, bool):
        progress = max(0.0, min(1.0, float(fraction)))
    elif isinstance(args.get("done"), (int, float)) and isinstance(args.get("total"), (int, float)) and args["total"]:
        progress = max(0.0, min(1.0, args["done"] / args["total"]))
    buttons.sort(key=lambda b: {"primary": 0, "secondary": 1, "quiet": 2}[b.role])
    actions = {key: action for action, keys in ACTION_KEYS.items() for key in keys}
    buttons = [Button(b.key, b.text, b.role, actions.get(b.key)) for b in buttons]
    return ScreenSpec(
        component=view.component,
        state=view.state,
        tone=view.decisions.tone or "neutral",
        title=title,
        body=body,
        buttons=buttons,
        progress=progress,
        busy=busy,
        product=product,
        developer=developer,
        focus=view.decisions.focus or "",
    )
