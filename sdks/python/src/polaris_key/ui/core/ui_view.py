"""Renderer-neutral views for the Python UI kits.

A view model answers plain data: the component/state, catalog keys, actions, formatting arguments and
DL4/DL6/DL7/DL9/DL14 decisions.  Qt, a future native Python kit, and test fixtures can consume the
same value without importing one another.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence, Tuple

from ...core.manage import is_manage_url
from .ui_contract import ACTION_KEYS, Context, can_browse, coarse_pointer, platform_class

__all__ = [
    "ROW_INPUT_KEYS",
    "Decisions",
    "IdentityText",
    "LinkVerdict",
    "View",
    "actions_for",
    "bidi_isolate",
    "code_expired",
    "countdown",
    "display_link",
    "format_bytes",
    "hidden_view",
    "identity_text",
    "link_verdict",
    "make_view",
    "qr_allowed",
    "valid_link",
]

_FSI = "\u2068"
_PDI = "\u2069"
_FIELDS = frozenset(("part.keyField.label", "devices.renameLabel", "offlineActivation.paste"))
_OPENERS = frozenset(
    key
    for action in ("open-card", "open-browser", "open-manage-url")
    for key in ACTION_KEYS[action]
)
_ISOLATED_ARGS = frozenset(("product", "app", "developer", "device", "thisDevice", "name", "org", "tier"))
_MISSING = object()
#: The members of a model's input a row-drawing renderer reads (View.rows).
ROW_INPUT_KEYS = ("config", "devices", "licenses", "account", "activation", "edit", "selected", "platform")
_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


@dataclass(frozen=True)
class LinkVerdict:
    """The one validated link policy (DL14) for a state."""

    purpose: str
    url: Optional[str]
    display: Optional[str]
    open: bool
    qr: bool


@dataclass(frozen=True)
class Decisions:
    """The design-language decisions for a rendered state."""

    primary: Optional[str]
    tone: Optional[str]
    error_slot: Optional[str]
    focus: Optional[str]
    link: Optional[LinkVerdict]
    qr: bool


@dataclass(frozen=True)
class View:
    """A serializable view-model result shared by every Python UI renderer."""

    component: str
    state: str
    copy: Tuple[str, ...]
    actions: Tuple[str, ...]
    args: Mapping[str, Any]
    isolate: Tuple[str, ...]
    decisions: Decisions
    #: The data a list-shaped screen draws as rows (settings, devices, the account, the seat count):
    #: the slice of the model's input it read. It does not take part in equality; a renderer that
    #: draws rows reads it, the others ignore it.
    rows: Mapping[str, Any] = field(default_factory=dict, compare=False, repr=False)

    def as_dict(self) -> Dict[str, Any]:
        """A QML/JSON friendly representation without framework objects."""
        result = asdict(self)
        result.pop("rows", None)
        result["copy"] = list(self.copy)
        result["actions"] = list(self.actions)
        result["isolate"] = list(self.isolate)
        return result


@dataclass(frozen=True)
class IdentityText:
    """The text identity a view's catalog messages need (UI-KITS §1.2)."""

    name: str
    inline_name: str
    developer: Optional[str]
    icon: bool


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def identity_text(ctx: Context) -> IdentityText:
    """Resolve display text in the integrator → presentation → bundle order."""
    integrator = _mapping(ctx.input.get("integrator"))
    presentation = _mapping(ctx.input.get("presentation"))
    bundle = _mapping(ctx.input.get("bundle"))
    name = integrator.get("name") or presentation.get("name") or bundle.get("name") or bundle.get("slug") or ""
    if not isinstance(name, str):
        name = ""
    inline = integrator.get("shortName") or name
    if not isinstance(inline, str):
        inline = name
    developer = integrator.get("developer") or presentation.get("developerName")
    if not isinstance(developer, str) or not developer:
        developer = None
    return IdentityText(
        name=name,
        inline_name=inline,
        developer=developer,
        icon=integrator.get("icon") is True or presentation.get("icon") is True,
    )


def bidi_isolate(value: str) -> str:
    """Wrap untrusted presentation text in FSI/PDI (HA-12 Q5)."""
    return _FSI + value + _PDI


def actions_for(copy: Iterable[str], extra: Iterable[str] = ()) -> Tuple[str, ...]:
    """Derive sorted actions from catalog controls and any action with no control key."""
    present = frozenset(copy)
    out = set(extra)
    for action, keys in ACTION_KEYS.items():
        if any(key in present for key in keys):
            out.add(action)
    return tuple(sorted(out))


def _focus_for(ctx: Context, target: Optional[str]) -> Optional[str]:
    if target is None:
        return None
    if target in _FIELDS and coarse_pointer(ctx.platform):
        return "heading"
    if platform_class(ctx.platform) in ("tv", "console") and target in _OPENERS:
        return "heading"
    return target


def make_view(
    ctx: Context,
    component: str,
    state: str,
    copy: Sequence[Optional[str]],
    *,
    extra_actions: Sequence[str] = (),
    args: Optional[Mapping[str, Any]] = None,
    primary: Optional[str] = None,
    tone: Optional[str] = None,
    error_slot: Optional[str] = None,
    focus: Any = _MISSING,
    link: Optional[LinkVerdict] = None,
    qr: Optional[bool] = None,
) -> View:
    """Build one normalized view from its state specification.

    Catalog keys are de-duplicated/sorted, actions always follow visible controls, and focus uses
    the coarse-pointer/TV rules.  ``focus`` omitted means primary, then heading; passing ``None``
    intentionally suppresses focus for banners, toasts, progress and the licensed app.
    """
    keys = tuple(sorted({key for key in copy if isinstance(key, str)}))
    values: Dict[str, Any] = {}
    for key, value in (args or {}).items():
        if value is not None:
            values[key] = value
    desired = (primary or "heading") if focus is _MISSING else focus
    resolved_qr = link.qr if qr is None and link is not None else bool(qr)
    return View(
        component=component,
        state=state,
        copy=keys,
        actions=actions_for(keys, extra_actions),
        args=values,
        isolate=tuple(sorted(key for key in values if key in _ISOLATED_ARGS)),
        decisions=Decisions(
            primary=primary,
            tone=tone,
            error_slot=error_slot,
            focus=_focus_for(ctx, desired),
            link=link,
            qr=resolved_qr,
        ),
        rows={key: ctx.input[key] for key in ROW_INPUT_KEYS if key in ctx.input},
    )


def hidden_view(ctx: Context, component: str) -> View:
    """The empty state of a component whose service is disabled."""
    return make_view(ctx, component, "hidden", (), focus=None)


def valid_link(raw: Any) -> Optional[str]:
    """Return a DL14-safe absolute URL, accepting an integrator's scheme-less https address."""
    if not isinstance(raw, str) or not raw:
        return None
    candidate = raw if _SCHEME.match(raw) else "https://" + raw
    return candidate if is_manage_url(candidate) else None


def display_link(url: str) -> str:
    """The visible URL (without its scheme or one trailing slash)."""
    return re.sub(r"/$", "", re.sub(r"^https?://", "", url, flags=re.IGNORECASE))


def qr_allowed(platform: Optional[Mapping[str, Any]], purpose: str) -> bool:
    """Whether this link may have a QR code under DL14."""
    if purpose == "offline-request":
        return True
    if purpose == "purchase":
        return False
    return platform_class(platform) in ("tv", "console")


def link_verdict(raw: Any, platform: Optional[Mapping[str, Any]], purpose: str) -> LinkVerdict:
    """Validate a supplied link once, then describe whether it can be opened or encoded."""
    url = valid_link(raw)
    return LinkVerdict(
        purpose=purpose,
        url=url,
        display=display_link(url) if url is not None else None,
        open=url is not None and can_browse(platform),
        qr=url is not None and qr_allowed(platform, purpose),
    )


def code_expired(seconds_left: Any) -> bool:
    """A device-code view expires locally at zero even while a poll is outstanding."""
    return isinstance(seconds_left, (int, float)) and not isinstance(seconds_left, bool) and seconds_left <= 0


def countdown(seconds: Any) -> str:
    """A code countdown in m:ss, rounded up as the shared contract requires."""
    try:
        value = math.ceil(float(seconds))
    except (TypeError, ValueError):
        value = 0
    value = max(0, value)
    return "%d:%02d" % (value // 60, value % 60)


def format_bytes(n: Any) -> str:
    """A byte count as the person reads it: ``820 KB``, ``4.2 MB``, ``61 MB`` (decimal units)."""
    try:
        value = float(n)
    except (TypeError, ValueError):
        return ""
    if value < 0:
        return ""
    units = ("KB", "MB", "GB", "TB")
    if value < 1000:
        return "%d B" % int(value)
    unit = units[0]
    value /= 1000.0
    for unit in units:
        if value < 1000 or unit == units[-1]:
            break
        value /= 1000.0
    text = ("%.1f" % value) if value < 10 else ("%d" % round(value))
    return (text[:-2] if text.endswith(".0") else text) + " " + unit
