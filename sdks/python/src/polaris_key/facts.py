"""Software facts: the OS/runtime/hardware summary and product-declared probe results
reported through ``POST /<product>/config/report``.

Mirrors ``packages/sdk-node/src/facts.ts``. Deliberately narrow — there is no installed-
application enumeration. A product declares the companion apps it cares about and the client
answers only those, so the payload stays small and the privacy story stays defensible
(see docs/PRIVACY.md).
"""

from __future__ import annotations

import locale as _locale
import os
import platform
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

__all__ = ["ProbeDeclaration", "collect_facts", "run_probes"]


@dataclass(frozen=True)
class ProbeDeclaration:
    """A product-declared companion-application check."""

    id: str
    label: Optional[str] = None
    macos: Optional[str] = None
    windows: Optional[str] = None
    linux: Optional[str] = None


def _target_for_platform(probe: ProbeDeclaration) -> Optional[str]:
    if sys.platform == "darwin":
        return probe.macos
    if sys.platform == "win32":
        return probe.windows
    return probe.linux


def run_probes(declarations: List[ProbeDeclaration]) -> Dict[str, dict]:
    """Answer the declared probes for this platform."""
    out: Dict[str, dict] = {}
    for probe in declarations:
        target = _target_for_platform(probe)
        # A probe with no target for this platform is not applicable — reporting it as
        # ``present: False`` would be a lie an admin can't distinguish from "not installed".
        if not target:
            continue
        out[probe.id] = {"present": os.path.exists(target)}
    return out


def _os_build() -> Optional[str]:
    if sys.platform != "darwin":
        return None
    try:
        return subprocess.run(
            ["sw_vers", "-buildVersion"],
            capture_output=True,
            text=True,
            check=True,
            timeout=2,
        ).stdout.strip() or None
    except Exception:
        return None


def _short_platform() -> str:
    """Match the Node SDK's short OS family (``darwin``/``win32``/``linux``)."""
    return sys.platform


def collect_facts(probes: Optional[List[ProbeDeclaration]] = None) -> dict:
    """Collect this device's software facts."""
    os_block: dict = {"name": _short_platform(), "version": platform.release()}
    build = _os_build()
    if build:
        os_block["build"] = build
    os_block["kernel"] = platform.system()

    hardware: dict = {}
    machine = platform.machine()
    if machine:
        hardware["machineModel"] = machine
    cores = os.cpu_count()
    if cores:
        hardware["cpuCores"] = cores

    facts: dict = {
        "os": os_block,
        "hardware": hardware,
        "runtime": {"name": "python", "version": platform.python_version()},
    }

    try:
        lang = _locale.getlocale()[0] or _locale.getdefaultlocale()[0]
    except Exception:
        lang = None
    if lang:
        facts["locale"] = lang

    tz = datetime.now(timezone.utc).astimezone().tzname()
    if tz:
        facts["timezone"] = tz

    if probes:
        results = run_probes(probes)
        if results:
            facts["probes"] = results
    return facts
