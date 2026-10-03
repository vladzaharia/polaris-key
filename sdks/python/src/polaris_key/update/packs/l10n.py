"""The plain parsers behind the ``l10n.table`` and ``data.json`` handlers (P4-16; a port of
client-core's ``packs/handlers``): strict JSON over any value, PO, CSV and the BCP-47
well-formedness rule. Every parser reads bytes as data and never evaluates them: no ``eval``, no
``pickle``, no YAML, no gettext ``.mo`` loader, nothing that builds objects from the input.

A table file's format is judged by its content, never its name: after an optional UTF-8 BOM and
ASCII whitespace, ``{`` is a JSON table, ``#``, ``msgid`` or ``msgctxt`` a PO file, anything else
a CSV file.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ...core.jws import (
    MAX_JSON_DEPTH,
    _depth_exceeds,
    _has_surrogate,
    _parse_constant,
    _parse_float,
    _parse_int,
    _strict_pairs,
)

__all__ = [
    "L10nMessage",
    "L10nTable",
    "L10nParseResult",
    "bcp47_canonical",
    "parse_l10n_table",
    "strict_json_value",
]


class _NotStrict(Exception):
    pass


def strict_json_value(data: bytes) -> Tuple[bool, Any]:
    """V4 §1.2's strict JSON over UTF-8 bytes (no BOM, no duplicate member, no trailing comma,
    no comment, no ``NaN``, nothing after the value), whatever the top-level value is.
    ``(True, value)`` or ``(False, None)``."""
    try:
        text = bytes(data).decode("utf-8")
        if text.startswith("\ufeff"):
            raise _NotStrict("byte order mark")
        if _depth_exceeds(text, MAX_JSON_DEPTH):
            raise _NotStrict("too deep")
        value = json.loads(
            text,
            object_pairs_hook=_strict_pairs,
            parse_int=_parse_int,
            parse_float=_parse_float,
            parse_constant=_parse_constant,
        )
        if _has_surrogate(value):
            raise _NotStrict("lone surrogate")
        return True, value
    except Exception:
        return False, None


# ── BCP-47 ──────────────────────────────────────────────────────────────────────────────────

_BCP47_CHARS = re.compile(r"[A-Za-z0-9-]+")
_BCP47 = re.compile(
    r"(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?"
    r"(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*"
    r"(?:-x(?:-[a-z0-9]{1,8})+)?"
)


def _ascii_lower(s: str) -> str:
    """Lowercase ASCII letters only (never Unicode case folding)."""
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def bcp47_canonical(tag: Any) -> Optional[str]:
    """The canonical form of a locale tag (``_`` → ``-``, case kept) when it is a well-formed
    BCP-47 tag (2–35 ASCII letters, digits and hyphens, matching the grammar), else ``None``."""
    if not isinstance(tag, str):
        return None
    c = tag.replace("_", "-")
    if not (2 <= len(c) <= 35) or not c.isascii() or _BCP47_CHARS.fullmatch(c) is None:
        return None
    return c if _BCP47.fullmatch(c.lower()) is not None else None


# ── The table model ─────────────────────────────────────────────────────────────────────────


@dataclass
class L10nMessage:
    """One message: ``id``, an optional ``context`` and ``plural`` (the PO ``msgid_plural``),
    and its ``strings`` (one, or one per plural form)."""

    context: Optional[str]
    id: str
    plural: Optional[str]
    strings: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {"context": self.context, "id": self.id, "plural": self.plural, "strings": list(self.strings)}


@dataclass
class L10nTable:
    """One locale's table from one file (a CSV file with several locale columns gives one per
    column). ``locale`` is the raw tag as the file declares it until the handler canonicalises
    it."""

    path: str
    locale: str
    messages: List[L10nMessage] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {"path": self.path, "locale": self.locale, "messages": [m.to_dict() for m in self.messages]}


@dataclass
class L10nParseResult:
    ok: bool
    tables: List[L10nTable] = field(default_factory=list)


_WS = b" \t\n\r"


def parse_l10n_table(path: str, data: bytes) -> L10nParseResult:
    """Parse one table file (spec rules 2–4): valid UTF-8 without NUL, format by content, then
    the format's plain parser. The locales are returned raw (the handler validates them)."""
    b = bytes(data)
    if b"\x00" in b:
        return L10nParseResult(False)
    try:
        text = b.decode("utf-8")
    except UnicodeDecodeError:
        return L10nParseResult(False)
    if text.startswith("\ufeff"):
        text = text[1:]
    i = 0
    while i < len(text) and text[i] in " \t\n\r":
        i += 1
    if i == len(text):
        return L10nParseResult(False)
    rest = text[i:]
    try:
        if rest.startswith("{"):
            return _json_table(path, text)
        if rest.startswith("#") or rest.startswith("msgid") or rest.startswith("msgctxt"):
            return _po_table(path, text)
        return _csv_table(path, text)
    except _NotStrict:
        return L10nParseResult(False)


def _json_table(path: str, text: str) -> L10nParseResult:
    ok, value = strict_json_value(text.encode("utf-8"))
    if not ok or not isinstance(value, dict):
        raise _NotStrict("not a JSON table")
    locale = value.get("locale")
    messages = value.get("messages")
    if not isinstance(locale, str) or not isinstance(messages, dict):
        raise _NotStrict("not a JSON table")
    out: List[L10nMessage] = []
    for k, v in messages.items():
        if not isinstance(v, str):
            raise _NotStrict("a message is not a string")
        out.append(L10nMessage(None, k, None, [v]))
    # Member order is not portable (JS lists integer-like keys first; Swift keeps none): sorted
    # by the UTF-8 bytes of the id.
    out.sort(key=lambda m: m.id.encode("utf-8", "surrogatepass"))
    return L10nParseResult(True, [L10nTable(path, locale, out)])


# ── PO ──────────────────────────────────────────────────────────────────────────────────────

_PO_KEYWORD = re.compile(r"(msgctxt|msgid_plural|msgid|msgstr(?:\[([0-9]{1,2})\])?)[ \t]+(.*)")
_PO_ESCAPES = {"\\": "\\", '"': '"', "n": "\n", "t": "\t", "r": "\r"}


def _po_string(s: str) -> str:
    """A quoted PO string followed only by spaces or tabs; the five escapes only."""
    if not s.startswith('"'):
        raise _NotStrict("not a string")
    out: List[str] = []
    i = 1
    while True:
        if i >= len(s):
            raise _NotStrict("unterminated string")
        c = s[i]
        if c == '"':
            break
        if c == "\\":
            if i + 1 >= len(s) or s[i + 1] not in _PO_ESCAPES:
                raise _NotStrict("bad escape")
            out.append(_PO_ESCAPES[s[i + 1]])
            i += 2
            continue
        out.append(c)
        i += 1
    if s[i + 1 :].strip(" \t") != "":
        raise _NotStrict("text after the string")
    return "".join(out)


class _PoEntry:
    def __init__(self) -> None:
        self.ctxt: Optional[str] = None
        self.id: Optional[str] = None
        self.plural: Optional[str] = None
        self.strs: List[str] = []
        self.indexed = False
        #: The keyword the next continuation line extends: ("ctxt"|"id"|"plural"|"str", index).
        self.last: Optional[Tuple[str, int]] = None

    def complete(self) -> bool:
        if self.id is None or not self.strs:
            return False
        return self.indexed if self.plural is not None else not self.indexed


def _po_table(path: str, text: str) -> L10nParseResult:
    entries: List[_PoEntry] = []
    cur: Optional[_PoEntry] = None
    for raw in text.split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        if line.strip(" \t") == "":
            if cur is not None:
                cur.last = None
            continue
        if line.startswith("#"):
            if cur is not None:
                cur.last = None
            continue
        if line.startswith('"'):
            if cur is None or cur.last is None:
                raise _NotStrict("continuation without a keyword")
            s = _po_string(line)
            kind, n = cur.last
            if kind == "ctxt":
                cur.ctxt = (cur.ctxt or "") + s
            elif kind == "id":
                cur.id = (cur.id or "") + s
            elif kind == "plural":
                cur.plural = (cur.plural or "") + s
            else:
                cur.strs[n] += s
            continue
        m = _PO_KEYWORD.fullmatch(line)
        if m is None:
            raise _NotStrict("not a PO line")
        kw, idx, value = m.group(1), m.group(2), _po_string(m.group(3))
        if kw in ("msgctxt", "msgid"):
            starts_new = cur is None or cur.complete()
            if kw == "msgid" and cur is not None and not cur.complete() and cur.id is None:
                starts_new = False  # msgid after this entry's msgctxt
            if starts_new:
                if cur is not None:
                    entries.append(cur)
                cur = _PoEntry()
            assert cur is not None
            if kw == "msgctxt":
                if cur.ctxt is not None or cur.id is not None:
                    raise _NotStrict("msgctxt out of order")
                cur.ctxt = value
                cur.last = ("ctxt", 0)
            else:
                if cur.id is not None:
                    raise _NotStrict("msgid out of order")
                cur.id = value
                cur.last = ("id", 0)
        elif kw == "msgid_plural":
            if cur is None or cur.id is None or cur.plural is not None or cur.strs:
                raise _NotStrict("msgid_plural out of order")
            cur.plural = value
            cur.last = ("plural", 0)
        else:  # msgstr / msgstr[N]
            if cur is None or cur.id is None:
                raise _NotStrict("msgstr out of order")
            if idx is None:
                if cur.plural is not None or cur.strs:
                    raise _NotStrict("msgstr out of order")
                cur.strs.append(value)
            else:
                if cur.plural is None or int(idx) != len(cur.strs):
                    raise _NotStrict("msgstr[N] out of order")
                cur.indexed = True
                cur.strs.append(value)
            cur.last = ("str", len(cur.strs) - 1)
    if cur is not None:
        if not cur.complete():
            raise _NotStrict("incomplete entry")
        entries.append(cur)
    locale: Optional[str] = None
    header_seen = False
    seen = set()
    messages: List[L10nMessage] = []
    for e in entries:
        if not e.complete():
            raise _NotStrict("incomplete entry")
        assert e.id is not None
        if e.id == "" and e.ctxt is None:
            if header_seen or e.plural is not None:
                raise _NotStrict("a second header, or a plural header")
            header_seen = True
            for hl in e.strs[0].split("\n"):
                if hl.startswith("Language:"):
                    locale = hl[len("Language:") :].strip(" \t")
                    break
            continue
        key = (e.ctxt, e.id)
        if key in seen:
            raise _NotStrict("duplicate message")
        seen.add(key)
        messages.append(L10nMessage(e.ctxt, e.id, e.plural, list(e.strs)))
    if not header_seen or not locale:
        raise _NotStrict("no Language header")
    return L10nParseResult(True, [L10nTable(path, locale, messages)])


# ── CSV ─────────────────────────────────────────────────────────────────────────────────────


def _csv_records(text: str) -> List[List[str]]:
    """RFC 4180 records (comma only): ``\\n`` or ``\\r\\n`` outside quotes ends a record; a
    final empty line is not a record and other empty lines are skipped."""
    records: List[List[str]] = []
    n = len(text)
    i = 0
    while i < n:
        # An empty line (a record with no characters) is skipped.
        if text[i] == "\n":
            i += 1
            continue
        if text.startswith("\r\n", i):
            i += 2
            continue
        fields: List[str] = []
        while True:
            if i < n and text[i] == '"':
                i += 1
                buf: List[str] = []
                while True:
                    if i >= n:
                        raise _NotStrict("unterminated quote")
                    c = text[i]
                    if c == '"':
                        if i + 1 < n and text[i + 1] == '"':
                            buf.append('"')
                            i += 2
                            continue
                        i += 1
                        break
                    buf.append(c)
                    i += 1
                fields.append("".join(buf))
                if i < n and not (text[i] == "," or text[i] == "\n" or text.startswith("\r\n", i)):
                    raise _NotStrict("text after a closing quote")
            else:
                j = i
                while j < n and text[j] != "," and text[j] != "\n" and not text.startswith("\r\n", j):
                    if text[j] == '"':
                        raise _NotStrict("a quote inside an unquoted field")
                    j += 1
                fields.append(text[i:j])
                i = j
            if i < n and text[i] == ",":
                i += 1
                continue
            break
        if i < n:
            i += 2 if text.startswith("\r\n", i) else 1
        records.append(fields)
    return records


def _csv_table(path: str, text: str) -> L10nParseResult:
    records = _csv_records(text)
    if not records:
        raise _NotStrict("no header")
    header = records[0]
    if len(header) < 2:
        raise _NotStrict("no locale column")
    seen_locales = set()
    for loc in header[1:]:
        # ASCII-only lowercasing, as every other SDK: str.lower() would fold U+212A KELVIN SIGN
        # to "k" and call two different columns the same locale.
        k = _ascii_lower(loc.replace("_", "-"))
        if k in seen_locales:
            raise _NotStrict("duplicate locale column")
        seen_locales.add(k)
    tables = [L10nTable(path, loc, []) for loc in header[1:]]
    keys = set()
    for row in records[1:]:
        if len(row) != len(header):
            raise _NotStrict("ragged row")
        key = row[0]
        if key == "":
            raise _NotStrict("empty key")
        if key in keys:
            raise _NotStrict("duplicate key")
        keys.add(key)
        for t, cell in zip(tables, row[1:]):
            t.messages.append(L10nMessage(None, key, None, [cell]))
    return L10nParseResult(True, tables)
