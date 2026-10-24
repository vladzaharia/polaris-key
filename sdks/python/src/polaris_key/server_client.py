"""``server_client()``: managed config on a server (framework drop-ins §5.7, SP-63).

A server is a device with its own licence (owner decision 8), for example a ``server`` tier with
a high device limit, so it never takes a customer's seat. This is the NORMAL client with five
settings made for a container, not a second client:

* a memory store: nothing is written to the container's disk but the device id file, if the
  host names one;
* a device id that stays stable across restarts, from ``device_id``, ``PKEY_DEVICE_ID`` or a
  file on a volume (``device_id_file``, ``PKEY_DEVICE_ID_FILE``), minted there on first start;
* the licence key from ``license_key`` or ``PKEY_LICENSE_KEY``, activated at start (the memory
  store holds no token across a restart, so each start re-activates the same device id, which
  the server coalesces onto one seat);
* no device reports (``device_reports=False``): a server has nothing a customer's device list
  should show;
* a background refresh (``refresh_interval_seconds``, default 3600), so
  ``client.config.get()`` follows the console.

Per-user config is not offered: the device's config document carries ``secrets`` and is never
forwarded (§13 Q8).
"""

from __future__ import annotations

import os
import re
import uuid
from typing import Any, Mapping, Optional

from .client import PolarisKeyClient
from .constants_generated import ErrorCode
from .core.errors import PolarisError
from .devices.deviceid import device_id_from_raw
from .devices.store import InMemoryStore

__all__ = ["server_client", "resolve_server_device_id"]

#: The server-side device id shape: 32 base64url characters.
_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{32}$")


def _bad(message: str) -> PolarisError:
    return PolarisError(ErrorCode.INVALID_OPTIONS, message)


def _checked(value: str, source: str) -> str:
    v = value.strip()
    if not _DEVICE_ID_RE.match(v):
        raise _bad(f"{source} is not a device id (32 characters of A-Z a-z 0-9 _ -).")
    return v


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def resolve_server_device_id(
    product_slug: str,
    *,
    device_id: Optional[str] = None,
    device_id_file: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
) -> str:
    """The device id: the argument, ``PKEY_DEVICE_ID``, or the volume file (created on first
    start with mode 0600)."""
    e = os.environ if env is None else env
    if device_id:
        return _checked(device_id, "device_id")
    if e.get("PKEY_DEVICE_ID"):
        return _checked(e["PKEY_DEVICE_ID"], "PKEY_DEVICE_ID")
    path = device_id_file or e.get("PKEY_DEVICE_ID_FILE")
    if not path:
        raise _bad(
            "server_client() needs a stable device id: set PKEY_DEVICE_ID, or "
            "PKEY_DEVICE_ID_FILE to a file on a volume."
        )
    try:
        return _checked(_read(path), path)
    except FileNotFoundError:
        pass
    new_id = device_id_from_raw(product_slug, str(uuid.uuid4()))
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    try:
        # "x": a second container racing on the same volume loses and reads the winner's id.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _checked(_read(path), path)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(new_id + "\n")
    return new_id


def server_client(
    *,
    product_slug: str,
    version: str,
    pinned_keys: Mapping[str, str],
    device_id: Optional[str] = None,
    device_id_file: Optional[str] = None,
    license_key: Optional[str] = None,
    refresh_interval_seconds: float = 3600,
    env: Optional[Mapping[str, str]] = None,
    **opts: Any,
) -> PolarisKeyClient:
    """The normal client for a server: memory store, stable device id, ``PKEY_LICENSE_KEY``, no
    device reports and a background refresh. Returns once the key is activated and the first
    sync is done; read config with ``client.config.get()``. ``close()`` (or ``with``)
    stops the refresh.

    Raises ``PolarisError`` ``invalid-options`` for a missing or malformed id or key, and one
    carrying the server's code when the key is refused (``device_limit``, ``unauthorized``, …).
    """
    for banned in ("store", "device_reports"):
        if banned in opts:
            raise _bad(f"server_client() sets {banned} itself.")
    e = os.environ if env is None else env
    key = license_key or e.get("PKEY_LICENSE_KEY")
    if not key:
        raise _bad("server_client() needs PKEY_LICENSE_KEY (or license_key).")
    dev = resolve_server_device_id(
        product_slug, device_id=device_id, device_id_file=device_id_file, env=env
    )
    opts.setdefault("fingerprint", False)  # a container's hardware is not a stable anchor
    client = PolarisKeyClient.create(
        product_slug=product_slug,
        version=version,
        pinned_keys=dict(pinned_keys),
        store=InMemoryStore(product_slug, dev),
        device_reports=False,
        refresh_interval_seconds=refresh_interval_seconds,
        **opts,
    )
    try:
        r = client.license.activate_with_key(key)
        if r.kind != "ok":
            detail = getattr(r, "message", "") or r.kind
            raise PolarisError(
                getattr(r, "code", "") or r.kind,
                f"server_client() could not activate its licence key: {detail}",
                status=getattr(r, "status", None),
            )
    except BaseException:
        client.close()
        raise
    return client
