"""Device telemetry — ``POST /<p>/devices/report`` (wire contract v3 §6).

It moved out of the config service in v3 (``POST /<p>/config/report`` is gone) because it
was never config: it is the device's software facts plus a snapshot of what it BELIEVES it
was granted, which is licence anti-fraud data. It is a Core surface now, available under
every registration policy, and a config-only product reports on it too.

THE SNAPSHOT IS BUILT FROM RE-VERIFIED DOCUMENTS

R4-05: v1 echoed the on-disk cache back to the control plane verbatim, so a forged local
file authored the one signal that would have revealed the forgery. Everything below is
read from the documents :class:`polaris_key.core.cache.CacheManager` re-verified moments ago;
if nothing verified, the maps are empty, and an empty report is a truthful one.

Best-effort throughout: facts collection is wrapped, the POST is wrapped, and a failure at
either end is invisible to the caller. Telemetry must never be able to fail a sync.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .cache import CacheManager
    from .context import CoreContext
    from ..devices.facts import ProbeDeclaration

__all__ = ["REPORT_PATH", "build_snapshot", "report_snapshot"]

#: ``POST /<p>/devices/report``. The old ``/config/report`` path is gone in v3.
REPORT_PATH = "devices/report"


def build_snapshot(
    cache: "CacheManager",
    probes: Optional[List["ProbeDeclaration"]] = None,
    caps: Optional[Callable[[], List[str]]] = None,
    pack_set_id: Optional[Callable[[], Optional[str]]] = None,
    *,
    gate: Optional[Callable[[], Optional[str]]] = None,
    outlet: Optional[Callable[[], Optional[str]]] = None,
    updates: Optional[Callable[[], List[Dict[str, Any]]]] = None,
    pack_installs: Optional[Callable[[], List[Dict[str, Any]]]] = None,
) -> Dict[str, Any]:
    """Assemble the report body from re-verified content plus this host's software facts.

    ``caps`` gives the feature ids ``supports()`` answers Supported for (P1b-10, PARITY
    §2.2). It rides EVERY report: the Worker overwrites the stored report each time, so a
    list sent only when it changed would vanish from the next one. ``pack_set_id`` gives the
    active pack set's id (plans/P4-01.md §2.11), sent as ``content: {packSetId}`` when the host
    has packs.

    The SDK parity pass (§3.13) adds the rest of the Worker's allowlist (``core/devices.ts``
    ``REPORT_KEYS``) the SDK knows: ``gate`` (``{status}``, the gate verdict right now),
    ``outlet`` (the outlet id this install resolved, at most 64 characters), ``updates`` (the
    update-health journal's pending events, at most 16) and ``packInstalls`` (the pack
    engine's recent installs, at most 8). Each is best-effort and omitted when unknown or
    empty."""
    config: Dict[str, Any] = {}
    entitlements: Dict[str, Any] = {}
    config_doc = cache.config_doc()
    if config_doc is not None:
        for k, v in config_doc.config.items():
            config[k] = v.value
    license_doc = cache.license_doc()
    if license_doc is not None:
        for k, v in license_doc.entitlements.items():
            entitlements[k] = v.value

    # Software facts ride alongside the snapshot on the SAME call — no extra round trip,
    # and the Worker's allowlist keeps the payload bounded. Imported here rather than at
    # module scope so Core never pulls `polaris_key.devices` into its own import cycle.
    facts: Dict[str, Any] = {}
    try:
        from ..devices.facts import collect_facts

        facts = collect_facts(probes)
    except Exception:
        # Facts are diagnostic; failing to gather them must never break a sync.
        facts = {}
    out: Dict[str, Any] = {**facts, "config": config, "entitlements": entitlements}
    if caps is not None:
        try:
            out["caps"] = list(caps())
        except Exception:
            # Diagnostic like the facts: never able to fail a sync.
            pass
    if pack_set_id is not None:
        try:
            set_id = pack_set_id()
        except Exception:
            set_id = None
        if set_id is not None:
            out["content"] = {"packSetId": set_id}
    status = _quiet(gate)
    if isinstance(status, str) and status:
        out["gate"] = {"status": status}
    outlet_id = _quiet(outlet)
    if isinstance(outlet_id, str) and outlet_id:
        out["outlet"] = outlet_id[:64]
    events = _quiet(updates)
    if isinstance(events, list) and events:
        out["updates"] = events[:16]
    installs = _quiet(pack_installs)
    if isinstance(installs, list) and installs:
        out["packInstalls"] = installs[-8:]
    return out


def _quiet(fn: Optional[Callable[[], Any]]) -> Any:
    """``fn()``, or ``None`` when it is absent or raises: telemetry never fails a sync."""
    if fn is None:
        return None
    try:
        return fn()
    except Exception:
        return None


def report_snapshot(ctx: "CoreContext", token: str, snapshot: Any) -> bool:
    """POST the snapshot. Returns whether the server accepted it; callers ignore that."""
    try:
        res = ctx.request(
            "POST",
            ctx.url(REPORT_PATH),
            headers=ctx.headers(
                {
                    "authorization": f"Bearer {token}",
                    "content-type": "application/json",
                }
            ),
            json=snapshot,
        )
        return res.is_success
    except Exception:
        return False
