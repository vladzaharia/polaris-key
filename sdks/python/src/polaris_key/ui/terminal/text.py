"""Styled terminal text: spans, lines and their ANSI form (docs/design/UI-KITS.md §1.4 Terminal).

A :class:`Span` is a run of text with roles (``accent``, ``muted``, ``chip`` …), an optional link
and its **source**: the catalog key it came from (``"key:deviceLimit.heading"``), or the kind of
data it shows (``"data:product"``, ``"data:code"``, ``"symbol"`` …). The source never reaches the
terminal; the kit's string lint reads it to prove that every visible word is catalog copy or data
(§1.5 rule 11, §7.3).

:func:`to_ansi` turns a line into bytes for one :class:`Palette`: SGR parameters from the generated
tables in ``polaris_key.ui.ansi`` (ANSI-16 for every status role), truecolor only for the product
accent and only when the palette says so, OSC 8 around links, nothing at all without colour. The
rich backend (``polaris_key.ui.terminal.device``) renders the same lines to the same bytes.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from ...core.manage import is_manage_url
from .. import ansi

__all__ = [
    "BREAKS",
    "DROP",
    "break_pieces",
    "clean",
    "safe_link",
    "Span",
    "Line",
    "Palette",
    "cell_len",
    "middle",
    "plain",
    "to_ansi",
    "wrap",
]


#: C0 controls, DEL and C1 controls: what could start or end a terminal escape (ESC, BEL, CSI
#: 0x9B, OSC 0x9D, ST 0x9C …) or move the cursor. Text never carries them to a terminal.
_CONTROLS = re.compile("[\x00-\x1f\x7f-\x9f]")


def clean(text: str) -> str:
    """``text`` without control characters. Copy and data (a device label, a product name, a
    changelog line, a URL from the server) are drawn as text, never as escapes: the kit's own
    escapes are written by :func:`to_ansi` outside every span's text."""
    return _CONTROLS.sub("", text) if text else text


def safe_link(url: Optional[str]) -> Optional[str]:
    """``url`` when it may become an OSC 8 hyperlink: an absolute ``https`` URL (or ``http`` to a
    loopback host) with no whitespace, control character or userinfo (the manage-URL rule of
    ``polaris_key.core.manage``). Anything else is drawn as text without a link."""
    if not url or _CONTROLS.search(url) or not is_manage_url(url):
        return None
    return url


@dataclass(frozen=True)
class Span:
    text: str
    roles: Tuple[str, ...] = ()
    link: Optional[str] = None
    #: ``key:<catalog key>``, ``data:<kind>``, ``symbol`` or ``space``.
    src: str = "space"
    #: Never broken across lines (a key, a user code, a URL).
    nobreak: bool = False
    #: Part of one keep-unit (a name, an email, a date, "3 of 3", "38 MB", a key and its label): a
    #: maximal run of adjacent ``unit`` spans moves to the next line whole and breaks at its own
    #: spaces only when wider than the line. A non-``unit`` span (a separator) ends a run.
    unit: bool = False

    def __post_init__(self) -> None:
        if self.text and _CONTROLS.search(self.text):
            object.__setattr__(self, "text", clean(self.text))


@dataclass
class Line:
    spans: List[Span] = field(default_factory=list)
    #: Compaction tier for a live screen taller than the terminal (see ``fit_screen``): the line is
    #: dropped at this tier, lowest first. ``None``: never dropped (the URL line, the code, the hints).
    drop: Optional[int] = None
    #: ``"spinner"`` is the waiting line the key hints merge onto first; ``"hints"`` the hints line
    #: that merges (``hint_spans`` are its spans without the rail prefix); ``"header"`` the flow's
    #: header lines, which a live region leaves out once a resize pushed them into the terminal's
    #: scrollback (they cannot be erased, and are never printed a second time).
    role: Optional[str] = None
    hint_spans: Optional[List[Span]] = None

    def __add__(self, other: "Line") -> "Line":
        return Line(self.spans + other.spans, self.drop, self.role, self.hint_spans)

    @property
    def text(self) -> str:
        return "".join(s.text for s in self.spans)

    @property
    def width(self) -> int:
        return cell_len(self.text)


# ── Cells ────────────────────────────────────────────────────────────────────────────────────


def _char_width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    return 1


def cell_len(text: str) -> int:
    """Terminal cells ``text`` occupies (CJK wide characters take two)."""
    return sum(_char_width(c) for c in text)


def middle(text: str, width: int, *, keep_tail: int = 6, ellipsis: str = "…") -> str:
    """``text`` shortened in the middle to ``width`` cells, keeping the head and the last
    ``keep_tail`` characters (``pkey_tidewater_7Q2M…3WPLDA``, UI-KITS §1.5 rule 12)."""
    if cell_len(text) <= width:
        return text
    tail = text[-keep_tail:] if keep_tail else ""
    room = width - cell_len(ellipsis) - cell_len(tail)
    if room < 1:
        return text[: max(width - cell_len(ellipsis), 1)] + ellipsis
    head = ""
    for ch in text:
        if cell_len(head + ch) > room:
            break
        head += ch
    return head + ellipsis + tail


def plain(lines: Iterable[Line]) -> str:
    return "\n".join(ln.text.rstrip() for ln in lines)


# ── Wrapping ─────────────────────────────────────────────────────────────────────────────────
#
# Three kinds of token never break at a space like prose does (the Node kit's width.ts is the
# same):
#
# * a **key** or an id (``nobreak``): one line, cut in the middle when it cannot fit;
# * a **URL** (``src="data:url"``): never cut and never given an ellipsis. One that does not fit
#   the rest of the line starts a line of its own and, wider than a line, wraps after ``/`` or
#   before ``?`` and ``&`` (then after ``-`` or before ``.``, then anywhere), hanging under the
#   content column; every piece keeps the link;
# * a **user code** (``src="data:code"``): never cut; wider than a line, it wraps after a ``-``.

#: The compaction tiers a live screen drops, in order, when it is taller than the terminal.
DROP = {"blank_prose": 2, "check": 3, "blank_code": 4, "countdown": 5}

#: Span sources whose text wraps at its own break points and is never cut.
BREAKS = {"data:url": "url", "data:code": "code"}


def _split_at(text: str, after: str, before: str = "") -> List[str]:
    out: List[str] = []
    cur = ""
    for ch in text:
        if ch in before and cur:
            out.append(cur)
            cur = ""
        cur += ch
        if ch in after:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


def _hard_split(text: str, width: int) -> List[str]:
    out: List[str] = []
    cur, used = "", 0
    for ch in text:
        w = _char_width(ch)
        if used + w > width and cur:
            out.append(cur)
            cur, used = "", 0
        cur += ch
        used += w
    if cur:
        out.append(cur)
    return out


def break_pieces(text: str, kind: str, width: int) -> List[str]:
    """The pieces a URL (``kind="url"``) or a user code (``"code"``) may wrap between, none wider
    than ``width``: a URL after ``/`` and before ``?`` and ``&``, a piece still too wide after
    ``-`` and before ``.``; a code after ``-``; anything still too wide in runs of ``width`` cells.
    Joined, the pieces are the text unchanged."""
    w = max(1, width)
    first = _split_at(text, "/", "?&") if kind == "url" else _split_at(text, "-")
    second: List[str] = []
    for p in first:
        second += _split_at(p, "-", ".") if kind == "url" and cell_len(p) > w else [p]
    out: List[str] = []
    for p in second:
        out += _hard_split(p, w) if cell_len(p) > w else [p]
    return out


def _fragments(spans: Sequence[Span]) -> Iterable[Tuple[str, Span]]:
    for span in spans:
        if span.nobreak:
            yield "word", span
            continue
        text, i = span.text, 0
        while i < len(text):
            ch = text[i]
            if ch == " ":
                j = i
                while j < len(text) and text[j] == " ":
                    j += 1
                kind = "space"
            elif _char_width(ch) == 2:
                j, kind = i + 1, "wide"
            else:
                j = i
                while j < len(text) and text[j] != " " and _char_width(text[j]) != 2:
                    j += 1
                kind = "word"
            yield kind, Span(text[i:j], span.roles, span.link, span.src, span.nobreak, span.unit)
            i = j


def _tokens(spans: Sequence[Span]) -> List[List[Span]]:
    """Split spans into words: runs of non-space text (kept with their styles), each with the
    spaces after it. A CJK wide character is a word of its own, so lines can break between them;
    a ``nobreak`` span is one word."""
    words: List[List[Span]] = []
    cur: List[Span] = []
    closed = False
    for kind, s in _fragments(spans):
        if kind == "space":
            cur.append(s)
            closed = True
        elif kind == "wide":
            if cur:
                words.append(cur)
            cur, closed = [s], True
        else:
            if closed and cur:
                words.append(cur)
                cur = []
            cur.append(s)
            closed = False
    if cur:
        words.append(cur)
    return words


def _word_len(word: Sequence[Span], *, trailing: bool = True) -> int:
    text = "".join(s.text for s in word)
    return cell_len(text if trailing else text.rstrip(" "))


def _is_piece(word: Sequence[Span]) -> bool:
    return any(s.src in BREAKS for s in word)


def _groups(spans: Sequence[Span]) -> List[Tuple[str, List[List[Span]], int]]:
    """Prose words, each URL or code as one ``group`` of pieces, and each run of ``unit`` spans as
    one ``unit`` group of words, in order. The spaces after a URL or a code stay with its last
    piece."""
    out: List[Tuple[str, List[List[Span]], int]] = []
    run: List[Span] = []
    unit: List[Span] = []

    def flush() -> None:
        if run:
            for w in _tokens(run):
                if w[0].text.strip(" ") == "" and out and out[-1][0] == "group":
                    out[-1][1][-1].extend(w)  # spaces right after a URL or a code
                else:
                    out.append(("word", [w], 0))
            run.clear()

    def flush_unit() -> None:
        if unit:
            words = _tokens(unit)
            out.append(("unit", words, cell_len("".join(s.text for s in unit).rstrip(" "))))
            unit.clear()

    for span in spans:
        if span.unit and span.src not in BREAKS and span.text:
            flush()
            unit.append(span)
            continue
        flush_unit()
        if span.src in BREAKS and span.text:
            flush()
            out.append(("group", [[span]], cell_len(span.text.strip(" "))))
        else:
            run.append(span)
    flush()
    flush_unit()
    return out


def wrap(spans: Sequence[Span], width: int, *, ellipsis: str = "…") -> List[List[Span]]:
    """Wrap ``spans`` to ``width`` cells on word boundaries, without leaving a single orphan word on
    the last line when the line above can give one (UI-KITS §1.5 rule 11). A URL or a code wraps
    at its own break points and is never cut; any other ``nobreak`` span (a key, an id) wider than
    the line is cut in the middle."""
    width = max(1, width)
    lines: List[List[List[Span]]] = [[]]
    used = 0

    def trim(line: List[List[Span]]) -> None:
        # A separator ("·") divides items on one line, and a line never ends with one or with a
        # trailing space word left where a separator or unit moved away.
        while len(line) > 1 and "".join(s.text for s in line[-1]).strip(" ") in ("·", ""):
            line.pop()

    def new_line() -> None:
        trim(lines[-1])
        lines.append([])

    def only_whitespace(line: List[List[Span]]) -> bool:
        return all("".join(s.text for s in w).strip(" ") == "" for w in line)

    def pull_lead_in(line: List[List[Span]], first: int) -> List[List[Span]]:
        # Pull a short lead-in ("go to") off the previous line onto a URL's own line, when it fits.
        moved: List[List[Span]] = []
        w = first
        while line:
            word = line[-1]
            text = "".join(s.text for s in word)
            if any(s.src in BREAKS or s.unit for s in word) or text.strip(" ") == "":
                break
            ww = cell_len(text.rstrip(" "))
            if ww > 6 or len(moved) >= 2 or w + ww + 1 > width:
                break
            moved.insert(0, line.pop())
            w += ww + 1
        trim(line)
        return moved

    for kind, words, total in _groups(spans):
        if kind == "unit":
            # A unit that does not fit the rest of the line moves to the next line whole; wider
            # than a line, it falls through to break at its own spaces.
            if total <= width:
                if lines[-1] and used + total > width:
                    new_line()
                    used = 0
                for w in words:
                    lines[-1].append(w)
                    used += _word_len(w)
                continue
            kind = "words-run"
        if kind in ("word", "words-run"):
            for w in words:
                n = _word_len(w, trailing=False)
                if n > width and len(w) == 1 and w[0].nobreak:
                    s0 = w[0]
                    w = [Span(middle(s0.text, width, ellipsis=ellipsis), s0.roles, s0.link, s0.src, True)]
                    n = _word_len(w, trailing=False)
                if lines[-1] and used + n > width:
                    new_line()
                    used = 0
                lines[-1].append(w)
                used += _word_len(w)
            continue
        if kind == "group":
            span = words[0][0]
            tail = words[0][1:]  # the spaces after it
            pieces = break_pieces(span.text, BREAKS[span.src], width)
            if lines[-1] and used + total > width and not only_whitespace(lines[-1]):
                lead = pull_lead_in(lines[-1], cell_len(pieces[0]))
                new_line()
                used = 0
                for w in lead:
                    lines[-1].append(w)
                    used += _word_len(w)
            for i, piece in enumerate(pieces):
                word: List[Span] = [Span(piece, span.roles, span.link, span.src, True)]
                if i == len(pieces) - 1:
                    word += tail
                n = cell_len(piece)
                if lines[-1] and used + n > width:
                    new_line()
                    used = 0
                lines[-1].append(word)
                used += _word_len(word)
            continue
    # Orphan check: move one word down when the last line holds a single short word (never a piece
    # of a URL or a code: moving one would put a space inside it).
    def _is_unit(word: Sequence[Span]) -> bool:
        return any(s.unit for s in word)

    if len(lines) >= 2 and len(lines[-1]) == 1 and len(lines[-2]) > 2 and not _is_piece(lines[-1][0]) and not _is_unit(lines[-1][0]):
        if not _is_piece(lines[-2][-1]) and not _is_unit(lines[-2][-1]):
            moved = lines[-2].pop()
            if sum(_word_len(x) for x in [moved] + lines[-1]) <= width:
                lines[-1].insert(0, moved)
                trim(lines[-2])
            else:
                lines[-2].append(moved)
    out: List[List[Span]] = []
    for ln in lines:
        flat: List[Span] = []
        for s in (s for w in ln for s in w):
            prev = flat[-1] if flat else None
            if prev and prev.src in BREAKS and (prev.src, prev.roles, prev.link) == (s.src, s.roles, s.link):
                flat[-1] = Span(prev.text + s.text, prev.roles, prev.link, prev.src, True)  # one URL or code piece per line
            else:
                flat.append(s)
        if flat and not flat[-1].nobreak:
            last = flat[-1]
            flat[-1] = Span(last.text.rstrip(" "), last.roles, last.link, last.src, last.nobreak)
        out.append([s for s in flat if s.text])
    return out


# ── ANSI ─────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Palette:
    """How roles become escapes on one terminal.

    ``color`` is ``"none"``, ``"ansi16"`` or ``"truecolor"``. ``accent`` is the product accent's
    parameters for the accent role (``"36"``, or ``"38;2;r;g;b"`` under truecolor; ``"1"`` for an
    ink product); ``chip`` the product chip's (``"1;7;36"``, or ``"1;38;2;…;48;2;…"``).
    ``overrides`` maps a role to its own parameters (the theme's ``colors``)."""

    color: str = "none"
    accent: str = ansi.SGR["accent"]
    chip: str = "1;" + ansi.SGR["chip"] + ";" + ansi.SGR["accent"]
    hyperlinks: bool = False
    overrides: Tuple[Tuple[str, str], ...] = ()
    #: With ``color="none"`` on a terminal: keep weight, not colour. Bold and reverse video stay
    #: (the code chip, the key hints, titles) so the code is still the focal point; a pipe, TERM=dumb
    #: and ``--json`` write no escape at all.
    attributes: bool = False

    def params(self, roles: Sequence[str]) -> str:
        """The SGR parameters for ``roles``, in rich's order (attributes, then colours)."""
        if self.color == "none":
            keep = {"strong": ["1"], "code": ["1", "7"], "chip": ["7"]}
            return _order([c for r in roles for c in keep.get(r, [])]) if self.attributes else ""
        over: Dict[str, str] = dict(self.overrides)
        codes: List[str] = []
        for role in roles:
            if role in over:
                codes.extend(over[role].split(";"))
            elif role == "accent":
                codes.extend(self.accent.split(";"))
            elif role == "chip":
                codes.extend(self.chip.split(";"))
            elif role == "code":
                codes.extend(["1", ansi.SGR["chip"]])
            elif role == "qr":
                codes.extend(["30", "107"] if self.color == "ansi16" else ["38;2;0;0;0", "48;2;255;255;255"])
            elif role in ansi.SGR:
                codes.extend(ansi.SGR[role].split(";"))
        return _order(codes)


def _order(codes: List[str]) -> str:
    """Attributes first (1, 2, 3, 4, 7), then the foreground, then the background, each once; the
    same order rich writes, so both backends agree byte for byte."""
    attrs: List[str] = []
    fg: Optional[str] = None
    bg: Optional[str] = None
    i = 0
    while i < len(codes):
        c = codes[i]
        if c in ("38", "48") and i + 4 < len(codes) and codes[i + 1] == "2":
            value = ";".join(codes[i : i + 5])
            if c == "38":
                fg = value
            else:
                bg = value
            i += 5
            continue
        if ";" in c:  # a pre-joined truecolor value
            if c.startswith("38;"):
                fg = c
            elif c.startswith("48;"):
                bg = c
            i += 1
            continue
        n = int(c)
        if n in (1, 2, 3, 4, 5, 7, 8, 9):
            if c not in attrs:
                attrs.append(c)
        elif 30 <= n <= 37 or 90 <= n <= 97:
            fg = c
        elif 40 <= n <= 47 or 100 <= n <= 107:
            bg = c
        i += 1
    attrs.sort(key=int)
    return ";".join(attrs + ([fg] if fg else []) + ([bg] if bg else []))


def _merge(spans: Sequence[Span]) -> List[Span]:
    out: List[Span] = []
    for s in spans:
        if not s.text:
            continue
        if out and out[-1].roles == s.roles and out[-1].link == s.link:
            prev = out[-1]
            out[-1] = Span(prev.text + s.text, prev.roles, prev.link, prev.src, prev.nobreak)
        else:
            out.append(s)
    return out


def to_ansi(line: Line, palette: Palette) -> str:
    """One line as terminal bytes (no newline), trailing spaces trimmed."""
    spans = _merge(line.spans)
    while spans and not spans[-1].roles and spans[-1].text.rstrip(" ") != spans[-1].text:
        last = spans[-1]
        trimmed = last.text.rstrip(" ")
        spans = spans[:-1] + ([Span(trimmed, last.roles, last.link, last.src)] if trimmed else [])
    if palette.color == "none" and not palette.attributes and not palette.hyperlinks:
        return "".join(clean(s.text) for s in spans)
    out: List[str] = []
    for s in spans:
        text = clean(s.text)
        params = palette.params(s.roles) if s.roles else ""
        body = f"\x1b[{params}m{text}\x1b[0m" if params else text
        link = safe_link(s.link) if palette.hyperlinks else None
        if link:
            body = f"\x1b]8;;{link}\x1b\\{body}\x1b]8;;\x1b\\"
        out.append(body)
    return "".join(out)
