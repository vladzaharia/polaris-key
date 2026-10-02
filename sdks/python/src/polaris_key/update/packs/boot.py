"""The stage machine's host side for packs (plans/P4-01.md §2.10, §5; a port of client-core's
``packs/boot.ts``): the boot's FETCH stage driven by the pack engine. :func:`boot_pack_options`
turns the content stamp's ``expects`` into ``requiredPacks`` and ``essentialPacks``;
:func:`run_boot_fetch` sends the v3 events the machine accepts in ``fetch`` —
``fetch.consent {bytes, metered}`` when the host asks before downloading,
``fetch.progress {done, total}`` from the first byte, and ``fetch.done {result, installed}``.
``stage-matrix.json`` pins what the machine does with them.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from ...constants_generated import ErrorCode
from .engine import PackEngine, PackError, PackProgress, _target

__all__ = ["boot_pack_options", "run_boot_fetch"]


def boot_pack_options(stamp: Optional[Mapping[str, Any]]) -> Dict[str, List[str]]:
    """``requiredPacks`` are the ``required: true`` expects; ``essentialPacks`` the
    ``delivery: "essential"`` ones that are not required. Any other delivery waits for
    ``ensure``."""
    expects = (stamp or {}).get("expects") or []
    return {
        "requiredPacks": [e["pack"] for e in expects if e.get("required")],
        "essentialPacks": [
            e["pack"] for e in expects if not e.get("required") and e.get("delivery") == "essential"
        ],
    }


def run_boot_fetch(
    engine: PackEngine,
    *,
    stamp: Optional[Mapping[str, Any]],
    send: Callable[[Dict[str, Any]], None],
    consent: str = "metered",
    metered: bool = False,
    answer: Optional[Callable[[int, bool], bool]] = None,
    install: Optional[Sequence[Any]] = None,
) -> Dict[str, Any]:
    """Run the FETCH stage: estimate the required and essential packs that are not current, ask
    when the policy says so (``always``, ``metered`` — the default — or ``never``), download them
    with progress, and report what is installed. The result is ``ok`` when every wanted pack
    installed, ``declined`` when the player said no, ``offline`` when a download failed for want
    of a network (``network-error``), else ``failed``. Returns ``{"result", "installed"}``.

    ``install`` is a ``packs`` decision's install list (plans/P4-13.md §2.5 "Applying a packs
    answer"): its ``required`` and ``essential`` entries are installed here, before mount, at
    exactly the named release; the others come back in ``background`` for the host to install
    after the boot (``engine.ensure_releases``). Omitted: the stamp's pins, as before."""
    opts = boot_pack_options(stamp)
    wanted: List[str] = []
    for pid in opts["requiredPacks"] + opts["essentialPacks"]:
        if pid not in wanted:
            wanted.append(pid)
    blocking = set(wanted)
    targets: Dict[str, Any] = {}
    background: List[Any] = []
    for t in install or ():
        pack, release = _target(t)
        if pack in blocking:
            targets[pack] = (pack, release)
        else:
            background.append(t)
    is_metered = metered is True
    pins = {p["pack"]: p["release"]["sha256"] for p in ((stamp or {}).get("pins") or [])}
    for pid, (_pack, release) in targets.items():
        pins[pid] = release["sha256"]

    def installed_now() -> List[str]:
        running = engine.state().running
        return [
            pid for pid in wanted if pid in running and running[pid]["recordSha256"] == pins.get(pid)
        ]

    def done(result: str) -> Dict[str, Any]:
        installed = installed_now()
        send({"type": "fetch.done", "result": result, "installed": installed})
        out: Dict[str, Any] = {"result": result, "installed": installed}
        if install is not None:
            out["background"] = background
        return out

    # The decision's targets install at exactly their release; the other wanted packs at the pin.
    est = engine.estimate([pid for pid in wanted if pid not in targets])
    if targets:
        t_est = engine.estimate_releases(
            [{"pack": pack, "release": release} for pack, release in targets.values()]
        )
        est.bytes += t_est.bytes
        est.packs.extend(t_est.packs)
        est.refused.extend(t_est.refused)
    ask = est.bytes > 0 and (consent == "always" or (consent == "metered" and is_metered))
    if ask:
        send({"type": "fetch.consent", "bytes": est.bytes, "metered": is_metered})
        yes = answer(est.bytes, is_metered) if answer is not None else False
        if not yes:
            return done("declined")
    total = est.bytes
    send({"type": "fetch.progress", "done": 0, "total": total})
    track = {"base": 0, "last": 0}

    def on_progress(p: PackProgress) -> None:
        if p.phase != "download":
            return
        now = min(total, track["base"] + p.done)
        if now > track["last"]:
            track["last"] = now
            send({"type": "fetch.progress", "done": now, "total": total})

    off = engine.on(on_progress)
    result = "ok"
    try:
        for pid in est.packs:
            try:
                if pid in targets:
                    pack, release = targets[pid]
                    engine.ensure_releases([{"pack": pack, "release": release}])
                else:
                    engine.ensure([pid])
            except PackError as e:
                result = "offline" if e.code == ErrorCode.NETWORK_ERROR else "failed"
            except Exception:
                result = "failed"
            track["base"] = track["last"]
        if est.refused and result == "ok":
            result = (
                "offline"
                if any(r["code"] == ErrorCode.NETWORK_ERROR for r in est.refused)
                else "failed"
            )
    finally:
        off()
    if result == "ok" and track["last"] < total:
        send({"type": "fetch.progress", "done": total, "total": total})
    return done(result)
