"""Framework-agnostic CLI command core.

Each command takes plain arguments + a :class:`PolarisKeyClient` and returns a
:class:`CommandResult` (exit code + lines). The argparse / click / typer front ends are
thin adapters over these, so behavior lives in exactly one place.

The trust-set parsing, the common-option bundle (:class:`ClientOptions`), and the
client-construction + lifecycle helpers also live here so the three adapters never copy
that logic. A ``client_factory`` (``ClientOptions -> PolarisKeyClient``) lets a consumer
inject their own pinned trust keys / base URL when mounting the hooks into their CLI.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from ..client import PolarisKeyClient
from ..endpoints import EnrollMachineLimit, EnrollOk, EnrollUnauthorized

__all__ = [
    "CommandResult",
    "ClientOptions",
    "ClientFactory",
    "parse_trust",
    "build_client",
    "default_client_factory",
    "run_command",
    "activate",
    "deactivate",
    "status",
    "config",
]


@dataclass
class CommandResult:
    """A command's outcome: process exit code + human-readable output lines."""

    code: int = 0
    lines: List[str] = field(default_factory=list)

    def emit(self) -> None:
        for line in self.lines:
            print(line)


@dataclass
class ClientOptions:
    """The common options every front end collects to build a client."""

    product: str
    version: str = "0.0.0-dev"
    trust: Dict[str, str] = field(default_factory=dict)
    base_url: Optional[str] = None
    config_dir: Optional[str] = None


# A factory turns the collected options into a ready client. Consumers can supply their
# own (e.g. with trust keys baked in) when mounting the hooks; the default reads them off
# the parsed CLI options.
ClientFactory = Callable[[ClientOptions], PolarisKeyClient]


def parse_trust(pairs: Optional[Iterable[str]]) -> Dict[str, str]:
    """Parse repeated ``kid=rawBase64url`` pairs into a trust set.

    Raises :class:`ValueError` on a malformed pair so each adapter can translate it into
    its framework's native error.
    """
    trust: Dict[str, str] = {}
    for p in pairs or []:
        if "=" not in p:
            raise ValueError(f"--trust expects kid=rawBase64url, got: {p}")
        kid, raw = p.split("=", 1)
        trust[kid] = raw
    return trust


def build_client(opts: ClientOptions) -> PolarisKeyClient:
    """Construct + initialise a client from collected :class:`ClientOptions`."""
    return PolarisKeyClient.create(
        product_slug=opts.product,
        version=opts.version,
        trust=opts.trust,
        base_url=opts.base_url,
        config_dir=opts.config_dir,
    )


# The default factory simply builds a client from the parsed options.
default_client_factory: ClientFactory = build_client


def run_command(
    factory: ClientFactory,
    opts: ClientOptions,
    command: Callable[[PolarisKeyClient], CommandResult],
) -> CommandResult:
    """Build a client via ``factory``, run ``command``, and always close the client."""
    client = factory(opts)
    try:
        return command(client)
    finally:
        client.close()


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


def config(
    client: PolarisKeyClient, key: str, fallback: Optional[str] = None
) -> CommandResult:
    """Resolve a single layered-config ``key`` and print its value + source."""
    value = client.get_config(key, fallback)
    source = client.get_config_source(key)
    return CommandResult(0, [f"{key} = {value!r} (source: {source})"])
