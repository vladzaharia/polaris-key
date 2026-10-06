"""The update-health journal (P6-03; SDK parity pass §3.13).

Update outcome events — ``update_offered``, ``update_downloaded``, ``update_applied``,
``update_confirmed``, ``update_reverted``, ``pack_failed``, ``boot_rolled_back`` (the
``updateEvent`` enum of ``conformance/parity/enums.json``) — ride the next
``POST /<p>/devices/report`` in its ``updates`` key. They are what staged-rollout auto-halt
counts, so a fleet that never reports them is invisible to it.

The journal is persisted (``update-events.json`` in the state directory) so an event recorded
just before a crash or an update restart is still delivered. At most
:data:`MAX_UPDATE_EVENTS` go per report, oldest first; a report the Worker accepted marks the
ones it carried as sent and they are dropped. Past :data:`MAX_STORED_EVENTS` the oldest are
dropped. The Worker deduplicates on (device, ``eventId``), so a resent event counts once.

Each entry is exactly the Worker's ``UpdateOutcomeEvent`` (``core/updateHealth.ts``
``boundedEntry``): ``{eventId, event, deliverable, release, fromRelease?, outlet, channel,
packSetId?, at, code?}``. Values that would fail the Worker's patterns are normalised here
(an outlet that is not an outlet id becomes ``unknown``), and an entry that still would not
pass is not recorded, since the Worker would drop it anyway. No hardware value and no user
identifier is ever carried (AGENTS rule 7).
"""

from __future__ import annotations

import os
import re
import secrets
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

from ..constants_generated import UpdateEvent
from .local_state import JsonStateFile

__all__ = ["MAX_UPDATE_EVENTS", "MAX_STORED_EVENTS", "UPDATE_EVENTS", "UpdateJournal"]

#: At most this many events per report (``MAX_UPDATE_EVENTS`` in ``core/updateHealth.ts``).
MAX_UPDATE_EVENTS = 16
#: At most this many are kept waiting; the oldest go first (Godot's ``MAX_EVENTS``).
MAX_STORED_EVENTS = 64

UPDATE_EVENTS = (
    UpdateEvent.UPDATE_OFFERED,
    UpdateEvent.UPDATE_DOWNLOADED,
    UpdateEvent.UPDATE_APPLIED,
    UpdateEvent.UPDATE_CONFIRMED,
    UpdateEvent.UPDATE_REVERTED,
    UpdateEvent.PACK_FAILED,
    UpdateEvent.BOOT_ROLLED_BACK,
)

# The Worker's patterns (core/updateHealth.ts); an entry that fails one is never recorded.
_EVENT_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_DELIVERABLE = re.compile(r"^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$")
_RELEASE = re.compile(r"^[A-Za-z0-9._+@:/-]{1,128}$")
_CHANNEL = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_PACK_SET = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_CODE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
#: OUTLET_ID_PATTERN (@polaris-key/protocol/distribution).
_OUTLET = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


class UpdateJournal:
    """The persisted queue of update events.

    ``context`` returns the defaults each event takes when the caller names none:
    ``{"outlet": …, "channel": …, "release": …}`` (the running build's outlet id, channel and
    version).
    """

    def __init__(
        self,
        directory: Optional[str],
        context: Callable[[], Dict[str, Optional[str]]],
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._file = JsonStateFile(
            os.path.join(directory, "update-events.json") if directory else None,
            lambda: {"events": [], "offered": None},
        )
        self._context = context
        self._clock = clock

    # ── Recording ────────────────────────────────────────────────────────────────────
    def record(
        self,
        event: str,
        *,
        release: Optional[str] = None,
        from_release: Optional[str] = None,
        deliverable: str = "app",
        code: Optional[str] = None,
        channel: Optional[str] = None,
        outlet: Optional[str] = None,
        pack_set_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Queue one event; returns the entry, or ``None`` when it would not pass the Worker's
        validation (an unknown event name, a release id with spaces, …)."""
        if event not in UPDATE_EVENTS:
            return None
        ctx = self._safe_context()
        entry: Dict[str, Any] = {
            "eventId": f"{secrets.token_hex(8)}-{event}"[:64],
            "event": event,
            "deliverable": deliverable,
            "release": release if release is not None else (ctx.get("release") or ""),
            "outlet": _outlet_or_unknown(outlet if outlet is not None else ctx.get("outlet")),
            "channel": channel or ctx.get("channel") or "stable",
            "at": max(1, int(self._clock())),
        }
        if from_release and from_release != entry["release"]:
            entry["fromRelease"] = from_release
        if pack_set_id:
            entry["packSetId"] = pack_set_id
        if code:
            entry["code"] = code[:64]
        if not _valid(entry):
            return None

        def add(state: Any) -> Any:
            state = _shape(state)
            state["events"].append(entry)
            del state["events"][:-MAX_STORED_EVENTS]
            return state

        self._file.update(add)
        return dict(entry)

    def offered(self, release: str, *, from_release: Optional[str] = None,
                channel: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """``update_offered``, once per offered release: a decision that offers the same
        release again (every launch until the player updates) records nothing."""
        state = _shape(self._file.load())
        if state.get("offered") == release:
            return None
        entry = self.record(
            UpdateEvent.UPDATE_OFFERED, release=release, from_release=from_release, channel=channel
        )
        if entry is not None:
            self._file.update(lambda s: {**_shape(s), "offered": release})
        return entry

    # ── Reporting ────────────────────────────────────────────────────────────────────
    def events(self) -> List[Dict[str, Any]]:
        """Every queued event, oldest first (a copy)."""
        return [dict(e) for e in _shape(self._file.load())["events"]]

    def pending(self) -> List[Dict[str, Any]]:
        """The events the next report carries: at most :data:`MAX_UPDATE_EVENTS`, oldest
        first."""
        return self.events()[:MAX_UPDATE_EVENTS]

    def mark_sent(self, event_ids: Sequence[str]) -> None:
        """Drop the events a report the Worker accepted carried."""
        ids = set(event_ids)
        if not ids:
            return

        def drop(state: Any) -> Any:
            state = _shape(state)
            state["events"] = [e for e in state["events"] if e.get("eventId") not in ids]
            return state

        self._file.update(drop)

    def _safe_context(self) -> Dict[str, Optional[str]]:
        try:
            return dict(self._context() or {})
        except Exception:
            return {}


def _outlet_or_unknown(v: Any) -> str:
    return v if isinstance(v, str) and _OUTLET.match(v) else "unknown"


def _shape(state: Any) -> Dict[str, Any]:
    if not isinstance(state, dict):
        state = {}
    events = state.get("events")
    state["events"] = [e for e in events if isinstance(e, dict) and _valid(e)] if isinstance(events, list) else []
    state.setdefault("offered", None)
    return state


def _valid(e: Dict[str, Any]) -> bool:
    def ok(v: Any, rx: "re.Pattern[str]") -> bool:
        return isinstance(v, str) and rx.match(v) is not None

    at = e.get("at")
    return (
        ok(e.get("eventId"), _EVENT_ID)
        and e.get("event") in UPDATE_EVENTS
        and ok(e.get("deliverable"), _DELIVERABLE)
        and ok(e.get("release"), _RELEASE)
        and ok(e.get("outlet"), _OUTLET)
        and ok(e.get("channel"), _CHANNEL)
        and isinstance(at, int)
        and not isinstance(at, bool)
        and at > 0
        and (e.get("fromRelease") is None or ok(e.get("fromRelease"), _RELEASE))
        and (e.get("packSetId") is None or ok(e.get("packSetId"), _PACK_SET))
        and (e.get("code") is None or ok(e.get("code"), _CODE))
    )
