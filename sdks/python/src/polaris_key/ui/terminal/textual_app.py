"""The optional Textual app (``pip install polaris-key[tui]``; UI-KITS §5.1 "Terminal (rich, Textual)",
§8 terminal board "Textual app").

``run_app(client)`` opens a full-screen account view for a product: Account and license, Devices
and Updates in a side list, the product name and the section in the header, key hints in the
footer. It renders the same headless models and catalog copy as the CLI (layer c), in a Textual
theme built from the brand tokens and the product's resolved accent (``preset="native"`` keeps
Textual's own theme). Buttons share one shape, a one-row block with one cell of padding: the
primary in the accent, the secondary tonal, never bracketed text beside blocks.

Importing this module needs Textual; nothing else in the SDK does.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.theme import Theme as TextualTheme
from textual.widgets import Button, Footer, ListItem, ListView, Static

from .. import _tokens
from ..core.copy import Copy
from ..core.identity import ResolvedIdentity, presentation_source, resolve_identity
from ...core.models import license_user
from ..core.models import DevicesView, DeviceRow, GateView, UpdateView, gate_view, update_view
from ..core.theme import Theme
from . import fmt
from .fmt import platform_name
from .screens import portal_url
from .text import clean

__all__ = ["PolarisKeyApp", "run_app", "SECTIONS"]

#: Under this many columns the sections are one row under the header; under this many rows the
#: pane drops its padding (UI-KITS §7.1: the 60- and 40-column and short renders).
NARROW_COLUMNS = 70
SHORT_ROWS = 14

#: The side list: (id, catalog key).
SECTIONS: Tuple[Tuple[str, str], ...] = (
    ("account", "account.title"),
    ("devices", "account.devices"),
    ("updates", "account.updates"),
)


def textual_theme(identity: ResolvedIdentity, scheme: str) -> TextualTheme:
    """A Textual theme from the brand tokens, with the product's resolved accent as primary
    (ink when the product has none)."""
    t = _tokens.THEMES[scheme]
    accent = identity.accent(scheme)
    primary = accent.solid if accent is not None else t["text_strong"]
    return TextualTheme(
        name=f"polaris-key-{scheme}",
        primary=primary,
        secondary=t["text_muted"],
        accent=accent.fg if accent is not None else t["text_strong"],
        foreground=t["text_default"],
        background=t["surface_page"],
        surface=t["surface_raised"],
        panel=t["surface_overlay"],
        success=t["success"],
        warning=t["warning"],
        error=t["danger"],
        dark=scheme == "dark",
        variables=kit_variables(identity, scheme),
    )


def kit_variables(identity: ResolvedIdentity, scheme: str) -> Dict[str, str]:
    """The kit's own CSS variables: the label on the primary, muted text, the selection tint."""
    t = _tokens.THEMES[scheme]
    accent = identity.accent(scheme)
    return {
        "pk-on-primary": accent.on if accent is not None else t["surface_page"],
        "pk-muted": t["text_muted"],
        "pk-subtle": accent.subtle if accent is not None else t["surface_sunken"],
    }


class PolarisKeyApp(App):
    """The account view. ``data`` (for tests and the sample) replaces the client's reads."""

    CSS = """
    Screen { layout: vertical; }
    #pk-header { height: 1; padding: 0 1; background: $pk-subtle; color: $text; }
    #pk-body { height: 1fr; }
    #pk-nav { width: 26; border-right: solid $panel-lighten-2; padding: 1 0; }
    #pk-nav > ListItem { padding: 0 2; }
    #pk-nav > ListItem.-highlight { background: $pk-subtle; color: $text; }
    #pk-nav:focus > ListItem.-highlight { text-style: bold reverse; }
    #pk-main { padding: 1 3; }
    .pk-title { text-style: bold; }
    .pk-muted { color: $pk-muted; }
    .pk-refusal { color: $warning; text-style: bold; }
    .pk-error { color: $error; }
    .pk-row { height: auto; }
    .pk-gap { margin-top: 1; }
    .pk-actions { height: auto; margin-top: 1; }
    .pk-note { margin-top: 1; }
    Button { min-width: 0; height: 1; border: none; padding: 0 1; margin: 0 1 0 0; text-style: bold; }
    Button.pk-primary { background: $primary; color: $pk-on-primary; }
    Button.pk-secondary { background: $foreground 16%; color: $text; }
    Button:focus { text-style: bold reverse underline; }

    /* Narrow (under 70 columns): the sections are one row under the header and the pane takes
       the full width; the actions stack whole (UI-KITS §1.5 rule 10), never two and one. */
    .-narrow #pk-body { layout: vertical; }
    .-narrow #pk-nav { layout: horizontal; width: 100%; height: 1; border-right: none; padding: 0; }
    .-narrow #pk-nav > ListItem { width: auto; height: 1; padding: 0 1; }
    .-narrow #pk-nav > ListItem > Static { width: auto; }
    .-narrow #pk-main { padding: 1 1; }
    .-narrow .pk-actions { layout: vertical; }
    .-narrow Button { margin: 0 0 1 0; }
    /* Short (under 14 rows): no spare rows, so the pane drops its padding and gaps. */
    .-short #pk-main { padding: 0 1; }
    .-short .pk-gap, .-short .pk-actions, .-short .pk-note { margin-top: 0; }
    .-short Button { margin-bottom: 0; }
    """

    ENABLE_COMMAND_PALETTE = False

    #: Arrows move through the sections from the pane as well as from the list.
    BINDINGS = [
        Binding("up", "section(-1)", show=False),
        Binding("left", "section(-1)", show=False),
        Binding("down", "section(1)", show=False),
        Binding("right", "section(1)", show=False),
    ]

    def __init__(
        self,
        client: Any = None,
        *,
        theme: Optional[Theme] = None,
        product: Optional[str] = None,
        scheme: str = "dark",
        data: Optional[Dict[str, Any]] = None,
        manage_url: Optional[str] = None,
    ) -> None:
        self.client = client
        self.kit_theme = theme or Theme()
        self.copy = Copy(self.kit_theme.locale, self.kit_theme.copy_overrides)
        slug = product or getattr(client, "product", None)
        self.identity = resolve_identity(
            integrator=self.kit_theme.product, source=presentation_source(client), slug=slug, accent=self.kit_theme.accent
        )
        self.scheme = scheme if self.kit_theme.color_scheme == "system" else self.kit_theme.color_scheme
        self.data = data or {}
        self.manage_url = manage_url
        self.section = "account"
        #: The account pane's second step: "Sign out of {product}?" with its Cancel.
        self.confirming = False
        #: Why the last update check or device read could not run.
        self._update_error: Optional[BaseException] = None
        self._devices_error: Optional[BaseException] = None
        #: A message for the slot of the pane that is about to be built.
        self._pending_note: Optional[Tuple[str, bool]] = None
        super().__init__()
        self.title = clean(self.identity.name)
        # The one key binding, labelled from the catalog.
        self.bind("q", "quit", description=self.copy("common.close"))

    # ── Data (the SDK, or the fixture data) ───────────────────────────────────────────────

    def gate(self) -> GateView:
        if "gate" in self.data:
            return self.data["gate"]
        c = self.client
        st = c.status()
        profile = c.license.get_profile() if hasattr(c, "license") else None
        return gate_view(
            st.status,
            now=0,
            grace_until=getattr(st, "graceUntil", None),
            holder=getattr(profile, "name", None) if profile else None,
            email=getattr(profile, "email", None) if profile else None,
            signed_in=license_user(profile) is not None,
            version=getattr(getattr(c, "core", None), "version", None),
        )

    def devices(self) -> DevicesView:
        self._devices_error = None
        if "devices" in self.data:
            return self.data["devices"]
        try:
            rows = tuple(DeviceRow(d.id, d.label, d.platform, bool(d.current)) for d in self.client.list_devices())
        except Exception as e:
            if getattr(e, "code", None) == "device-management-unsupported" or type(e).__name__.startswith("DeviceManagementUnsupported"):
                return DevicesView("Devices", "browser-mode")
            # A read that failed is an error with Try again, never "no devices" (DL7).
            self._devices_error = e
            return DevicesView("Devices", "failed")
        return DevicesView("Devices", "list" if rows else "empty", rows)

    def update_state(self) -> Any:
        self._update_error = None
        if "update" in self.data:
            return self.data["update"]
        current = getattr(self.client.core, "version", None)
        try:
            if not self.client.update.configured:
                # No signed updates here: the unsigned version check, as `update check` does.
                vc = self.client.update.check()
                return UpdateView("UpdatePrompt", "available" if vc.updateAvailable else "up-to-date", vc.version if vc.updateAvailable else None, current, notes_url=vc.url or None, installable=False)
            return update_view(self.client.update.decide().decision, current=current)
        except Exception as e:
            self._update_error = e
            return None

    def page_url(self) -> Optional[str]:
        """The product's page where a license is renewed, replaced or checked: the host's
        ``manage_url``, else the portal link the plain terminal names."""
        return self.manage_url or portal_url(self.client)

    # ── Layout ────────────────────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        yield Static(self._header("account.title"), id="pk-header")
        with Horizontal(id="pk-body"):
            yield ListView(*[ListItem(_text(self.copy(key)), id=f"pk-{sid}") for sid, key in SECTIONS], id="pk-nav")
            main = VerticalScroll(id="pk-main")
            # Not a tab stop of its own: Tab goes list, then the pane's buttons.
            main.can_focus = False
            yield main
        yield Footer()

    def get_theme_variable_defaults(self) -> Dict[str, str]:
        return {**super().get_theme_variable_defaults(), **kit_variables(self.identity, self.scheme)}

    def on_mount(self) -> None:
        if self.kit_theme.preset == "native":
            self.theme = "textual-dark" if self.scheme == "dark" else "textual-light"
        else:
            th = textual_theme(self.identity, self.scheme)
            self.register_theme(th)
            self.theme = th.name
        self._fit(self.size)
        self.show("account")
        self.focus_primary()

    def on_resize(self, event: Any) -> None:
        self._fit(event.size)

    def _fit(self, size: Any) -> None:
        self.set_class(size.width < NARROW_COLUMNS, "-narrow")
        self.set_class(size.height < SHORT_ROWS, "-short")
        if self.is_mounted_pane():
            self.query_one("#pk-header", Static).update(self._header(dict(SECTIONS)[self.section]))

    def is_mounted_pane(self) -> bool:
        return bool(self.query("#pk-header"))

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if event.item is not None and event.item.id and event.item.id[3:] != self.section:
            self.show(event.item.id[3:])

    def action_section(self, step: int) -> None:
        ids = [sid for sid, _ in SECTIONS]
        i = max(0, min(len(ids) - 1, ids.index(self.section) + step))
        if ids[i] != self.section:
            self.show(ids[i])

    def show(self, section: str) -> None:
        """Switch the pane. The state changes now; the pane is rebuilt in order on the app's own
        loop, the old one gone before the new one is mounted (ids repeat from pane to pane)."""
        if section != self.section:
            self.confirming = False
        self.section = section
        self.call_later(self._rebuild)

    async def _rebuild(self) -> None:
        section = self.section
        main = self.query_one("#pk-main", VerticalScroll)
        await main.remove_children()
        await main.mount_all(self._section(section))
        self.query_one("#pk-header", Static).update(self._header(dict(SECTIONS)[section]))
        nav = self.query_one("#pk-nav", ListView)
        index = [sid for sid, _ in SECTIONS].index(section)
        if nav.index != index:
            nav.index = index
        if self._pending_note is not None:
            text, error = self._pending_note
            self._pending_note = None
            if self.query("#pk-note"):
                self.say(text, error=error)

    def focus_primary(self) -> None:
        """Initial focus is the pane's primary (DL9); a pane with none leaves it on the list."""
        def go() -> None:
            first = self.query(".pk-primary")
            if first:
                first.first().focus()
            else:
                self.query_one("#pk-nav", ListView).focus()

        self.call_after_refresh(go)

    def _header(self, key: str) -> Text:
        """The monogram and the product name in bold, then the section: rich Text, never parsed
        as markup. The name is on this line once (DL5); the pane under it does not repeat it."""
        # Narrow, the section row under it names the section; the header keeps the identity whole
        # rather than cut the title mid-word.
        section = [] if self.has_class("-narrow") else [" · " + clean(self.copy(key))]
        return Text.assemble(self._monogram(), " ", (clean(self.identity.name), "bold"), *section, no_wrap=True, overflow="ellipsis")

    def _monogram(self) -> Text:
        """No icon in a terminal, so the product's initial on the neutral tile (UI-KITS §1.2)."""
        initial = next((c for c in clean(self.identity.name) if c.isalnum()), "?").upper()
        if self.kit_theme.preset == "native":
            return Text(f" {initial} ", "bold reverse")
        t = _tokens.THEMES[self.scheme]
        return Text(f" {initial} ", f"bold {t['text_strong']} on {t['surface_sunken']}")

    # ── Panes ─────────────────────────────────────────────────────────────────────────────

    def _refusal(self, text: str) -> Static:
        """A refusal is ▲ and its words (DL6), never ✗ and never the danger colour."""
        return Static(Text("▲ ", "bold") + Text(clean(text)), markup=False, classes="pk-refusal")

    def _error_copy(self, exc: Optional[BaseException]) -> Tuple[str, str]:
        """The catalog's title and message for a failure's code, else the fallback sentence."""
        t = self.copy
        code = getattr(exc, "code", None)
        if code is None and isinstance(exc, OSError):
            code = "network"
        if isinstance(code, str) and t.has(f"core.codes.{code}.message"):
            title = t(f"core.codes.{code}.title") if t.has(f"core.codes.{code}.title") else t("core.fallback.title")
            return title, t(f"core.codes.{code}.message")
        return t("core.fallback.title"), t("core.fallback.message", code=code if isinstance(code, str) else "unknown")

    def _note(self) -> Static:
        """The message slot under the actions (DL7): empty until an action reports."""
        slot = _text("", id="pk-note", classes="pk-note")
        slot.display = False
        return slot

    def say(self, text: str, *, error: bool = False) -> None:
        slot = self.query_one("#pk-note", Static)
        slot.set_classes("pk-note pk-error" if error else "pk-note pk-muted")
        slot.update(Text(clean(text)))
        slot.display = True

    def _actions(self, *buttons: Button) -> Horizontal:
        return Horizontal(*buttons, classes="pk-actions")

    def _section(self, section: str) -> List[Any]:
        if section == "devices":
            return self._devices_pane()
        if section == "updates":
            return self._updates_pane()
        return self._account_pane()

    def _devices_pane(self) -> List[Any]:
        t = self.copy
        v = self.devices()
        head = [_text(t("devices.title"), classes="pk-title")]
        if v.state == "browser-mode":
            url = self.page_url()
            return head + [_text(t("devices.browser"), classes="pk-muted")] + (
                [self._actions(Button(_out(t("devices.manage")), classes="pk-primary", id="pk-devices-manage")), self._note()] if url else []
            )
        if v.state == "failed":
            return head + [
                _text(t("devices.loadFailed"), classes="pk-error"),
                self._actions(Button(t("common.tryAgain"), classes="pk-primary", id="pk-devices-retry")),
            ]
        if v.state == "empty":
            return head + [_text(t("devices.empty"), classes="pk-muted")]
        out: List[Any] = head + [_text(t("devices.count", count=len(v.rows)), classes="pk-muted")]
        for r in v.rows:
            name = r.label or t("devices.unnamed")
            tag = f" · {t('part.thisDeviceTitle', formFactor='computer')}" if r.current else ""
            out.append(_text(f"{name}{tag}", classes="pk-gap"))
            if r.platform:
                out.append(_text(platform_name(r.platform) or "", classes="pk-muted"))
        return out

    def _updates_pane(self) -> List[Any]:
        t = self.copy
        u = self.update_state()
        if u is None:
            # The check could not run: a failed load is an error with Try again (DL7), never a bare label.
            title, message = self._error_copy(self._update_error)
            return [
                _text(title, classes="pk-title"),
                _text(message, classes="pk-muted"),
                self._actions(Button(t("common.tryAgain"), classes="pk-primary", id="pk-check")),
            ]
        if u.state == "up-to-date":
            return [_text(t("update.upToDate"), classes="pk-title"), _text(t("account.version", version=u.current or ""), classes="pk-muted")]
        name = self.identity.name
        if u.state == "blocked":
            # No update exists here: the refusal, in words, and nothing to press (DL6).
            return [self._refusal(t("update.blockedTitle")), _text(t("update.blockedBody", product=name), classes="pk-muted")]
        if u.state == "revoked-required-content":
            return [
                self._refusal(t("core.codes.pack-revoked.title")),
                _text(t("update.revokedContent", product=name), classes="pk-muted"),
                self._actions(Button(t("update.install"), classes="pk-primary", id="pk-install")),
            ]
        if u.state in ("store", "platform"):
            # The store or platform installs it: the kit offers no install of its own.
            return [
                _text(t("update.title", product=name, version=u.version or ""), classes="pk-title"),
                _text(t("update.platform.generic", product=name), classes="pk-muted"),
            ]
        if u.state == "mandatory":
            # Nothing to put off: the one action is the update (DL4, no Later).
            return [
                self._refusal(t("update.mandatoryTitle", product=name)),
                _text(t("update.mandatoryBody", product=name), classes="pk-muted"),
                self._actions(Button(t("update.install"), classes="pk-primary", id="pk-install")),
            ]
        head = [_text(t("cli.update.availableNoSize", version=u.version or ""), classes="pk-title"), _text(t("account.version", version=u.current or ""), classes="pk-muted")]
        if u.installable:
            go = Button(t("update.install"), classes="pk-primary", id="pk-install")
        elif u.notes_url:
            go = Button(_out(t("update.install")), classes="pk-primary", id="pk-download")
        else:
            # Nothing the kit can start, and Later alone would only close the pane: say where it comes from.
            return head + [_text(t("cli.update.downloadNoLink", product=name), classes="pk-muted")]
        return head + [self._actions(go, Button(t("update.later"), classes="pk-secondary", id="pk-later")), self._note()]

    def _account_pane(self) -> List[Any]:
        t = self.copy
        g = self.gate()
        if self.confirming:
            return self._sign_out_pane(g)
        out: List[Any] = []
        sign_out = lambda primary: Button(t("common.signOut"), classes="pk-primary" if primary else "pk-secondary", id="pk-sign-out")  # noqa: E731
        reconnect = Button(t("common.reconnect"), classes="pk-primary", id="pk-reconnect")
        if g.component == "StatusScreen":
            # A refusal, never a failure: ▲, what happened, and the fix as the one primary (DL6).
            out += [self._refusal(t(f"core.gate.{g.state}.title")), _text(t(f"core.gate.{g.state}.message"), classes="pk-muted")]
            if g.state in ("version-too-old", "version-too-new") and (g.allowed_min or g.allowed_max):
                if g.allowed_min and g.allowed_max:
                    out.append(_text(t("status.allowedRange", min=g.allowed_min, max=g.allowed_max), classes="pk-muted"))
                elif g.allowed_min:
                    out.append(_text(t("status.allowedMin", min=g.allowed_min), classes="pk-muted"))
                else:
                    out.append(_text(t("status.allowedMax", max=g.allowed_max), classes="pk-muted"))
            url = self.page_url()
            if g.state == "version-too-old":
                fix = Button(t("status.update"), classes="pk-primary", id="pk-fix-update")
            elif url:
                fix = Button(_out(t("common.manage")), classes="pk-primary", id="pk-manage")
            else:
                # A fix the kit cannot reach is named in words, and Try again stays.
                out.append(_text(t("status.contact", developer=self.identity.developer or self.identity.name), classes="pk-muted"))
                fix = Button(t("common.tryAgain"), classes="pk-primary", id="pk-reconnect")
            buttons = [fix]
            if fix.id != "pk-reconnect":
                buttons.append(Button(t("common.tryAgain"), classes="pk-secondary", id="pk-reconnect"))
            buttons.append(sign_out(False))
            return out + [self._actions(*buttons), self._note()]
        if g.component == "GraceBanner":
            out.append(self._refusal(t("grace.lastDay", product=self.identity.name) if g.state == "last-day" else t("grace.daysLeft", days=g.days_left or 0)))
            if g.grace_until:
                out.append(_text(t("grace.deadline", date=fmt.date(g.grace_until, t.locale)), classes="pk-muted"))
            if g.version:
                out.append(_text(t("account.version", version=g.version), classes="pk-muted"))
            return out + [self._actions(reconnect, sign_out(False)), self._note()]
        if g.state == "licensed":
            return [_text(t("core.gate.not-applicable.title"), classes="pk-title"), _text(t("core.gate.not-applicable.message"), classes="pk-muted")]
        if g.component == "PolarisKeyGate":
            # Nothing is held: what to do, in words; the one action re-reads the state.
            return [
                _text(t("core.gate.needs-activation.title"), classes="pk-title"),
                _text(t("core.gate.needs-activation.message"), classes="pk-muted"),
                self._actions(Button(t("common.tryAgain"), classes="pk-primary", id="pk-reconnect")),
            ]
        # Licensed: the tier is the title and the product is in the header (DL5, DL8).
        title: Text = Text(clean(t("account.tier", tier=g.tier) if g.tier else t("part.status.ok")), "bold")
        if g.term:
            title.append(f" · {clean(g.term)}", "dim")
        out.append(Static(title, markup=False, classes="pk-row"))
        if g.signed_in and (g.holder or g.email):
            out.append(_text(t("account.holder", name=g.holder or g.email), classes="pk-muted"))
        else:
            out.append(_text(t("account.keyOnly"), classes="pk-muted"))
        if g.version:
            out.append(_text(t("account.version", version=g.version), classes="pk-muted"))
        # A lone action is the primary (DL4).
        buttons = [Button(_out(t("common.manage")), classes="pk-primary", id="pk-manage")] if self.manage_url else []
        buttons.append(sign_out(not buttons))
        return out + [self._actions(*buttons), self._note()]

    def _sign_out_pane(self, g: GateView) -> List[Any]:
        t = self.copy
        name = self.identity.name
        out: List[Any] = [_text(t("signin.signout.title", product=name), classes="pk-title")]
        if g.tier:
            out.append(_text(t("signin.signout.released", product=name, tier=g.tier), classes="pk-muted"))
        # Cancel is not an error: it puts the account back with nothing said.
        return out + [
            self._actions(Button(t("common.signOut"), classes="pk-primary", id="pk-sign-out-confirm"), Button(t("common.cancel"), classes="pk-secondary", id="pk-cancel")),
            self._note(),
        ]

    # ── Actions ───────────────────────────────────────────────────────────────────────────

    def _open(self, url: Optional[str]) -> None:
        """Open a page; where no browser took it, say where to go instead."""
        if not url:
            return
        import webbrowser

        try:
            opened = webbrowser.open(url)
        except Exception:
            opened = False
        if not opened:
            self.say(self.copy("signin.cli.ifNotOpened", url=url))

    def _reshow(self) -> None:
        self.show(self.section)
        self.focus_primary()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid in ("pk-manage", "pk-devices-manage"):
            self._open(self.page_url())
        elif bid == "pk-sign-out":
            self.confirming = True
            self._reshow()
        elif bid == "pk-cancel":
            self.confirming = False
            self._reshow()
        elif bid == "pk-sign-out-confirm":
            self.confirming = False
            if self.client is None:
                self._reshow()
                return
            try:
                self.client.identity.sign_out()
            except Exception as e:
                # The error sits under the action that caused it (DL7), and the confirm stays.
                self.confirming = True
                self._pending_note = (self._error_copy(e)[1], True)
                self._reshow()
                return
            self._reshow()
        elif bid == "pk-download":
            u = self.update_state()
            if u is not None:
                self._open(u.notes_url)
        elif bid == "pk-install":
            self.exit("update")
        elif bid == "pk-later":
            # Postponing is not a failure: the account, with nothing said.
            self.show("account")
        elif bid in ("pk-check", "pk-reconnect", "pk-devices-retry"):
            self._reshow()
        elif bid == "pk-fix-update":
            self.show("updates")
            self.focus_primary()


def _text(text: str, **kw: Any) -> Static:
    """A Static for copy and data: control characters dropped and never parsed as markup, so a
    server's device label or product name is drawn as written."""
    return Static(clean(text), markup=False, **kw)


def _out(label: str) -> str:
    """The new-window glyph on an action that leaves the app (UI-KITS §1.5 rule 11), never an ellipsis."""
    return f"{label} ↗"


def run_app(client: Any, *, theme: Optional[Theme] = None, scheme: Optional[str] = None, manage_url: Optional[str] = None) -> Any:
    """Open the account view for ``client`` until the person quits; returns the app's result
    (``"update"`` when the person chose to update)."""
    from .env import detect

    s = scheme or detect(color_scheme=(theme or Theme()).color_scheme).scheme
    return PolarisKeyApp(client, theme=theme, scheme=s, manage_url=manage_url).run()
