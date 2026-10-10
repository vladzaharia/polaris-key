"""User-facing copy for every code the SDK can surface (SDK parity pass §3.2, ``core.copy``).

``message(code)`` and ``title(code)`` turn a registry error code (``errors.json``), a gate status
(``licenseStatus``) or an activation result (``activationResult``) into a short English sentence
and heading for a CLI line, a dialog or a log.

ENGLISH IS GENERATED. :mod:`polaris_key.copy_generated` is written by ``pnpm gen constants`` from
``conformance/parity/copy.en.json`` with three tables, kept apart on purpose as React and Node
read them: ``COPY_CODES`` (per error code), ``COPY_GATE`` (per gate status) and
``COPY_ACTIVATION`` (per activation result). The error code ``unauthorized`` reads "Not signed
in"; the activation result ``unauthorized`` reads "Key not accepted".

* :func:`message` / :func:`title` look a code up as an error code, then as a gate status, then as
  an activation result.
* :func:`activation_message` / :func:`activation_title` read a typed activation result
  (``ActivationResult.kind``) from the activation table only.
* :func:`describe_error` says an activation result a verb returned or an error it raised.

A code with no entry falls back to ``COPY_FALLBACK``, which names the code and never shows a raw
server body. ``{name}`` placeholders are filled from ``params`` (``{code}`` defaults to the code);
an unfilled placeholder is dropped with the space before it, so a raw ``{name}`` never shows.

:func:`register_locale` adds a table for another locale (missing keys fall back to English). For
``en`` it feeds the host's override layer instead, which wins per key over the generated text.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Optional, Tuple, Union

from .copy_generated import (
    COPY_ACTIVATION,
    COPY_CODES,
    COPY_FALLBACK,
    COPY_GATE,
    COPY_PLACEHOLDERS,
    CopyEntry,
)

__all__ = [
    "message",
    "title",
    "activation_message",
    "activation_title",
    "describe_error",
    "has_copy",
    "register_locale",
    "reset_overrides",
    "COPY_FALLBACK",
    "COPY_PLACEHOLDERS",
    "GENERIC",
    "CopyEntry",
]

#: The fallback for a code without copy (an alias of the generated ``COPY_FALLBACK``).
GENERIC = COPY_FALLBACK

Params = Mapping[str, Union[str, int, float]]

#: The host's English override layer (``register_locale("en", ...)``): code → (title, message).
_OVERRIDES: Dict[str, Tuple[str, str]] = {}
#: Non-English locale tables: tag → code → (title, message).
_LOCALES: Dict[str, Dict[str, Tuple[str, str]]] = {}

_PLACEHOLDER = re.compile(r"( ?)\{(\w+)\}")
_CAMEL = re.compile(r"[A-Z]")


def register_locale(locale: str, table: Mapping[str, Tuple[str, str]]) -> None:
    """Add entries (code → ``(title, message)``) to a locale. ``en`` entries override the
    generated English for those keys only; every other key keeps the generated text."""
    tag = locale.lower().replace("_", "-")
    target = _OVERRIDES if tag == "en" else _LOCALES.setdefault(tag, {})
    target.update(table)


def reset_overrides() -> None:
    """Drop every host override and registered locale (tests, or a host reloading its copy)."""
    _OVERRIDES.clear()
    _LOCALES.clear()


def _activation_key(kind: str) -> str:
    """``deviceLimit`` / ``device_limit`` / ``device-limit`` → the activationResult spelling."""
    return _CAMEL.sub(lambda m: "-" + m.group(0).lower(), kind).replace("_", "-")


def _english(code: str) -> Optional[CopyEntry]:
    """The generated entry: error code, then gate status, then activation result."""
    return COPY_CODES.get(code) or COPY_GATE.get(code) or COPY_ACTIVATION.get(_activation_key(code))


def _localised(code: str, locale: Optional[str]) -> Optional[Tuple[str, str]]:
    """A registered non-English entry (exact tag, then its language), else a host override."""
    if locale:
        tag = locale.lower().replace("_", "-")
        for candidate in (tag, tag.split("-")[0]):
            table = _LOCALES.get(candidate)
            if table and code in table:
                return table[code]
    return _OVERRIDES.get(code)


def _fill(text: str, code: str, params: Optional[Params]) -> str:
    values = params or {}

    def sub(m: "re.Match[str]") -> str:
        space, name = m.group(1), m.group(2)
        value = values.get(name)
        if value is not None:
            return f"{space}{value}"
        if name == "code":
            return f"{space}{code}"
        return ""

    return _PLACEHOLDER.sub(sub, text)


def has_copy(code: str, locale: Optional[str] = None) -> bool:
    """Whether ``code`` has its own sentence (a locale entry, a host override or generated)."""
    return _localised(code, locale) is not None or _english(code) is not None


def message(
    code: str,
    detail: Optional[str] = None,
    locale: Optional[str] = None,
    *,
    params: Optional[Params] = None,
) -> str:
    """The sentence for ``code``; ``detail`` (a refusal's reason, say) is appended in
    parentheses. An unknown code reads ``COPY_FALLBACK`` naming it."""
    own = _localised(code, locale)
    if own is not None:
        text = own[1]
    else:
        entry = _english(code)
        text = entry.message if entry is not None else COPY_FALLBACK.message
    out = _fill(text, code, params)
    return f"{out} ({detail})" if detail else out


def title(code: str, locale: Optional[str] = None) -> str:
    """The short heading for ``code``, or ``COPY_FALLBACK``'s title."""
    own = _localised(code, locale)
    if own is not None:
        return own[0]
    entry = _english(code)
    return entry.title if entry is not None else COPY_FALLBACK.title


def _activation_entry(kind: str, locale: Optional[str]) -> Optional[Tuple[str, str]]:
    key = _activation_key(kind)
    own = _localised(key, locale)
    if own is not None:
        return own
    return COPY_ACTIVATION.get(key)


def activation_message(
    kind: str,
    *,
    locale: Optional[str] = None,
    code: Optional[str] = None,
    params: Optional[Params] = None,
) -> str:
    """The sentence for a typed activation result, from the activation table only (never the
    error-code table). ``refused`` names the server's ``code``. A kind outside the table reads
    like :func:`message`."""
    entry = _activation_entry(kind, locale)
    if entry is None:
        return message(kind, locale=locale, params=params)
    return _fill(entry[1], code or kind, params)


def activation_title(kind: str, locale: Optional[str] = None) -> str:
    """The heading for a typed activation result."""
    entry = _activation_entry(kind, locale)
    return entry[0] if entry is not None else title(kind, locale)


def describe_error(err: Any, locale: Optional[str] = None) -> str:
    """The sentence for an activation result (anything with ``kind``) or a raised error (anything
    with ``code``). An activation result reads the activation table, except ``refused``, which
    reads the server code's own sentence when the catalog has one."""
    if err is None:
        return message("unknown", locale=locale)
    kind = getattr(err, "kind", None)
    code = getattr(err, "code", None)
    code = code if isinstance(code, str) else None
    if isinstance(kind, str) and kind != "ok":
        params: Dict[str, Union[str, int, float]] = {}
        for name in ("limit", "deviceCount", "retryAfterSeconds"):
            value = getattr(err, name, None)
            if value is not None:
                params[name] = value
        if kind == "refused" and code is not None and has_copy(code, locale):
            return message(code, locale=locale, params=params)
        return activation_message(kind, locale=locale, code=code, params=params)
    return message(code or "unknown", locale=locale)
