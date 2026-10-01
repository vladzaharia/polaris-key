"""The Config sub-client — layered settings resolution over the signed config document.

The resolution rules themselves are :mod:`polaris_key.config.resolve`'s, shared with the
Node/React/Swift ports and pinned by the same corpus. What lives here is the OVERRIDE
LAYERS, and they are config-side options rather than Core ones for a reason:
``env_prefix``, ``env`` and ``local_overrides`` are inputs to this resolution and to
nothing else, so a product that has disabled Config never has to think about them.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Mapping, Optional

from ..core.cache import CacheManager
from ..core.context import CoreContext
from ..core.models import ConfigDoc
from .resolve import (
    DEFAULT_ENV_PREFIX,
    UNSET,
    ResolveContext,
    list_user_entries,
    resolve,
    resolve_source,
)

__all__ = ["ConfigClient", "DEFAULT_ENV_PREFIX", "UNSET"]


class ConfigClient:
    def __init__(
        self,
        ctx: CoreContext,
        cache: CacheManager,
        *,
        local_overrides: Optional[Mapping[str, Any]] = None,
        env_prefix: str = DEFAULT_ENV_PREFIX,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        self._ctx = ctx
        self._cache = cache
        self._local_overrides: Dict[str, Any] = dict(local_overrides or {})
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
        return body if _is_catalog(body) else None

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



def _is_catalog(value: Any) -> bool:
    """The catalog's outer shape. The entries are the product's own data; the client does
    not validate them, because nothing it decides depends on them."""
    return (
        isinstance(value, dict)
        and isinstance(value.get("schemaVersion"), int)
        and not isinstance(value.get("schemaVersion"), bool)
        and isinstance(value.get("entries"), list)
    )
