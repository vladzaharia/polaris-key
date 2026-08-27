"""Layered config resolution.

Mirrors ``@polaris-key/client-core``'s ``config.ts``. The signed remote config document carries,
per key, a ``ManagedEntry`` with a management ``state``. The client honours that state and
otherwise layers local + environment overrides on top of the remote default::

    enforced | hidden (remote) > local override > environment > remote default > fallback

``enforced``/``hidden`` always win (the value is locked to the server); a ``default`` (or
an absent entry) can be overridden locally or via an env var. See docs/CONCEPTS.md.

The environment is an injected lookup table, never ``os.environ`` read here, so a host can
resolve against a table it controls.

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


def _read_env(ctx: ResolveContext, key: str) -> Any:
    """Read a key from the environment, JSON-parsing when it parses, else returning the
    raw string. Returns :data:`UNSET` when the var is unset."""
    name = env_var_name(ctx.env_prefix, key)
    if name not in ctx.env:
        return UNSET
    raw = ctx.env[name]
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


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
    """The user-facing catalog list (for settings UIs): every remote entry MINUS the
    ``hidden`` ones, each marked with whether it is ``enforced`` (read-only in the UI).

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
