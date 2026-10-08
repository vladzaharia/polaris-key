"""The terminal kit's styled parts (layer b, docs/design/UI-KITS.md §4.1 "Styled parts").

:class:`Kit` is the context every part and screen draws with: the terminal (:class:`TermEnv`), the
copy, the resolved product identity and the theme. Its methods are the parts: the product header
(the chip), the continuous rail, step glyphs, wrapped body text, key hints (keys in ``strong``,
actions in ``mute``, §1.5 rule 13), radio rows, the neutral seat meter, the progress bar, the user
code in reverse video, the half-block QR (black on white, shown only where the whole screen fits
with it), links (OSC 8, wrapped at ``/ ? &`` and never cut) and keys truncated in the middle.

Spacing is one rail rhythm: one blank rail row between blocks, never two. A short terminal (16 rows
or fewer) drops the blank rows altogether, so the code, the URL and the key hints stay in view.

Restyle hooks: ``Theme.colors`` (per scheme, role → a hex colour, drawn only in truecolor; the same
value the Node kit takes), ``Theme.symbols`` (Unicode or ASCII) and ``Theme.preset = "native"`` (the
host terminal's own palette: no product colour, no ``colors``, the chip in plain reverse video).
Every line a part returns is a :class:`~.text.Line`; nothing is printed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, List, Optional, Sequence, Tuple

from ... import qr as _qr
from .. import ansi
from ..core.copy import Copy
from ..core.identity import ResolvedIdentity, resolve_identity
from ..core.theme import Theme
from .env import TermEnv
from .text import DROP, Line, Palette, Span, cell_len, middle, wrap

__all__ = ["Kit", "STEP_GLYPHS"]

#: Step kinds → (symbol name in the generated tables, role).
STEP_GLYPHS = {
    "active": ("stepActive", "accent"),
    "done": ("stepDone", "success"),
    "ok": ("ok", "success"),
    "fail": ("fail", "danger"),
    "warn": ("warn", "warning"),
}

#: Cells before a QR row: the rail, the gutter and the code's indent (it lines up with the code).
QR_INDENT = 6

#: Below this many columns a two-column command row stacks: the command, then its label.
STACK_COLUMNS = 50

_HEX = re.compile(r"^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")


def _rgb(hex_color: str) -> str:
    h = hex_color.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return "%d;%d;%d" % (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def role_colors(colors: Any, scheme: str, color: str, native: bool) -> Tuple[Tuple[str, str], ...]:
    """``Theme.colors`` for one terminal: each role's hex colour as SGR parameters, only in
    truecolor and never under the native preset (ANSI-16 keeps the user's palette, ``NO_COLOR``
    drops everything). A value that is not a hex colour is ignored."""
    if native or color != "truecolor" or not colors:
        return ()
    out: List[Tuple[str, str]] = []
    for role, value in dict(colors.get(scheme, {}) or {}).items():
        if isinstance(value, str) and _HEX.match(value.strip()):
            out.append((role, "38;2;" + _rgb(value)))
    return tuple(out)


@dataclass
class Kit:
    env: TermEnv
    copy: Copy
    identity: ResolvedIdentity
    theme: Theme = field(default_factory=Theme)
    #: The command a person types (``polaris-key``, or the host CLI's own name).
    prog: str = "polaris-key"
    #: The product slug (a key's prefix names it).
    slug: Optional[str] = None
    #: Every catalog key a render used, in order (the string lint and the fixture contract).
    used: List[str] = field(default_factory=list)

    @classmethod
    def create(
        cls,
        env: TermEnv,
        *,
        theme: Optional[Theme] = None,
        product: Optional[str] = None,
        source: Any = None,
        prog: str = "polaris-key",
    ) -> "Kit":
        th = theme or Theme()
        ident = resolve_identity(integrator=th.product, source=source, slug=product, accent=th.accent)
        return cls(env=env, copy=Copy(th.locale, th.copy_overrides), identity=ident, theme=th, prog=prog, slug=product)

    # ── Copy and data spans ───────────────────────────────────────────────────────────────

    def t(self, key: str, *roles: str, link: Optional[str] = None, **args: Any) -> Span:
        """A span of catalog copy."""
        self.used.append(key)
        return Span(self.copy(key, **args), tuple(roles), link, "key:" + key)

    def s(self, key: str, **args: Any) -> str:
        """Catalog copy as a plain string (for an argument of another message)."""
        self.used.append(key)
        return self.copy(key, **args)

    @staticmethod
    def d(text: Any, kind: str, *roles: str, link: Optional[str] = None, nobreak: bool = False) -> Span:
        """A span of data: a product name, a device, a version, a URL, a key, a code …"""
        return Span(str(text), tuple(roles), link, "data:" + kind, nobreak)

    @staticmethod
    def sp(n: int = 1) -> Span:
        return Span(" " * n)

    def sym(self, name: str, *roles: str) -> Span:
        """A symbol (``✓``, ``▲`` …), drawn only on a terminal: piped output keeps the words."""
        if not self.decor:
            return Span("")
        return Span(self.env.symbol[name], tuple(roles), None, "symbol")

    def icon(self, name: str, *roles: str) -> List[Span]:
        """A status symbol and its space before a word (``✓ Copied``); nothing when piped."""
        return [self.sym(name, *roles), Span(" ")] if self.decor else []

    def sep(self) -> Span:
        """`` · `` in mute (thin separators, §1.5 rule 11)."""
        return Span(" " + self.env.symbol["separator"] + " ", ("muted",), None, "symbol")

    @property
    def product(self) -> str:
        return self.identity.name

    @property
    def inline_product(self) -> str:
        return self.identity.inline_name

    # ── Palette ───────────────────────────────────────────────────────────────────────────

    def palette(self) -> Palette:
        env = self.env
        native = self.theme.preset == "native"
        overrides = role_colors(self.theme.colors, env.scheme, env.color, native)
        if env.color == "none":
            return Palette(color="none")
        resolved = None if native else self.identity.accent(env.scheme)
        if resolved is None:
            # Ink (no product colour) or the host's own colours: strong text, a plain reverse chip.
            accent, chip = ansi.SGR["strong"], "1;" + ansi.SGR["chip"]
        elif env.color == "truecolor":
            accent = "38;2;" + _rgb(resolved.fg)
            chip = "1;38;2;" + _rgb(resolved.on) + ";48;2;" + _rgb(resolved.solid)
        else:
            accent = ansi.SGR["accent"]
            chip = "1;" + ansi.SGR["chip"] + ";" + ansi.SGR["accent"]
        return Palette(color=env.color, accent=accent, chip=chip, hyperlinks=env.hyperlinks, overrides=overrides)

    # ── Layout ────────────────────────────────────────────────────────────────────────────

    @property
    def decor(self) -> bool:
        """Rails and glyphs: on a terminal. Piped output (a log, a screen reader) is plain lines
        (UI-KITS §4.4)."""
        return self.env.tty and not self.env.dumb

    @property
    def body_width(self) -> int:
        return self.env.width - (3 if self.decor else 0)

    def gap(self, tier: int = DROP["blank_prose"]) -> List[Line]:
        """A blank rail row between blocks (none under ``density="compact"``). On a live screen it
        carries a compaction ``tier``: it is dropped only when the screen is taller than the
        terminal (``screen.fit_screen``)."""
        if self.decor and self.theme.density == "compact":
            return []
        return [Line([Span(self.env.symbol["rail"], ("muted",), None, "symbol")], drop=tier)] if self.decor else [Line([])]

    def fits(self, spans: Sequence[Span]) -> bool:
        """``spans`` fit one line of the body."""
        return cell_len("".join(s.text for s in spans).rstrip()) <= self.body_width

    def _prefix(self, symbol: str, role: str = "muted") -> List[Span]:
        if not self.decor:
            return []
        return [Span(self.env.symbol[symbol], (role,), None, "symbol"), Span("  ")]

    def header(self, verb: str) -> Line:
        """``┌  [ Product ] · verb``: the product chip opens every flow. A name too long for the
        line ends in an ellipsis inside the chip (never a hard crop)."""
        if not self.product:
            return Line(self._prefix("railStart") + [self.d(verb, "command", *(("muted",) if self.decor else ()))], role="header")
        if not self.decor:
            return Line([Span(self.product, (), None, "data:product"), self.sep(), self.d(verb, "command")], role="header")
        room = max(8, self.body_width - 2 - 3 - cell_len(verb))
        chip = Span(" " + _end_cut(self.product, room, self.env.symbol["ellipsis"]) + " ", ("chip",), None, "data:product")
        return Line(self._prefix("railStart") + [chip, self.sep(), self.d(verb, "command", "muted")], role="header")

    def rail(self) -> Line:
        return Line([Span(self.env.symbol["rail"], ("muted",), None, "symbol")] if self.decor else [])

    def step(self, kind: str, spans: Sequence[Span]) -> List[Line]:
        """A step line: its glyph on the rail, then the title (wrapped under itself)."""
        name, role = STEP_GLYPHS[kind]
        first = self._prefix(name, role) if self.decor else []
        rows = wrap(spans, self.body_width)
        out = [Line(first + rows[0])] if rows else [Line(first)]
        for r in rows[1:]:
            out.append(Line(self._prefix("rail") + r))
        return out

    def body(self, spans: Sequence[Span], indent: int = 0) -> List[Line]:
        """Text under a step, on the rail, wrapped to the layout width."""
        pad = [Span(" " * indent)] if indent else []
        rows = wrap(spans, self.body_width - indent)
        return [Line(self._prefix("rail") + pad + r) for r in rows] or [Line(self._prefix("rail"))]

    def end(self, spans: Sequence[Span] = (), hints: bool = False) -> List[Line]:
        """``└  …``: the last line of a flow, usually its key hints (``hints=True``: they may join
        the waiting line on a screen that does not fit). A closing line that wraps keeps ``│`` on
        every row but the last, which takes the ``└``."""
        if not self.decor:
            return [Line(list(r)) for r in wrap(spans, self.body_width)] if spans else []
        rows = wrap(spans, self.body_width) if spans else [[]]
        out = [Line(self._prefix("rail") + r) for r in rows]
        out[-1] = Line(self._prefix("railEnd") + rows[-1])
        if hints and spans:
            out[-1] = Line(out[-1].spans, role="hints", hint_spans=list(spans))
        return out

    # ── Parts ─────────────────────────────────────────────────────────────────────────────

    def hints(self, pairs: Sequence[Tuple[str, str]]) -> List[Span]:
        """Key hints: ``[(key, catalog key)]`` → ``Enter Activate license · Esc Cancel``. Keys are
        the keyboard's own names (``Enter``, ``Esc``, ``c``), drawn in ``strong``."""
        out: List[Span] = []
        for i, (key, action) in enumerate(pairs):
            if i:
                out.append(self.sep())
            out += [Span(key, ("strong",), None, "symbol"), Span(" "), self.t(action, "muted")]
        return out

    def hint_string(self, key: str) -> List[Span]:
        """A catalog hint line that already pairs keys and actions (``signin.cli.keys``):
        ``Enter open again · c use a code · Esc cancel``, each key ``strong``, each action
        ``mute``. The key is the first word of each part, in every locale."""
        raw = self.copy(key)
        self.used.append(key)
        out: List[Span] = []
        for i, part in enumerate(raw.split(" · ")):
            if i:
                out.append(self.sep())
            k, _, action = part.partition(" ")
            out += [Span(k, ("strong",), None, "key:" + key), Span(" "), Span(action, ("muted",), None, "key:" + key)]
        return out

    def command(self, words: str, label_key: Optional[str] = None, width: int = 0, **args: Any) -> List[Span]:
        """A fix as a command (``polaris-key activate   Use a different key``), §4.1 StatusScreen."""
        cmd = f"{self.prog} {words}".rstrip()
        out = [self.d(cmd, "command", "strong", nobreak=True)]
        if label_key:
            out += [Span(" " * max(3, width - cell_len(cmd) + 3)), self.t(label_key, "muted", **args)]
        return out

    def radio(self, on: bool, spans: Sequence[Span]) -> List[Span]:
        mark = self.sym("radioOn", "accent") if on else self.sym("radioOff", "muted")
        return [mark, Span(" ")] + list(spans)

    def seat_meter(self, used: int, limit: int, caption: bool = False) -> List[Span]:
        """The neutral seat meter: filled marks for seats in use, the rest muted (§1.5 rule 9: a
        full license is a limit, not an error). Dots only on a terminal, since the title beside it
        already says "3 of 3"; ``caption=True`` adds the numbers, and piped output (no dots) keeps
        them as words."""
        n = max(0, min(int(limit), 12))
        filled = max(0, min(int(used), n))
        on, off = (self.env.symbol["radioOn"], self.env.symbol["radioOff"])
        if self.env.symbols == "ascii":
            on, off = "#", "-"
        text = self.t("part.seatMeter.caption", "muted", used=used, limit=limit)
        if not self.decor:
            return [text]
        out = [Span(on * filled, ("strong",), None, "symbol"), Span(off * (n - filled), ("muted",), None, "symbol")]
        return out + ([Span(" "), text] if caption else [])

    def bar(self, fraction: float) -> List[Span]:
        """The progress bar: the done part in the accent, the rest in mute, scaled to the width."""
        if not self.decor:
            return []
        width = max(10, round(ansi.LAYOUT["barWidth"] * self.env.width / ansi.LAYOUT["columns"]))
        f = max(0.0, min(1.0, fraction))
        done = round(f * width)
        return [
            Span(self.env.symbol["barFull"] * done, ("accent",), None, "symbol"),
            Span(self.env.symbol["barEmpty"] * (width - done), ("muted",), None, "symbol"),
        ]

    def code(self, user_code: str) -> Span:
        """The user code in reverse video (§4.3: the terminal shows the same string reversed)."""
        if not self.decor:
            return Span(user_code, (), None, "data:code", True)
        return Span(" " + user_code + " ", ("code",), None, "data:code", True)

    def link(self, url: str, text: Optional[str] = None, *roles: str) -> Span:
        shown = text if text is not None else _display_url(url)
        return Span(shown, ("link",) + tuple(roles), url, "data:url", True)

    def key(self, raw: str, width: Optional[int] = None) -> Span:
        """A license key once it has been entered: its product prefix and its last six
        characters (what people compare against the purchase email, §4.3), the rest left out, so
        scrollback and logs never hold a usable key. One line, never wrapped (§1.5 rule 12)."""
        from ..core.models import parse_key

        ell = self.env.symbol["ellipsis"]
        v = parse_key(raw, final=True)
        body = raw[len(v.prefix) :] if v.prefix and raw.startswith(v.prefix) else raw
        shown = (v.prefix or "") + ell + body[-6:] if len(body) > 8 else (v.prefix or "") + ell
        w = width if width is not None else self.body_width - 16
        return Span(middle(shown, w, ellipsis=ell), ("muted",), None, "data:key", True)

    def qr(self, payload: str) -> List[Line]:
        """The half-block QR, black on white, lined up under the code, or nothing without Unicode
        or as wide as the terminal. QR codes are always paired with the text code (§4.4 rule 7);
        whether the screen has the rows for it is the screen's to decide (``screens``)."""
        if not self.decor or self.env.symbols == "ascii":
            return []
        invert = self.env.color == "none" and self.env.scheme == "dark"
        text = _qr.terminal(payload, quiet_zone=2, invert=invert)
        if text is None:
            return []
        rows = text.split("\n")
        if QR_INDENT + max(cell_len(r) for r in rows) > self.env.columns:
            return []
        roles = () if self.env.color == "none" else ("qr",)
        return [Line(self._prefix("rail") + [Span("   "), Span(row, roles, None, "symbol", True)]) for row in rows]


def _end_cut(text: str, width: int, ellipsis: str) -> str:
    """``text`` cut at its end to ``width`` cells with an ellipsis (a name, never a key or a URL)."""
    if cell_len(text) <= width:
        return text
    out = ""
    for ch in text:
        if cell_len(out + ch) > width - cell_len(ellipsis):
            break
        out += ch
    return out.rstrip() + ellipsis


def _display_url(url: str) -> str:
    for scheme in ("https://", "http://"):
        if url.startswith(scheme):
            return url[len(scheme) :]
    return url
