"""Device telemetry — ``POST /<p>/devices/report`` (wire contract v3 §6).

It moved out of the config service in v3 (``POST /<p>/config/report`` is gone) because it
was never config: it is the device's software facts plus a snapshot of what it BELIEVES it
was granted, which is licence anti-fraud data. It is a Core surface now, available under
every registration policy, and a config-only product reports on it too.

THE SNAPSHOT IS BUILT FROM RE-VERIFIED DOCUMENTS

R4-05: v1 echoed the on-disk cache back to the control plane verbatim, so a forged local
file authored the one signal that would have revealed the forgery. Everything below is
read from the documents :class:`polaris.core.cache.CacheManager` re-verified moments ago;
if nothing verified, the maps are empty, and an empty report is a truthful one.

Best-effort throughout: facts collection is wrapped, the POST is wrapped, and a failure at
either end is invisible to the caller. Telemetry must never be able to fail a sync.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .cache import CacheManager
    from .context import CoreContext
    from ..devices.facts import ProbeDeclaration

__all__ = ["REPORT_PATH", "build_snapshot", "report_snapshot"]

#: ``POST /<p>/devices/report``. The old ``/config/report`` path is gone in v3.
REPORT_PATH = "devices/report"


def build_snapshot(
    cache: "CacheManager", probes: Optional[List["ProbeDeclaration"]] = None
) -> Dict[str, Any]:
    """Assemble the report body from re-verified content plus this host's software facts."""
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
    # module scope so Core never pulls `polaris.devices` into its own import cycle.
    facts: Dict[str, Any] = {}
    try:
        from ..devices.facts import collect_facts

        facts = collect_facts(probes)
    except Exception:
        # Facts are diagnostic; failing to gather them must never break a sync.
        facts = {}
    return {**facts, "config": config, "entitlements": entitlements}


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
