"""Layered config resolution.

Mirrors ``@polaris-key/client-core``'s ``config.ts``. The signed remote config document carries,
per key, a ``ManagedEntry`` with a management ``state``. The client honours that state and
otherwise layers local + environment overrides on top of the remote default::

    enforced | hidden (remote) > local override > environment > remote default > fallback

``enforced``/``hidden`` always win (the value is locked to the server); a ``default`` (or
an absent entry) can be overridden locally or via an env var. See
packages/docs/src/content/docs/start/concepts.md.

The environment is an injected lookup table, never ``os.environ`` read here, so a host can
resolve against a table it controls. Its values follow WIRE-CONTRACT-V3 §2.2.1 rule 2 (pinned by
``conformance/corpus/v2/config-matrix.json``): a value is parsed only when the raw string is one
strict JSON text — no duplicate member names, no member name holding U+0000, no lone surrogate
(``os.environ`` holds one for each byte it cannot decode), every number zero or of magnitude
10^-307 up to below 10^308 judged from its digits, at most 64 levels deep — and is otherwise
the raw string. Reading a variable never raises.

ENV PREFIX. A key's env var is ``<prefix><key with "." → "__">`` — ``run.concurrency`` →
``PKEY_CONFIG_run__concurrency``. The prefix is ``PKEY_CONFIG_``; the interim ``PLRS_CONFIG_``
spelling that Amendment A1 withdrew is NOT read as a fallback (§8/§9), and the suite has a
negative test pinning that.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple

from ..core.models import ManagedEntry
from ..core.strict_json import reject_duplicate_keys

__all__ = [
    "DEFAULT_ENV_PREFIX",
    "UNSET",
    "ResolveContext",
    "env_var_name",
    "resolve_value",
    "resolve_source",
    "list_user_entries",
]

#: The v3 env-var prefix for config overrides.
DEFAULT_ENV_PREFIX = "PKEY_CONFIG_"

#: Distinguishes "no value at any layer" from "a layer resolved to ``None``".
UNSET = object()


@dataclass(frozen=True)
class ResolveContext:
    """The inputs one resolution needs."""

    #: The remote config map from the verified config document (may be ``None`` when
    #: doc-less — a product with the config service disabled, or a first run).
    remote: Optional[Dict[str, ManagedEntry]]
    #: User/local overrides (highest precedence for ``default`` keys).
    local_overrides: Mapping[str, Any]
    #: Environment lookup table (the host supplies ``os.environ`` or an equivalent).
    env: Mapping[str, str]
    #: Env-var prefix.
    env_prefix: str = DEFAULT_ENV_PREFIX


def env_var_name(env_prefix: str, key: str) -> str:
    """``run.concurrency`` → ``PKEY_CONFIG_run__concurrency`` (dots become double
    underscores). The prefix itself is the HOST's; this module only owns the dot→``__``
    mapping, which every SDK must agree on."""
    return env_prefix + key.replace(".", "__")


#: Rule 2: at most this many arrays and objects open at any point.
_MAX_ENV_DEPTH = 64
#: Rule 2: a non-zero number's first non-zero digit has a power of ten within ±307.
_MAX_DECIMAL_EXPONENT = 307
#: Rule 2: an exponent part has at most this many significant digits.
_MAX_EXPONENT_DIGITS = 6


def _nesting_exceeds(raw: str, limit: int) -> bool:
    """True when more than ``limit`` arrays and objects are open at some point. String
    contents are skipped (a backslash skips the next character). Iterative, and exact for
    every text ``json.loads`` accepts; any other text is raw anyway."""
    depth = 0
    in_string = False
    i = 0
    n = len(raw)
    while i < n:
        c = raw[i]
        if in_string:
            if c == "\\":
                i += 1
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c == "[" or c == "{":
            depth += 1
            if depth > limit:
                return True
        elif c == "]" or c == "}":
            depth -= 1
        i += 1
    return False


def _number_token_in_range(token: str) -> bool:
    """Judge one JSON number token from its decimal digits, with no floating point. In range
    when its exponent part has at most six significant digits and the number is zero or its
    first non-zero digit's power of ten is from -307 to 307."""
    mantissa, _, exponent = token.lower().partition("e")
    if mantissa.startswith("-"):
        mantissa = mantissa[1:]
    integer, _, fraction = mantissa.partition(".")
    exp_digits = exponent.lstrip("+-").lstrip("0")
    if len(exp_digits) > _MAX_EXPONENT_DIGITS:
        return False
    exp = int(exp_digits) if exp_digits.isdigit() else 0
    if exponent.startswith("-"):
        exp = -exp
    digits = integer + fraction
    stripped = digits.lstrip("0")
    if stripped == "":
        return True  # every digit is zero
    leading_zeros = len(digits) - len(stripped)
    power = len(integer) - 1 - leading_zeros + exp
    return -_MAX_DECIMAL_EXPONENT <= power <= _MAX_DECIMAL_EXPONENT


def _ranged_int(token: str) -> int:
    if not _number_token_in_range(token):
        raise ValueError("number out of range")
    return int(token)


def _ranged_float(token: str) -> float:
    if not _number_token_in_range(token):
        raise ValueError("number out of range")
    return float(token)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def _has_lone_surrogate(s: str) -> bool:
    # A Python ``str`` holds code points, so any surrogate code point is lone: a well-formed
    # escaped pair (``"\\ud83d\\ude00"``) is decoded to one non-surrogate code point.
    return any("\ud800" <= ch <= "\udfff" for ch in s)


def _strict_pairs(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    """Rule 2's member-name checks: no duplicate (compared by code point), and no name holding
    U+0000 or a lone surrogate."""
    for key, _value in pairs:
        if "\x00" in key or _has_lone_surrogate(key):
            raise ValueError("refused member name")
    return reject_duplicate_keys(pairs)


def _strings_allowed(value: Any) -> bool:
    """No lone surrogate in any string value. Recursion is bounded by the depth scan."""
    if isinstance(value, str):
        return not _has_lone_surrogate(value)
    if isinstance(value, list):
        return all(_strings_allowed(v) for v in value)
    if isinstance(value, dict):
        return all(_strings_allowed(v) for v in value.values())
    return True


def _parse_env_value(raw: str) -> Any:
    """Rule 2: the parsed value, or the raw string unchanged. Never raises."""
    try:
        if _nesting_exceeds(raw, _MAX_ENV_DEPTH):
            return raw
        value = json.loads(
            raw,
            object_pairs_hook=_strict_pairs,
            parse_constant=_reject_constant,
            parse_float=_ranged_float,
            parse_int=_ranged_int,
        )
        if not _strings_allowed(value):
            return raw
        return value
    except (ValueError, TypeError, OverflowError, RecursionError):
        return raw


def _read_env(ctx: ResolveContext, key: str) -> Any:
    """Read a key from the environment (rules 1-2). Returns :data:`UNSET` when the variable is
    unset; a set but empty variable counts."""
    name = env_var_name(ctx.env_prefix, key)
    if name not in ctx.env:
        return UNSET
    raw = ctx.env[name]
    if not isinstance(raw, str):
        return UNSET
    return _parse_env_value(raw)


def _entry(ctx: ResolveContext, key: str) -> Optional[ManagedEntry]:
    if not ctx.remote:
        return None
    return ctx.remote.get(key)


def resolve(ctx: ResolveContext, key: str, fallback: Any = None) -> Tuple[Any, str]:
    """Return ``(value, source)`` per the layered precedence."""
    entry = _entry(ctx, key)
    if entry is not None and entry.state in ("enforced", "hidden"):
        # The remote value is LOCKED; local/env are ignored. That is the whole point of
        # the management state.
        return entry.value, ("hidden" if entry.state == "hidden" else "enforced")
    if key in ctx.local_overrides:
        return ctx.local_overrides[key], "local"
    env_value = _read_env(ctx, key)
    if env_value is not UNSET:
        return env_value, "env"
    if entry is not None:
        return entry.value, "remote-default"
    return fallback, "fallback"


def resolve_value(ctx: ResolveContext, key: str, fallback: Any = None) -> Any:
    """Resolve the effective value for a key, honouring management state + the override
    layers."""
    value, _source = resolve(ctx, key, fallback)
    return value


def resolve_source(ctx: ResolveContext, key: str) -> str:
    """One of ``enforced|hidden|local|env|remote-default|fallback``."""
    _value, source = resolve(ctx, key)
    return source


def list_user_entries(ctx: ResolveContext) -> List[Dict[str, Any]]:
    """The user-facing catalog list (for settings UIs, WIRE-CONTRACT-V3 §2.2.1 rule 4): every
    document entry MINUS the ``hidden`` ones, each with its resolved value and whether it is
    ``enforced`` (read-only in the UI). A key only a local override or the environment
    supplies is not listed.

    ``hidden`` keys are still APPLIED by :func:`resolve_value`; they are merely withheld
    from this enumeration.
    """
    out: List[Dict[str, Any]] = []
    for key, entry in (ctx.remote or {}).items():
        if entry.state == "hidden":
            continue
        value, _source = resolve(ctx, key, entry.value)
        out.append({"key": key, "value": value, "enforced": entry.state == "enforced"})
    return out
