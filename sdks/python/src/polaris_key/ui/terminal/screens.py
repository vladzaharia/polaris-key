"""The terminal kit's screens (layer b): one function per catalog component, a view in, lines out.

Each draws the terminal board's layout (docs/design/ui-kits/terminal.html, UI-KITS §8) with the
copy of SIGN-IN.md §5.2 and the catalog: the product chip on the header line, a continuous rail,
one glyph per step (``◆`` active, ``◇`` done, ``✓``, ``✗``, ``▲``), key hints on the last line.
Nothing is printed here; :mod:`.device` writes the lines, and :mod:`.flows` drives them.
"""

from __future__ import annotations

from typing import Any, List, Optional, Sequence, Tuple

from ..core.models import (
    BOOT_STAGE_COPY,
    ActivateView,
    BootView,
    DevicesView,
    GateView,
    KeyVerdict,
    OfflineView,
    ProgressView,
    ReleaseNotesView,
    SettingsView,
    SignInView,
    UpdateView,
)
from . import fmt
from .parts import Kit
from .text import Line, Span

__all__ = [
    "activate",
    "boot",
    "boot_progress",
    "device_limit",
    "devices",
    "diagnostic",
    "gate",
    "key_entry",
    "offline_activation",
    "release_notes",
    "settings",
    "sign_in",
    "update",
    "update_progress",
    "DEVICE_CODE_URL",
]

#: The device-code page when the product sets none (SIGN-IN.md D-16).
DEVICE_CODE_URL = "https://key.plrs.im/device"

Lines = List[Line]


def _frame(k: Kit, verb: str, body: Lines, end: Sequence[Span] = ()) -> Lines:
    out = [k.header(verb)]
    if k.decor:
        out.append(k.rail())
    out += body
    out += k.end(end)
    return out


def _gap(k: Kit) -> Lines:
    return [k.rail()] if k.decor else [Line([])]


def _fixes(k: Kit, fixes: Sequence[Tuple[str, str]]) -> Lines:
    """Fix commands, aligned: ``polaris-key activate   Use a different key``."""
    if not fixes:
        return []
    width = max(len(f"{k.prog} {w}") for w, _ in fixes)
    return [Line(k._prefix("rail") + k.command(w, label, width)) for w, label in fixes]


def _code_title_message(k: Kit, code: Optional[str], *, group: str = "codes") -> Tuple[Span, Span]:
    """The catalog's title and message for a registry ``code``, else the fallback."""
    if code and k.copy.has(f"core.{group}.{code}.title") and k.copy.has(f"core.{group}.{code}.message"):
        return k.t(f"core.{group}.{code}.title", "strong"), k.t(f"core.{group}.{code}.message")
    if code and k.copy.has(f"core.{group}.{code}.message"):
        return k.t("core.fallback.title", "strong"), k.t(f"core.{group}.{code}.message")
    return k.t("core.fallback.title", "strong"), k.t("core.fallback.message", code=code or "unknown")


# ── PolarisKeyGate, StatusScreen, GraceBanner, AccountAndLicense: `status` ───────────────────


def _account_rows(k: Kit, v: GateView) -> Lines:
    out: Lines = []
    pill = k.t("part.status.ok") if v.status == "ok" else k.t("part.status.grace") if v.status == "grace" else k.t("part.status.notApplicable")
    first: List[Span] = [pill]
    if v.tier:
        first += [k.sep(), k.t("account.tier", tier=v.tier)]
    if v.term:
        first += [k.sep(), k.d(v.term, "term", "muted")]
    out += k.body(first)
    if v.signed_in and (v.holder or v.email):
        row = [k.t("account.holder", name=v.holder or v.email)]
        if v.holder and v.email:
            row += [k.sep(), k.d(v.email, "email", "muted")]
        out += k.body(row)
    elif not v.signed_in:
        out += k.body([k.t("account.keyOnly", "muted")])
    if v.version:
        out += k.body([k.t("account.version", version=v.version)] + ([k.sep(), k.d(v.channel, "channel", "muted")] if v.channel else []))
    return out


def gate(k: Kit, v: GateView, verb: str = "status") -> Lines:
    """The ``status`` verb: the account summary when licensed, the grace line offline, the
    blocked state with its fix as a command, or the activation prompt."""
    body: Lines = []
    end: List[Span] = []
    if v.component == "AccountAndLicense":
        body += k.step("active", [k.t("account.title", "strong")])
        body += _account_rows(k, v)
    elif v.component == "GraceBanner":
        if v.state == "last-day":
            body += k.step("warn", [k.t("grace.lastDay", "strong", product=k.inline_product)])
        else:
            body += k.step("warn", [k.t("grace.daysLeft", "strong", days=v.days_left or 0)])
        if v.grace_until:
            body += k.body([k.t("grace.deadline", "muted", date=fmt.date(v.grace_until))])
        body += _gap(k)
        body += _account_rows(k, v)
        body += _gap(k)
        body += _fixes(k, [("status", "common.reconnect")])
    elif v.component == "StatusScreen":
        body += k.step("fail", [k.t(f"core.gate.{v.state}.title", "strong")])
        body += k.body([k.t(f"core.gate.{v.state}.message")])
        if v.state in ("version-too-old", "version-too-new") and (v.allowed_min or v.allowed_max):
            if v.allowed_min and v.allowed_max:
                rng = k.t("status.allowedRange", "muted", min=v.allowed_min, max=v.allowed_max)
            elif v.allowed_min:
                rng = k.t("status.allowedMin", "muted", min=v.allowed_min)
            else:
                rng = k.t("status.allowedMax", "muted", max=v.allowed_max)
            body += k.body([rng])
        fixes = {
            "revoked": [("activate", "signin.key.differentKey"), ("sign-out", "common.signOut")],
            "expired": [("activate", "status.renew")],
            "version-too-old": [("update", "status.update")],
            "version-too-new": [],
            "channel-not-entitled": [("update --channel <name>", "status.switchChannel")],
        }[v.state]
        if fixes:
            body += _gap(k)
            body += _fixes(k, fixes)
        if v.state == "channel-not-entitled" and v.developer:
            body += k.body([k.t("status.contact", "muted", developer=v.developer)])
    elif v.state == "licensed":
        body += k.step("ok", [k.t("core.gate.not-applicable.title", "strong")])
        body += k.body([k.t("core.gate.not-applicable.message", "muted")])
    else:
        body += k.step("warn", [k.t("core.gate.needs-activation.title", "strong")])
        body += k.body([k.t("core.gate.needs-activation.message")])
        body += _gap(k)
        body += _fixes(k, [("activate", "welcome.useKey"), ("sign-in", "welcome.signIn")])
    return _frame(k, verb, body, end)


# ── Activate, DeviceLimit ────────────────────────────────────────────────────────────────────


def _masked(k: Kit, raw: str, verdict: KeyVerdict) -> List[Span]:
    """The key as typed, masked: the prefix in clear, the body as bullets, the last six clear."""
    if verdict.prefix and raw.startswith(verdict.prefix):
        body = raw[len(verdict.prefix) :]
        head = verdict.prefix
    else:
        body, head = raw, ""
    tail = body[-6:] if len(body) > 6 else ""
    dot = "*" if k.env.symbols == "ascii" else "•"
    hidden = dot * (len(body) - len(tail))
    room = k.body_width - len(head) - len(tail) - 2
    if len(hidden) > room:
        hidden = hidden[: max(room, 1)]
    out = [k.d(head, "key")] if head else []
    out += [Span(hidden, ("muted",), None, "symbol")] if hidden else []
    out += [k.d(tail, "key")] if tail else []
    return out


def key_entry(
    k: Kit,
    raw: str,
    verdict: KeyVerdict,
    *,
    busy: bool = False,
    frame: int = 0,
    show_empty: bool = False,
    verb: str = "activate",
) -> Lines:
    """The masked key field with its live verdict (Activate ``empty``, ``typing``, ``parsed``,
    ``cut-short``, ``rejected`` and ``busy``)."""
    body: Lines = []
    body += k.step("active", [k.t("part.keyField.label", "strong"), Span("  "), k.t("activate.lede", "muted")])
    cursor = Span(" ", ("code",), None, "symbol") if k.decor and not busy else Span("")
    if raw:
        body += [Line(k._prefix("rail") + _masked(k, raw, verdict) + [cursor])]
    else:
        body += [Line(k._prefix("rail") + [k.t("part.keyField.placeholder", "muted"), cursor])]
    if busy:
        spin = k.env.symbol["ellipsis"] if not k.env.motion else _spinner(k, frame)
        body += k.body([Span(spin, ("muted",), None, "symbol"), Span(" "), k.t("activate.busy")])
    elif verdict.state == "parsed":
        name = k.product if verdict.slug in (None, _slug_of(k)) else verdict.slug
        body += k.body([*k.icon("ok", "success"), k.t("part.keyField.forProduct", "muted", product=name)])
    elif verdict.state == "cut-short":
        body += k.body([*k.icon("fail", "danger"), k.t("part.keyField.cutShort", prefix=verdict.prefix, used=verdict.used, limit=verdict.limit)])
    elif verdict.state == "malformed":
        body += k.body([*k.icon("fail", "danger"), k.t("part.keyField.malformed")])
    elif verdict.state == "empty" and show_empty:
        body += k.body([*k.icon("fail", "danger"), k.t("part.keyField.empty")])
    hints = [] if busy else k.hints([("Enter", "activate.submit"), ("Esc", "common.cancel")])
    return _frame(k, verb, body, hints)


def _slug_of(k: Kit) -> Optional[str]:
    return k.slug


def _key_done(k: Kit, key: Optional[str]) -> Lines:
    if not key:
        return []
    return k.step("done", [k.t("part.keyField.label"), k.sep(), k.key(key)])


def activate(k: Kit, v: ActivateView, verb: str = "activate") -> Lines:
    """An activation's outcome: ``done``, or ``rejected`` with the result's copy."""
    if v.component == "DeviceLimit":
        return device_limit(k, v, verb)
    body: Lines = _key_done(k, v.key)
    if body:
        body += _gap(k)
    end: List[Span] = []
    if v.state == "done":
        body += k.step("ok", [k.t("core.activation.ok.title", "strong")])
        body += k.body([k.t("core.activation.ok.message")])
    elif v.kind == "key-entry-limit":
        body += k.step("fail", [k.t("core.activation.key-entry-limit.title", "strong")])
        body += k.body([k.t("signin.key.noEntries", product=k.inline_product)])
        body += _gap(k)
        body += _fixes(k, [("sign-in", "welcome.signIn")])
    else:
        kind = v.kind if k.copy.has(f"core.activation.{v.kind}.title") else "error"
        body += k.step("fail", [k.t(f"core.activation.{kind}.title", "strong")])
        body += k.body([k.t(f"core.activation.{kind}.message", code=v.code or kind)])
        if kind == "unauthorized":
            body += _gap(k)
            body += _fixes(k, [("activate", "signin.key.differentKey")])
        elif kind == "enroll-claimed":
            body += _gap(k)
            body += _fixes(k, [("sign-in", "welcome.signIn")])
    return _frame(k, verb, body, end)


def device_limit(k: Kit, v: ActivateView, verb: str = "activate", *, opened: bool = False) -> Lines:
    """DeviceLimit in browser mode (UI-KITS §4.3: layer 1 has no device list for a key, so
    **Replace a device** opens ``manageUrl``), then **Try again**."""
    body: Lines = _key_done(k, v.key)
    if body:
        body += _gap(k)
    if v.used is not None and v.limit is not None:
        body += k.step("warn", [k.t("deviceLimit.heading", "strong", used=v.used, limit=v.limit)])
        body += k.body(k.seat_meter(v.used, v.limit))
        body += k.body([k.t("deviceLimit.lede", formFactor="computer")])
    else:
        body += k.step("warn", [k.t("core.activation.device-limit.title", "strong")])
        body += k.body([k.t("core.activation.device-limit.message")])
    end: List[Span] = []
    if v.manage_url:
        body += _gap(k)
        body += k.step("active", [k.t("deviceLimit.title", "strong")])
        body += k.body([k.t("deviceLimit.browser", product=k.inline_product)])
        body += k.body([k.link(v.manage_url, None, "muted")])
        if k.env.interactive:
            end = k.hints([("Enter", "common.tryAgain" if opened else "deviceLimit.openBrowser"), ("Esc", "common.cancel")])
    else:
        body += _gap(k)
        body += _fixes(k, [("activate", "common.tryAgain")])
    return _frame(k, verb, body, end)


# ── Sign-in (SIGN-IN.md §4.15 frame 32) ──────────────────────────────────────────────────────


def _spinner(k: Kit, frame: int) -> str:
    from .. import ansi

    frames = ansi.SPINNER["ascii" if k.env.symbols == "ascii" else "unicode"]
    return frames[frame % len(frames)]


def _wait_line(k: Kit, key: str, frame: int, **args: Any) -> Lines:
    """The waiting line: the braille spinner in mute on the rail's column (a still ellipsis when
    motion is off), then the status."""
    glyph = _spinner(k, frame) if k.env.motion else k.env.symbol["ellipsis"]
    if not k.decor:
        return [Line([k.t(key, **args)])]
    return [Line([Span(glyph, ("muted",), None, "symbol"), Span("  "), k.t(key, **args)])]


def sign_in(k: Kit, v: SignInView, verb: str = "sign-in", *, frame: int = 0) -> Lines:
    """``login`` / ``sign-in``: the browser presentation (no QR on any terminal, D-67)."""
    body: Lines = []
    end: List[Span] = []
    url = v.url or DEVICE_CODE_URL
    if v.state == "starting":
        body += _wait_line(k, "signInHandoff.starting", frame)
    elif v.state in ("handoff", "finishing") and v.component == "SignIn":
        body += k.step("done", [k.t("signin.cli.opening")])
        if v.url_complete:
            body += _if_not_opened(k, v.url_complete)
        body += _gap(k)
        body += _wait_line(k, "signin.handoff.finishing" if v.state == "finishing" else "signin.handoff.waiting", frame)
        if k.env.interactive and v.state != "finishing":
            end = k.hint_string("signin.cli.keys")
    elif v.state == "no-browser":
        body += k.step("warn", [k.t("signin.handoff.noBrowser", "strong")])
        body += k.body([k.t("signin.handoff.noBrowserBody")])
        if v.url_complete:
            body += k.body([k.link(v.url_complete)])
        if k.env.interactive:
            end = k.hints([("c", "signin.handoff.useCode"), ("Esc", "common.cancel")])
    elif v.state in ("code", "link-copied") or (v.state == "finishing" and v.component == "SignInHandoff"):
        if v.headless:
            body += k.step("done", [k.t("signin.cli.headless")])
        else:
            body += k.step("active", [k.t("signin.handoff.codeTitle", "strong")])
        body += _with_link(k, "signin.handoff.codeBody", url)
        body += _gap(k)
        body += [Line(k._prefix("rail") + ([Span("   ")] if k.decor else []) + [k.code(v.user_code or "")])]
        body += _gap(k)
        body += k.body([k.t("signin.handoff.check")])
        if v.seconds_left is not None:
            body += k.body([k.t("signin.handoff.expires", "muted", time=fmt.countdown(v.seconds_left))])
        if v.copied:
            body += k.body([*k.icon("ok", "success"), k.t("common.copied", "muted")])
        body += _gap(k)
        body += _wait_line(k, "signin.handoff.finishing" if v.state == "finishing" else "signin.handoff.waiting", frame)
        if k.env.interactive and v.state != "finishing":
            pairs = [("c", "a11y.copyCode")] if k.env.clipboard else []
            if not v.headless:
                pairs.append(("o", "signin.handoff.openBrowser"))
            end = k.hints(pairs + [("Esc", "common.cancel")])
    elif v.state == "done":
        who = [k.t("signin.cli.signedIn", name=v.name, email=v.email)] if (v.name and v.email) else [k.t("account.holder", name=v.name or v.email or k.product)]
        body += k.step("ok", who)
        end = [k.t("signin.cli.closeTab", "muted")] if not v.headless else []
    else:
        group = "codes"
        code = v.code or ("cancelled" if v.state == "cancelled" else "sign-in-failed")
        title, message = _code_title_message(k, code, group=group)
        body += k.step("fail", [title])
        body += k.body([message])
        again = {"expired": "signin.again", "denied": "signInHandoff.newCode"}.get(v.state)
        if again:
            body += _gap(k)
            body += _fixes(k, [("sign-in", again)])
    return _frame(k, verb, body, end)


def _with_link(k: Kit, key: str, url: str) -> Lines:
    """A message with ``{url}`` inside, the URL drawn as a link (OSC 8) and never broken."""
    marker = "￿"
    text = k.s(key, url=marker)
    before, _, after = text.partition(marker)
    spans = [Span(before, (), None, "key:" + key), k.link(url), Span(after, (), None, "key:" + key)]
    return k.body([s for s in spans if s.text])


def _if_not_opened(k: Kit, url: str) -> Lines:
    return _with_link(k, "signin.cli.ifNotOpened", url)


# ── OfflineActivation ────────────────────────────────────────────────────────────────────────


def offline_activation(k: Kit, v: OfflineView, verb: str = "offline-request") -> Lines:
    body: Lines = []
    if v.state == "default":
        body += k.step("active", [k.t("offlineActivation.title", "strong")])
        body += k.body([k.t("offlineActivation.request")])
        body += k.body([k.t("offlineActivation.product", "muted", product=k.product)])
        body += _gap(k)
        body += [Line(k._prefix("rail") + ([Span("   ")] if k.decor else []) + [k.code(v.request_code or "")])]
        qr = k.qr(v.request_code or "")
        if qr:
            body += _gap(k)
            body += qr
        body += _gap(k)
        body += k.body([k.t("offlineActivation.loadHint")])
        body += _fixes(k, [("import-bundle <file>", "offlineActivation.submit")])
    elif v.state == "done":
        body += k.step("ok", [k.t("offlineActivation.done", "strong")])
        if v.imported:
            body += k.body([k.d(" + ".join(v.imported), "imported", "muted")])
    else:
        title, message = _code_title_message(k, v.code)
        body += k.step("fail", [title])
        body += k.body([message])
    return _frame(k, verb, body)


# ── Devices ──────────────────────────────────────────────────────────────────────────────────


def devices(k: Kit, v: DevicesView, verb: str = "devices") -> Lines:
    body: Lines = []
    if v.state == "browser-mode":
        body += k.step("active", [k.t("devices.title", "strong")])
        body += k.body([k.t("core.codes.device-management-unsupported.message")])
        body += k.body([k.t("devices.browser", "muted")])
        return _frame(k, verb, body)
    if v.state == "empty":
        body += k.step("active", [k.t("devices.title", "strong")])
        body += k.body([k.t("devices.empty", "muted")])
        return _frame(k, verb, body)
    if v.state == "confirming" and v.target is not None:
        name = v.target.label or k.s("devices.unnamed")
        body += k.step("warn", [k.t("devices.removeConfirm", "strong", device=name, product=k.inline_product)])
        end = k.hints([("y", "devices.remove"), ("Esc", "common.cancel")]) if k.env.interactive else []
        return _frame(k, verb, body, end)
    if v.state == "done":
        done: List[Span] = [k.t("common.done", "strong")]
        if v.target is not None:
            done += [k.sep(), k.d(v.target.label or v.target.id, "device", "muted")]
        body += k.step("ok", done)
        return _frame(k, verb, body)
    body += k.step("active", [k.t("devices.title", "strong"), k.sep(), k.t("devices.count", "muted", count=len(v.rows))])
    body += k.body([k.t("devices.lede", "muted")])
    for row in v.rows:
        body += _gap(k)
        name = k.d(row.label, "device", "strong") if row.label else k.t("devices.unnamed", "strong")
        first = [name]
        if row.current:
            first += [k.sep(), k.t("part.thisDeviceTitle", "accent", formFactor="computer")]
        body += k.body(first)
        meta: List[Span] = []
        if row.platform and row.when:
            meta.append(k.t("devices.meta", "muted", platform=row.platform, when=row.when))
        elif row.platform:
            meta.append(k.d(row.platform, "platform", "muted"))
        if meta:
            meta.append(k.sep())
        meta.append(k.d(row.id, "id", "muted", nobreak=True))
        body += k.body(meta, 2)
    body += _gap(k)
    body += _fixes(k, [("devices rename <id> <name>", "devices.rename"), ("devices deauthorize <id>", "devices.remove")])
    return _frame(k, verb, body)


# ── Updates ──────────────────────────────────────────────────────────────────────────────────


def _progress_line(k: Kit, fraction: Optional[float], done: Optional[str], total: Optional[str], eta: Optional[str], key: str = "update.downloading") -> Lines:
    f = fraction or 0.0
    bar = k.bar(f)
    spans = bar + ([Span(" ")] if bar else []) + [k.d(f"{round(f * 100)}%", "percent")]
    out = k.body(spans)
    meta: List[Span] = []
    if done and total:
        meta.append(k.t(key, "muted", size=done, total=total, time=eta or ""))
    if eta and key == "update.downloading":
        meta += [k.sep(), k.t("update.timeLeft", "muted", time=eta)]
    if meta:
        out += k.body(meta)
    return out


def update(k: Kit, v: UpdateView, verb: str = "update") -> Lines:
    body: Lines = []
    end: List[Span] = []
    if v.state == "up-to-date":
        body += k.step("ok", [k.t("update.upToDate", "strong")])
        if v.current:
            body += k.body([k.t("account.version", "muted", version=v.current)])
    elif v.state == "blocked":
        body += k.step("warn", [k.t("update.blockedTitle", "strong")])
        body += k.body([k.t("update.blockedBody", product=k.inline_product)])
    elif v.state == "revoked-required-content":
        body += k.step("fail", [k.t("core.codes.pack-revoked.title", "strong")])
        body += k.body([k.t("update.revokedContent", product=k.inline_product)])
        body += _gap(k)
        body += _fixes(k, [("update apply", "update.install")])
    elif v.state == "ready":
        body += k.step("ok", [k.t("update.readyTitle", "strong", product=k.product, version=v.version)])
        body += k.body([k.t("update.readyBody", product=k.inline_product)])
    elif v.state == "downloading":
        body += k.step("active", [k.t("update.title", "strong", product=k.product, version=v.version)])
        body += _progress_line(k, v.fraction, v.done, v.total, v.eta)
        if k.env.interactive:
            end = k.hints([("Ctrl-C", "common.cancel")])
    else:
        if v.state == "mandatory":
            body += k.step("warn", [k.t("update.mandatoryTitle", "strong", product=k.inline_product)])
            body += k.body([k.t("update.mandatoryBody", product=k.inline_product)])
            body += k.body([k.t("update.title", "muted", product=k.product, version=v.version)])
        else:
            body += k.step("active", [k.t("update.title", "strong", product=k.product, version=v.version)])
            if v.current and v.size:
                body += k.body([k.t("update.current", "muted", version=v.current, size=v.size)])
            elif v.current:
                body += k.body([k.t("account.version", "muted", version=v.current)])
        if v.critical:
            body += k.body([*k.icon("warn", "warning"), k.t("update.critical")])
        if v.notes:
            body += _gap(k)
            body += k.body([k.t("update.whatsNew", "muted")])
            for note in v.notes[:3]:
                body += k.body([k.d(note, "notes")])
            if v.notes_url:
                body += k.body([k.t("update.allChanges", "muted", link=v.notes_url, version=v.version)])
        body += _gap(k)
        if v.state == "store":
            body += k.body([k.t("update.platform.generic", product=k.inline_product)])
            if v.listing_url:
                body += k.body([k.link(v.listing_url, None, "muted")])
        elif v.state == "platform":
            body += k.body([k.t("update.platform.generic", product=k.inline_product)])
        else:
            fixes = [("update apply", "update.install")] if v.installable else []
            body += _fixes(k, fixes + [("changelog", "update.whatsNew")])
    return _frame(k, verb, body, end)


def update_progress(k: Kit, v: ProgressView, verb: str = "packs") -> Lines:
    """UpdateProgress for content packs: queued, downloading, installing, failed, done."""
    body: Lines = []
    name = [k.d(v.name, "pack", "strong")] if v.name else [k.t("updateProgress.contentTitle", "strong")]
    if v.state == "queued":
        body += k.step("active", name)
        body += k.body([k.t("updateProgress.queued", "muted")])
    elif v.state == "downloading":
        body += k.step("active", name)
        body += _progress_line(k, v.fraction, v.done, v.total, v.eta, key="updateProgress.downloading")
    elif v.state == "installing":
        body += k.step("active", name)
        body += k.body([k.t("updateProgress.installing", "muted")])
    elif v.state == "failed":
        body += k.step("fail", name)
        title, message = _code_title_message(k, v.code)
        body += k.body([k.t("updateProgress.failed")])
        body += k.body([message])
        body += _gap(k)
        body += _fixes(k, [("packs ensure " + (v.name or "<pack>"), "common.tryAgain")])
    else:
        body += k.step("ok", name)
        body += k.body([k.t("updateProgress.done", "muted")])
    return _frame(k, verb, body)


def release_notes(k: Kit, v: ReleaseNotesView, verb: str = "changelog") -> Lines:
    body: Lines = []
    if v.state == "error":
        body += k.step("fail", [k.t("releaseNotes.error", "strong")])
        body += _gap(k)
        body += _fixes(k, [("changelog", "common.tryAgain")])
        return _frame(k, verb, body)
    body += k.step("active", [k.t("releaseNotes.title", "strong", product=k.inline_product)])
    if v.state == "empty":
        body += k.body([k.t("releaseNotes.empty", "muted")])
        return _frame(k, verb, body)
    for version, date, summary, url in v.entries:
        body += _gap(k)
        head: List[Span] = [k.t("releaseNotes.version", "strong", link=url, version=version)]
        if date:
            head += [k.sep(), k.t("releaseNotes.released", "muted", date=date)]
        body += k.body(head)
        for line in summary:
            if line.strip():
                body += k.body([k.d(line.strip(), "notes")], 2)
    return _frame(k, verb, body)


# ── Boot ─────────────────────────────────────────────────────────────────────────────────────


def boot_progress(k: Kit, stage: str, frame: int = 0, *, done: Optional[str] = None, total: Optional[str] = None) -> Lines:
    """One live line while the stage machine runs: the spinner and the stage's copy."""
    key = BOOT_STAGE_COPY.get(stage, "common.loading")
    if stage == "fetch" and done and total:
        return _wait_line(k, "boot.fetchingProgress", frame, size=done, total=total)
    return _wait_line(k, key, frame)


def boot(k: Kit, v: BootView, verb: str = "boot") -> Lines:
    body: Lines = []
    end: List[Span] = []
    if v.component == "PolarisKeyGate":
        return gate(k, _gate_needs(v), verb)
    if v.state in ("progress", "rolled-back"):
        # The terminal board's boot: the spinner line, then one result line, no frame.
        out: Lines = []
        if v.rolled_back:
            out += k.step("warn", [k.t("boot.rolledBack")])
        out += k.step("ok", [k.d(k.product, "product", "strong"), k.sep(), k.t("boot.ready", "muted")])
        if v.update_available:
            out += [Line([Span("   ")] + k.command("update", "update.availableTitle"))] if k.decor else [Line(k.command("update", "update.availableTitle"))]
        return out
    if v.state == "consent":
        body += k.step("active", [k.t("boot.consent.title", "strong")])
        key = "boot.consent.bodyMetered" if v.metered else "boot.consent.body"
        body += k.body([k.t(key, product=k.inline_product, size=v.size or "")])
        if k.env.interactive:
            end = k.hints([("y", "boot.consent.download"), ("n", "common.notNow")])
    elif v.state == "offline":
        body += k.step("warn", [k.t("boot.offline.title", "strong")])
        body += k.body([k.t("boot.offline.playable" if v.playable else "boot.offline.body")])
        body += _gap(k)
        body += _fixes(k, [("boot", "common.tryAgain")])
    elif v.state == "blocked":
        status = v.status if v.status in ("version-too-old", "version-too-new", "channel-not-entitled", "expired", "revoked") else "version-too-old"
        body += k.step("fail", [k.t(f"core.gate.{status}.title", "strong")])
        body += k.body([k.t(f"core.gate.{status}.message")])
        if status == "version-too-old":
            body += _gap(k)
            body += _fixes(k, [("update", "status.update")])
    elif v.state == "declined":
        body += k.step("warn", [k.t("boot.declined.title", "strong")])
        body += k.body([k.t("boot.declined.body", product=k.inline_product)])
        body += _gap(k)
        body += _fixes(k, [("boot", "common.tryAgain")])
    elif v.state == "fetching":
        body += boot_progress(k, "fetch", done=v.size, total=v.size)
    else:
        body += k.step("fail", [k.t("gate.error.title", "strong", product=k.inline_product)])
        body += k.body([k.t("boot.error.body", product=k.inline_product, code=v.code or "unknown")])
        body += _gap(k)
        body += _fixes(k, [("boot", "common.tryAgain")])
    return _frame(k, verb, body, end)


def _gate_needs(v: BootView) -> GateView:
    return GateView("PolarisKeyGate", "needs-activation", v.status or "needs-activation")


# ── Settings ─────────────────────────────────────────────────────────────────────────────────


def _value(v: Any) -> str:
    import json

    return json.dumps(v, ensure_ascii=False)


def settings(k: Kit, v: SettingsView, verb: str = "config") -> Lines:
    body: Lines = []
    if v.state == "error":
        title, message = _code_title_message(k, v.code)
        body += k.step("fail", [title])
        body += k.body([message])
        return _frame(k, verb, body)
    if v.state in ("saved",):
        body += k.step("ok", [k.t("settings.saved", "strong")])
    else:
        body += k.step("active", [k.t("settings.title", "strong")])
    if not v.rows:
        body += k.body([k.t("settings.empty", "muted")])
        return _frame(k, verb, body)
    width = min(max(len(r.key) for r in v.rows), max(12, k.body_width // 2 - 4))
    for row in v.rows:
        source = {
            "local": lambda: k.t("settings.source.local", "muted"),
            "env": lambda: k.t("settings.source.env", "muted"),
            "default": lambda: k.t("settings.source.default", "muted"),
            "enforced": lambda: (
                k.t("settings.setBy", "muted", org=row.org) if row.org else k.t("core.codes.managed_by_admin.title", "muted")
            ),
        }[row.source]()
        key = k.d(row.key, "setting", nobreak=True)
        pad = Span(" " * max(2, width - len(row.key) + 2))
        body += k.body([key, pad, k.d(_value(row.value), "value", "strong"), k.sep(), source])
    if v.state != "saved":
        body += _gap(k)
        body += _fixes(k, [("config set <key> <value>", None), ("config reset <key>", "settings.reset")])  # type: ignore[list-item]
    return _frame(k, verb, body)


# ── Diagnostics (developer verbs; plain data rows, no catalog component) ─────────────────────


def diagnostic(k: Kit, verb: str, rows: Sequence[Tuple[str, str]], *, ok: bool = True) -> Lines:
    """``doctor``, ``secret``, ``mint`` and the CLI's own errors: label/value rows for the person
    integrating the SDK, in the kit's frame. Their words are developer diagnostics, not product
    UI, so they are data here (the string lint's ``diagnostic`` source)."""
    body: Lines = []
    width = max((len(a) for a, _ in rows), default=0)
    for label, value in rows:
        if label:
            body += k.body([Span(label + " " * (width - len(label) + 2), ("muted",), None, "data:diagnostic"), Span(value, (), None, "data:diagnostic")])
        else:
            body += k.body([Span(value, (), None, "data:diagnostic")])
    return _frame(k, verb, body)
