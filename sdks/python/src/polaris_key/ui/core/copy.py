"""The kit copy lookup and the ICU-subset formatter (docs/design/UI-KITS.md §4.7, plans/UK-02.md D3, D5).

Every visible string a Python kit draws comes through :class:`Copy`: the generated tables in
``polaris_key.ui.kit_copy_generated`` (kit keys plus the core copy under ``core.*``), looked up the
way every kit must:

1. the integrator's override for the active locale,
2. the locale's table,
3. the English override,
4. English.

A key no table has is a programming error and raises ``KeyError``. Messages use the catalog's ICU
subset: plain ``{arg}`` arguments, at most one ``{n, plural, …}`` on an integer argument with the
locale's CLDR categories (``#`` is the integer), and ``{formFactor, select, …}``. A missing argument
stays as ``{name}`` so the gap is visible, as in the reference formatter
(``packages/brand/scripts/kit-copy.ts``, ``formatMessage``). Dates, durations and byte sizes are
formatted by the caller and passed as strings.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Mapping, Optional, Tuple, Union

from ..kit_copy_generated import KIT_COPY, KIT_COPY_LOCALES, KIT_COPY_VARIANTS

__all__ = [
    "Copy",
    "LOCALES",
    "format_message",
    "plural_category",
    "resolve_locale",
]

#: The launch locales, English first.
LOCALES: Tuple[str, ...] = tuple(KIT_COPY_LOCALES)

#: Overrides: ``{locale: {key: value}}``, or a flat ``{key: value}`` for every locale.
Overrides = Mapping[str, Union[str, Mapping[str, str]]]


def resolve_locale(requested: Optional[str] = None, env: Optional[Mapping[str, str]] = None) -> str:
    """The launch locale for ``requested`` (a BCP 47 tag or a POSIX locale such as
    ``de_DE.UTF-8``), else for the environment (``LC_ALL``, ``LC_MESSAGES``, ``LANG``), else
    ``"en"``. ``pt`` and ``pt_BR`` map to ``pt-BR``; ``zh``, ``zh_CN``, ``zh_SG`` and ``zh-Hans``
    to ``zh-Hans``; anything else outside the launch set falls back to English."""
    environ = os.environ if env is None else env
    candidates: List[str] = []
    if requested:
        candidates.append(requested)
    for name in ("LC_ALL", "LC_MESSAGES", "LANG"):
        value = environ.get(name)
        if value:
            candidates.append(value)
            break
    for raw in candidates:
        tag = raw.split(".", 1)[0].split("@", 1)[0].replace("_", "-")
        if not tag or tag in ("C", "POSIX"):
            continue
        parts = tag.split("-")
        lang = parts[0].lower()
        rest = [p for p in parts[1:] if p]
        if lang == "pt":
            return "pt-BR"
        if lang == "zh":
            if any(p.lower() in ("hant", "tw", "hk", "mo") for p in rest):
                continue
            return "zh-Hans"
        if lang in LOCALES:
            return lang
    return "en"


def plural_category(locale: str, n: int) -> str:
    """The CLDR plural category of the integer ``n`` in ``locale`` (integers only: the catalog's
    plural arguments are counts). Matches ``Intl.PluralRules`` for the launch locales."""
    n = abs(int(n))
    lang = locale.split("-", 1)[0]
    if lang in ("ja", "ko", "zh"):
        return "other"
    if lang in ("en", "de"):
        return "one" if n == 1 else "other"
    million = n != 0 and n % 1_000_000 == 0
    if lang in ("fr", "pt"):
        if n in (0, 1):
            return "one"
        return "many" if million else "other"
    if lang in ("es", "it"):
        if n == 1:
            return "one"
        return "many" if million else "other"
    return "one" if n == 1 else "other"


# ── The ICU subset ───────────────────────────────────────────────────────────────────────────

# A parsed message: literal text and plain arguments, around at most one complex argument.
# Piece = ("text", str) | ("arg", name) | ("num", "") | ("complex", (arg, kind, {case: [Piece]}))
_Piece = Tuple[str, Any]
_PARSED: Dict[str, List[_Piece]] = {}


def _parse(message: str) -> List[_Piece]:
    cached = _PARSED.get(message)
    if cached is not None:
        return cached
    pieces, i = _read(message, 0, None)
    if i != len(message):
        raise ValueError(f"unbalanced braces in message: {message!r}")
    _PARSED[message] = pieces
    return pieces


def _read(src: str, i: int, in_case: Optional[str]) -> Tuple[List[_Piece], int]:
    pieces: List[_Piece] = []
    text: List[str] = []

    def flush() -> None:
        if text:
            pieces.append(("text", "".join(text)))
            text.clear()

    while i < len(src):
        ch = src[i]
        if ch == "}" and in_case is not None:
            break
        if ch == "#" and in_case == "plural":
            flush()
            pieces.append(("num", ""))
            i += 1
            continue
        if ch != "{":
            text.append(ch)
            i += 1
            continue
        flush()
        close = src.find("}", i)
        comma = src.find(",", i)
        if close < 0:
            raise ValueError(f"unbalanced braces in message: {src!r}")
        if comma < 0 or close < comma:
            pieces.append(("arg", src[i + 1 : close].strip()))
            i = close + 1
            continue
        name = src[i + 1 : comma].strip()
        j = src.find(",", comma + 1)
        kind = src[comma + 1 : j].strip()
        if kind not in ("plural", "select"):
            raise ValueError(f"ICU type {kind!r} is outside the subset: {src!r}")
        i = j + 1
        cases: Dict[str, List[_Piece]] = {}
        while True:
            while i < len(src) and src[i] == " ":
                i += 1
            if i < len(src) and src[i] == "}":
                i += 1
                break
            k = src.find("{", i)
            case = src[i:k].strip()
            body, i = _read(src, k + 1, kind)
            cases[case] = body
            i += 1  # the case's closing brace
        pieces.append(("complex", (name, kind, cases)))
    flush()
    return pieces, i


def _render(pieces: List[_Piece], args: Mapping[str, Any], locale: str, number: Any) -> str:
    out: List[str] = []
    for kind, value in pieces:
        if kind == "text":
            out.append(value)
        elif kind == "arg":
            out.append(str(args[value]) if value in args and args[value] is not None else "{" + value + "}")
        elif kind == "num":
            out.append(str(number))
        else:
            name, sel, cases = value
            v = args.get(name)
            if sel == "plural":
                try:
                    n = int(v)  # type: ignore[arg-type]
                except (TypeError, ValueError):
                    out.append("{" + name + "}")
                    continue
                case = plural_category(locale, n)
                if case not in cases:
                    case = "other"
                out.append(_render(cases[case], args, locale, n))
            else:
                case = v if isinstance(v, str) and v in cases else "other"
                out.append(_render(cases[case], args, locale, number))
    return "".join(out)


def format_message(locale: str, message: str, args: Optional[Mapping[str, Any]] = None) -> str:
    """Format one catalog ``message`` in ``locale`` with ``args`` (the ICU subset above)."""
    return _render(_parse(message), args or {}, locale, "#")


class Copy:
    """The kit copy for one locale, with the integrator's overrides and a platform variant.

    ``copy("deviceLimit.heading", used=3, limit=3)`` formats a key; ``copy.raw(key)`` is its
    unformatted message. ``platform`` selects a key's documented variant (UI-KITS §4.7) in English
    only; the terminal has none today, so it is ``"terminal"`` by default."""

    def __init__(
        self,
        locale: Optional[str] = None,
        overrides: Optional[Overrides] = None,
        *,
        platform: str = "terminal",
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.locale = resolve_locale(locale, env)
        self.platform = platform
        self._overrides: Dict[str, Dict[str, str]] = {}
        for k, v in (overrides or {}).items():
            if isinstance(v, str):
                for loc in LOCALES:
                    self._overrides.setdefault(loc, {})[k] = v
            else:
                self._overrides.setdefault(resolve_locale(k, {}), {}).update(v)

    def has(self, key: str) -> bool:
        return key in KIT_COPY["en"]

    def raw(self, key: str) -> str:
        own = self._overrides.get(self.locale, {})
        if key in own:
            return own[key]
        if self.locale != "en" and key in KIT_COPY.get(self.locale, {}):
            return KIT_COPY[self.locale][key]
        english = self._overrides.get("en", {})
        if key in english:
            return english[key]
        variant = KIT_COPY_VARIANTS.get(key, {}).get(self.platform)
        if variant is not None:
            return variant
        return KIT_COPY["en"][key]

    def __call__(self, key: str, **args: Any) -> str:
        return format_message(self.locale, self.raw(key), args)
