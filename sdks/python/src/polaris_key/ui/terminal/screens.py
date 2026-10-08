"""The terminal kit's screens (layer b): one function per catalog component, a view in, lines out.

Each draws the terminal board's layout (docs/design/ui-kits/terminal.html, UI-KITS §8) with the
copy of SIGN-IN.md §5.2 and the catalog: the product chip on the header line, a continuous rail,
one glyph per step (``◆`` active, ``◇`` done, ``✓``, ``✗``, ``▲``), key hints on the last line.
Nothing is printed here; :mod:`.device` writes the lines, and :mod:`.flows` drives them.
"""

from __future__ import annotations

from dataclasses import replace
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
from .parts import STACK_COLUMNS, Kit
from .text import DROP, Line, Span, cell_len, wrap

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


def _close(k: Kit, lines: Lines) -> Lines:
    """End the rail on the last content row: a bare ``└`` row under a ``│`` row becomes that row's
    own ``└``, so no empty closing row hangs below the content."""
    if not k.decor or len(lines) < 2:
        return lines
    last, prev = lines[-1], lines[-2]
    rail, end = k.env.symbol["rail"], k.env.symbol["railEnd"]
    bare = len(last.spans) <= 2 and last.spans and last.spans[0].text == end and not "".join(s.text for s in last.spans[1:]).strip()
    if bare and len(prev.spans) > 1 and prev.spans[0].text == rail and "".join(s.text for s in prev.spans[1:]).strip():
        first = Span(end, prev.spans[0].roles, None, "symbol")
        return lines[:-2] + [Line([first] + prev.spans[1:], prev.drop, prev.role, prev.hint_spans)]
    return lines


def _frame(k: Kit, verb: str, body: Lines, end: Sequence[Span] = (), hints: bool = False) -> Lines:
    out = [k.header(verb)]
    if k.decor:
        out += [replace(ln, role="header") for ln in k.gap()]
    out += body
    out += k.end(end, hints)
    return _close(k, out)


def _gap(k: Kit, tier: int = DROP["blank_prose"]) -> Lines:
    """One blank rail row between blocks (dropped only when the screen does not fit)."""
    return k.gap(tier)


def _fixes(k: Kit, fixes: Sequence[Tuple[str, str]]) -> Lines:
    """Fix commands, aligned: ``polaris-key activate   Use a different key``. Below 50 columns, or
    when a row would not fit its line, each command stacks above its label."""
    if not fixes:
        return []
    width = max(len(f"{k.prog} {w}") for w, _ in fixes)
    rows = [k.command(w, label, width) for w, label in fixes]
    if k.env.width >= STACK_COLUMNS and all(k.fits(r) for r in rows):
        return [Line(k._prefix("rail") + r) for r in rows]
    out: Lines = []
    for w, label in fixes:
        # A command wider than the line wraps at its spaces with a four-cell hanging indent, deeper
        # than the label under it.
        for i, ln in enumerate(wrap(k.command(w), max(1, k.body_width - 4))):
            out.append(Line(k._prefix("rail") + ([Span("    ")] if i else []) + ln))
        if label:
            out += k.body([k.t(label, "muted")], 2)
    return out


def _code_row(k: Kit, code: str) -> Lines:
    """The user code in reverse video, under the content column (wrapped after a hyphen, never
    cut, when it is wider than a line)."""
    return [replace(ln, keep=True) for ln in k.body(([Span("   ")] if k.decor and not k.narrow else []) + [k.code(code)])]


def _code_title_message(k: Kit, code: Optional[str], *, group: str = "codes") -> Tuple[Span, Span]:
    """The catalog's title and message for a registry ``code``, else the fallback."""
    if code and k.copy.has(f"core.{group}.{code}.title") and k.copy.has(f"core.{group}.{code}.message"):
        return k.t(f"core.{group}.{code}.title", "strong"), k.t(f"core.{group}.{code}.message")
    if code and k.copy.has(f"core.{group}.{code}.message"):
        return k.t("core.fallback.title", "strong"), k.t(f"core.{group}.{code}.message")
    return k.t("core.fallback.title", "strong"), k.t("core.fallback.message", code=code or "unknown")


# ── PolarisKeyGate, StatusScreen, GraceBanner, AccountAndLicense: `status` ───────────────────


def _unit(span: Span) -> Span:
    return replace(span, unit=True)


def _account_rows(k: Kit, v: GateView) -> Lines:
    """The board's table: one ✓ row per fact, the datum in bold and its detail in muted. Each name,
    email and date is a keep-unit, so a narrow line breaks between them, never inside."""
    seat = k.sep()
    license_value: List[Span] = [k.u(v.tier, "tier", "strong") if v.tier else _unit(k.t("part.status.ok", "strong"))]
    if v.term:
        license_value += [seat, k.u(v.term, "term", "muted")]
    holder = v.email or v.holder
    license_value += [seat, k.u(holder, "email", "muted")] if v.signed_in and holder else [seat, _unit(k.t("account.keyOnly", "muted"))]
    rows: List[Tuple[str, Span, Sequence[Span]]] = [("ok", k.t("cli.status.license"), license_value)]
    if v.seats_used is not None and v.seats_limit:
        rows.append(("ok", k.t("cli.status.devices"), [_unit(k.t("cli.status.seatsOf", "strong", used=v.seats_used, limit=v.seats_limit))]))
    if v.grace_until:
        rows.append(("ok", k.t("cli.status.offline"), [_unit(k.t("cli.status.offlineUntil", "strong", date=fmt.date(v.grace_until, k.copy.locale)))]))
    if v.version:
        value: List[Span] = [k.u(v.version, "version", "strong")]
        if v.channel:
            value += [seat, k.u(v.channel, "channel", "muted")]
        rows.append(("ok", k.t("cli.status.version"), value))
    return k.table(rows)


def gate(k: Kit, v: GateView, verb: str = "status") -> Lines:
    """The ``status`` verb: the account summary when licensed, the grace line offline, the
    blocked state with its fix as a command, or the activation prompt."""
    body: Lines = []
    end: List[Span] = []
    if v.component == "AccountAndLicense":
        body += _account_rows(k, v)
    elif v.component == "GraceBanner":
        if v.state == "last-day":
            body += k.step("warn", [k.t("grace.lastDay", "strong", product=k.inline_product)])
        else:
            body += k.step("warn", [k.t("grace.daysLeft", "strong", days=v.days_left or 0)])
        if v.grace_until:
            body += k.body([k.t("grace.deadline", "muted", date=fmt.date(v.grace_until, k.copy.locale))])
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
            # A revoked device cannot be fixed by signing out: use another key, or the account's license.
            "revoked": [("activate", "signin.key.differentKey"), ("login", "cli.fix.signIn")],
            "expired": [("activate", "status.renew")],
            "version-too-old": [("update", "status.update")],
            "version-too-new": [],
            "channel-not-entitled": [("update --channel <name>", "status.switchChannel")],
        }[v.state]
        if fixes:
            body += _gap(k)
            body += k.body([k.t("cli.status.fixes", product=k.product)])
            body += _fixes(k, fixes)
        if v.state == "channel-not-entitled" and v.developer:
            body += k.body([k.t("status.contact", "muted", developer=v.developer)])
    elif v.state == "licensed":
        body += k.step("ok", [k.t("core.gate.not-applicable.title", "strong")])
        body += k.body([k.t("core.gate.not-applicable.message", "muted")])
    else:
        # The command rows say what a lede above them would, so there is none.
        body += k.step("active", [k.t("core.gate.needs-activation.title", "strong")])
        body += _gap(k)
        body += _fixes(k, [("activate", "welcome.useKey"), ("login", "welcome.signIn")])
    return _frame(k, verb, body, end)


# ── Activate, DeviceLimit ────────────────────────────────────────────────────────────────────


def _masked(k: Kit, raw: str, verdict: KeyVerdict) -> List[Span]:
    """The key as typed, masked: the public ``pkey_<product>_`` prefix, then bullets, never a
    character of the secret (the Node kit's rule)."""
    return [k.key_mask(raw)]


def other_product(k: Kit, verdict: KeyVerdict) -> bool:
    """A parsed key that belongs to another product than this command's."""
    return verdict.state == "parsed" and bool(verdict.slug) and verdict.slug != _slug_of(k)


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
    elif other_product(k, verdict):
        body += k.body([*k.icon("warn", "warning"), k.t("cli.activate.otherProduct", app=verdict.slug, product=k.product)])
    elif verdict.state == "parsed":
        body += k.body([*k.icon("ok", "success"), k.t("part.keyField.forProduct", "muted", product=k.product)])
    elif verdict.state == "cut-short":
        body += k.body([*k.icon("fail", "danger"), k.t("part.keyField.cutShort", prefix=verdict.prefix, used=verdict.used, limit=verdict.limit)])
    elif verdict.state == "malformed":
        body += k.body([*k.icon("fail", "danger"), k.t("part.keyField.malformed")])
    elif verdict.state == "empty" and show_empty:
        body += k.body([*k.icon("fail", "danger"), k.t("part.keyField.empty")])
    hints = [] if busy else k.hint_string("cli.keys.activate")
    return _frame(k, verb, body, hints, bool(hints))


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
        body += _fixes(k, [("login", "welcome.signIn")])
    else:
        kind = v.kind if k.copy.has(f"core.activation.{v.kind}.title") else "error"
        body += k.step("fail", [k.t(f"core.activation.{kind}.title", "strong")])
        body += k.body([k.t(f"core.activation.{kind}.message", code=v.code or kind)])
        if kind == "unauthorized":
            body += _gap(k)
            body += _fixes(k, [("activate", "signin.key.differentKey")])
        elif kind == "enroll-claimed":
            body += _gap(k)
            body += _fixes(k, [("login", "welcome.signIn")])
    return _frame(k, verb, body, end)


def device_limit(k: Kit, v: ActivateView, verb: str = "activate", *, opened: bool = False, ended: bool = False) -> Lines:
    """DeviceLimit in browser mode (UI-KITS §4.3: layer 1 has no device list for a key, so
    **Replace a device** opens ``manageUrl``), then **Try again**. The board: the answered key row,
    the title, the meter as dots only, one sentence, the page that frees a seat, the hints (or, once
    the person left with Esc, the line that says what to run)."""
    body: Lines = _key_done(k, v.key)
    if v.used is not None and v.limit is not None:
        body += k.step("warn", [k.t("deviceLimit.heading", "strong", used=v.used, limit=v.limit)])
        body += k.body(k.seat_meter(v.used, v.limit))
    else:
        body += k.step("warn", [k.t("core.activation.device-limit.title", "strong")])
    end: List[Span] = []
    hints = False
    if v.manage_url:
        # The terminal does not poll: it never promises the product continues by itself.
        body += k.body([k.t("cli.deviceLimit.body")])
        body += [replace(ln, keep=True) for ln in k.body([k.link(v.manage_url, None, "muted")])]
        if ended:
            end = [k.t("cli.deviceLimit.again", command=f"{k.prog} {verb}")]
        elif k.env.interactive:
            end, hints = k.hint_string("cli.keys.retry" if opened else "cli.keys.deviceLimit"), True
    else:
        body += k.body([k.t("core.activation.device-limit.message")])
        body += _gap(k)
        body += _fixes(k, [(verb, "common.tryAgain")])
    return _frame(k, verb, body, end, hints)


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
    # The glyph takes the rail's column; a status that is wider than the line wraps under itself,
    # and the waiting role sits on its last line (where the key hints join).
    rows = wrap([k.t(key, **args)], k.body_width - (2 if k.narrow else 0)) or [[]]
    mark = Span(glyph, ("muted",), None, "symbol")
    out = [Line([mark, Span(" " if k.narrow else "  ")] + rows[0])]
    for r in rows[1:]:
        out.append(Line(([Span("  ")] if k.narrow else k._prefix("rail")) + r))
    out[-1] = replace(out[-1], role="spinner")
    return out


def _again(k: Kit, verb: str) -> Lines:
    """The command that starts the flow over, for the verb the person ran (never another's)."""
    return _gap(k) + _fixes(k, [(verb, "signin.again")])


def sign_in(k: Kit, v: SignInView, verb: str = "sign-in", *, frame: int = 0) -> Lines:
    """``login`` / ``sign-in``: the browser presentation (no QR on any terminal, D-67). The whole
    screen is one frame: it compacts by fit while it waits (``screen.fit_screen``) and its ending is
    one result block, never the code view above it."""
    body: Lines = []
    end: List[Span] = []
    hints = False
    url = v.url or DEVICE_CODE_URL
    wait = "signin.handoff.finishing" if v.state == "finishing" else "cli.signin.waitingCode"
    if v.state == "starting":
        body += _wait_line(k, "signInHandoff.starting", frame)
    elif v.state in ("handoff", "finishing") and v.component == "SignIn":
        body += k.step("done", [k.t("signin.cli.opening")])
        if v.url_complete:
            body += _if_not_opened(k, v.url_complete)
        body += _gap(k)
        body += _wait_line(k, "signin.handoff.finishing" if v.state == "finishing" else "signin.handoff.waiting", frame)
        if k.env.interactive and v.state != "finishing":
            end, hints = k.hint_string("signin.cli.keys"), True
    elif v.state in ("code", "link-copied", "no-browser") or (v.state == "finishing" and v.component == "SignInHandoff"):
        if v.headless and not k.env.device_code:
            # No browser here: say so. Someone who asked for a code (--device-code) needs no note.
            body += k.step("done", [k.t("signin.cli.headless")])
        elif v.no_browser:
            body += k.step("warn", [k.t("signin.handoff.noBrowser", "strong")])
        elif not v.headless or k.env.device_code:
            body += k.step("active", [k.t("signin.handoff.codeTitle", "strong")])
        body += _with_link(k, "signin.handoff.codeBody", url)
        body += _code_rows(k, v.user_code or "")
        body += [replace(ln, drop=DROP["check"]) for ln in k.body([k.t("signin.handoff.check")])]
        if v.seconds_left is not None:
            body += [
                replace(ln, drop=DROP["countdown"])
                for ln in k.body([k.t("signin.handoff.expires", "muted", time=fmt.countdown(v.seconds_left))])
            ]
        body += _gap(k)
        body += _wait_line(k, wait, frame)
        if k.env.interactive and v.state != "finishing":
            browser = not v.headless and not v.no_browser
            end, hints = _code_hints(k, browser, v.copied), True
    elif v.state == "done":
        who = [k.t("signin.cli.signedIn", name=v.name, email=v.email)] if (v.name and v.email) else [k.t("account.holder", name=v.name or v.email or k.product)]
        body += k.step("ok", who)
        end = [k.t("signin.cli.closeTab", "muted")] if not v.headless else []
    else:
        # One result block: the title and the command that starts over, nothing that restates it.
        code = v.code or ("cancelled" if v.state == "cancelled" else "sign-in-failed")
        if code == "identity_disabled":
            # What happened, then the fix: this product takes a license key, not an account.
            body += k.step("fail", [k.t("cli.identityOff.notice", "strong", product=k.inline_product)])
            body += k.body([k.t("cli.identityOff.fix", command=f"{k.prog} activate")])
        else:
            title, _ = _code_title_message(k, code, group="codes")
            body += k.step("fail", [title])
            if v.state in ("expired", "denied", "cancelled"):
                body += _again(k, verb)
    return _frame(k, verb, body, end, hints)


def _code_hints(k: Kit, browser: bool, copied: bool) -> List[Span]:
    """The code view's key hints, in the catalog's words (the Node kit's too): ``c copy the code``
    gives way to ``Copied`` on the same row, and ``o`` appears only where a browser can open."""
    key = "cli.keys.codeBrowser" if browser else "cli.keys.code"
    spans = k.hint_string(key)
    if not copied:
        return spans
    # Drop the first hint (the copy key and its label) and put "✓ Copied" in its place.
    rest: List[Span] = []
    seen_sep = False
    for sp in spans:
        if seen_sep:
            rest.append(sp)
        elif sp.src == "symbol" and sp.text.strip() == k.env.symbol["separator"]:
            seen_sep = True
            rest.append(sp)
    mark = [*k.icon("ok", "success"), k.t("common.copied", "success")]
    return mark + rest


def _code_rows(k: Kit, code: str) -> Lines:
    """The user code with a blank rail row on each side (dropped only when the screen is tall)."""
    return _gap(k, DROP["blank_code"]) + _code_row(k, code) + _gap(k, DROP["blank_code"])


def _with_link(k: Kit, key: str, url: str) -> Lines:
    """A message with ``{url}`` inside, the URL drawn as a link (OSC 8) and never broken."""
    marker = "￿"
    text = k.s(key, url=marker)
    before, _, after = text.partition(marker)
    spans = [Span(before, (), None, "key:" + key), k.link(url), Span(after, (), None, "key:" + key)]
    # The lines that hold the URL stay when the screen is cut to the height; the lead-in goes first.
    return [
        replace(ln, keep=any(sp.src == "data:url" for sp in ln.spans))
        for ln in k.body([s for s in spans if s.text])
    ]


def _if_not_opened(k: Kit, url: str) -> Lines:
    return _with_link(k, "signin.cli.ifNotOpened", url)


# ── OfflineActivation ────────────────────────────────────────────────────────────────────────


def offline_activation(k: Kit, v: OfflineView, verb: str = "offline-request") -> Lines:
    body: Lines = []
    if v.state == "default":
        # The chip already names the product: no "Product: …" line. One footer command row says
        # what to do with the file that comes back, and the rail ends on it.
        head = k.step("active", [k.t("offlineActivation.title", "strong")]) + k.body([k.t("offlineActivation.request")])
        footer = _fixes(k, [("import-bundle <file>", "cli.verb.importBundle")])
        code = _code_row(k, v.request_code or "")
        plain = _frame(k, verb, head + _gap(k) + code + _gap(k) + footer)
        spans = k.qr_spans(v.request_code or "")
        if spans:
            # Landscape: the QR beside the request, top-aligned with its title, when the line has
            # room for both and the QR fits the height.
            left_w = max((ln.width for ln in plain), default=0)
            qr_w = max(cell_len(sp.text) for sp in spans)
            title_at = 2 if k.decor else 0
            if k.env.columns >= 100 and left_w + 2 + qr_w <= k.env.columns and title_at + len(spans) <= k.env.height - 1:
                rail = k.rail()
                out: Lines = []
                for i in range(max(len(plain), title_at + len(spans))):
                    left = plain[i] if i < len(plain) else rail
                    j = i - title_at
                    if 0 <= j < len(spans):
                        pad = Span(" " * (left_w - left.width + 2))
                        left = Line(left.spans + [pad, spans[j]], left.drop, left.role, left.hint_spans)
                    out.append(left)
                return out
            # Portrait: under the code, its own quiet zone the gap, when the whole screen fits.
            stacked = _frame(k, verb, head + _gap(k) + code + k.qr(v.request_code or "") + footer)
            if len(stacked) + 1 <= k.env.height:
                return stacked
        return plain
    elif v.state == "done":
        body += k.step("ok", [k.t("offlineActivation.done", "strong")])
        if v.imported:
            body += k.body([k.d(" + ".join(v.imported), "imported", "muted")])
    else:
        # One title and who to ask for a new file: the same two lines in both kits.
        body += k.step("fail", [k.t("core.codes.bundle.title", "strong")])
        body += k.body([k.t("cli.import.fix")])
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
    # The title with the bare count, then one item per device: the name after its dot, and under it
    # the platform (with when it was last seen), the id and which one is this. One left edge for
    # an item's text: a continuation hangs under the name, never under the dot.
    body += k.step("active", [k.t("devices.title", "strong"), k.sep(), k.d(len(v.rows), "count", "muted")])
    for row in v.rows:
        name = _unit(k.d(row.label, "device", "strong")) if row.label else _unit(k.t("devices.unnamed", "strong"))
        radio = k.sym("radioOn", "accent") if row.current else k.sym("radioOff", "muted")
        meta: List[Span] = []
        if row.platform and row.when:
            meta.append(_unit(k.t("devices.meta", "muted", platform=row.platform, when=row.when)))
        elif row.platform:
            meta.append(k.u(row.platform, "platform", "muted"))
        if meta:
            meta.append(k.sep())
        meta.append(Span(row.id, ("muted",), None, "data:id", True, True))
        if row.current:
            meta += [k.sep(), _unit(k.t("part.thisDeviceTitle", "muted", formFactor="computer"))]
        lines = wrap([name], max(1, k.body_width - 2)) + wrap(meta, max(1, k.body_width - 2))
        for i, ln in enumerate(lines):
            lead = [radio, Span(" ")] if i == 0 else [Span("  ")]
            body.append(Line(k._prefix("rail") + lead + ln))
    body += _gap(k)
    body += _fixes(k, [("devices rename <id> <name>", "devices.rename"), ("devices deauthorize <id>", "devices.remove")])
    return _frame(k, verb, body)


# ── Updates ──────────────────────────────────────────────────────────────────────────────────


def _progress_line(
    k: Kit,
    fraction: Optional[float],
    done: Optional[str],
    total: Optional[str],
    eta: Optional[str],
    key: str = "update.downloading",
    *,
    done_bytes: Optional[int] = None,
    total_bytes: Optional[int] = None,
    eta_seconds: Optional[float] = None,
) -> Lines:
    """The download's progress: the bar (at least 16 cells), the percentage, then the figures. As
    the line narrows the figures give way in order: the time left goes, then the sizes shorten to
    ``38/61 MB``, then they move to their own muted line under the bar. Each number keeps its unit,
    and the time left is left out until it is known (never ``0 s left``)."""
    f = fraction or 0.0
    pct = k.d(f"  {round(f * 100)}%", "percent", "strong")
    if done_bytes is None or total_bytes is None or not k.decor:
        bar = k.bar(f)
        out = k.body(bar + ([Span(" ")] if bar else []) + [k.d(f"{round(f * 100)}%", "percent")])
        meta: List[Span] = []
        if done and total:
            meta.append(k.t(key, "muted", size=done, total=total, time=eta or ""))
        if eta and key == "update.downloading":
            meta += [k.sep(), k.t("update.timeLeft", "muted", time=eta)]
        return out + (k.body(meta) if meta else [])
    loc = k.copy.locale
    n, whole = fmt.size_pair(done_bytes, total_bytes, loc)
    long = _unit(k.t("cli.update.figures", "muted", size=n, total=whole))
    short = _unit(k.t("cli.update.figuresShort", "muted", size=n, total=whole))
    left = _unit(k.t("cli.update.timeLeft", "muted", time=fmt.duration(eta_seconds, loc))) if eta_seconds and eta_seconds >= 1 else None
    variants: List[List[Span]] = [[long, left] if left else [long], [long], [short]]
    seen: List[List[Span]] = []
    for v in variants:
        if v not in seen:
            seen.append(v)
    for parts in seen:
        meta = []
        for i, sp in enumerate(parts):
            meta += ([k.sep()] if i == 0 else [k.sep()]) + [sp]
        room = k.body_width - cell_len(pct.text) - sum(cell_len(sp.text) for sp in meta)
        if room >= 16:
            return [Line(k._prefix("rail") + k.bar(f, min(36, room)) + [pct] + meta)]
    # Narrower still: the figures on their own muted line under the bar.
    out = [Line(k._prefix("rail") + k.bar(f, max(10, min(36, k.body_width - cell_len(pct.text)))) + [pct])]
    return out + [Line(k._prefix("rail") + [long])]


def update(k: Kit, v: UpdateView, verb: str = "update") -> Lines:
    body: Lines = []
    end: List[Span] = []
    hints = False
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
        # One result block replaces the title and the bar; the chip already names the product.
        title = k.t("cli.update.ready", "strong", version=v.version, size=v.size) if v.size else k.t("cli.update.readyNoSize", "strong", version=v.version)
        body += k.step("ok", [title])
        body += k.body([k.t("cli.update.restart")])
    elif v.state == "downloading":
        body += k.step("active", [k.t("update.title", "strong", product=k.product, version=v.version)])
        body += _progress_line(k, v.fraction, v.done, v.total, v.eta, done_bytes=v.done_bytes, total_bytes=v.total_bytes, eta_seconds=v.eta_seconds)
        if k.env.interactive:
            end, hints = k.hint_string("cli.keys.download"), True
    elif v.state == "failed":
        # What happened, that nothing was installed, and the command to try again.
        body += k.step("fail", [k.t(f"core.codes.{v.code}.title", "strong") if v.code and k.copy.has(f"core.codes.{v.code}.title") else k.t("core.fallback.title", "strong")])
        body += k.body([k.t("cli.update.nothingInstalled")])
        body += _gap(k)
        body += _fixes(k, [("update apply", "common.tryAgain")])
    elif v.state == "cancelled":
        body += k.step("fail", [k.t("cli.update.cancelled", "strong")])
    else:
        if v.state == "mandatory":
            body += k.step("warn", [k.t("update.mandatoryTitle", "strong", product=k.inline_product)])
            body += k.body([k.t("update.mandatoryBody", product=k.inline_product)])
            if v.critical:
                body += k.body([*k.icon("warn", "warning"), k.t("update.critical")])
            body += _gap(k)
            body += _fixes(k, [("update apply", "cli.update.install")] if v.installable else [])
        elif v.state in ("store", "platform"):
            body += k.step("active", [k.t("update.title", "strong", product=k.product, version=v.version)])
            if v.critical:
                body += k.body([*k.icon("warn", "warning"), k.t("update.critical")])
            body += _gap(k)
            body += k.body([k.t("update.platform.generic", product=k.inline_product)])
            if v.state == "store" and v.listing_url:
                body += k.body([k.link(v.listing_url, None, "muted")])
        else:
            # "2.5.0 is available", what you have now, and the two commands that follow from it.
            title = k.t("cli.update.available", "strong", version=v.version, size=v.size) if v.size else k.t("cli.update.availableNoSize", "strong", version=v.version)
            body += k.step("active", [title])
            if v.current:
                body += k.body([k.t("cli.update.have", "muted", version=v.current)])
            if v.critical:
                body += k.body([*k.icon("warn", "warning"), k.t("update.critical")])
            body += _gap(k)
            body += _fixes(k, ([("update apply", "cli.update.install")] if v.installable else []) + [("changelog", "update.whatsNew")])
    return _frame(k, verb, body, end, hints)


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
        body += k.body([k.t("cli.changelog.fix", command=f"{k.prog} {verb}")])
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
            out += _fixes(k, [("update", "update.availableTitle")])
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
