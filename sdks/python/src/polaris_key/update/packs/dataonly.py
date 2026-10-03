"""The data-only rule for delegated installs (plans/P4-19.md §2.5 and Amendment A1,
WIRE-CONTRACT-V4 §2.8). A port of client-core's ``packs/dataonly.ts``.

A pack release signed by a delegated content key may hold only files this rule admits. The
extension allow-list is the real control (Godot chooses its resource loader by extension); the
head and tail sniffs and the text rule are defence in depth that fail closed. The engine runs
the extension rule over the files index before any payload object is fetched and the whole rule
on each file's decoded bytes as the applier writes it. Release-signed packs keep their own
rules. Pure; never raises.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

from ...constants_generated import (
    DATA_ONLY_EXTENSION_VALUES,
    DATA_ONLY_HEAD_BYTES,
    DATA_ONLY_TAIL_BYTES,
)
from .files import _path_safe

__all__ = [
    "DATA_ONLY_TEXT_EXTENSIONS",
    "DATA_ONLY_SCRIPT_MARKERS",
    "DataOnlyRefusalSeen",
    "data_only_extension",
    "data_only_path_refusal",
    "data_only_text_refusal",
    "data_only_refusal",
    "data_only_file_refusal",
    "data_only_tree_sink",
]

#: The refused heads (rule 3), after a UTF-8 BOM and ASCII whitespace are skipped: Godot
#: resource, pack and script formats; archives and native code; scripts. With ``_WORD_HEADS``
#: (each followed by a space or a tab) these are the 20 entries.
_HEADS = (
    # Godot.
    b"RSRC",
    b"RSCC",
    b"GDPC",
    b"GDEC",
    b"GCPF",
    b"GDSC",
    b"[gd_",
    # Archives and native code.
    b"PK\x03\x04",
    b"\x7fELF",
    b"MZ",
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\x00asm",
    # Scripts.
    b"#!",
    b"@tool",
)
_WORD_HEADS = (b"extends", b"class_name")

#: ``PK\x05\x06``: a zip end-of-central-directory record (rule 4).
_ZIP_EOCD = b"PK\x05\x06"
_GDPC = b"GDPC"
_BOM = b"\xef\xbb\xbf"

#: The extensions whose files are text a VariantParser reader could parse (Amendment A1): the
#: whole decoded file passes the text rule.
DATA_ONLY_TEXT_EXTENSIONS = ("json", "csv", "tsv", "po", "txt")

#: The script markers a text file may not hold (Amendment A1): the script types, then the
#: properties that hold a script's source. The same list as P4-08's ``packLint``
#: ``SCRIPT_MARKERS``.
DATA_ONLY_SCRIPT_MARKERS = (
    "GDScript",
    "CSharpScript",
    "ScriptExtension",
    "script/source",
    "source_code",
)

_HEX4 = re.compile(r"[0-9A-Fa-f]{4}")
_HEX6 = re.compile(r"[0-9A-Fa-f]{6}")


def _is_ws(b: int) -> bool:
    return b == 0x20 or 0x09 <= b <= 0x0D


def _straddles(window: bytes, at: int, magic: bytes) -> bool:
    """True when the window ends inside ``magic`` read from ``at``: what is visible is its
    prefix."""
    if at + len(magic) <= len(window):
        return False
    return magic.startswith(window[at:])


def _ascii_escape(text: str) -> bool:
    """True when the text holds a ``\\u`` or ``\\U`` escape that could spell ASCII (Amendment
    A1): ``\\u`` not followed by exactly 4 hex digits, or ``\\U`` not followed by exactly 6
    (VariantParser's form), or either decoding below 0x80. Escapes of non-ASCII characters
    (surrogate halves included) pass."""
    at = text.find("\\")
    while at >= 0:
        c = text[at + 1 : at + 2]
        if c in ("u", "U"):
            n = 4 if c == "u" else 6
            digits = text[at + 2 : at + 2 + n]
            if (_HEX4 if n == 4 else _HEX6).fullmatch(digits) is None:
                return True
            if int(digits, 16) < 0x80:
                return True
        at = text.find("\\", at + 1)
    return False


def data_only_text_refusal(data: bytes) -> Optional[str]:
    """Rule 5 (Amendment A1), over a text file's whole decoded bytes: ``content`` when the bytes
    are not valid UTF-8 (decoded strictly, as client-core's fatal ``TextDecoder``) or hold a
    NUL; when the text, or the text with every backslash removed, holds a script marker; or when
    it holds a ``\\u`` or ``\\U`` escape that could spell ASCII. ``None`` when admitted."""
    try:
        text = bytes(data).decode("utf-8", "strict")
    except Exception:
        return "content"
    if "\x00" in text:
        return "content"
    if _ascii_escape(text):
        return "content"
    bare = text.replace("\\", "")
    for m in DATA_ONLY_SCRIPT_MARKERS:
        if m in text or m in bare:
            return "content"
    return None


def data_only_extension(path: str) -> Optional[str]:
    """Rule 2: the final segment's text after its last ``.``, ASCII-lowercased; ``None``
    without one."""
    last = path[path.rfind("/") + 1 :]
    dot = last.rfind(".")
    if dot < 0:
        return None
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in last[dot + 1 :])


def data_only_path_refusal(path: Any) -> Optional[str]:
    """Rules 1 and 2 alone, over a path: ``extension`` when the path is not already normalised
    (it fails the files index's path rules) or its extension is not in
    ``DATA_ONLY_EXTENSIONS``."""
    if not isinstance(path, str) or not _path_safe(path):
        return "extension"
    ext = data_only_extension(path)
    if ext is None or ext not in DATA_ONLY_EXTENSION_VALUES:
        return "extension"
    return None


def data_only_refusal(
    path: Any, head: bytes, tail: bytes, full: Optional[bytes] = None
) -> Optional[str]:
    """The data-only rule over one file (plans/P4-19.md §2.5): ``path`` its index path,
    ``head`` its first ``DATA_ONLY_HEAD_BYTES`` decoded bytes (fewer for a shorter file),
    ``tail`` its last ``DATA_ONLY_TAIL_BYTES`` (fewer for a shorter file; the two may overlap),
    ``full`` the whole decoded file. In order:

    1. the path is already normalised, else ``extension``;
    2. its extension is in ``DATA_ONLY_EXTENSIONS``, else ``extension``;
    3. after a UTF-8 BOM and then ASCII whitespace inside ``head``, what remains starts with
       none of the refused heads, else ``content``. When ``head`` is a full window (it may cut
       the file), the skip reaching its end, or a refused head that the window's end cuts, is
       ``content`` too (Amendment A1);
    4. ``tail`` does not end with ``GDPC`` and holds no ``PK\\x05\\x06``, else ``content``;
    5. a text file (``DATA_ONLY_TEXT_EXTENSIONS``) passes :func:`data_only_text_refusal` over
       ``full``; without ``full`` such a file is refused (``content``).

    ``None`` when the file is admitted. Never raises."""
    p = data_only_path_refusal(path)
    if p is not None:
        return p
    h = bytes(head[:DATA_ONLY_HEAD_BYTES])
    at = 3 if h.startswith(_BOM) else 0
    while at < len(h) and _is_ws(h[at]):
        at += 1
    # A full window may cut the file: what it cannot see is refused (fails closed).
    cut = len(h) == DATA_ONLY_HEAD_BYTES
    if cut and at == len(h):
        return "content"
    for m in _HEADS:
        if h.startswith(m, at) or (cut and _straddles(h, at, m)):
            return "content"
    for m in _WORD_HEADS:
        if h.startswith(m, at):
            k = at + len(m)
            if k < len(h):
                if h[k] in (0x20, 0x09):
                    return "content"
            elif cut:
                return "content"
        elif cut and _straddles(h, at, m):
            return "content"
    t = bytes(tail)
    if len(t) > DATA_ONLY_TAIL_BYTES:
        t = t[len(t) - DATA_ONLY_TAIL_BYTES :]
    if t.endswith(_GDPC):
        return "content"
    if _ZIP_EOCD in t:
        return "content"
    if data_only_extension(path) in DATA_ONLY_TEXT_EXTENSIONS:
        return "content" if full is None else data_only_text_refusal(full)
    return None


def data_only_file_refusal(path: Any, data: bytes) -> Optional[str]:
    """:func:`data_only_refusal` over a whole file's decoded bytes."""
    return data_only_refusal(
        path,
        data[:DATA_ONLY_HEAD_BYTES],
        data[max(0, len(data) - DATA_ONLY_TAIL_BYTES) :],
        data,
    )


@dataclass
class DataOnlyRefusalSeen:
    """A refusal the data-only tree sink saw: the first file it refused."""

    path: str
    rule: str


class _DataOnlyTreeSink:
    def __init__(self, inner: Any, seen: "dict[str, Optional[DataOnlyRefusalSeen]]") -> None:
        self._inner = inner
        self._seen = seen

    def write_file(self, path: str, data: bytes) -> None:
        rule = data_only_file_refusal(path, data)
        if rule is not None:
            if self._seen.get("refusal") is None:
                self._seen["refusal"] = DataOnlyRefusalSeen(path=path, rule=rule)
            raise ValueError(f"pack-not-data-only: {path} ({rule})")
        self._inner.write_file(path, data)


def data_only_tree_sink(inner: Any, seen: "dict[str, Optional[DataOnlyRefusalSeen]]") -> Any:
    """Wrap a tree sink so every file a delegated install writes passes
    :func:`data_only_refusal` before it reaches the sink. The first refusal is recorded in
    ``seen["refusal"]`` and the write raises, which fails the applier; the engine then aborts
    the plan with ``pack-not-data-only``."""
    return _DataOnlyTreeSink(inner, seen)
