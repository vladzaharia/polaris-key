"""The Config sub-client — layered settings resolution over the signed config document.

The resolution rules themselves are :mod:`polaris_key.config.resolve`'s, shared with the
Node/React/Swift ports and pinned by the same corpus. What lives here is the OVERRIDE
LAYERS, and they are config-side options rather than Core ones for a reason:
``env_prefix``, ``env`` and ``local_overrides`` are inputs to this resolution and to
nothing else, so a product that has disabled Config never has to think about them.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from typing import Any, Callable, Dict, List, Mapping, Optional

from ..core.cache import CacheManager
from ..core.context import CoreContext
from ..core.errors import PolarisError
from ..core.local_state import JsonStateFile
from ..core.models import ConfigDoc
from ..core.token import TokenManager
from .mint import MintCache, MintedToken, mint_token
from .resolve import (
    DEFAULT_ENV_PREFIX,
    UNSET,
    ResolveContext,
    list_user_entries,
    resolve,
    resolve_source,
)

__all__ = ["ConfigClient", "ConfigSetting", "DEFAULT_ENV_PREFIX", "UNSET", "MintedToken", "validate_value"]


class ConfigClient:
    def __init__(
        self,
        ctx: CoreContext,
        cache: CacheManager,
        *,
        local_overrides: Optional[Mapping[str, Any]] = None,
        env_prefix: str = DEFAULT_ENV_PREFIX,
        env: Optional[Mapping[str, str]] = None,
        tokens: Optional[TokenManager] = None,
        local_store: Optional[JsonStateFile] = None,
        events: Any = None,
    ) -> None:
        self._ctx = ctx
        self._cache = cache
        # The device credential edge-mint authenticates with. Without it `mint_token` has
        # nothing to present and refuses with `unauthorized`, as a client holding no token
        # does.
        self._tokens = tokens
        self._minted = MintCache()
        self._local_overrides: Dict[str, Any] = dict(local_overrides or {})
        #: ``config.local`` (SDK parity pass §3.11): the player's settings, persisted as JSON in
        #: the state directory (in memory without one) and layered over the host's
        #: ``local_overrides``.
        self._local_store = local_store or JsonStateFile(None, lambda: {"overrides": {}})
        self._local_lock = threading.RLock()
        persisted = self._local_store.load()
        if isinstance(persisted, dict) and isinstance(persisted.get("overrides"), dict):
            self._local_overrides.update(persisted["overrides"])
        self._events = events
        #: Set by the facade: runs after a local change so the facade's one change detector
        #: emits the ``config`` event (no duplicate on the next sync). Unset: emitted here.
        self.changed: Optional[Callable[[], None]] = None
        #: The catalog from the last successful :meth:`fetch_schema`, for ``set`` validation.
        self._catalog: Optional[Dict[str, Any]] = None
        self._env_prefix = env_prefix
        self._env: Mapping[str, str] = os.environ if env is None else env

    @property
    def doc(self) -> Optional[ConfigDoc]:
        return self._cache.config_doc()

    def _context(self) -> ResolveContext:
        doc = self.doc
        return ResolveContext(
            remote=doc.config if doc is not None else None,
            local_overrides=self._local_overrides,
            env=self._env,
            env_prefix=self._env_prefix,
        )

    def get_config(self, key: str, fallback: Any = None) -> Any:
        """Resolve the effective value for a key, honouring management state + the
        override layers."""
        value, _source = resolve(self._context(), key, fallback)
        return value

    def get_config_source(self, key: str) -> str:
        """Where :meth:`get_config` would source its value from (for diagnostics /
        settings UIs)."""
        return resolve_source(self._context(), key)

    def list_user_config(self) -> List[Dict[str, Any]]:
        """The catalog entries for a settings UI: every remote entry MINUS the ``hidden``
        ones, each ``{key, value, enforced}``."""
        return list_user_entries(self._context())

    def get_secret(self, key: str) -> Optional[str]:
        """A managed secret's value, or ``None``. Secrets are never enumerated."""
        doc = self.doc
        if doc is None:
            return None
        entry = doc.secrets.get(key)
        if entry is not None and isinstance(entry.value, str):
            return entry.value
        return None

    def schema_version(self) -> Optional[int]:
        """The product's active catalog version, as the last verified document stated it."""
        doc = self.doc
        return doc.schemaVersion if doc is not None else None

    def fetch_schema(self) -> Optional[Dict[str, Any]]:
        """``GET /<p>/config/schema`` — the product's active config catalog, parsed.

        Unsigned, unauthenticated and DIAGNOSTIC: nothing security-relevant is ever read
        from it (the values a client acts on arrive in the signed config document), so every
        failure — a refusal, a network error, a body that is not a catalog, local-only mode,
        a product that does not run Config (D-21: not even probed) — answers ``None``. It
        never raises.
        """
        if not self._ctx.enabled("config"):
            return None
        try:
            res = self._ctx.request(
                "GET",
                self._ctx.url("config/schema"),
                headers=self._ctx.headers({"accept": "application/json"}),
            )
            if not res.is_success:
                return None
            body = res.json()
        except Exception:  # noqa: BLE001 - diagnostic: any failure is "no catalog"
            return None
        if _is_catalog(body):
            self._catalog = body
            return body
        return None

    # ── config.local: persisted settings (SDK parity pass §3.11) ──────────────────────
    def set(self, key: str, value: Any, *, catalog: Optional[Mapping[str, Any]] = None) -> None:
        """Persist the player's value for ``key`` (a ``default``-state setting).

        Refused with ``managed_by_admin`` when the signed document enforces or hides the key,
        and with ``bad_request`` when the value is not JSON or fails the key's catalog schema
        (``catalog``, else the one :meth:`fetch_schema` last loaded; without either only the
        JSON shape is checked). Emits a ``config`` event when the effective value changes."""
        doc = self.doc
        entry = doc.config.get(key) if doc is not None else None
        if entry is not None and entry.state in ("enforced", "hidden"):
            raise PolarisError("managed_by_admin", f"{key} is enforced by an operator.")
        try:
            json.dumps(value, allow_nan=False)
        except (TypeError, ValueError):
            raise PolarisError("bad_request", f"{key}: the value is not representable as JSON.") from None
        schema = _schema_for(catalog or self._catalog, key)
        if schema is not None:
            problem = validate_value(value, schema)
            if problem is not None:
                raise PolarisError("bad_request", f"{key}: {problem}")
        self._change(key, lambda: self._local_overrides.__setitem__(key, value))

    def clear(self, key: str) -> None:
        """Forget the player's value for ``key``; the next layer (environment, remote default,
        fallback) applies again."""
        self._change(key, lambda: self._local_overrides.pop(key, None))

    def local_values(self) -> Dict[str, Any]:
        """The persisted settings the player chose (a copy)."""
        persisted = self._local_store.load()
        return dict(persisted.get("overrides") or {}) if isinstance(persisted, dict) else {}

    def setting(self, key: str, fallback: Any = None) -> "ConfigSetting":
        """A handle on one setting: ``value``, ``source``, ``set()``, ``clear()`` and
        ``subscribe(fn)`` for its changes."""
        return ConfigSetting(self, key, fallback)

    def on_change(self, key: str, listener: Callable[[Any], None]) -> Callable[[], None]:
        """Call ``listener(event)`` when ``key``'s effective value changes (``"*"``: any key).
        Returns the unsubscribe function."""
        if self._events is None:
            return lambda: None

        def filtered(event: Any) -> None:
            if key == "*" or event.data.get("key") == key:
                listener(event)

        return self._events.subscribe(filtered, ("config",))

    def snapshot(self) -> Dict[str, Any]:
        """Every known key's effective value (document keys and local ones), for change
        detection."""
        keys = set(self._local_overrides)
        doc = self.doc
        if doc is not None:
            keys.update(doc.config)
        return {k: self.get_config(k) for k in sorted(keys)}

    def _change(self, key: str, mutate: Callable[[], Any]) -> None:
        with self._local_lock:
            before = self.get_config(key)
            mutate()
            persisted = self.local_values()
            if key in self._local_overrides:
                persisted[key] = self._local_overrides[key]
            else:
                persisted.pop(key, None)
            self._local_store.save({"overrides": persisted})
            after = self.get_config(key)
        if self.changed is not None:
            self.changed()
            return
        if self._events is not None and before != after:
            self._events.emit(
                "config", key=key, value=after, previous=before, source=self.get_config_source(key)
            )

    def mint_token(self, recipe_id: str) -> MintedToken:
        """Mint a third-party token through the product's edge-mint recipe ``recipe_id``
        (``GET /<p>/config/mint/<recipe_id>/token``, authenticated with the device token).

        Minted tokens are cached IN MEMORY ONLY, per recipe, and reused until 30 seconds
        before ``expiresAt``: they are short-lived secrets and never reach the cache file or
        the keyring. A 401 gets the one re-acquire every authenticated call gets (§5), then
        one retry.

        Raises :class:`~polaris_key.core.errors.PolarisError`: ``service-unavailable`` (no
        Config service, before any request), ``bad_request`` (a recipe id the router could
        never match, before any request), ``unauthorized`` (no token, or still 401 after the
        re-acquire), or the Worker's code — ``not_found`` for an unknown or unapproved
        recipe, ``rate_limited``, ``misconfigured``.
        """
        return mint_token(self._ctx, self._tokens, self._minted, recipe_id)

    @property
    def enabled(self) -> bool:
        """Whether the product runs Config at all — the config-side twin of the licence
        gate's ``not-applicable``."""
        return self._ctx.enabled("config")

    def resolve_with_source(self, key: str, fallback: Any = None) -> Any:
        """``(value, source)`` in one pass, for callers that want both without resolving
        twice. ``UNSET`` is re-exported so a CLI can tell "no value anywhere" from a
        legitimately ``None`` value."""
        return resolve(self._context(), key, fallback)



class ConfigSetting:
    """One setting, reactive: read ``value`` / ``source``, write with ``set`` / ``clear``,
    watch with ``subscribe``."""

    def __init__(self, client: ConfigClient, key: str, fallback: Any = None) -> None:
        self._client = client
        self.key = key
        self.fallback = fallback

    @property
    def value(self) -> Any:
        return self._client.get_config(self.key, self.fallback)

    @property
    def source(self) -> str:
        return self._client.get_config_source(self.key)

    @property
    def enforced(self) -> bool:
        return self.source in ("enforced", "hidden")

    def set(self, value: Any) -> None:
        self._client.set(self.key, value)

    def clear(self) -> None:
        self._client.clear(self.key)

    def subscribe(self, listener: Callable[[Any], None]) -> Callable[[], None]:
        return self._client.on_change(self.key, listener)


def _schema_for(catalog: Optional[Mapping[str, Any]], key: str) -> Optional[Mapping[str, Any]]:
    if not isinstance(catalog, Mapping):
        return None
    for e in catalog.get("entries") or ():
        if isinstance(e, Mapping) and e.get("key") == key and isinstance(e.get("schema"), Mapping):
            return e["schema"]
    return None


_TYPES = {
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool)
    or (isinstance(v, float) and v.is_integer()),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
    "null": lambda v: v is None,
}


def validate_value(value: Any, schema: Mapping[str, Any], path: str = "value") -> Optional[str]:
    """Check ``value`` against a catalog entry's schema (the Draft-07 subset the catalog uses:
    ``type``, ``enum``, ``const``, ``minimum`` / ``maximum`` / ``exclusive*``, ``minLength`` /
    ``maxLength``, ``pattern``, ``items``, ``minItems`` / ``maxItems``, ``properties``,
    ``required``, ``additionalProperties: false``). Returns the first problem, or ``None``.
    Keywords outside the subset are ignored: the server validates the full catalog."""
    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_TYPES.get(x, lambda v: True)(value) for x in types):
            return f"{path} must be {' or '.join(map(str, types))}"
    if "const" in schema and value != schema["const"]:
        return f"{path} must be {schema['const']!r}"
    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        return f"{path} must be one of {schema['enum']!r}"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
            return f"{path} must be at least {schema['minimum']}"
        if isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
            return f"{path} must be at most {schema['maximum']}"
        if isinstance(schema.get("exclusiveMinimum"), (int, float)) and value <= schema["exclusiveMinimum"]:
            return f"{path} must be above {schema['exclusiveMinimum']}"
        if isinstance(schema.get("exclusiveMaximum"), (int, float)) and value >= schema["exclusiveMaximum"]:
            return f"{path} must be below {schema['exclusiveMaximum']}"
    if isinstance(value, str):
        if isinstance(schema.get("minLength"), int) and len(value) < schema["minLength"]:
            return f"{path} is shorter than {schema['minLength']}"
        if isinstance(schema.get("maxLength"), int) and len(value) > schema["maxLength"]:
            return f"{path} is longer than {schema['maxLength']}"
        if isinstance(schema.get("pattern"), str):
            try:
                if re.search(schema["pattern"], value) is None:
                    return f"{path} does not match {schema['pattern']}"
            except re.error:
                pass
    if isinstance(value, list):
        if isinstance(schema.get("minItems"), int) and len(value) < schema["minItems"]:
            return f"{path} has fewer than {schema['minItems']} items"
        if isinstance(schema.get("maxItems"), int) and len(value) > schema["maxItems"]:
            return f"{path} has more than {schema['maxItems']} items"
        if isinstance(schema.get("items"), Mapping):
            for i, item in enumerate(value):
                p = validate_value(item, schema["items"], f"{path}[{i}]")
                if p is not None:
                    return p
    if isinstance(value, dict):
        props = schema.get("properties") if isinstance(schema.get("properties"), Mapping) else {}
        for req in schema.get("required") or ():
            if req not in value:
                return f"{path}.{req} is required"
        for k, v in value.items():
            if k in props and isinstance(props[k], Mapping):
                p = validate_value(v, props[k], f"{path}.{k}")
                if p is not None:
                    return p
            elif schema.get("additionalProperties") is False:
                return f"{path}.{k} is not allowed"
    return None


def _is_catalog(value: Any) -> bool:
    """The catalog's outer shape. The entries are the product's own data; the client does
    not validate them, because nothing it decides depends on them."""
    return (
        isinstance(value, dict)
        and isinstance(value.get("schemaVersion"), int)
        and not isinstance(value.get("schemaVersion"), bool)
        and isinstance(value.get("entries"), list)
    )
