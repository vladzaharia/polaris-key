"""Rows for the Qt kit: the settings, devices, seat-meter and account screens as plain data (no Qt
import), the way ``layout`` lays out the rest.

A bare :class:`~polaris_key.ui.core.ui_view.View` names catalog keys and counts; the *rows* (a setting
and its value, a device and when it was last seen, the seats in use, who is signed in) live in the
model's input and in the rich models of ``polaris_key.ui.core.models``. :func:`row_data` reads either
into one :class:`RowData`, and :func:`build_rows` lays it out as :class:`Group` s of :class:`Row` s
that ``kit/KitScreen.qml`` draws with real controls (a Switch, a Slider, a ComboBox, buttons, a radio
list). Every string is a catalog key through :class:`~polaris_key.ui.core.copy.Copy`; a row whose fact
the data lacks is left out rather than drawn as a label with nothing after it (DL8).

Structure follows the React kit (``packages/sdk-react/src/kit/views.tsx``): the same rows, the same
tags, the same order, under UI-KITS §4.1 and §4.3 (inset grouped lists, 64 px device rows, a bare
20 px form-factor glyph, a neutral seat meter).
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from ..core.copy import Copy
from ..core.format import relative_days
from ..core.ui_choice import origin_key
from ..core.ui_view import View, bidi_isolate

__all__ = [
    "Group",
    "Row",
    "RowAction",
    "RowData",
    "RowsSpec",
    "Seat",
    "build_rows",
    "row_data",
    "setting_label",
]

#: Beyond this many seats the meter stops adding segments (React's cap).
MAX_SEGMENTS = 12
#: Source keys of a setting, in the catalog.
_SOURCES = ("default", "local", "env")


@dataclass(frozen=True)
class RowData:
    """What the rows draw, whichever shape it arrived in (a ui-matrix input or a rich model)."""

    config: Tuple[Mapping[str, Any], ...] = ()
    devices: Tuple[Mapping[str, Any], ...] = ()
    licenses: Tuple[Mapping[str, Any], ...] = ()
    account: Mapping[str, Any] = field(default_factory=dict)
    activation: Mapping[str, Any] = field(default_factory=dict)
    edit: Mapping[str, Any] = field(default_factory=dict)
    #: The device list's selected index, when the host tracks it (React's ``input.selected``).
    selected: Optional[int] = None
    #: This device's form factor, for "this Mac".
    form_factor: str = "computer"
    #: The device-code sign-in the code view draws: ``userCode``, ``secondsLeft``, ``expiresIn`` (the
    #: code's whole life, for the ring) and ``copied``.
    device_code: Mapping[str, Any] = field(default_factory=dict)
    #: What the key field holds (``keyField.text``): the key the person typed or pasted.
    key_text: str = ""
    #: The sign-in grant's roster (LicenseChoice: ``choices``) and the device list a Replace opens
    #: (``replaceView``), as the ui-matrix inputs carry them; ``pick`` is the host's choice by name
    #: (``"create"``) when it is not a licence id.
    choices: Mapping[str, Any] = field(default_factory=dict)
    replace_view: Mapping[str, Any] = field(default_factory=dict)
    pick: str = ""


def _maps(value: Any) -> Tuple[Mapping[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    return tuple(item for item in value if isinstance(item, Mapping))


def _map(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _int(value: Any) -> Optional[int]:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def row_data(source: Any) -> RowData:
    """Normalise ``source`` into :class:`RowData`.

    ``source`` is a ui-matrix input (``config``, ``devices``, ``account``, ``activation``, ``edit``,
    ``selected``, ``platform``), a ``SettingsView``, a ``DevicesView``, a ``GateView`` or an
    ``ActivateView`` from ``polaris_key.ui.core.models``, or a :class:`RowData` already."""
    if source is None:
        return RowData()
    if isinstance(source, RowData):
        return source
    if isinstance(source, Mapping):
        platform = _map(source.get("platform"))
        selected = source.get("selected")
        return RowData(
            config=_maps(source.get("config")),
            devices=_maps(source.get("devices")),
            licenses=_maps(source.get("licenses")),
            account=_map(source.get("account")),
            activation=_map(source.get("activation")),
            edit=_map(source.get("edit")),
            selected=_int(selected) if selected is not None else None,
            form_factor=str(platform.get("formFactor") or "computer"),
            device_code=_map(source.get("deviceCode")),
            key_text=str(_map(source.get("keyField")).get("text") or ""),
            choices=_map(source.get("choices")),
            replace_view=_map(source.get("replaceView")),
            pick=selected if isinstance(selected, str) else "",
        )
    name = type(source).__name__
    if name == "SettingsView":
        config = []
        for row in source.rows:
            value = row.value
            kind = "boolean" if isinstance(value, bool) else "number" if isinstance(value, (int, float)) else "string"
            config.append(
                {
                    "key": row.key,
                    "type": kind,
                    "source": "default" if row.source == "enforced" else row.source,
                    "locked": row.source == "enforced",
                    "org": row.org,
                    "value": value,
                }
            )
        return RowData(config=tuple(config))
    if name == "DevicesView":
        devices = [
            {"id": r.id, "name": r.label, "platform": r.platform, "when": r.when, "current": r.current}
            for r in source.rows
        ]
        edit: Dict[str, Any] = {}
        if source.target is not None and source.state in ("renaming", "confirming"):
            edit = {"kind": "rename" if source.state == "renaming" else "remove", "device": source.target.label}
        return RowData(devices=tuple(devices), edit=edit)
    if name == "GateView":
        account: Dict[str, Any] = {"signedIn": bool(source.signed_in)}
        for key, attr in (("holder", "holder"), ("tier", "tier"), ("channel", "channel"), ("version", "version")):
            if getattr(source, attr, None):
                account[key] = getattr(source, attr)
        if source.seats_used is not None:
            account["devices"] = {"used": source.seats_used, "limit": source.seats_limit}
        if source.status in ("expired", "grace"):
            account["renew"] = True
        return RowData(account=account)
    if name == "ActivateView":
        return RowData(activation={"deviceCount": source.used, "limit": source.limit})
    raise TypeError("cannot read rows from %s" % name)


# ── What the renderer draws ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RowAction:
    """A real button on a row. ``name`` is its accessible name when the visible text alone would be
    ambiguous ("Rename Work laptop"); ``role`` is the kit button role (``quiet``, ``secondary``,
    ``primary``, ``danger`` (the destructive solid) or ``dangerText`` (outlined, danger text: Sign out))."""

    key: str
    text: str
    action: str
    name: str = ""
    role: str = "quiet"
    external: bool = False
    describe: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "text": self.text,
            "action": self.action,
            "name": self.name or self.text,
            "role": self.role,
            "external": self.external,
            "describe": self.describe,
        }


@dataclass(frozen=True)
class Seat:
    """The neutral seat meter (rule 9): segments, a caption that says the count once, a label."""

    used: int
    limit: int
    label: str
    caption: str = ""

    @property
    def over(self) -> bool:
        return self.used > self.limit

    def as_dict(self) -> Dict[str, Any]:
        count = max(1, min(self.limit, MAX_SEGMENTS))
        return {
            "used": self.used,
            "limit": self.limit,
            "segments": [i < self.used for i in range(count)],
            "label": self.label,
            "caption": self.caption,
            "over": self.over,
        }


@dataclass(frozen=True)
class Row:
    """One row of a grouped list. ``kind`` is ``setting``, ``device``, ``license``, ``account``,
    ``edit`` (a device's inline rename) or ``confirm`` (the inline remove confirm)."""

    id: str
    kind: str
    title: str = ""
    meta: str = ""
    #: A quiet tag after the name ("Least recent"), full radius.
    tag: str = ""
    #: ``phone``, ``tablet``, ``tv`` or ``computer``; empty draws no glyph.
    glyph: str = ""
    glyph_label: str = ""
    #: ``switch``, ``slider``, ``choice``, ``field``, ``value`` or empty.
    control: str = ""
    value: str = ""
    on: bool = False
    #: "On" / "Off" beside a switch.
    state_text: str = ""
    #: The edit event's key (``config:audio.volume``) and the control's accessible name.
    key: str = ""
    name: str = ""
    minimum: float = 0.0
    maximum: float = 0.0
    step: float = 1.0
    number: float = 0.0
    numeric: bool = False
    options: Tuple[Tuple[str, str], ...] = ()
    current: int = 0
    locked: bool = False
    lock_label: str = ""
    #: A radio row (Replace a device) and whether it is the chosen one.
    radio: bool = False
    selected: bool = False
    enabled: bool = True
    actions: Tuple[RowAction, ...] = ()
    seat: Optional[Seat] = None
    #: A confirm row's sentence; an edit row's field label and its text.
    text: str = ""
    field_label: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "meta": self.meta,
            "tag": self.tag,
            "glyph": self.glyph,
            "glyphLabel": self.glyph_label,
            "control": self.control,
            "value": self.value,
            "on": self.on,
            "stateText": self.state_text,
            "key": self.key,
            "name": self.name or self.title,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "step": self.step,
            "number": self.number,
            "numeric": self.numeric,
            "options": [{"value": v, "label": label} for v, label in self.options],
            "current": self.current,
            "locked": self.locked,
            "lockLabel": self.lock_label,
            "radio": self.radio,
            "selected": self.selected,
            "enabled": self.enabled,
            "actions": [a.as_dict() for a in self.actions],
            "seat": self.seat.as_dict() if self.seat is not None else None,
            "text": self.text,
            "fieldLabel": self.field_label,
        }


@dataclass(frozen=True)
class Group:
    """An inset grouped list under an optional 13 px heading."""

    id: str
    rows: Tuple[Row, ...]
    heading: str = ""
    radio: bool = False
    #: The service the header belongs to (``config``, ``update``): its tinted glyph tile shows when the
    #: theme asks for service cues (UI-KITS 1.2).
    service: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "heading": self.heading,
            "radio": self.radio,
            "service": self.service,
            "rows": [r.as_dict() for r in self.rows],
        }


@dataclass(frozen=True)
class RowsSpec:
    """The rows of one screen, and how they change the sentences around them."""

    groups: Tuple[Group, ...] = ()
    seat: Optional[Seat] = None
    #: The search field's placeholder (settings), when the catalog offers it.
    search: str = ""
    #: Catalog keys the rows now draw (so the body and the buttons do not repeat them).
    consumed: frozenset = frozenset()
    #: The sentences above the list, in order, and below it (``strong`` marks the confirm's first line).
    before: Optional[Tuple[str, ...]] = None
    after: Tuple[str, ...] = ()
    #: Arguments the sentences need that the view does not carry (this device, the chosen device).
    args: Mapping[str, Any] = field(default_factory=dict)
    #: The catalog key of the pane's title when the state names none (Settings' dirty state).
    title_key: str = ""


# ── Small helpers ──────────────────────────────────────────────────────────────────────────────

_ACRONYMS = {
    "ui": "UI", "url": "URL", "uri": "URI", "id": "ID", "api": "API", "cpu": "CPU", "gpu": "GPU",
    "fps": "FPS", "hdr": "HDR", "vr": "VR", "ar": "AR", "ip": "IP", "dns": "DNS", "vpn": "VPN",
    "usb": "USB", "tls": "TLS", "ssl": "SSL", "sdk": "SDK", "os": "OS", "pc": "PC", "tv": "TV",
    "hdmi": "HDMI", "pin": "PIN", "qr": "QR",
}  # fmt: skip


def setting_label(row: Mapping[str, Any]) -> str:
    """A setting's name: the catalog entry's ``label``, else its key read as words (``audio.volume`` is
    "Audio volume"), never the raw key (DL8)."""
    label = row.get("label")
    if isinstance(label, str) and label.strip():
        return label.strip()
    key = str(row.get("key", ""))
    words = [w for w in re.split(r"[._\-\s/:]+", re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)) if w]
    phrase = " ".join(_ACRONYMS.get(w.lower(), w.lower()) for w in words)
    return phrase[:1].upper() + phrase[1:] if phrase else key


def _number(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _glyph(form_factor: Any, platform: Any) -> str:
    if form_factor in ("iphone", "phone"):
        return "phone"
    if form_factor in ("ipad", "tablet"):
        return "tablet"
    if form_factor == "tv":
        return "tv"
    if not form_factor and str(platform or "").lower() in ("ios", "android"):
        return "phone"
    return "computer"


def _platform(copy: Copy, platform: Any) -> str:
    if not isinstance(platform, str) or not platform.strip():
        return ""
    key = "part.platform." + platform.strip().lower()
    return copy(key) if copy.has(key) else platform.strip()


def _when(copy: Copy, device: Mapping[str, Any]) -> str:
    when = device.get("when")
    if isinstance(when, str) and when:
        return when
    days = _int(device.get("lastSeenDays"))
    return relative_days(max(0, days), copy.locale) if days is not None else ""


def _name(device: Mapping[str, Any]) -> str:
    name = device.get("name")
    return name.strip() if isinstance(name, str) and name.strip() else ""


def _device_id(device: Mapping[str, Any], index: int) -> str:
    ident = device.get("id")
    return str(ident) if isinstance(ident, (str, int)) and not isinstance(ident, bool) and str(ident) else str(index)


def _least_recent(devices: Sequence[Mapping[str, Any]]) -> Optional[int]:
    pick: Optional[int] = None
    for i, d in enumerate(devices):
        if d.get("current") is True:
            continue
        age = _int(d.get("lastSeenDays"))
        age = -1 if age is None else age
        if pick is None:
            pick = i
            continue
        before = _int(devices[pick].get("lastSeenDays"))
        if age > (-1 if before is None else before):
            pick = i
    return pick


def _seat(copy: Copy, used: Any, limit: Any, *, caption: bool) -> Optional[Seat]:
    u, n = _int(used), _int(limit)
    if u is None or n is None or n < 1 or u < 0:
        return None
    return Seat(u, n, copy("a11y.seatMeter", used=u, limit=n), copy("part.seatMeter.caption", used=u, limit=n) if caption else "")


# ── Settings ───────────────────────────────────────────────────────────────────────────────────

_SETTINGS_KEYS = frozenset(
    (
        "settings.search settings.fromDeveloper settings.source.default settings.source.env "
        "settings.source.local settings.setBy settings.setByGuardian settings.on settings.off "
        "settings.range settings.reset settings.advanced a11y.locked"
    ).split()
)


def _setting_row(copy: Copy, r: Mapping[str, Any], args: Mapping[str, Any]) -> Row:
    label = setting_label(r)
    title = bidi_isolate(label)
    locked = r.get("locked") is True
    org = r.get("org") if isinstance(r.get("org"), str) and r.get("org") else None
    source = r.get("source") if r.get("source") in _SOURCES else ""
    meta: List[str] = []
    if locked:
        meta.append(copy("settings.setBy", org=bidi_isolate(org)) if org else copy("settings.setByGuardian"))
    elif source:
        meta.append(copy("settings.source." + source))
    lo, hi = r.get("min"), r.get("max")
    bounded = (
        r.get("type") == "number"
        and isinstance(lo, (int, float))
        and isinstance(hi, (int, float))
        and not isinstance(lo, bool)
        and not isinstance(hi, bool)
    )
    if bounded:
        meta.append(copy("settings.range", min=_number(lo), max=_number(hi)))
    value = r.get("value")
    options = tuple(
        (str(o.get("value")), str(o.get("label", o.get("value"))))
        for o in _maps(r.get("options"))
    )
    common: Dict[str, Any] = dict(
        id=str(r.get("key", label)),
        kind="setting",
        title=title,
        meta=" · ".join(meta),
        key="config:" + str(r.get("key", "")),
        name=label,
        locked=locked,
    )
    actions: Tuple[RowAction, ...] = ()
    if source == "local" and not locked:
        actions = (RowAction("settings.reset", copy("settings.reset"), "reset", describe=label),)
    if locked:
        shown = ""
        if isinstance(value, bool):
            shown = copy("settings.on" if value else "settings.off")
        elif value is not None:
            shown = str(r.get("display") or _number(value))
        return Row(**common, control="value" if shown else "", value=shown, lock_label=copy("a11y.locked"), actions=actions)
    if isinstance(value, bool):
        return Row(
            **common,
            control="switch",
            on=value,
            state_text=copy("settings.on" if value else "settings.off"),
            actions=actions,
        )
    if options and value is not None:
        index = next((i for i, (v, _l) in enumerate(options) if v == str(value)), 0)
        return Row(**common, control="choice", options=options, current=index, actions=actions)
    if bounded and isinstance(value, (int, float)) and not isinstance(value, bool):
        span = float(hi) - float(lo)  # type: ignore[arg-type]
        step = r.get("step") if isinstance(r.get("step"), (int, float)) else (1.0 if span <= 100 else span / 100.0)
        return Row(
            **common,
            control="slider",
            minimum=float(lo),  # type: ignore[arg-type]
            maximum=float(hi),  # type: ignore[arg-type]
            step=float(step),
            number=float(value),
            value=str(r.get("display") or _number(value)),
            actions=actions,
        )
    if value is not None:
        return Row(
            **common,
            control="field",
            value=_number(value),
            numeric=r.get("type") == "number" or isinstance(value, (int, float)),
            actions=actions,
        )
    return Row(**common, actions=actions)


def _settings(view: View, copy: Copy, data: RowData, args: Mapping[str, Any], advanced: bool) -> Optional[RowsSpec]:
    if not data.config or view.state not in ("list", "dirty", "saving", "locked"):
        return None
    has_advanced = any(r.get("advanced") is True for r in data.config)
    shown = [r for r in data.config if advanced or r.get("advanced") is not True]
    own = [r for r in shown if r.get("locked") is not True and r.get("source") != "default"]
    pushed = [r for r in shown if r.get("locked") is not True and r.get("source") == "default"]
    managed = [r for r in shown if r.get("locked") is True]
    developer = args.get("developer")
    groups: List[Group] = []
    if own:
        groups.append(Group("own", tuple(_setting_row(copy, r, args) for r in own)))
    if pushed:
        heading = copy("settings.fromDeveloper", developer=developer) if isinstance(developer, str) and developer else ""
        groups.append(Group("developer", tuple(_setting_row(copy, r, args) for r in pushed), heading, service="config"))
    if managed:
        groups.append(
            Group("managed", tuple(_setting_row(copy, r, args) for r in managed), copy("account.managedSettings"), service="config")
        )
    if has_advanced:
        groups.append(
            Group(
                "advanced",
                (
                    Row(
                        "advanced",
                        "setting",
                        title=copy("settings.advanced"),
                        control="switch",
                        on=advanced,
                        key="advanced",
                        name=copy("settings.advanced"),
                    ),
                ),
            )
        )
    return RowsSpec(
        groups=tuple(groups),
        search=copy("settings.search") if "settings.search" in view.copy else "",
        consumed=_SETTINGS_KEYS,
        title_key="settings.title",
    )


# ── Devices ────────────────────────────────────────────────────────────────────────────────────

_DEVICES_KEYS = frozenset(
    (
        "devices.meta devices.rename devices.remove devices.unnamed a11y.renameDevice a11y.removeDevice "
        "a11y.formFactor part.thisDeviceTitle devices.renameLabel devices.removeConfirm common.save "
        "common.cancel"
    ).split()
)


def _device_meta(copy: Copy, d: Mapping[str, Any], form_factor: str) -> str:
    """The second line: "This Mac" for this device, else "<platform> · last used <when>"."""
    if d.get("current") is True:
        return copy("part.thisDeviceTitle", formFactor=d.get("formFactor") or form_factor or "other")
    platform = _platform(copy, d.get("platform"))
    when = _when(copy, d)
    if platform and when:
        return copy("devices.meta", platform=platform, when=when)
    return platform


def _devices(view: View, copy: Copy, data: RowData, args: Mapping[str, Any]) -> Optional[RowsSpec]:
    if not data.devices or view.state not in ("list", "renaming", "confirming"):
        return None
    unnamed = copy("devices.unnamed")
    edit = data.edit
    at: Optional[int] = None
    if view.state in ("renaming", "confirming"):
        if data.selected is not None and 0 <= data.selected < len(data.devices):
            at = data.selected
        else:
            target = edit.get("device")
            at = next((i for i, d in enumerate(data.devices) if _name(d) == target), None)
    product = args.get("product", "")
    rows: List[Row] = []
    for i, d in enumerate(data.devices):
        name = _name(d)
        label = name or unnamed
        ident = _device_id(d, i)
        glyph = _glyph(d.get("formFactor"), d.get("platform"))
        glyph_label = copy("a11y.formFactor", formFactor=d.get("formFactor") or "other")
        if view.state == "renaming" and i == at:
            rows.append(
                Row(
                    ident,
                    "edit",
                    title=bidi_isolate(label),
                    glyph=glyph,
                    glyph_label=glyph_label,
                    key="devices.renameLabel",
                    field_label=copy("devices.renameLabel"),
                    text=name,
                    actions=(
                        RowAction("common.save", copy("common.save"), "save", role="primary"),
                        RowAction("common.cancel", copy("common.cancel"), "cancel", role="secondary"),
                    ),
                )
            )
            continue
        actions = [
            RowAction("devices.rename", copy("devices.rename"), "rename", copy("a11y.renameDevice", device=bidi_isolate(label)))
        ]
        if d.get("current") is not True:
            actions.append(
                RowAction("devices.remove", copy("devices.remove"), "remove", copy("a11y.removeDevice", device=bidi_isolate(label)))
            )
        rows.append(
            Row(
                ident,
                "device",
                title=bidi_isolate(label),
                meta=_device_meta(copy, d, data.form_factor),
                glyph=glyph,
                glyph_label=glyph_label,
                actions=tuple(actions),
            )
        )
        if view.state == "confirming" and i == at:
            rows.append(
                Row(
                    ident + ":confirm",
                    "confirm",
                    text=copy("devices.removeConfirm", device=bidi_isolate(label), product=product),
                    actions=(
                        RowAction("devices.remove", copy("devices.remove"), "remove", role="danger"),
                        RowAction("common.cancel", copy("common.cancel"), "cancel", role="secondary"),
                    ),
                )
            )
    return RowsSpec(
        groups=(Group("devices", tuple(rows)),),
        consumed=_DEVICES_KEYS,
        before=("devices.lede", "devices.count") if view.state == "list" else (),
        title_key="devices.title",
    )


# ── Replace a device ───────────────────────────────────────────────────────────────────────────

_LIMIT_KEYS = frozenset(
    (
        "part.seatMeter.caption a11y.seatMeter signin.replace.meta signin.replace.leastRecent "
        "a11y.formFactor"
    ).split()
)


def _device_limit(
    view: View, copy: Copy, data: RowData, args: Mapping[str, Any], selected_id: Optional[str]
) -> Optional[RowsSpec]:
    if view.state != "default":
        return None
    used = data.activation.get("deviceCount")
    limit = data.activation.get("limit")
    seat = _seat(copy, used if used is not None else len(data.devices), limit, caption="deviceLimit.heading" not in view.copy)
    if seat is not None and "part.seatMeter.caption" not in view.copy:
        seat = None
    devices = list(data.devices)
    least = _least_recent(devices)
    ids = [_device_id(d, i) for i, d in enumerate(devices)]
    chosen = selected_id if selected_id in ids else (ids[least] if least is not None else None)
    if chosen is not None and devices[ids.index(chosen)].get("current") is True:
        chosen = ids[least] if least is not None else None
    tag = copy("signin.replace.leastRecent") if "signin.replace.leastRecent" in view.copy else ""
    rows: List[Row] = []
    for i, d in enumerate(devices):
        label = _name(d) or copy("devices.unnamed")
        current = d.get("current") is True
        platform = _platform(copy, d.get("platform"))
        when = _when(copy, d)
        meta = (
            copy("part.thisDeviceTitle", formFactor=d.get("formFactor") or data.form_factor or "other")
            if current
            else copy("signin.replace.meta", platform=platform, when=when) if platform and when else platform
        )
        rows.append(
            Row(
                ids[i],
                "device",
                title=bidi_isolate(label),
                meta=meta,
                tag=tag if i == least else "",
                glyph=_glyph(d.get("formFactor"), d.get("platform")),
                glyph_label=copy("a11y.formFactor", formFactor=d.get("formFactor") or "other"),
                radio=True,
                selected=ids[i] == chosen,
                enabled=not current,
                name=label,
            )
        )
    pick = devices[ids.index(chosen)] if chosen is not None else None
    extra: Dict[str, Any] = {"formFactor": data.form_factor}
    after: Tuple[str, ...] = ()
    if pick is not None:
        extra["device"] = bidi_isolate(_name(pick) or copy("devices.unnamed"))
        extra["thisDevice"] = copy("part.thisDevice", formFactor=data.form_factor)
        after = ("deviceLimit.confirmTitle", "deviceLimit.consequence")
    return RowsSpec(
        groups=(Group("replace", tuple(rows), radio=True),) if rows else (),
        seat=seat,
        consumed=_LIMIT_KEYS,
        before=("deviceLimit.heading", "deviceLimit.lede"),
        after=after,
        args=extra,
    )


# ── Licenses (LicenseChoice) ───────────────────────────────────────────────────────────────────

_ORIGINS = {
    "signIn": "signin.choice.origin.signIn",
    "key": "signin.choice.origin.key",
    "keyAdded": "signin.choice.origin.keyAdded",
    "storeKey": "signin.choice.origin.storeKey",
    "storeKeyAdded": "signin.choice.origin.storeKeyAdded",
    "store": "signin.choice.origin.store",
    "developer": "signin.choice.origin.developer",
    "free": "signin.choice.origin.free",
    "gift": "signin.choice.origin.gift",
    "org": "signin.choice.origin.org",
}
_LICENSE_KEYS = frozenset(
    ("signin.choice.group signin.choice.meta signin.choice.devices signin.choice.tag.current signin.choice.tag.full "
     "signin.choice.origin.signIn signin.choice.origin.key signin.choice.origin.keyAdded "
     "signin.choice.origin.storeKey signin.choice.origin.storeKeyAdded signin.choice.origin.store "
     "signin.choice.origin.developer signin.choice.origin.free signin.choice.origin.gift "
     "signin.choice.origin.org signin.term.lifetime signin.term.until signin.term.yearlyUntil").split()
)  # fmt: skip


def _licenses(view: View, copy: Copy, data: RowData, args: Mapping[str, Any], selected_id: Optional[str]) -> Optional[RowsSpec]:
    if data.choices or data.replace_view:
        return _roster(view, copy, data, args, selected_id)
    if not data.licenses or view.component != "LicenseChoice" or view.state not in ("many", "one", "all-full", "mixed"):
        return None
    ids = [str(lic.get("id", i)) for i, lic in enumerate(data.licenses)]
    chosen = selected_id if selected_id in ids else next(
        (ids[i] for i, lic in enumerate(data.licenses) if lic.get("current") is True and not _full(lic)),
        next((ids[i] for i, lic in enumerate(data.licenses) if not _full(lic)), None),
    )
    rows: List[Row] = []
    for i, lic in enumerate(data.licenses):
        full = _full(lic)
        origin = _origin(copy, lic)
        term = lic.get("term") if isinstance(lic.get("term"), str) else ""
        used, limit = _int(lic.get("used")), _int(lic.get("limit"))
        seat = _seat(copy, used, limit, caption=False)
        tier = lic.get("tier") if isinstance(lic.get("tier"), str) else ""
        tag = (
            copy("signin.choice.tag.full")
            if full
            else copy("signin.choice.tag.current")
            if lic.get("current") is True
            else ""
        )
        rows.append(
            Row(
                ids[i],
                "license",
                title=bidi_isolate(tier or origin),
                meta=" · ".join(p for p in ((origin if tier else ""), term) if p),
                tag=tag,
                value=copy("signin.choice.devices", used=used, limit=limit) if seat is not None else "",
                radio=not full,
                selected=ids[i] == chosen,
                enabled=not full,
                seat=seat,
                name=tier or origin,
            )
        )
    return RowsSpec(
        groups=(Group("licenses", tuple(rows), radio=True, heading=copy("signin.choice.group", product=args.get("product", ""))),),
        consumed=_LICENSE_KEYS,
        title_key="signin.choice.title",
    )


_MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
_ROSTER_KEYS = _LICENSE_KEYS | frozenset(
    (
        "signin.choice.keep signin.choice.keepMeta signin.choice.create signin.choice.createMeta "
        "signin.choice.tag.new signin.choice.metaNew signin.replace.meta signin.replace.leastRecent "
        "signin.replace.activeNow signin.replace.thisBrowser"
    ).split()
)
_ROSTER_STATES = ("many", "one", "current", "mixed", "keep", "create", "new", "all-full", "raced", "replace-open")


def _date(copy: Copy, seconds: Any) -> str:
    """A day as the person reads it: ``Jan 1, 2027`` in English, else the ISO date (no guessing a
    locale's order)."""
    value = _int(seconds)
    if value is None:
        return ""
    day = _dt.datetime.fromtimestamp(value, _dt.timezone.utc)
    if copy.locale.split("-")[0] == "en":
        return f"{_MONTHS[day.month - 1]} {day.day}, {day.year}"
    return day.strftime("%Y-%m-%d")


def _roster_origin(copy: Copy, choice: Mapping[str, Any], args: Mapping[str, Any]) -> str:
    key = origin_key(choice)
    if key == "signin.choice.origin.store" and not choice.get("store"):
        return ""  # "From {store}" with no store named is not a sentence (DL8)
    text = copy(key, developer=args.get("developer") or "", store=choice.get("store") or "")
    return "" if "{" in text else text


def _roster(view: View, copy: Copy, data: RowData, args: Mapping[str, Any], selected_id: Optional[str]) -> Optional[RowsSpec]:
    """LicenseChoice from the grant roster (``choices``): licence rows with the seat meter, the
    keep and create rows beside them (never merged into one outcome), and the Replace a device list."""
    if view.state not in _ROSTER_STATES:
        return None
    if view.state == "replace-open":
        return _replace_list(view, copy, data, args, selected_id)
    roster = data.choices
    licences = list(_maps(roster.get("choices")))
    ids = [str(c.get("id", i)) for i, c in enumerate(licences)]
    usable = [ids[i] for i, c in enumerate(licences) if c.get("state") != "full"]
    rows: List[Row] = []
    for i, c in enumerate(licences):
        full = c.get("state") == "full"
        seats = _map(c.get("seats"))
        seat = _seat(copy, seats.get("used"), seats.get("limit"), caption=False)
        term = copy("signin.term.until", date=_date(copy, c["expiresAt"])) if c.get("expiresAt") is not None else copy("signin.term.lifetime")
        tier = c.get("name") if isinstance(c.get("name"), str) and c.get("name") else c.get("tierName")
        origin = _roster_origin(copy, c, args)
        rows.append(
            Row(
                ids[i],
                "license",
                title=bidi_isolate(str(tier or origin)),
                meta=" · ".join(p for p in (origin if tier else "", term) if p),
                tag=copy("signin.choice.tag.full") if full else copy("signin.choice.tag.current") if c.get("current") is True else "",
                value=copy("signin.choice.devices", used=seats.get("used"), limit=seats.get("limit")) if seat is not None else "",
                radio=not full,
                selected=False,
                enabled=not full,
                seat=seat,
                name=str(tier or origin),
            )
        )
    create = _map(roster.get("create"))
    if roster.get("state") == "autoIssue" and create:
        rows = [
            Row(
                "new",
                "license",
                title=bidi_isolate(str(create.get("tierName") or args.get("product") or "")),
                meta=copy("signin.choice.metaNew"),
                tag=copy("signin.choice.tag.new"),
                radio=True,
                selected=True,
                name=str(create.get("tierName") or ""),
            )
        ]
        ids = ["new"]
    else:
        if roster.get("keep") is True:
            rows.insert(0, Row("keep", "license", title=copy("signin.choice.keep"), meta=copy("signin.choice.keepMeta", product=args.get("product", "")), radio=True, name=copy("signin.choice.keep")))
            ids.insert(0, "keep")
        if create:
            rows.append(Row("create", "license", title=copy("signin.choice.create"), meta=copy("signin.choice.createMeta"), radio=True, name=copy("signin.choice.create")))
            ids.append("create")
        wanted = {"keep": "keep", "create": "create"}.get(view.state)
        current = next((ids[i] for i, c in enumerate(licences) if c.get("current") is True and c.get("state") != "full"), None)
        pre = roster.get("preselected")
        chosen = next(
            (x for x in (selected_id, data.pick, wanted, pre, current, usable[0] if usable else None) if x in ids), None
        )
        rows = [replace(r, selected=r.id == chosen) for r in rows]
    heading = copy("signin.choice.group", product=args.get("product", "")) if len(rows) > 1 else ""
    return RowsSpec(groups=(Group("licenses", tuple(rows), radio=True, heading=heading),), consumed=_ROSTER_KEYS, title_key="signin.choice.title")


def _replace_list(view: View, copy: Copy, data: RowData, args: Mapping[str, Any], selected_id: Optional[str]) -> Optional[RowsSpec]:
    """Replace a device, in place: the license's devices as a radio list, the least recent first."""
    devices = list(_maps(data.replace_view.get("devices")))
    if not devices:
        return None
    ids = [_device_id(d, i) for i, d in enumerate(devices)]
    least = next((i for i, d in enumerate(devices) if d.get("leastRecent") is True and d.get("thisBrowser") is not True), None)
    chosen = selected_id if selected_id in ids and devices[ids.index(selected_id)].get("thisBrowser") is not True else (ids[least] if least is not None else None)
    seats = _map(data.replace_view.get("seats"))
    rows: List[Row] = []
    for i, d in enumerate(devices):
        here = d.get("thisBrowser") is True
        label = copy("signin.replace.thisBrowser") if here else (_name({"name": d.get("label")}) or copy("devices.unnamed"))
        platform = _platform(copy, d.get("platform"))
        meta = (
            copy("signin.replace.activeNow")
            if d.get("activeNow") is True
            else copy("signin.replace.meta", platform=platform, when=_date(copy, d.get("lastSeen"))) if platform and d.get("lastSeen") is not None else platform
        )
        rows.append(
            Row(
                ids[i],
                "device",
                title=bidi_isolate(label),
                meta=meta,
                tag=copy("signin.replace.leastRecent") if i == least else "",
                glyph=_glyph(d.get("deviceType"), d.get("platform")),
                glyph_label=copy("a11y.formFactor", formFactor=d.get("deviceType") or "other"),
                radio=True,
                selected=ids[i] == chosen,
                enabled=not here,
                name=label,
            )
        )
    pick = devices[ids.index(chosen)] if chosen is not None else None
    extra: Dict[str, Any] = {"thisDevice": copy("part.thisDevice", formFactor=data.form_factor)}
    if pick is not None:
        extra["device"] = bidi_isolate(_name({"name": pick.get("label")}) or copy("devices.unnamed"))
    return RowsSpec(
        groups=(Group("replace", tuple(rows), radio=True),),
        seat=_seat(copy, seats.get("used"), seats.get("limit"), caption=False),
        consumed=_ROSTER_KEYS,
        before=("signin.replace.open",),
        after=("signin.replace.consequence",),
        args=extra,
    )


def _full(lic: Mapping[str, Any]) -> bool:
    used, limit = _int(lic.get("used")), _int(lic.get("limit"))
    return used is not None and limit is not None and used >= limit


def _origin(copy: Copy, lic: Mapping[str, Any]) -> str:
    key = _ORIGINS.get(str(lic.get("origin", "")))
    if key is None:
        return ""
    return copy(
        key,
        last6=lic.get("last6"),
        store=lic.get("store"),
        developer=lic.get("developer"),
        org=lic.get("org"),
    )


# ── Account and license ────────────────────────────────────────────────────────────────────────

_ACCOUNT_KEYS = frozenset(
    (
        "account.tier account.holder account.keyOnly account.devices account.cloudSync account.updates "
        "account.autoUpdate account.channel account.version account.managedSettings common.manage "
        "a11y.externalLink update.checkNow common.signOut signin.choice.devices status.renew license.renew"
    ).split()
)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _account(view: View, copy: Copy, data: RowData, args: Mapping[str, Any]) -> Optional[RowsSpec]:
    if view.state not in ("signed-in", "key-only"):
        return None
    acct = data.account
    keys = set(view.copy)
    tier = _text(acct.get("tier"))
    main: List[Row] = []
    manage = (
        RowAction("common.manage", copy("common.manage"), "manage", describe=copy("a11y.externalLink") if "a11y.externalLink" in keys else "", external=True)
        if "common.manage" in keys
        else None
    )
    if view.state == "signed-in":
        holder = _text(acct.get("holder"))
        if holder and "account.holder" in keys:
            main.append(
                Row("holder", "account", title=copy("account.holder", name=bidi_isolate(holder)), actions=(manage,) if manage else ())
            )
        elif manage:
            main.append(Row("manage", "account", actions=(manage,)))
    elif "account.keyOnly" in keys:
        main.append(Row("key", "account", title=copy("account.keyOnly")))
    if tier and "account.tier" in keys:
        developer = args.get("developer")
        # "Renew with {developer}" when the developer is known; a bare "Renew" otherwise.
        renew_text = (
            copy("license.renew", developer=developer)
            if isinstance(developer, str) and developer
            else copy("status.renew")
        )
        renew = (
            (RowAction("status.renew", renew_text, "renew", describe=copy("a11y.externalLink") if "a11y.externalLink" in keys else "", external=True),)
            if acct.get("renew") is True
            else ()
        )
        main.append(Row("tier", "account", title=copy("account.tier", tier=bidi_isolate(tier)), meta=_text(acct.get("term")), actions=renew))
    devices = _map(acct.get("devices"))
    used, limit = _int(devices.get("used")), _int(devices.get("limit"))
    if view.state == "signed-in" and "account.devices" in keys and used is not None:
        seat = _seat(copy, used, limit, caption=False) if limit is not None else None
        main.append(
            Row(
                "devices",
                "account",
                title=copy("account.devices"),
                value=copy("signin.choice.devices", used=used, limit=limit) if limit is not None else str(used),
                seat=seat,
            )
        )
    # An account page that holds the devices and settings panes links to them: a Review button on a row.
    review = copy("common.review")
    if acct.get("devicesPage") is True and "account.devices" in keys:
        link = RowAction("common.review", review, "open-devices", name=review + " " + copy("account.devices"))
        existing = next((r for r in main if r.id == "devices"), None)
        if existing is not None:
            main[main.index(existing)] = replace(existing, actions=(link,))
        else:
            main.append(Row("devices", "account", title=copy("account.devices"), actions=(link,)))
    if acct.get("settingsPage") is True:
        link = RowAction("common.review", review, "open-settings", name=review + " " + copy("settings.title"))
        main.append(Row("settings", "account", title=copy("settings.title"), actions=(link,)))
    updates: List[Row] = []
    auto = acct.get("autoUpdate")
    if isinstance(auto, bool) and "account.autoUpdate" in keys:
        label = copy("account.autoUpdate")
        updates.append(
            Row(
                "autoUpdate",
                "setting",
                title=label,
                control="switch",
                on=auto,
                key="autoUpdate",
                name=label,
                state_text=copy("settings.on" if auto else "settings.off"),
            )
        )
    channel = _text(acct.get("channel"))
    picker = _map(acct.get("channelPicker"))
    if picker and channel and "account.channel" in keys:
        # The ChannelPicker (UI-KITS §4.1): a choice, or locked with the reason when the outlet fixes the
        # channel (decision 6; never locked without saying why).
        options = tuple((str(o.get("value")), str(o.get("label", o.get("value")))) for o in _maps(picker.get("options")))
        if picker.get("locked") is True or not options:
            store = _text(picker.get("store"))
            updates.append(
                Row(
                    "channel", "account", title=copy("channel.title"), control="value", value=bidi_isolate(channel),
                    meta=copy("channel.locked", store=bidi_isolate(store)) if store else "",
                    locked=True, lock_label=copy("a11y.locked"), name=copy("channel.title"),
                )
            )
        else:
            index = next((i for i, (v, _l) in enumerate(options) if v == channel), 0)
            updates.append(
                Row("channel", "setting", title=copy("channel.title"), control="choice", options=options, current=index,
                    key="channel", name=copy("channel.title"))
            )
    elif channel and "account.channel" in keys:
        updates.append(Row("channel", "account", title=copy("account.channel"), control="value", value=bidi_isolate(channel)))
    version = _text(acct.get("version"))
    check = (
        (RowAction("update.checkNow", copy("update.checkNow"), "check-update"),) if "update.checkNow" in keys else ()
    )
    if version and "account.version" in keys:
        updates.append(Row("version", "account", title=copy("account.version", version=version), actions=check))
    elif check:
        updates.append(Row("check", "account", actions=check))
    groups: List[Group] = []
    if main:
        groups.append(Group("account", tuple(main)))
    if updates:
        groups.append(
            Group("updates", tuple(updates), copy("account.updates") if "account.updates" in keys else "", service="update")
        )
    if "common.signOut" in keys:
        groups.append(
            Group("session", (Row("signOut", "account", actions=(RowAction("common.signOut", copy("common.signOut"), "sign-out", role="dangerText"),)),))
        )
    return RowsSpec(groups=tuple(groups), consumed=_ACCOUNT_KEYS)


# ── The entry point ────────────────────────────────────────────────────────────────────────────


def build_rows(
    view: View,
    copy: Copy,
    data: RowData,
    args: Mapping[str, Any],
    *,
    selected_id: Optional[str] = None,
    advanced: bool = False,
) -> Optional[RowsSpec]:
    """The rows of ``view`` from ``data``, or ``None`` when this state has none to draw (the layout
    then draws it as sentences and buttons only)."""
    if view.component == "Settings":
        return _settings(view, copy, data, args, advanced)
    if view.component == "Devices":
        return _devices(view, copy, data, args)
    if view.component == "DeviceLimit":
        return _device_limit(view, copy, data, args, selected_id)
    if view.component == "LicenseChoice":
        return _licenses(view, copy, data, args, selected_id)
    if view.component == "AccountAndLicense":
        return _account(view, copy, data, args)
    return None
