"""Framework-agnostic CLI command core.

Each command takes plain arguments + a :class:`PolarisKeyClient` and returns a
:class:`CommandResult` (exit code + lines). The argparse / click / typer front ends are
thin adapters over these, so behavior lives in exactly one place.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from ..client import PolarisKeyClient
from ..endpoints import EnrollMachineLimit, EnrollOk, EnrollUnauthorized

__all__ = ["CommandResult", "activate", "deactivate", "status"]


@dataclass
class CommandResult:
    """A command's outcome: process exit code + human-readable output lines."""

    code: int = 0
    lines: List[str] = field(default_factory=list)

    def emit(self) -> None:
        for line in self.lines:
            print(line)


def activate(client: PolarisKeyClient, key: str) -> CommandResult:
    """Enroll this device with a license ``key`` and pull the first config doc."""
    r = client.activate_with_key(key)
    if isinstance(r, EnrollOk):
        st = client.status()
        return CommandResult(0, [f"Activated. Status: {st.status}"])
    if isinstance(r, EnrollMachineLimit):
        detail = ""
        if r.limit is not None:
            detail = f" ({r.machineCount}/{r.limit} devices in use)"
        return CommandResult(1, [f"Activation failed: device limit reached{detail}."])
    if isinstance(r, EnrollUnauthorized):
        return CommandResult(1, ["Activation failed: invalid or revoked key."])
    return CommandResult(1, [f"Activation failed: {r.message}"])


def deactivate(client: PolarisKeyClient) -> CommandResult:
    """Deauthorize this device and wipe the local token + cache."""
    client.deactivate()
    return CommandResult(0, ["Deactivated. Local credentials wiped."])


def status(client: PolarisKeyClient) -> CommandResult:
    """Print the current gate status + a short profile/grace summary."""
    st = client.status()
    lines = [f"Status: {st.status}"]
    if st.graceUntil is not None:
        lines.append(f"Grace until (epoch): {st.graceUntil}")
    if st.allowedRange is not None:
        ar = st.allowedRange
        rng = f"min={ar.min or '-'} max={ar.max or '-'}"
        lines.append(f"Allowed version range: {rng}")
    profile = client.get_profile()
    if profile is not None:
        lines.append(f"Licensed to: {profile.name} <{profile.email}>")
    lines.append(f"Usable: {client.is_licensed()}")
    code = 0 if client.is_licensed() else 1
    return CommandResult(code, lines)


def build_client(
    *,
    product: str,
    version: str,
    trust: dict,
    base_url: Optional[str] = None,
    config_dir: Optional[str] = None,
) -> PolarisKeyClient:
    """Construct + initialise a client for the CLI front ends."""
    return PolarisKeyClient.create(
        product_slug=product,
        version=version,
        trust=trust,
        base_url=base_url,
        config_dir=config_dir,
    )
