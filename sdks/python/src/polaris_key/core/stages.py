"""The boot stage machine — client boot behaviour, outside the wire contract.

Mirrors ``@polaris-key/client-core``'s ``stages.ts``. One pure reducer every renderer drives:
the host does the work of each stage and reports its result as an event; the machine decides
the next stage and what to emit. It does no I/O, reads no clock, uses no randomness and never
mutates its input, so the same inputs reach the same stages, emits and outcome in every
language. ``conformance/corpus/v2/stage-matrix.json`` pins it, and
``tests/test_stage_matrix.py`` replays every row and every probe of its ``accepts`` table.

The normal path is idle → shell → guard → sync → gate → decide → fetch → mount → ready, and
every stage is entered even when it has nothing to do. An event the current stage does not
accept, or a malformed one, is IGNORED: the input state comes back as the same object with
no emits. Every accepted event emits something, so an empty ``emits`` always means the event
was ignored.

The strings are the corpus's: events are dotted (``sync.done``), emits snake_case
(``stage_changed``), payload keys camelCase and payload values kebab-case. Events and emits
are plain dicts in that shape; ``BootState`` and ``BootOptions`` are frozen dataclasses with
camelCase fields, like :class:`polaris_key.license.gate.LicenseState`.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, Iterable, List, Literal, NamedTuple, Optional, Tuple, TypedDict, Union

from .models import LicenseStatus

__all__ = [
    "BOOT_STAGES",
    "BOOT_OUTCOMES",
    "BOOT_EVENT_TYPES",
    "BOOT_EMIT_TYPES",
    "BOOT_GUARD_ACTIONS",
    "MAX_FAILED_BOOTS",
    "BOOT_DECISIONS",
    "BOOT_OK_SECONDS",
    "BOOT_CONFIRMATIONS",
    "boot_confirmation",
    "BootStage",
    "BootOutcome",
    "BootGuardAction",
    "BootGuardResult",
    "BootSyncResult",
    "BootDecision",
    "BootFetchResult",
    "BootBlockedReason",
    "BootEvent",
    "BootEmit",
    "BootOptions",
    "BootState",
    "BootTransition",
    "initial_boot_state",
    "boot_transition",
    "boot_guard_action",
]

#: Every stage, in boot order, then the three stops.
BOOT_STAGES: Tuple[str, ...] = (
    "idle",
    "shell",
    "guard",
    "sync",
    "gate",
    "decide",
    "fetch",
    "mount",
    "ready",
    "background",
    "offline",
    "blocked",
    "error",
)
#: The outcome a renderer reports: ``running`` until the boot stops or the gate waits.
BOOT_OUTCOMES: Tuple[str, ...] = ("running", "waiting", "ready", "blocked", "offline", "error")
#: The events a host sends, dotted.
BOOT_EVENT_TYPES: Tuple[str, ...] = (
    "start",
    "shell.done",
    "guard.done",
    "sync.done",
    "sync.timeout",
    "gate.status",
    "decide.done",
    "fetch.done",
    "mount.done",
    "background.start",
    "background.done",
    "retry",
    "play-offline",
    "fail",
    # Stage matrix v3 (plans/P4-01.md §2.10): download consent and progress.
    "fetch.consent",
    "fetch.progress",
)
#: The emits the machine produces, snake_case: the signal names renderers expose.
BOOT_EMIT_TYPES: Tuple[str, ...] = (
    "stage_changed",
    "waiting",
    "update_available",
    "blocked",
    "offline",
    "error",
    "boot_rolled_back",
    "boot_ready",
    "consent_needed",
    "fetch_progress",
)
#: What :func:`boot_guard_action` decides at launch.
BOOT_GUARD_ACTIONS: Tuple[str, ...] = ("none", "apply-staged", "roll-back")
#: Unconfirmed launches of the active slot that trigger a rollback on the next launch.
MAX_FAILED_BOOTS = 2

#: What ``decide.done`` carries. ``required`` is P1-09's; no v4 update decision maps to it.
BOOT_DECISIONS: Tuple[str, ...] = ("none", "optional", "required")
#: How long the outcome must stay ``ready``, with the process alive, before the launch counts
#: as confirmed (plans/P3-01.md §2.10; ``stage-matrix.json#/bootOkSeconds``).
BOOT_OK_SECONDS = 10
#: When a launch is confirmed, by outcome.
BOOT_CONFIRMATIONS: Tuple[str, ...] = ("now", "after-ok-seconds", "never")

BootStage = Literal[
    "idle",
    "shell",
    "guard",
    "sync",
    "gate",
    "decide",
    "fetch",
    "mount",
    "ready",
    "background",
    "offline",
    "blocked",
    "error",
]
BootOutcome = Literal["running", "waiting", "ready", "blocked", "offline", "error"]
BootGuardAction = Literal["none", "apply-staged", "roll-back"]
BootGuardResult = Literal["ok", "applied", "rolled-back"]
BootSyncResult = Literal["ok", "offline", "error"]
BootDecision = Literal["none", "optional", "required"]
BootFetchResult = Literal["ok", "offline", "failed", "declined"]
BootBlockedReason = Literal["update-required", "not-available", "content-declined"]

_LICENSE_STATUSES: Tuple[str, ...] = (
    "ok",
    "grace",
    "expired",
    "revoked",
    "needs-activation",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
    "not-applicable",
)


# ── Events (the corpus's shape) ─────────────────────────────────────────────────────
class BootPlainEvent(TypedDict):
    """``start``, ``shell.done``, ``sync.timeout``, ``mount.done``, ``background.start``,
    ``background.done``, ``retry`` or ``play-offline``."""

    type: str


class BootGuardDoneEvent(TypedDict):
    type: Literal["guard.done"]
    result: BootGuardResult


class BootSyncDoneEvent(TypedDict):
    type: Literal["sync.done"]
    result: BootSyncResult


class BootGateStatusEvent(TypedDict):
    type: Literal["gate.status"]
    status: LicenseStatus


class BootDecideDoneEvent(TypedDict):
    type: Literal["decide.done"]
    decision: BootDecision


class BootFetchDoneEvent(TypedDict):
    type: Literal["fetch.done"]
    result: BootFetchResult
    #: The pack ids present after the fetch, compared by exact string.
    installed: List[str]


class BootFetchConsentEvent(TypedDict):
    """v3: the download needs the player's consent (the size disclosure and the cellular
    choice). ``bytes`` an integer >= 0."""

    type: Literal["fetch.consent"]
    bytes: int
    metered: bool


class BootFetchProgressEvent(TypedDict):
    """v3: download progress, integers with ``0 <= done <= total``."""

    type: Literal["fetch.progress"]
    done: int
    total: int


class BootFailEvent(TypedDict):
    """The host's own work for the current stage failed in a way its event cannot express."""

    type: Literal["fail"]
    code: str


BootEvent = Union[
    BootPlainEvent,
    BootGuardDoneEvent,
    BootSyncDoneEvent,
    BootGateStatusEvent,
    BootDecideDoneEvent,
    BootFetchDoneEvent,
    BootFetchConsentEvent,
    BootFetchProgressEvent,
    BootFailEvent,
]


# ── Emits (the corpus's shape) ──────────────────────────────────────────────────────
class BootStageChangedEmit(TypedDict):
    type: Literal["stage_changed"]
    stage: BootStage
    previous: BootStage


class BootWaitingEmit(TypedDict):
    type: Literal["waiting"]
    status: LicenseStatus


class BootPlainEmit(TypedDict):
    """``update_available``, ``boot_rolled_back`` or ``boot_ready``."""

    type: str


class BootBlockedEmit(TypedDict):
    type: Literal["blocked"]
    reason: BootBlockedReason


class BootOfflineEmit(TypedDict):
    """``canPlayOffline`` is true only when the required packs are present and an essential
    one could not download (v3)."""

    type: Literal["offline"]
    canPlayOffline: bool


class BootConsentNeededEmit(TypedDict):
    type: Literal["consent_needed"]
    bytes: int
    metered: bool


class BootFetchProgressEmit(TypedDict):
    type: Literal["fetch_progress"]
    done: int
    total: int


class BootErrorEmit(TypedDict):
    """``sync-failed``, ``fetch-failed``, or the code of the host's ``fail``."""

    type: Literal["error"]
    code: str


BootEmit = Union[
    BootStageChangedEmit,
    BootWaitingEmit,
    BootPlainEmit,
    BootBlockedEmit,
    BootOfflineEmit,
    BootConsentNeededEmit,
    BootFetchProgressEmit,
    BootErrorEmit,
]


# ── State ───────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class BootOptions:
    """The boot's options, defaults applied."""

    #: Continue on local state when the sync gets no answer or an unusable one.
    allowOffline: bool = True
    #: Let ``grace`` pass the gate.
    allowGrace: bool = True
    #: Pack ids that must be installed before ``mount``.
    requiredPacks: Tuple[str, ...] = ()
    #: v3: pack ids the boot wants before ``ready`` but can play without (``delivery:
    #: essential``, ``required: false``).
    essentialPacks: Tuple[str, ...] = ()


@dataclass(frozen=True)
class BootState:
    stage: str
    outcome: str
    options: BootOptions
    #: The latest sync result (``pending``, ``ok``, ``offline`` or ``error``); a timeout is
    #: ``offline``.
    sync: str
    #: Where ``retry`` goes: ``shell`` before ``shell.done``, ``guard`` before
    #: ``guard.done``, then ``sync``.
    resume: str
    #: v3: true only at ``offline`` reached with every required pack present and an
    #: essential one missing, where ``play-offline`` is accepted.
    canPlayOffline: bool = False


class BootTransition(NamedTuple):
    state: BootState
    emits: Tuple[BootEmit, ...]


def initial_boot_state(
    *,
    allow_offline: bool = True,
    allow_grace: bool = True,
    required_packs: Iterable[str] = (),
    essential_packs: Iterable[str] = (),
) -> BootState:
    """Stage ``idle``, outcome ``running``, sync ``pending``, resume ``shell``,
    ``canPlayOffline`` false."""
    return BootState(
        stage="idle",
        outcome="running",
        options=BootOptions(
            allowOffline=allow_offline,
            allowGrace=allow_grace,
            requiredPacks=tuple(required_packs),
            essentialPacks=tuple(essential_packs),
        ),
        sync="pending",
        resume="shell",
        canPlayOffline=False,
    )


def boot_guard_action(*, staged: bool, failed_boots: int) -> str:
    """The launch decision of the boot guard: roll back, apply a staged update, or neither."""
    if failed_boots >= MAX_FAILED_BOOTS:
        return "roll-back"
    if staged:
        return "apply-staged"
    return "none"


def _go(
    state: BootState,
    stage: str,
    outcome: str,
    extra: Optional[BootEmit] = None,
    **patch: Any,
) -> BootTransition:
    """Move to ``stage`` (``stage_changed`` first when it changes), then at most one emit.
    ``canPlayOffline`` resets unless the patch sets it."""
    emits: List[BootEmit] = []
    if stage != state.stage:
        emits.append({"type": "stage_changed", "stage": stage, "previous": state.stage})  # type: ignore[typeddict-item]
    if extra is not None:
        emits.append(extra)
    patch.setdefault("canPlayOffline", False)
    return BootTransition(replace(state, stage=stage, outcome=outcome, **patch), tuple(emits))


def _ignore(state: BootState) -> BootTransition:
    return BootTransition(state, ())


def _one_of(value: Any, allowed: Tuple[str, ...]) -> bool:
    return isinstance(value, str) and value in allowed


def _sync_stop(state: BootState, result: str, **patch: Any) -> BootTransition:
    """The stop a failed sync leads to: offline after no answer, error after an unusable one."""
    if result == "offline":
        return _go(state, "offline", "offline", {"type": "offline", "canPlayOffline": False}, **patch)
    return _go(state, "error", "error", {"type": "error", "code": "sync-failed"}, **patch)


def _on_sync(state: BootState, result: str) -> BootTransition:
    if result == "ok" or state.options.allowOffline:
        return _go(state, "gate", "running", sync=result)
    return _sync_stop(state, result, sync=result)


def _gate_holds(state: BootState, status: str) -> BootTransition:
    """``expired``, or ``grace`` the options refuse: the player can renew after an answered
    sync, otherwise the boot stops for the reason the sync failed."""
    if state.sync in ("offline", "error"):
        return _sync_stop(state, state.sync)
    return _go(state, "gate", "waiting", {"type": "waiting", "status": status})


def _on_gate_status(state: BootState, status: str) -> BootTransition:
    if status in ("ok", "not-applicable") or (status == "grace" and state.options.allowGrace):
        return _go(state, "decide", "running")
    if status in ("grace", "expired"):
        return _gate_holds(state, status)
    if status in ("needs-activation", "revoked"):
        return _go(state, "gate", "waiting", {"type": "waiting", "status": status})
    if status == "version-too-old":
        return _go(state, "blocked", "blocked", {"type": "blocked", "reason": "update-required"})
    # version-too-new, channel-not-entitled
    return _go(state, "blocked", "blocked", {"type": "blocked", "reason": "not-available"})


def _missing(ids: Tuple[str, ...], installed: Any) -> bool:
    return any(pack not in installed for pack in ids)


_MAX_SAFE_INTEGER = 2**53 - 1


def _count(value: Any) -> bool:
    """A non-negative safe integer (v3's consent and progress payloads); never a bool."""
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= _MAX_SAFE_INTEGER
    )


_FAILING_STAGES = ("shell", "guard", "sync", "gate", "decide", "fetch", "mount")
_RETRY_STAGES = ("offline", "blocked", "error")


def boot_transition(state: BootState, event: BootEvent) -> BootTransition:
    """The reducer: the next state and the emits the event produced, ``stage_changed`` first.

    An event the current stage does not accept, or a malformed one (an unknown ``type``, a
    missing payload field, a payload value outside the vocabulary or of the wrong type),
    returns the input state itself and no emits. Extra keys do not make an event malformed.
    """
    if not isinstance(event, Mapping):
        return _ignore(state)
    e: Mapping[str, Any] = event
    kind = e.get("type")
    stage = state.stage
    waiting = stage == "gate" and state.outcome == "waiting"
    fetching = stage == "fetch"
    consent_waiting = fetching and state.outcome == "waiting"

    if kind == "start":
        return _go(state, "shell", "running") if stage == "idle" else _ignore(state)

    if kind == "shell.done":
        if stage != "shell":
            return _ignore(state)
        return _go(state, "guard", "running", resume="guard")

    if kind == "guard.done":
        result = e.get("result")
        if stage != "guard" or not _one_of(result, ("ok", "applied", "rolled-back")):
            return _ignore(state)
        extra: Optional[BootEmit] = {"type": "boot_rolled_back"} if result == "rolled-back" else None
        return _go(state, "sync", "running", extra, resume="sync")

    if kind == "sync.done":
        result = e.get("result")
        if stage != "sync" or not _one_of(result, ("ok", "offline", "error")):
            return _ignore(state)
        return _on_sync(state, result)

    if kind == "sync.timeout":
        return _on_sync(state, "offline") if stage == "sync" else _ignore(state)

    if kind == "gate.status":
        status = e.get("status")
        if stage != "gate" or not _one_of(status, _LICENSE_STATUSES):
            return _ignore(state)
        return _on_gate_status(state, status)

    if kind == "decide.done":
        decision = e.get("decision")
        if stage != "decide" or not _one_of(decision, ("none", "optional", "required")):
            return _ignore(state)
        if decision == "none":
            return _go(state, "fetch", "running")
        if decision == "optional":
            return _go(state, "fetch", "running", {"type": "update_available"})
        return _go(state, "blocked", "blocked", {"type": "blocked", "reason": "update-required"})

    if kind == "fetch.done":
        result = e.get("result")
        installed = e.get("installed")
        if (
            not fetching
            or not _one_of(result, ("ok", "offline", "failed", "declined"))
            or not isinstance(installed, (list, tuple))
            or not all(isinstance(i, str) for i in installed)
        ):
            return _ignore(state)
        if _missing(state.options.requiredPacks, installed):
            if result == "offline":
                return _go(state, "offline", "offline", {"type": "offline", "canPlayOffline": False})
            if result == "declined":
                return _go(state, "blocked", "blocked", {"type": "blocked", "reason": "content-declined"})
            return _go(state, "error", "error", {"type": "error", "code": "fetch-failed"})
        if result == "offline" and _missing(state.options.essentialPacks, installed):
            return _go(
                state,
                "offline",
                "offline",
                {"type": "offline", "canPlayOffline": True},
                canPlayOffline=True,
            )
        return _go(state, "mount", "running")

    if kind == "fetch.consent":
        size = e.get("bytes")
        metered = e.get("metered")
        if not fetching or consent_waiting or not _count(size) or not isinstance(metered, bool):
            return _ignore(state)
        return _go(state, "fetch", "waiting", {"type": "consent_needed", "bytes": size, "metered": metered})

    if kind == "fetch.progress":
        done = e.get("done")
        total = e.get("total")
        if not fetching or not _count(done) or not _count(total) or done > total:
            return _ignore(state)
        return _go(state, "fetch", "running", {"type": "fetch_progress", "done": done, "total": total})

    if kind == "play-offline":
        if stage == "offline" and state.canPlayOffline:
            return _go(state, "mount", "running")
        return _ignore(state)

    if kind == "mount.done":
        if stage != "mount":
            return _ignore(state)
        return _go(state, "ready", "ready", {"type": "boot_ready"})

    if kind == "background.start":
        return _go(state, "background", "ready") if stage == "ready" else _ignore(state)

    if kind == "background.done":
        return _go(state, "ready", "ready") if stage == "background" else _ignore(state)

    if kind == "retry":
        if not waiting and stage not in _RETRY_STAGES:
            return _ignore(state)
        return _go(state, state.resume, "running", sync="pending")

    if kind == "fail":
        code = e.get("code")
        if stage not in _FAILING_STAGES or waiting or consent_waiting or not isinstance(code, str):
            return _ignore(state)
        return _go(state, "error", "error", {"type": "error", "code": code})

    # An unknown type is malformed.
    return _ignore(state)


def boot_confirmation(outcome: str) -> str:
    """Stage matrix v2 (plans/P3-01.md §2.10): when the launch that reached ``outcome`` counts
    as confirmed. ``waiting``, ``blocked`` and ``offline`` confirm at once; ``ready`` after
    ``BOOT_OK_SECONDS`` with the process alive (or the game's ``confirm_boot()``, host-side);
    ``running`` and ``error`` never confirm."""
    if outcome in ("waiting", "blocked", "offline"):
        return "now"
    if outcome == "ready":
        return "after-ok-seconds"
    return "never"
