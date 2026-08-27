"""``polaris_key.config`` — the Config service's client surface.

The signed ``pkey-config+jws`` document and the layered resolution over it. Mirrors
``@polaris-key/node/config``. No licence import anywhere in this package: a product with License
disabled still gets config documents on a plain device token (D-08).
"""

from __future__ import annotations

from .client import ConfigClient
from .fetch import CONFIG_DOCUMENT_PATH, fetch_config_document
from .resolve import (
    DEFAULT_ENV_PREFIX,
    UNSET,
    ResolveContext,
    env_var_name,
    list_user_entries,
    resolve,
    resolve_source,
    resolve_value,
)

__all__ = [
    "ConfigClient",
    "CONFIG_DOCUMENT_PATH",
    "fetch_config_document",
    "DEFAULT_ENV_PREFIX",
    "UNSET",
    "ResolveContext",
    "env_var_name",
    "resolve",
    "resolve_value",
    "resolve_source",
    "list_user_entries",
]
