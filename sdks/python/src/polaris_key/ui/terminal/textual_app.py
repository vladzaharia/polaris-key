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

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.theme import Theme as TextualTheme
from textual.widgets import Button, Footer, ListItem, ListView, Static

from .. import _tokens
from ..core.copy import Copy
from ..core.identity import ResolvedIdentity, presentation_source, resolve_identity
from ..core.models import DevicesView, DeviceRow, GateView, gate_view, update_view
from ..core.theme import Theme

__all__ = ["PolarisKeyApp", "run_app", "SECTIONS"]

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
    #pk-main { padding: 1 3; }
    .pk-title { text-style: bold; }
    .pk-muted { color: $pk-muted; }
    .pk-row { height: auto; }
    .pk-actions { height: auto; margin-top: 1; }
    Button { min-width: 0; height: 1; border: none; padding: 0 1; margin: 0 1 0 0; text-style: bold; }
    Button.pk-primary { background: $primary; color: $pk-on-primary; }
    Button.pk-secondary { background: $foreground 16%; color: $text; }
    Button:focus { text-style: bold reverse; }
    """

    ENABLE_COMMAND_PALETTE = False

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
        super().__init__()
        self.title = self.identity.name
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
            signed_in=bool(profile),
            version=getattr(getattr(c, "core", None), "version", None),
        )

    def devices(self) -> DevicesView:
        if "devices" in self.data:
            return self.data["devices"]
        try:
            rows = tuple(DeviceRow(d.id, d.label, d.platform, bool(d.current)) for d in self.client.list_devices())
        except Exception:
            return DevicesView("Devices", "browser-mode")
        return DevicesView("Devices", "list" if rows else "empty", rows)

    def update_state(self) -> Any:
        if "update" in self.data:
            return self.data["update"]
        try:
            return update_view(self.client.update.decide().decision, current=getattr(self.client.core, "version", None))
        except Exception:
            return None

    # ── Layout ────────────────────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        sep = " · "
        yield Static(f"[b]{_esc(self.identity.name)}[/b]{sep}{_esc(self.copy('account.title'))}", id="pk-header")
        with Horizontal(id="pk-body"):
            yield ListView(*[ListItem(Static(self.copy(key)), id=f"pk-{sid}") for sid, key in SECTIONS], id="pk-nav")
            yield VerticalScroll(id="pk-main")
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
        self.show("account")

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if event.item is not None and event.item.id:
            self.show(event.item.id[3:])

    def show(self, section: str) -> None:
        self.section = section
        main = self.query_one("#pk-main", VerticalScroll)
        main.remove_children()
        main.mount_all(self._section(section))
        header = self.query_one("#pk-header", Static)
        title = dict(SECTIONS)[section]
        header.update(f"[b]{_esc(self.identity.name)}[/b] · {_esc(self.copy(title))}")

    def _section(self, section: str) -> List[Any]:
        t = self.copy
        if section == "devices":
            v = self.devices()
            if v.state == "browser-mode":
                return [Static(t("devices.browser"), classes="pk-muted")]
            if v.state == "empty":
                return [Static(t("devices.empty"), classes="pk-muted")]
            out: List[Any] = [Static(t("devices.title"), classes="pk-title"), Static(t("devices.count", count=len(v.rows)), classes="pk-muted")]
            for r in v.rows:
                name = r.label or t("devices.unnamed")
                tag = f" · {t('part.thisDeviceTitle', formFactor='computer')}" if r.current else ""
                out.append(Static(f"\n{_esc(name)}{_esc(tag)}"))
                if r.platform:
                    out.append(Static(_esc(r.platform), classes="pk-muted"))
            return out
        if section == "updates":
            u = self.update_state()
            if u is None:
                return [Static(t("update.checkNow"), classes="pk-muted")]
            if u.state == "up-to-date":
                return [Static(t("update.upToDate"), classes="pk-title"), Static(t("account.version", version=u.current or ""), classes="pk-muted")]
            return [
                Static(t("update.title", product=self.identity.name, version=u.version or ""), classes="pk-title"),
                Static(t("account.version", version=u.current or ""), classes="pk-muted"),
                Horizontal(Button(t("update.install"), classes="pk-primary", id="pk-install"), Button(t("update.later"), classes="pk-secondary", id="pk-later"), classes="pk-actions"),
            ]
        g = self.gate()
        lines: List[Any] = []
        head = self.identity.name + (f" {g.tier}" if g.tier else "")
        lines.append(Static(f"[b]{_esc(head)}[/b]" + (f" · {_esc(g.term)}" if g.term else ""), classes="pk-row"))
        if g.signed_in and (g.holder or g.email):
            lines.append(Static(t("account.holder", name=g.holder or g.email), classes="pk-muted"))
        else:
            lines.append(Static(t("account.keyOnly"), classes="pk-muted"))
        status_key = {"ok": "part.status.ok", "grace": "part.status.grace", "expired": "part.status.expired", "revoked": "part.status.revoked"}.get(g.status, "part.status.inactive")
        lines.append(Static(f"\n{_esc(t(status_key))}"))
        if g.version:
            lines.append(Static(t("account.version", version=g.version), classes="pk-muted"))
        buttons = [Button(t("common.manage"), classes="pk-primary", id="pk-manage")] if self.manage_url else []
        buttons.append(Button(t("common.signOut"), classes="pk-secondary", id="pk-sign-out"))
        lines.append(Horizontal(*buttons, classes="pk-actions"))
        return lines

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "pk-manage" and self.manage_url:
            import webbrowser

            webbrowser.open(self.manage_url)
        elif event.button.id == "pk-sign-out" and self.client is not None:
            self.client.identity.sign_out()
            self.show("account")
        elif event.button.id == "pk-install":
            self.exit("update")
        elif event.button.id == "pk-later":
            self.show("account")


def _esc(text: str) -> str:
    """Escape Textual markup in copy and data."""
    return text.replace("[", r"\[")


def run_app(client: Any, *, theme: Optional[Theme] = None, scheme: Optional[str] = None, manage_url: Optional[str] = None) -> Any:
    """Open the account view for ``client`` until the person quits; returns the app's result
    (``"update"`` when the person chose to update)."""
    from .env import detect

    s = scheme or detect(color_scheme=(theme or Theme()).color_scheme).scheme
    return PolarisKeyApp(client, theme=theme, scheme=s, manage_url=manage_url).run()
