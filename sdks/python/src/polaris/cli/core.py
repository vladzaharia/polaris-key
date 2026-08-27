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

import os
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, IO, Iterable, List, Mapping, Optional, Tuple

from .._version import __version__ as PACKAGE_VERSION
from ..client import PolarisKeyClient
from ..endpoints import (
    ActivationDeviceLimit,
    ActivationEnrollDisabled,
    ActivationFingerprintRequired,
    ActivationHardwareMismatch,
    ActivationOk,
    ActivationUnauthorized,
)

__all__ = [
    "CommandResult",
    "ClientOptions",
    "ClientFactory",
    "DEFAULT_VERSION",
    "KEY_ENV_VAR",
    "parse_trust",
    "resolve_activation_key",
    "build_client",
    "default_client_factory",
    "run_command",
    "activate",
    "deactivate",
    "status",
    "config",
]

# The version reported to the control plane when the host application doesn't say.
#
# This used to be the literal ``"0.0.0-dev"``. The Worker's build gate SHORT-CIRCUITS on a
# dev version — ``isDevBuild`` returns before either the version window or the channel
# entitlement is evaluated (``packages/worker/src/gate.ts:69-71,126-127``) — so a
# vendor-shipped tool's DEFAULT invocation asked for a document that skipped version AND
# channel enforcement entirely (audit finding R4-07). The installed package version is a
# truthful answer and gates normally.
DEFAULT_VERSION = PACKAGE_VERSION

# The documented, non-argv way to hand a licence key to the CLI.
KEY_ENV_VAR = "POLARIS_KEY_ACTIVATION_KEY"


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
    version: str = DEFAULT_VERSION
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


def resolve_activation_key(
    positional: Optional[str] = None,
    *,
    key_file: Optional[str] = None,
    key_stdin: bool = False,
    env: Optional[Mapping[str, str]] = None,
    stdin: Optional[IO[str]] = None,
    warn: Optional[Callable[[str], None]] = None,
) -> str:
    """Resolve the licence key from a NON-ARGV source by default (R12-13 / R4-16).

    A key passed as ``polaris-key activate PKEY-XXXX`` is written verbatim to
    ``~/.zsh_history``, is visible to every user on the box via ``ps auxww`` for the
    duration of the call, and is readable from ``/proc/<pid>/cmdline`` on Linux. The
    positional form still works — scripts depend on it — but it is no longer the
    documented path, and using it prints a warning.

    Resolution order (first hit wins):

    1. ``--key-file <path>`` — read and stripped.
    2. ``--key-stdin`` — one line from stdin.
    3. ``$POLARIS_KEY_ACTIVATION_KEY``.
    4. The positional argument, with a warning.
    5. An interactive prompt, when stdin is a TTY.

    Raises :class:`ValueError` when no source yielded a key.
    """
    environ = os.environ if env is None else env
    stream = sys.stdin if stdin is None else stdin
    emit = warn if warn is not None else (lambda m: print(m, file=sys.stderr))

    if key_file:
        with open(key_file, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if not key:
            raise ValueError(f"--key-file {key_file} is empty")
        return key

    if key_stdin:
        key = (stream.readline() or "").strip()
        if not key:
            raise ValueError("--key-stdin was given but stdin held no key")
        return key

    env_key = (environ.get(KEY_ENV_VAR) or "").strip()
    if env_key:
        return env_key

    if positional and positional.strip():
        emit(
            "warning: passing the license key as a command-line argument exposes it to "
            "your shell history and to `ps`. Prefer --key-stdin, --key-file, or "
            f"${KEY_ENV_VAR}."
        )
        return positional.strip()

    if getattr(stream, "isatty", lambda: False)():
        import getpass

        key = getpass.getpass("License key: ").strip()
        if key:
            return key

    raise ValueError(
        "no license key supplied — use --key-stdin, --key-file <path>, "
        f"${KEY_ENV_VAR}, or run interactively"
    )


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


def _describe_activation_failure(r: object, verb: str) -> CommandResult:
    """Render a non-ok activation outcome.

    Shared by ``activate`` and ``enroll`` so the two can't drift into describing the same
    server response differently. Mirrors describeFailure() in the Node CLI.
    """
    if isinstance(r, ActivationDeviceLimit):
        detail = ""
        if r.limit is not None:
            detail = f" ({r.deviceCount}/{r.limit} devices in use)"
        return CommandResult(1, [f"{verb} failed: device limit reached{detail}."])
    if isinstance(r, ActivationUnauthorized):
        return CommandResult(1, [f"{verb} failed: invalid or revoked credential."])
    if isinstance(r, ActivationFingerprintRequired):
        return CommandResult(
            1,
            [
                f"{verb} failed: a hardware fingerprint is required but could not be "
                "collected on this host."
            ],
        )
    if isinstance(r, ActivationHardwareMismatch):
        changed = f" ({', '.join(r.changed)})" if r.changed else ""
        return CommandResult(
            1,
            [
                f"{verb} failed: this machine's hardware changed{changed}. "
                "The previous authorization was released — run the command again to re-bind."
            ],
        )
    if isinstance(r, ActivationEnrollDisabled):
        return CommandResult(
            1, [f"{verb} failed: this product does not offer keyless enrollment."]
        )
    message = getattr(r, "message", "") or "unknown error."
    return CommandResult(1, [f"{verb} failed: {message}"])


def activate(client: PolarisKeyClient, key: str) -> CommandResult:
    """Activate this device with a license ``key`` and pull the first config doc."""
    r = client.activate_with_key(key)
    if isinstance(r, ActivationOk):
        st = client.status()
        return CommandResult(0, [f"Activated. Status: {st.status}"])
    return _describe_activation_failure(r, "Activation")


def enroll(client: PolarisKeyClient) -> CommandResult:
    """Obtain a license with no key and no sign-in, when the product offers a free tier."""
    r = client.enroll()
    if isinstance(r, ActivationOk):
        st = client.status()
        return CommandResult(0, [f"Enrolled. Status: {st.status}"])
    if isinstance(r, ActivationEnrollDisabled):
        return CommandResult(
            1,
            [
                "This product does not offer keyless enrollment — "
                "activate with a license key instead."
            ],
        )
    return _describe_activation_failure(r, "Enrollment")


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
