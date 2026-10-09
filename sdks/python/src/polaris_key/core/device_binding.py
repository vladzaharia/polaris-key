"""Device-id binding — wire contract v4 §6.

A copied state directory must not carry a device's identity to another machine. On a desktop
file store the device id is therefore RE-DERIVED from the platform anchor at every start
(``device_id_from_raw(product, anchor)``) rather than trusted from the ``device`` file:

* a stored id is used only when no anchor is readable;
* a stored id that disagrees with the derived one is discarded together with the token and the
  grant slices of the cache — ``deactivate()`` without the network call. The wire v4 update
  slices (feeds, release records) are kept: they are signed public documents and carry each
  channel's ``seq`` floor.

Stores that cannot be copied the same way (an in-memory store, a host's own store) opt out by
not offering ``set_device_id``.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from ..devices.deviceid import device_id_from_raw, raw_os_device_id
from .store import CacheRecord, Store

__all__ = ["bind_device_id"]


def bind_device_id(
    product_slug: str,
    store: Store,
    *,
    read_anchor: Optional[Callable[[], Optional[str]]] = None,
) -> str:
    """The device id this process runs as, after binding ``store`` to the platform anchor."""
    stored = store.get_device_id()
    set_device_id: Optional[Any] = getattr(store, "set_device_id", None)
    if not callable(set_device_id):
        return stored
    anchor = (read_anchor or raw_os_device_id)()
    if not anchor:
        return stored
    derived = device_id_from_raw(product_slug, anchor)
    if stored == derived:
        return stored
    # The stored id is not this machine's: a copied or restored state directory. Drop every
    # credential and grant it carried; re-activation seats this machine once.
    store.clear_token()
    rec = store.read_cache()
    # The non-grant slices stay: the signed feeds and release records (each channel's `seq`
    # floor) and a pinned key's revocation evidence. The grant keys (`trustJws`, `docs`,
    # `etags`, `bundle`, `lastSyncUnauthorized`, `blocked`) are dropped with the token.
    if rec is not None and (rec.feeds or rec.releaseRecords or rec.pinRevocations):
        store.write_cache(
            CacheRecord(
                feeds=dict(rec.feeds),
                releaseRecords=dict(rec.releaseRecords),
                pinRevocations=dict(rec.pinRevocations),
            )
        )
    else:
        store.clear_cache()
    set_device_id(derived)
    return derived
