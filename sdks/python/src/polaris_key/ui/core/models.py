"""Headless models (layer c, docs/design/UI-KITS.md §1.3, §5.2): SDK results in, a component and a
state out, with the data the state shows. No I/O and no UI: the terminal kit draws them, the Qt kit
(UK-12) can, and a host can draw its own screens from them.

Component and state names are the catalog's (``packages/brand/kit-copy/components.json``), so a view
lines up with the copy keys listed for it and with the UI fixtures (UK-02b) once they land.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Optional, Sequence, Tuple

__all__ = [
    "BootView",
    "DeviceRow",
    "DevicesView",
    "GateView",
    "KeyVerdict",
    "OfflineView",
    "ProgressView",
    "ReleaseNotesView",
    "SettingRow",
    "SettingsView",
    "SignInModel",
    "SignInView",
    "UpdateView",
    "ActivateView",
    "activation_view",
    "boot_view",
    "gate_view",
    "parse_key",
    "release_notes_view",
    "settings_view",
    "update_view",
    "KEY_BODY_LENGTH",
]

DAY = 86_400

# ── The gate: status, grace, blocked states and the account summary ──────────────────────────


@dataclass(frozen=True)
class GateView:
    """``status``: AccountAndLicense when licensed, GraceBanner offline, StatusScreen when blocked,
    PolarisKeyGate when nothing is held."""

    component: str
    state: str
    status: str
    days_left: Optional[int] = None
    grace_until: Optional[int] = None
    allowed_min: Optional[str] = None
    allowed_max: Optional[str] = None
    holder: Optional[str] = None
    email: Optional[str] = None
    signed_in: bool = False
    tier: Optional[str] = None
    term: Optional[str] = None
    version: Optional[str] = None
    channel: Optional[str] = None
    developer: Optional[str] = None
    usable: bool = False


_BLOCKED = ("expired", "revoked", "version-too-old", "version-too-new", "channel-not-entitled")


def gate_view(
    status: str,
    *,
    now: int,
    grace_until: Optional[int] = None,
    allowed_min: Optional[str] = None,
    allowed_max: Optional[str] = None,
    holder: Optional[str] = None,
    email: Optional[str] = None,
    signed_in: bool = False,
    tier: Optional[str] = None,
    term: Optional[str] = None,
    version: Optional[str] = None,
    channel: Optional[str] = None,
    developer: Optional[str] = None,
) -> GateView:
    """Map a gate status (``LICENSE_STATUS_VALUES``) to its component and state."""
    days: Optional[int] = None
    if status == "ok":
        component, state = "AccountAndLicense", "signed-in" if signed_in else "key-only"
    elif status == "grace":
        days = max(0, math.ceil(((grace_until or now) - now) / DAY))
        component, state = "GraceBanner", "last-day" if days <= 1 else "days-left"
    elif status in _BLOCKED:
        component, state = "StatusScreen", status
    elif status == "not-applicable":
        component, state = "PolarisKeyGate", "licensed"
    else:
        component, state = "PolarisKeyGate", "needs-activation"
    return GateView(
        component=component,
        state=state,
        status=status,
        days_left=days,
        grace_until=grace_until,
        allowed_min=allowed_min,
        allowed_max=allowed_max,
        holder=holder,
        email=email,
        signed_in=signed_in,
        tier=tier,
        term=term,
        version=version,
        channel=channel,
        developer=developer,
        usable=status in ("ok", "grace", "not-applicable"),
    )


# ── Activate and DeviceLimit ─────────────────────────────────────────────────────────────────

#: A license key's body: 16 random bytes in base64url (``pkey_<product>_<22>``).
KEY_BODY_LENGTH = 22
_BODY = re.compile(r"^[A-Za-z0-9_-]*$")
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")


@dataclass(frozen=True)
class KeyVerdict:
    """The live verdict on a key as it is typed (UI-KITS §4.3): ``empty``, ``typing``,
    ``parsed`` (the prefix names a product and the body is complete), ``cut-short`` or
    ``malformed``."""

    state: str
    #: The key as typed: never in a repr, so a log or a traceback does not hold it.
    key: str = field(default="", repr=False)
    slug: Optional[str] = None
    prefix: str = ""
    used: int = 0
    limit: int = KEY_BODY_LENGTH


def parse_key(raw: str, *, final: bool = False) -> KeyVerdict:
    """Parse ``raw`` as typed. With ``final`` (on submit) a short body is ``cut-short`` and
    anything else unparseable ``malformed``; while typing it is ``typing``."""
    key = (raw or "").strip()
    if not key:
        return KeyVerdict("empty")
    if not key.startswith("pkey_"):
        return KeyVerdict("malformed" if (final or len(key) >= 5) else "typing", key)
    rest = key[5:]
    slug, sep, body = rest.partition("_")
    if not sep or not _SLUG.match(slug):
        return KeyVerdict("malformed" if final else "typing", key)
    prefix = f"pkey_{slug}_"
    if not _BODY.match(body) or len(body) > KEY_BODY_LENGTH:
        return KeyVerdict("malformed", key, slug, prefix, len(body))
    if len(body) < KEY_BODY_LENGTH:
        return KeyVerdict("cut-short" if final else "typing", key, slug, prefix, len(body))
    return KeyVerdict("parsed", key, slug, prefix, len(body))


@dataclass(frozen=True)
class ActivateView:
    """An activation outcome. ``component`` is ``Activate``, or ``DeviceLimit`` (browser mode)
    when the license has no free device."""

    component: str
    state: str
    #: The result kind in kebab form (``ok``, ``device-limit``, ``unauthorized``, ``refused`` …).
    kind: str
    code: Optional[str] = None
    #: The key that was activated: never in a repr.
    key: Optional[str] = field(default=None, repr=False)
    used: Optional[int] = None
    limit: Optional[int] = None
    manage_url: Optional[str] = None
    verdict: Optional[KeyVerdict] = None


def activation_view(result: Any, key: Optional[str] = None) -> ActivateView:
    """Map a ``license.activate_with_key`` / ``enroll`` result to its view."""
    kind = getattr(result, "kind", "error")
    code = getattr(result, "code", None)
    if kind == "ok":
        return ActivateView("Activate", "done", "ok", key=key)
    if kind == "device-limit":
        manage = getattr(result, "manage_url", None)
        return ActivateView(
            "DeviceLimit",
            "browser-mode" if manage else "failed",
            kind,
            code,
            key,
            getattr(result, "deviceCount", None),
            getattr(result, "limit", None),
            manage,
        )
    if kind == "refused" and code == "key_entry_limit":
        kind = "key-entry-limit"
    return ActivateView("Activate", "rejected", kind, code if isinstance(code, str) else None, key)


# ── Sign-in (the browser presentation; SIGN-IN.md §4.15, D-68) ───────────────────────────────


@dataclass(frozen=True)
class SignInView:
    """``component`` is ``SignIn`` or ``SignInHandoff``; ``state`` one of the catalog's."""

    component: str
    state: str
    user_code: Optional[str] = None
    #: The page to type the code into (``key.plrs.im/device``, or the product's own).
    url: Optional[str] = None
    #: The same page with the code filled in: the browser opens it.
    url_complete: Optional[str] = None
    seconds_left: Optional[int] = None
    headless: bool = False
    name: Optional[str] = None
    email: Optional[str] = None
    code: Optional[str] = None
    copied: bool = False


class SignInModel:
    """The terminal's sign-in as a state machine over the SDK's device-code primitives. The
    browser presentation only (SIGN-IN.md D-93): the license is chosen on the card.

    ``starting`` → (``waiting`` in the browser | ``code`` when headless or on **Use a code**)
    → ``done``, or ``expired`` / ``denied`` / ``cancelled`` / ``error``."""

    def __init__(self, *, headless: bool = False, device_code_url: Optional[str] = None) -> None:
        self.headless = headless
        self._url_override = device_code_url
        self.view = SignInView("SignInHandoff", "starting", headless=headless)

    def _set(self, **changes: Any) -> SignInView:
        self.view = replace(self.view, **changes)
        return self.view

    def prompted(self, prompt: Any, now: int) -> SignInView:
        url = self._url_override or getattr(prompt, "verificationUri", None)
        return self._set(
            component="SignInHandoff" if self.headless else "SignIn",
            state="code" if self.headless else "handoff",
            user_code=getattr(prompt, "userCode", None),
            url=url,
            url_complete=getattr(prompt, "verificationUriComplete", None),
            seconds_left=max(0, int(getattr(prompt, "expiresAt", now) - now)),
        )

    def browser_failed(self) -> SignInView:
        return self._set(component="SignInHandoff", state="no-browser")

    def use_code(self) -> SignInView:
        return self._set(component="SignInHandoff", state="code")

    def tick(self, seconds_left: int) -> SignInView:
        return self._set(seconds_left=max(0, seconds_left))

    def copied(self) -> SignInView:
        return self._set(copied=True)

    def finished(self, result: Any) -> SignInView:
        status = getattr(result, "status", "error")
        if status == "ready":
            ident = getattr(result, "identity", None)
            return self._set(
                component="SignIn",
                state="done",
                name=getattr(ident, "name", None),
                email=getattr(ident, "email", None),
            )
        if status == "expired":
            return self._set(component="SignInHandoff", state="expired", code="sign-in-expired")
        message = getattr(result, "message", None) or ""
        if "denied" in message or "access_denied" in message:
            return self._set(component="SignInHandoff", state="denied", code="sign-in-denied")
        return self._set(component="SignIn", state="error", code="sign-in-failed")

    def cancelled(self) -> SignInView:
        return self._set(component="SignInHandoff", state="cancelled", code="cancelled")

    def failed(self, code: str) -> SignInView:
        return self._set(component="SignIn", state="error", code=code)


# ── Devices ──────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DeviceRow:
    id: str
    label: Optional[str]
    platform: Optional[str]
    current: bool = False
    when: Optional[str] = None


@dataclass(frozen=True)
class DevicesView:
    component: str
    state: str
    rows: Tuple[DeviceRow, ...] = ()
    target: Optional[DeviceRow] = None


# ── Updates ──────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class UpdateView:
    """``UpdatePrompt``: ``available``, ``mandatory``, ``up-to-date``, ``blocked``, ``store``,
    ``platform``, ``downloading``, ``ready`` or ``revoked-required-content``."""

    component: str
    state: str
    version: Optional[str] = None
    current: Optional[str] = None
    size: Optional[str] = None
    critical: bool = False
    notes: Tuple[str, ...] = ()
    notes_url: Optional[str] = None
    outlet: Optional[str] = None
    listing_url: Optional[str] = None
    fraction: Optional[float] = None
    done: Optional[str] = None
    total: Optional[str] = None
    eta: Optional[str] = None
    #: Whether this build can install it (a build without signed updates can only point at it).
    installable: bool = True


def update_view(decision: Any, *, current: Optional[str] = None, notes: Sequence[str] = (), notes_url: Optional[str] = None, size: Optional[str] = None) -> UpdateView:
    """Map an ``UpdateDecision`` to the prompt's state."""
    action = getattr(decision, "action", "none")
    release = getattr(decision, "release", None)
    version = getattr(release, "version", None)
    critical = bool(getattr(decision, "critical", False))
    mandatory = bool(getattr(decision, "mandatory", False))
    if action == "blocked":
        state = "revoked-required-content" if getattr(decision, "contentBlock", None) == "revoked-content" else "blocked"
        return UpdateView("UpdatePrompt", state, current=current)
    if action in ("none", "packs") or version is None:
        return UpdateView("UpdatePrompt", "up-to-date", current=current)
    if getattr(decision, "contentBlock", None) == "revoked-content":
        return UpdateView("UpdatePrompt", "revoked-required-content", version, current)
    if action == "store":
        return UpdateView("UpdatePrompt", "store", version, current, critical=critical, listing_url=getattr(decision, "listingUrl", None))
    if action == "platform":
        return UpdateView("UpdatePrompt", "platform", version, current, critical=critical)
    state = "mandatory" if mandatory else "available"
    return UpdateView("UpdatePrompt", state, version, current, size, critical, tuple(notes)[:3], notes_url)


@dataclass(frozen=True)
class ProgressView:
    """``UpdateProgress`` for a content pack, or a download inside ``UpdatePrompt``."""

    component: str
    state: str
    name: Optional[str] = None
    fraction: Optional[float] = None
    done: Optional[str] = None
    total: Optional[str] = None
    eta: Optional[str] = None
    code: Optional[str] = None


# ── Release notes ────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReleaseNotesView:
    component: str
    state: str
    entries: Tuple[Tuple[str, Optional[str], Tuple[str, ...], Optional[str]], ...] = ()


def release_notes_view(entries: Optional[Sequence[Any]], *, error: bool = False) -> ReleaseNotesView:
    if error or entries is None:
        return ReleaseNotesView("ReleaseNotes", "error")
    rows = tuple(
        (
            getattr(e, "version", ""),
            getattr(e, "date", None),
            tuple((getattr(e, "summary", None) or "").splitlines()),
            getattr(e, "url", None),
        )
        for e in entries
    )
    return ReleaseNotesView("ReleaseNotes", "list" if rows else "empty", rows)


# ── Boot ─────────────────────────────────────────────────────────────────────────────────────

#: Stage → the catalog key of its progress line.
BOOT_STAGE_COPY: Dict[str, str] = {
    "idle": "boot.starting",
    "shell": "boot.starting",
    "guard": "boot.starting",
    "sync": "boot.syncing",
    "gate": "gate.checking",
    "decide": "boot.deciding",
    "fetch": "boot.fetching",
    "mount": "common.loading",
    "background": "boot.ready",
    "ready": "boot.ready",
}


@dataclass(frozen=True)
class BootView:
    component: str
    state: str
    stage: Optional[str] = None
    status: Optional[str] = None
    code: Optional[str] = None
    size: Optional[str] = None
    metered: bool = False
    playable: bool = False
    update_available: bool = False
    rolled_back: bool = False


def boot_view(outcome: Any) -> BootView:
    """Map a ``BootOutcome`` to Boot's (or the gate's) state."""
    kind = getattr(outcome, "outcome", "error")
    emits = tuple(getattr(outcome, "emits", ()) or ())
    rolled = any(e.get("type") == "boot_rolled_back" for e in emits)
    upd = any(e.get("type") == "update_available" for e in emits)
    status = getattr(outcome, "status", None)
    if kind == "ready":
        return BootView("Boot", "rolled-back" if rolled else "progress", "ready", status, update_available=upd, rolled_back=rolled)
    if kind == "waiting":
        if status in ("needs-activation", "revoked"):
            return BootView("PolarisKeyGate", "needs-activation", "gate", status)
        return BootView("Boot", "declined", getattr(outcome, "stage", None), status)
    if kind == "blocked":
        reason = next((e.get("reason") for e in emits if e.get("type") == "blocked"), None)
        return BootView("Boot", "blocked", "blocked", status, code=reason)
    if kind == "offline":
        playable = bool(getattr(getattr(outcome, "state", None), "canPlayOffline", False))
        return BootView("Boot", "offline", "offline", status, playable=playable)
    code = getattr(outcome, "error", None) or next((e.get("code") for e in emits if e.get("type") == "error"), None)
    return BootView("Boot", "error", "error", status, code=code or "unknown")


# ── Settings ─────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SettingRow:
    key: str
    value: Any
    #: ``local``, ``default``, ``env`` or ``enforced``.
    source: str
    org: Optional[str] = None


@dataclass(frozen=True)
class SettingsView:
    component: str
    state: str
    rows: Tuple[SettingRow, ...] = ()
    code: Optional[str] = None


def settings_view(entries: Sequence[Dict[str, Any]], local: Optional[Dict[str, Any]] = None) -> SettingsView:
    rows: List[SettingRow] = []
    seen = set()
    for e in entries:
        key = e.get("key")
        if not isinstance(key, str):
            continue
        seen.add(key)
        src = "enforced" if e.get("enforced") else (e.get("source") if e.get("source") in ("local", "env", "default") else "default")
        rows.append(SettingRow(key, e.get("value"), src, e.get("org") if isinstance(e.get("org"), str) else None))
    for k, v in sorted((local or {}).items()):
        if k not in seen:
            rows.append(SettingRow(k, v, "local"))
    if not rows:
        return SettingsView("Settings", "list")
    state = "locked" if any(r.source == "enforced" for r in rows) else "list"
    return SettingsView("Settings", state, tuple(rows))


# ── Offline activation ───────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class OfflineView:
    component: str
    state: str
    request_code: Optional[str] = None
    code: Optional[str] = None
    imported: Tuple[str, ...] = field(default_factory=tuple)
