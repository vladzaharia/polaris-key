"""One-call boot: ``client.boot()`` (SDK parity pass §3.4) and ``client.ensure_activated()``.

``boot()`` drives the shared boot stage machine (:mod:`polaris_key.core.stages`, pinned by
``stage-matrix.json``) end to end, doing each stage's work with the client and sending the one
event the stage reads, exactly as Godot's ``PKeyBootHost`` does:

1. **shell** — discovery when the host pinned no services and none is loaded (best-effort);
2. **guard** — ``update.mark_boot_attempt()`` (the app build's boot guard): ``guard.done``;
3. **sync** — with no token on a product without License whose registration policy is
   ``open``, ``devices.register()`` first (and, with ``enroll=True``, a keyless enrolment on a
   licensed product); then ``sync()``: ``sync.done`` ``ok``, or ``offline`` when a document got
   no usable answer;
4. **gate** — ``gate.status`` from ``status()``. ``needs-activation`` (and ``revoked``) stop the
   boot at ``waiting``: an activation prompt is never invented, the UI renders the outcome;
5. **decide** — ``update.decide()`` when the product runs Update and update options are set:
   ``decide.done`` through ``boot_decision`` (a ``packs`` answer is ``none``; FETCH applies it);
6. **fetch** — ``update.packs.boot_fetch`` when the build has a content stamp (consent and
   progress events included), else ``fetch.done ok`` with nothing installed;
7. **mount** — ``mount.done`` (a Python host has nothing to mount) → ``ready``.

The launch is confirmed as ``stage-matrix.json``'s ``bootConfirmation`` says: at once for
``waiting``, ``blocked`` and ``offline``; ``BOOT_OK_SECONDS`` after ``ready`` (a daemon timer,
cancelled by ``close()``), unless ``auto_confirm=False`` — then the host calls
``client.update.confirm_boot()`` itself.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple

from .core.decide import boot_decision
from .core.errors import PolarisError
from .core.events import listener_failed
from .core.stages import (
    BOOT_OK_SECONDS,
    BootEmit,
    BootState,
    boot_confirmation,
    boot_transition,
    initial_boot_state,
)
from .core.sync import SyncResult

if TYPE_CHECKING:  # pragma: no cover
    from .client import PolarisKeyClient
    from .core.models import UpdateCheck

__all__ = ["BootOutcome", "ActivationOutcome", "run_boot", "ensure_activated", "registration_open"]


@dataclass(frozen=True)
class ActivationOutcome:
    """What :func:`ensure_activated` did: ``kind`` is ``activated`` (the gate is usable),
    ``registered`` / ``enrolled`` (it minted a credential keylessly and synced) or
    ``needs-activation`` (the player has to act: key, sign-in or offline bundle). ``status`` is
    the gate status after it."""

    kind: str
    status: str
    sync: Optional[SyncResult] = None
    detail: Any = None


@dataclass(frozen=True)
class BootOutcome:
    """Where the boot stopped. ``outcome`` is the machine's (``ready``, ``waiting``,
    ``blocked``, ``offline`` or ``error``); ``stage`` its stage; ``emits`` every emit in order
    (``update_available``, ``waiting {status}``, ``blocked {reason}``, ``error {code}``, …);
    ``status`` the gate status, ``check`` the update decision when one ran, ``guard`` the boot
    guard's outcome, ``background`` the pack targets left for after the boot."""

    outcome: str
    stage: str
    state: BootState
    emits: Tuple[BootEmit, ...]
    status: Optional[str] = None
    check: Optional["UpdateCheck"] = None
    guard: Any = None
    sync: Optional[SyncResult] = None
    background: Tuple[Any, ...] = ()
    error: Optional[str] = None

    @property
    def ready(self) -> bool:
        return self.outcome == "ready"

    @property
    def needs_activation(self) -> bool:
        return self.outcome == "waiting" and self.status in ("needs-activation", "revoked")

    @property
    def update_available(self) -> bool:
        return any(e.get("type") == "update_available" for e in self.emits)


def registration_open(client: "PolarisKeyClient") -> bool:
    """Whether a device with no token may get one without the player: a product without License
    whose registration policy is ``open`` (discovery's ``core.registration`` when loaded, else
    the WIRE-CONTRACT-V3 §6 default: open unless Identity runs)."""
    core = client.core
    if core.enabled("license"):
        return False
    doc = client._discovery_doc
    reg = (doc or {}).get("core", {}).get("registration") if isinstance(doc, dict) else None
    if isinstance(reg, str):
        return reg == "open"
    return not core.enabled("identity")


def _sync_result(r: SyncResult) -> str:
    """``sync.done``'s value: ``ok`` when every counted document was answered, ``offline`` when
    one got no usable answer (the Python sync does not tell a dropped connection from an
    unusable body, and the machine continues on local state either way)."""
    if any(o.kind == "error" for o in r.documents.values()):
        return "offline"
    return "ok"


def ensure_activated(
    client: "PolarisKeyClient", *, enroll: bool = False, sync: bool = True
) -> ActivationOutcome:
    """Steps 1–3 of the boot without the machine: register or enrol when that needs no player,
    then sync, and report whether the player must still act."""
    from .devices.client import RegisterOk
    from .license.endpoints import ActivationOk
    from .license.gate import is_usable

    kind = "activated"
    detail: Any = None
    synced: Optional[SyncResult] = None
    if client._tokens.current is None:
        if registration_open(client):
            r = client.devices.register()
            detail = r
            if isinstance(r, RegisterOk):
                kind = "registered"
        elif enroll and client.core.enabled("license") and client.license.activation() is None:
            a = client.license.enroll()  # syncs on success
            detail = a
            if isinstance(a, ActivationOk):
                kind = "enrolled"
                sync = False
    if sync:
        try:
            synced = client.sync()
        except PolarisError:
            synced = None
    status = client.status().status
    if not is_usable(status):
        kind = "needs-activation" if status in ("needs-activation", "revoked") else status
    return ActivationOutcome(kind=kind, status=status, sync=synced, detail=detail)


def run_boot(
    client: "PolarisKeyClient",
    *,
    on_stage: Optional[Callable[[BootState, Tuple[BootEmit, ...]], None]] = None,
    consent: str = "metered",
    metered: bool = False,
    answer: Optional[Callable[[int, bool], bool]] = None,
    allow_offline: bool = True,
    allow_grace: bool = True,
    enroll: bool = False,
    discover: Optional[bool] = None,
    auto_confirm: bool = True,
    decide: bool = True,
) -> BootOutcome:
    """Run the boot (see the module doc). ``on_stage(state, emits)`` runs after every accepted
    event; ``consent`` / ``metered`` / ``answer`` are the pack download consent policy
    (``packs.boot_fetch``)."""
    packs = client.update.packs
    opts: Dict[str, List[str]] = {"requiredPacks": [], "essentialPacks": []}
    if packs.configured:
        try:
            opts = packs.boot_options()
        except Exception:
            pass
    state = initial_boot_state(
        allow_offline=allow_offline,
        allow_grace=allow_grace,
        required_packs=opts["requiredPacks"],
        essential_packs=opts["essentialPacks"],
    )
    emits: List[BootEmit] = []
    info: Dict[str, Any] = {}

    def send(event: Dict[str, Any]) -> None:
        nonlocal state
        t = boot_transition(state, event)  # type: ignore[arg-type]
        if not t.emits:
            return
        state = t.state
        emits.extend(t.emits)
        if on_stage is not None:
            try:
                on_stage(state, t.emits)
            except Exception:
                listener_failed("on_stage")

    send({"type": "start"})
    # shell
    if discover is None:
        # As Node's runBoot: pinned services skip discovery only once a token is held; a fresh
        # install still discovers (and so learns the registration policy) before it syncs.
        discover = (
            client.core._expected_services is None or client._tokens.current is None
        ) and client._discovery_doc is None
    if discover and not client.core.local_only:
        client.try_discover()
    send({"type": "shell.done"})
    # guard
    try:
        g = client.update.mark_boot_attempt()
        info["guard"] = g
        send({"type": "guard.done", "result": g.result})
    except Exception:
        send({"type": "guard.done", "result": "ok"})
    # sync
    try:
        act = ensure_activated(client, enroll=enroll, sync=True)
        info["sync"] = act.sync
        result = _sync_result(act.sync) if act.sync is not None else "offline"
    except PolarisError as e:
        result = "offline" if e.code == "local-only" else "error"
    send({"type": "sync.done", "result": result})
    # gate
    status = client.status().status
    info["status"] = status
    send({"type": "gate.status", "status": status})
    if state.stage == "decide":
        check = None
        value = "none"
        install = None
        if decide and client.core.enabled("update") and client.update._configured is not None:
            try:
                check = client.update.decide()
                value = boot_decision(check.decision)
                if check.decision.action == "packs":
                    install = list(check.decision.install or ())
            except Exception:
                value = "none"
        info["check"] = check
        send({"type": "decide.done", "decision": value})
        if state.stage == "fetch":
            if packs.configured:
                try:
                    r = packs.boot_fetch(
                        send, consent=consent, metered=metered, answer=answer, install=install
                    )
                    info["background"] = tuple(r.get("background") or ())
                except Exception as e:
                    send({"type": "fail", "code": getattr(e, "code", None) or "fetch-failed"})
            else:
                send({"type": "fetch.done", "result": "ok", "installed": []})
        if state.stage == "mount":
            send({"type": "mount.done"})
    _confirm(client, state.outcome, auto_confirm)
    err = next((e.get("code") for e in reversed(emits) if e.get("type") == "error"), None)
    return BootOutcome(
        outcome=state.outcome,
        stage=state.stage,
        state=state,
        emits=tuple(emits),
        status=info.get("status"),
        check=info.get("check"),
        guard=info.get("guard"),
        sync=info.get("sync"),
        background=info.get("background", ()),
        error=err,
    )


def _confirm(client: "PolarisKeyClient", outcome: str, auto: bool) -> None:
    if not auto or client.update.guard is None:
        return
    when = boot_confirmation(outcome)
    if when == "now":
        client.update.confirm_boot()
    elif when == "after-ok-seconds":
        stop = client._timer_stop

        def later() -> None:
            if not stop.wait(BOOT_OK_SECONDS):
                try:
                    client.update.confirm_boot()
                except Exception:
                    pass

        threading.Thread(target=later, name="polaris-boot-confirm", daemon=True).start()
