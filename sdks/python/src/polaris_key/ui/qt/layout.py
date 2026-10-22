"""The Qt kit's screen layout as plain data (no Qt import): a :class:`~polaris_key.ui.core.ui_view.View`
in, one :class:`ScreenSpec` out (heading, body lines, buttons with their role, progress).

The QML screen (``kit/KitScreen.qml``) draws exactly this, so the layout is testable headless and a
host can draw the same spec in its own toolkit. Every string is a catalog key resolved through the
kit's :class:`~polaris_key.ui.core.copy.Copy`, with presentation text isolated in FSI...PDI
(HA-12 Q5).
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

from ... import qr as _qr
from ..core.copy import Copy
from ..core.ui_contract import ACTION_KEYS
from ..core.ui_loading import DELAYED_LOADING_STATES
from ..core.ui_view import View, bidi_isolate, format_bytes
from .rows import Group, RowData, Seat, build_rows

__all__ = ["Button", "Code", "Field", "ScreenSpec", "Step", "build_spec", "button_role", "is_button_key"]

_HEADING = re.compile(r"\.(title|heading|codeTitle|addTitle)$|^(gate\.error\.title|part\.status\.blocked)$")
_ACTION_KEYS = frozenset(key for keys in ACTION_KEYS.values() for key in keys)
#: The last catalog segment of every key that is a control, not a sentence.
_VERBS = frozenset(
    (
        "tryAgain notNow reconnect download continueOffline dismiss cancel signOut manage save back paste "
        "signIn useKey trial continueFree restore offline submit install later checkNow skipVersion "
        "restartNow restartWhenReady openStore resume remove rename reset update renew contact "
        "switchChannel useAnotherLicense openBrowser undo copyCode loadFile primary allChanges whatsNew "
        "appStore googlePlay steam altstore testflight differentKey continue start keyInstead useCode openSystem again newCode"
    ).split()
)
#: Quiet text buttons (the mockup's "Start a free trial", "Activate offline").
_QUIET = frozenset(
    ("welcome.trial", "welcome.offline", "welcome.restore", "welcome.continueFree", "common.notNow",
     "common.dismiss", "update.later", "update.skipVersion", "common.cancel", "common.back",
     "update.allChanges", "update.whatsNew", "signin.choice.keyInstead", "signin.handoff.useCode")

)
#: Keys the Qt kit never draws: the provider logo row and the passkey and email rows need a
#: provider list and the platform's own sheets, the menu item is not a screen control, and the
#: larger QR is for a console's couch. The kit's sign-in is the browser and the device code. (The
#: generic "Continue with {provider}" is drawn off the desktop, where it is the browser button; on
#: the desktop it repeats "Continue in browser", which is drawn instead.)
_NOT_DRAWN = frozenset(
    (
        "signin.provider.group signin.menu.signIn signin.passkey signin.email.continue part.qr.enlarge"
    ).split()
)
#: Screens whose one filled action is not always a catalog key of their copy (the model's primary is
#: the control the message sits on): it is drawn when the copy leaves it out.
_PRIMARY_ALWAYS = frozenset(("Activate", "SignIn", "Welcome"))
#: The code view's own parts: its label, its copy button and its QR are drawn as one block.
_CODE_PARTS = frozenset(("part.code.label", "a11y.copyCode", "a11y.copyAddress", "a11y.qr"))
#: Keys that read as status chips or meters, not paragraphs.
_NOT_BUTTONS = frozenset(("update.title", "update.current", "update.platform", "update.blockedTitle"))
_PROGRESS = frozenset(("a11y.progress", "boot.fetchingProgress", "updateProgress.downloading"))
_A11Y = re.compile(r"^a11y\.")
#: An entry the person types into (DL7): its label key, and the catalog keys that sit under it as
#: its placeholder, its hint (the key's product) and its message (the input being wrong).
_FIELDS = {
    "part.keyField.label": {
        "placeholder": "part.keyField.placeholder",
        "hint": ("part.keyField.forProduct",),
        "error": ("part.keyField.cutShort", "part.keyField.malformed", "part.keyField.empty"),
    },
    "devices.renameLabel": {"placeholder": None, "hint": (), "error": ()},
    "offlineActivation.paste": {"placeholder": None, "hint": (), "error": ()},
}
_FIELD_PARTS = frozenset(
    key
    for label, parts in _FIELDS.items()
    for key in (label, parts["placeholder"], *parts["hint"], *parts["error"])
    if key
)
#: Fragments of a row (a setting's source, an account line's label, a device's meta). Their data
#: lives in the view's ``rows`` (or the rich models), drawn by ``rows.py``; a state with no row data
#: would show the label alone with no value after it, so they are left out rather than drawn as
#: sentences.
_ROW_FRAGMENTS = frozenset(
    (
        "settings.off settings.on settings.range settings.source.default settings.source.env "
        "settings.source.local settings.reset settings.fromDeveloper account.autoUpdate account.channel "
        "account.cloudSync account.devices account.managedSettings account.tier account.holder "
        "account.version account.updates devices.meta devices.remove devices.rename "
        "part.thisDeviceTitle signin.replace.meta signin.replace.leastRecent part.seatMeter.caption "
        "settings.search settings.advanced signin.choice.devices"
    ).split()
)
#: Components whose lone action is not the screen's primary (a dismissal, a banner's own control).
_NOT_FILLED = frozenset(("Toast", "GraceBanner"))
#: When a heading needs data the view lacks (no product name), this neutral one stands in.
_FALLBACK_TITLE = "core.fallback.title"


#: Controls that leave the app: the same keys the web kits' OPENS holds.
_LEAVES = frozenset(
    {key for action in ("open-card", "open-browser", "open-manage-url") for key in ACTION_KEYS[action]}
    | {
        "status.renew", "status.update", "update.appStore", "update.googlePlay", "update.steam",
        "update.openStore", "paywall.portal", "signin.none.get", "common.manage", "about.licenses",
        "deviceLimit.title",
    }
)


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
    #: A busy control keeps its label and focus and adds the indicator (DL4).
    busy: bool = False
    #: The control leaves the app (UI-KITS §1.5 rule 11): drawn with the new-window glyph.
    external: bool = False

    def as_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "text": self.text,
            "role": self.role,
            "action": self.action or "",
            "busy": self.busy,
            "external": self.external,
        }


@dataclass(frozen=True)
class Field:
    """A text entry with its messages under it (DL7): ``error`` marks the input itself as wrong."""

    key: str
    label: str
    placeholder: str = ""
    hint: str = ""
    error: str = ""
    #: What the field holds when the screen is drawn (a typed or pasted key), and the label of the
    #: Paste control that sits at the end of the field (``""``: none).
    value: str = ""
    paste: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "placeholder": self.placeholder,
            "hint": self.hint,
            "error": self.error,
            "value": self.value,
            "paste": self.paste,
        }


@dataclass(frozen=True)
class Code:
    """The device-code view's block (UI-KITS §4.3): the code in mono with Copy, the countdown, and a
    QR only where DL14 allows one. ``fraction`` is what is left of the code's life, ``-1`` when the
    screen does not know it."""

    label: str
    value: str
    copy_label: str = ""
    copied: str = ""
    expires: str = ""
    fraction: float = -1.0
    #: The QR as an SVG data URI, and its accessible name, when the link may be scanned (TV, console).
    qr: str = ""
    qr_label: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "value": self.value,
            "copyLabel": self.copy_label,
            "copied": self.copied,
            "expires": self.expires,
            "fraction": self.fraction,
            "qr": self.qr,
            "qrLabel": self.qr_label,
        }


#: The two numbered steps of OfflineActivation: step 1 sends the request (the code, Copy and a QR),
#: step 2 loads the response. The sentence is the step; the kit draws the number.
_STEP_KEYS = {"offlineActivation.request": 1, "offlineActivation.loadHint": 2}


@dataclass(frozen=True)
class Step:
    """One numbered step: its number, its sentence and, on step 1, the request QR (an SVG data URI,
    black on white with its quiet zone) with its accessible name."""

    number: int
    text: str
    qr: str = ""
    qr_label: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {"number": self.number, "text": self.text, "qr": self.qr, "qrLabel": self.qr_label}


def _qr_uri(payload: str) -> str:
    svg = _qr.svg(payload, module=8, quiet_zone=2)
    return "" if svg is None else "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")


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
    #: The identity header (UI-KITS 1.2, DL5): the name beside the icon unless the title names the
    #: product already; the developer line on Welcome only; ``hero`` sizes the icon up on Welcome.
    show_name: bool = True
    developer_line: str = ""
    hero: bool = False
    #: DL7: the screen is a load. It shows nothing for the first 250 ms, then the identity, a muted
    #: label and the 2 px shimmer.
    loading: bool = False
    #: The title is in danger only when the screen itself failed; a wrong input marks its field.
    title_tone: str = ""
    fields: List[Field] = field(default_factory=list)
    focus: str = ""
    #: The attribution (UI-KITS §1.6): ``""`` (off), ``"line"`` or ``"badge"``, with its text.
    powered_by: str = ""
    powered_by_text: str = ""
    #: The seat meter, the search field's placeholder and the grouped rows (settings, devices, the
    #: account), with the sentences that follow the list (the Replace confirm; ``True`` marks the bold one).
    seat: Optional[Seat] = None
    search: str = ""
    groups: List[Group] = field(default_factory=list)
    after: List[Tuple[str, bool]] = field(default_factory=list)
    #: The numbered steps (OfflineActivation), drawn after the heading in place of those body lines.
    steps: List[Step] = field(default_factory=list)
    code: Optional[Code] = None
    #: A refusal the person can resolve (DL6): the core copy of a key that was not accepted, a license that
    #: is full or expired, in default text on a sunken callout under the field, never in the danger colour.
    callout: List[str] = field(default_factory=list)
    #: The catalog key of the screen's one filled button (what Enter in a field does), or ``""``.
    primary_key: str = ""
    #: What a new-window button says it does ("Opens in your browser"), or ``""`` when none leaves the app.
    external_note: str = ""

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
            "showName": self.show_name,
            "developerLine": self.developer_line,
            "hero": self.hero,
            "loading": self.loading,
            "titleTone": self.title_tone,
            "fields": [f.as_dict() for f in self.fields],
            "focus": self.focus,
            "poweredBy": self.powered_by,
            "poweredByText": self.powered_by_text,
            "seat": self.seat.as_dict() if self.seat is not None else None,
            "search": self.search,
            "groups": [g.as_dict() for g in self.groups],
            "after": [{"text": text, "strong": strong} for text, strong in self.after],
            "steps": [s.as_dict() for s in self.steps],
            "code": self.code.as_dict() if self.code is not None else None,
            "callout": list(self.callout),
            "primaryKey": self.primary_key,
            "externalNote": self.external_note,
            "hidden": self.state == "hidden"
            or not (
                self.title or self.body or self.steps or self.buttons or self.fields or self.groups or self.seat
                or self.progress is not None or self.code is not None or self.callout
            ),
        }


def _code_block(view: View, copy: Copy, args: Mapping[str, Any], data: Optional[RowData]) -> Optional[Code]:
    """The device-code view's block, or ``None`` on any other screen."""
    if view.component != "SignInHandoff" or view.state != "code" or not args.get("code"):
        return None
    dc = data.device_code if data is not None else {}
    left, total = dc.get("secondsLeft"), dc.get("expiresIn")
    known = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (left, total)) and total
    link = view.decisions.link
    qr = ""
    if view.decisions.qr and link is not None and link.url:
        svg = _qr.svg(link.url, dark="#060912", light="#ffffff")
        if svg:
            qr = "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return Code(
        label=copy("part.code.label"),
        value=str(args["code"]),
        copy_label=copy("a11y.copyCode") if "a11y.copyCode" in view.copy else "",
        copied=copy("common.copied") if dc.get("copied") is True else "",
        expires=copy("signin.handoff.expires", time=args["time"]) if args.get("time") else "",
        fraction=max(0.0, min(1.0, left / total)) if known else -1.0,
        qr=qr,
        qr_label=copy("a11y.qr") if qr else "",
    )


def _args(view: View) -> Mapping[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in view.args.items():
        out[key] = bidi_isolate(str(value)) if key in view.isolate and isinstance(value, str) else value
    return out


def _open(text: str) -> bool:
    """A message still holding a ``{placeholder}``: its data is not in the view (a row, a size)."""
    return "{" in text


def build_spec(
    view: View,
    copy: Copy,
    *,
    product: str = "",
    developer: str = "",
    powered_by: str = "",
    data: Optional[RowData] = None,
    selected_id: Optional[str] = None,
    advanced: bool = False,
    request_code: str = "",
) -> ScreenSpec:
    """Lay one view out. Heading, then sentences, then the buttons in catalog order with the
    model's primary first among equals; at most one filled button.

    The identity fills ``{product}``/``{app}``/``{developer}``. A sentence whose data the view does not
    carry (a file size, a row's name) is left out rather than drawn with its braces: rows and meters
    come from the rich models in ``polaris_key.ui.core.models`` or the view's own ``rows``, which
    ``data`` (a :class:`~.rows.RowData`) replaces; with them the list, the seat meter and the account
    rows are laid out too (``rows.py``)."""
    args = {**({"product": product, "app": product} if product else {}), **_args(view)}
    if developer:
        args.setdefault("developer", bidi_isolate(developer))
    if isinstance(args.get("size"), int) and not isinstance(args.get("size"), bool):
        args["size"] = format_bytes(args["size"])  # a byte count reads "50 MB", never 52428800
    rows = build_rows(view, copy, data, args, selected_id=selected_id, advanced=advanced) if data is not None else None
    consumed = rows.consumed if rows is not None else frozenset()
    if rows is not None and rows.args:
        args = {**args, **rows.args}
    primary = view.decisions.primary
    title = ""
    open_heading = False
    body: List[str] = []
    buttons: List[Button] = []
    progress: Optional[float] = None
    busy = False
    parts: Dict[str, str] = {}
    steps: List[Step] = []
    qr_label = ""
    keyed: Dict[str, str] = {}
    paste = ""
    for key in view.copy:
        if key == "common.byDeveloper":  # the identity header draws it
            continue
        if key == "part.poweredBy":  # drawn at the foot with the Locker mark, when the theme asks
            continue
        if key == "a11y.qrRequest":  # names the request QR of step 1; drawn only with a code to encode
            qr_label = copy(key, **args)
            continue
        if key.startswith("a11y."):
            busy = busy or key in ("a11y.busy", "a11y.progress")
            continue
        if key in _NOT_DRAWN or key in _CODE_PARTS:
            continue
        if key == "signin.provider.continue" and "signin.desktop.continue" in view.copy:
            continue
        if key in consumed:  # a row draws it, with its data
            continue
        if key in _PROGRESS and args.get("fraction") is None and not args.get("total"):
            progress = -1.0
        if key in _ROW_FRAGMENTS:
            continue
        if key in _FIELD_PARTS:
            text = copy(key, **args)
            if not _open(text):
                parts[key] = text
            continue
        if key == "common.paste":  # the key field's own control, at the end of the field
            paste = copy(key)
            continue
        if _HEADING.search(key):
            if not title:
                title = copy(key, **args)
                if _open(title):
                    title, open_heading = "", True
            continue
        if is_button_key(key, primary):
            text = copy(key, **args)
            if not _open(text):
                buttons.append(Button(key, text, button_role(key, primary)))
            continue
        text = copy(key, **args)
        if key in _STEP_KEYS and view.component == "OfflineActivation":
            steps.append(Step(_STEP_KEYS[key], text))
            continue
        if not _open(text):
            body.append(text)
            keyed[key] = text
    if steps and view.decisions.qr and request_code and qr_label:
        uri = _qr_uri(request_code)
        if uri:  # fail closed: no payload, no QR
            steps = [Step(s.number, s.text, uri, qr_label) if s.number == 1 else s for s in steps]
    after: List[Tuple[str, bool]] = []
    if rows is not None and rows.before is not None:
        # The list sits between the sentences that introduce it and the ones that follow it.
        placed = set(rows.before) | set(rows.after)
        rest = [text for key, text in keyed.items() if key not in placed]
        body = [keyed[k] for k in rows.before if k in keyed] + rest
        after = [(keyed[k], k == "deviceLimit.confirmTitle") for k in rows.after if k in keyed]
    if open_heading and not title:
        title = copy(_FALLBACK_TITLE)  # never a screen with a button and no words
    if rows is not None and not title and rows.title_key:
        title = copy(rows.title_key)
    if not title and view.component in ("SignIn", "SignInHandoff") and view.state not in ("hidden", "code"):
        title = copy("signIn.title", **args)  # every step of the form keeps its name
        if _open(title):
            title = ""
    fields = [
        Field(
            label,
            parts[label],
            parts.get(spec["placeholder"] or "", ""),
            next((parts[k] for k in spec["hint"] if k in parts), ""),
            next((parts[k] for k in spec["error"] if k in parts), ""),
            data.key_text if data is not None and label == "part.keyField.label" else "",
            paste if label == "part.keyField.label" else "",
        )
        for label, spec in _FIELDS.items()
        if label in parts
    ]
    loading = (
        f"{view.component}.{view.state}" in DELAYED_LOADING_STATES
        or (view.component == "Boot" and view.state in ("progress", "fetching"))
    ) and not buttons
    counted = isinstance(args.get("fraction"), (int, float)) and not isinstance(args.get("fraction"), bool)
    if counted:
        progress = max(0.0, min(1.0, float(args["fraction"])))
    elif isinstance(args.get("done"), (int, float)) and isinstance(args.get("total"), (int, float)) and args["total"]:
        progress = max(0.0, min(1.0, args["done"] / args["total"]))
    elif loading or progress == -1.0 or (
        view.component == "UpdateProgress" and view.state in ("queued", "installing")
    ) or (
        # Waiting for the browser, or for a code: a wait with no count is the shimmer, never a made-up bar.
        view.component in ("SignIn", "SignInHandoff") and view.state in ("handoff", "waiting", "starting", "finishing")
    ):
        progress = -1.0  # the 2 px shimmer: honest, no percentage is invented (DL7)
    else:
        progress = None  # a busy control carries its own indicator (DL4); nothing is part-filled
    # DL4: one filled control, and a lone action is always it. A busy primary keeps its label.
    if (
        primary
        and not any(b.key == primary for b in buttons)
        and ((busy and not loading) or (view.component in _PRIMARY_ALWAYS and primary not in _NOT_DRAWN))
    ):
        text = copy(primary, **args)
        if not _open(text):
            buttons.append(Button(primary, text, "primary"))
    elif not any(b.role == "primary" for b in buttons) and len(buttons) == 1 and view.component not in _NOT_FILLED:
        only = buttons[0]
        buttons = [Button(only.key, only.text, "primary")]
    busy_primary = busy and bool(primary) and any(b.key == primary for b in buttons)
    # The attribution (UI-KITS §1.6): the theme's `powered_by` alone turns it on for a signed-in account
    # pane or About, whether or not the integrator input carried the catalog key.
    attribution = powered_by if (
        powered_by
        and (
            "part.poweredBy" in view.copy
            or (view.component == "AccountAndLicense" and view.state == "signed-in")
            or view.component == "About"
        )
    ) else ""
    buttons.sort(key=lambda b: {"primary": 0, "secondary": 1, "quiet": 2}[b.role])
    actions = {key: action for action, keys in ACTION_KEYS.items() for key in keys}
    # A button the kit adds for the model's primary names its action only if the view lists it.
    buttons = [
        Button(b.key, b.text, b.role, actions.get(b.key) if actions.get(b.key) in view.actions else None, busy_primary and b.role == "primary", b.key in _LEAVES)
        for b in buttons
    ]
    isolated_product = bidi_isolate(product) if product else ""
    names_product = bool(product) and (product in title or isolated_product in title)
    on_field = view.decisions.error_slot in _FIELDS
    callout: List[str] = []
    if view.component in ("Activate", "SignIn") and view.decisions.tone == "neutral" and view.decisions.error_slot:
        for key in [k for k in keyed if k.startswith(("core.activation.", "core.codes."))]:
            text = keyed.pop(key)
            callout.append(text)
            body = [b for b in body if b != text]
    code = _code_block(view, copy, args, data)
    if code is not None:
        # The address follows the code; the sentence that introduces the code stays above it.
        after = after + [(keyed.pop("signin.handoff.url"), False)] if "signin.handoff.url" in keyed else after
        body = [text for key, text in keyed.items()] if rows is None or rows.before is None else body
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
        show_name=bool(product) and not names_product,
        developer_line=copy("common.byDeveloper", developer=bidi_isolate(developer)) if developer and view.component == "Welcome" else "",
        hero=view.component == "Welcome",
        loading=loading,
        title_tone="danger" if view.decisions.tone == "danger" and not on_field else "",
        fields=fields,
        focus=view.decisions.focus or "",
        powered_by=attribution,
        powered_by_text=copy("part.poweredBy") if attribution else "",
        seat=rows.seat if rows is not None else None,
        search=rows.search if rows is not None else "",
        groups=list(rows.groups) if rows is not None else [],
        after=after,
        steps=sorted(steps, key=lambda s: s.number),
        code=code,
        callout=callout,
        primary_key=next((b.key for b in buttons if b.role == "primary"), ""),
        external_note=copy("a11y.externalLink") if any(b.external for b in buttons) else "",
    )
