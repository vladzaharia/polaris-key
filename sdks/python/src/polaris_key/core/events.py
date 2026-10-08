"""``client.events`` — one multi-subscriber stream of what changed (SDK parity pass §3.11).

Kinds (:data:`EVENT_KINDS`):

* ``license`` — the gate status changed (``status``, ``previous``); also after a sign-out or a
  deactivation;
* ``entitlement`` — one entitlement's value changed (``name``, ``value``, ``previous``); a
  revoked or expired gate reads every entitlement as ``None`` (S-19 G11);
* ``config`` — one setting's effective value changed (``key``, ``value``, ``previous``,
  ``source``), from a sync or from ``config.set`` / ``config.clear``;
* ``updateAvailable`` — a decision offers a newer build (``version``, ``action``,
  ``mandatory``);
* ``packs`` — pack install progress (``pack``, ``phase``, ``done``, ``total``);
* ``store`` — the token store is degraded (``reason``, ``detail``).

Listeners run synchronously on the thread that caused the change (a sync, a ``config.set``) and
must not block. An exception in one cannot break the others or the SDK: it is logged, with its
traceback, on the ``polaris_key`` logger (:func:`listener_failed`) and the next listener runs.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

__all__ = ["Event", "EventBus", "EVENT_KINDS", "listener_failed"]

#: The SDK's logger. No handler is attached here: the host's logging configuration decides,
#: and without one Python's last-resort handler still prints a failing listener to stderr.
log = logging.getLogger("polaris_key")


def listener_failed(what: str) -> None:
    """Log the exception being handled as a failure of the host's ``what`` callback (an event
    listener, ``on_change``, ``on_stage``, ``on_progress``), with its traceback. Call it from an
    ``except`` block. A host bug is never swallowed silently, and never breaks the SDK."""
    log.exception("polaris_key: the %s callback raised; continuing", what)

EVENT_KINDS = ("license", "entitlement", "config", "updateAvailable", "packs", "store")


@dataclass(frozen=True)
class Event:
    kind: str
    data: Dict[str, Any] = field(default_factory=dict)

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)


Listener = Callable[[Event], None]


class EventBus:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._listeners: List[Tuple[Optional[frozenset], Listener]] = []

    def subscribe(self, listener: Listener, kinds: Optional[Iterable[str]] = None) -> Callable[[], None]:
        """Call ``listener(event)`` for every event (or only ``kinds``). Returns the
        unsubscribe function."""
        entry = (frozenset(kinds) if kinds is not None else None, listener)
        with self._lock:
            self._listeners.append(entry)

        def unsubscribe() -> None:
            with self._lock:
                try:
                    self._listeners.remove(entry)
                except ValueError:
                    pass

        return unsubscribe

    def on(self, kind: str, listener: Listener) -> Callable[[], None]:
        return self.subscribe(listener, (kind,))

    def emit(self, kind: str, **data: Any) -> Event:
        event = Event(kind, data)
        with self._lock:
            listeners = list(self._listeners)
        for kinds, fn in listeners:
            if kinds is not None and kind not in kinds:
                continue
            try:
                fn(event)
            except Exception:
                listener_failed(f"{kind!r} event listener")
        return event
