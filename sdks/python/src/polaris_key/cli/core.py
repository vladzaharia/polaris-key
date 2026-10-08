"""Framework-agnostic CLI command core.

Each command takes plain arguments + a :class:`polaris_key.PolarisKeyClient` and returns a
:class:`CommandResult` (exit code + lines). The argparse / click / typer front ends are
thin adapters over these, so behavior lives in exactly one place.

v3 GROUPS THE VERBS BY THE SERVICE THAT OWNS THEM, which is the CLI's version of the same
carve the SDK just went through::

    license  activate · enroll · deactivate · status
    devices  register
    config   config <key>
    core     import-bundle

``register`` is the new one and the reason the grouping matters: it is a DEVICES verb, not
a licensing one. A config-only product (D-08) has no ``activate`` to run and its whole
provisioning story is ``polaris-key register`` — which under a licence-shaped CLI would have
had nowhere to live.

The trust-set parsing, the common-option bundle (:class:`ClientOptions`), and the
client-construction + lifecycle helpers also live here so the three adapters never copy
that logic. A ``client_factory`` (``ClientOptions -> PolarisKeyClient``) lets a consumer
inject their own pinned trust keys / base URL when mounting the hooks into their CLI.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, IO, Iterable, List, Mapping, Optional

from .._version import __version__ as PACKAGE_VERSION
from ..client import PolarisKeyClient
from ..core.store import StoreStatus
__all__ = [
    "CommandResult",
    "ClientOptions",
    "ClientFactory",
    "DEFAULT_VERSION",
    "KEY_ENV_VAR",
    "SERVICE_COMMANDS",
    "parse_trust",
    "parse_services",
    "resolve_activation_key",
    "build_client",
    "default_client_factory",
    "run_command",
    "activate",
    "enroll",
    "deactivate",
    "status",
    "format_store_status",
    "LINUX_NO_MACHINE_ID_HINT",
    "register",
    "config",
    "import_bundle",
    "read_bundle_file",
    "result_of",
    "terminal_for",
]

# The version reported to the control plane when the host application doesn't say.
#
# This used to be the literal ``"0.0.0-dev"``. The Worker's build gate SHORT-CIRCUITS on a
# dev version — `isDevBuild` returns before either the version window or the channel
# entitlement is evaluated — so a vendor-shipped tool's DEFAULT invocation asked for a
# document that skipped version AND channel enforcement entirely (R4-07). The installed
# package version is a truthful answer and gates normally.
DEFAULT_VERSION = PACKAGE_VERSION

# The documented, non-argv way to hand a licence key to the CLI.
KEY_ENV_VAR = "POLARIS_KEY_ACTIVATION_KEY"

#: The verb → owning-service grouping the three adapters render in their help output.
SERVICE_COMMANDS: Dict[str, tuple] = {
    "license": ("activate", "enroll", "deactivate", "status"),
    "identity": ("sign-in", "sign-out", "login", "logout"),
    "devices": ("register", "devices"),
    "config": ("config", "secret", "mint"),
    "release": ("changelog",),
    "update": ("update", "packs"),
    "core": ("import-bundle", "offline-request", "boot", "doctor"),
}


@dataclass
class CommandResult:
    """A command's outcome: process exit code + human-readable output lines.

    ``lines`` is the plain text of the terminal kit's screen (UK-13). ``styled`` holds the same
    screen as kit lines and ``data`` the ``--json`` result's fields; ``terminal``, when the
    command ran through a front end, is where :meth:`emit` draws them."""

    code: int = 0
    lines: List[str] = field(default_factory=list)
    styled: Optional[List[Any]] = field(default=None, repr=False, compare=False)
    data: Dict[str, Any] = field(default_factory=dict, repr=False, compare=False)
    terminal: Optional[Any] = field(default=None, repr=False, compare=False)

    def emit(self) -> None:
        if self.terminal is not None:
            from ..ui.terminal.flows import Outcome

            self.terminal.finish(Outcome(self.code, list(self.styled or []), dict(self.data)))
            return
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
    #: The D-21 capability fallback, when the host build knows what it expects.
    expected_services: Optional[List[str]] = None


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


def parse_services(values: Optional[Iterable[str]]) -> Optional[List[str]]:
    """Parse repeated ``--service <slug>`` flags into the D-21 expectation list.

    No flags at all — which argparse reports as ``None`` and click as ``()`` — means "say
    nothing", so the client keeps the suite default (licence + config). It is deliberately
    NOT read as "this build expects no services": that stronger statement turns every
    sub-client off, and a CLI has no way to distinguish "I passed no flags" from "I meant
    none", so the safe reading is silence. A host that genuinely wants the empty
    expectation passes ``expected_services=[]`` to the client directly.
    """
    if values is None:
        return None
    out = [v for v in values]
    return out if out else None


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
        expected_services=opts.expected_services,
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


#: The Linux remedy for a keyless enrolment refused for want of a machine anchor (P1b-09).
LINUX_NO_MACHINE_ID_HINT = (
    "This host has no machine id (/etc/machine-id). In a container, mount the host's "
    "read-only, or create one and keep it in a volume."
)


def terminal_for(client: Any, verb: str, *, terminal: Any = None) -> Any:
    """The terminal kit (``polaris_key.ui.terminal``) a command draws with: the front end's, or
    for a library caller a plain one (no escapes, no prompts, the screen as text lines)."""
    from ..ui.terminal.env import TermEnv
    from ..ui.terminal.flows import Terminal

    if terminal is not None:
        terminal.verb = verb
        return terminal
    return Terminal.create(product=getattr(client, "product", None), client=client, verb=verb, term_env=TermEnv())


def result_of(outcome: Any, terminal: Any = None) -> CommandResult:
    """A flow's outcome as a :class:`CommandResult`."""
    return CommandResult(
        outcome.code,
        outcome.text,
        styled=list(outcome.lines),
        data=dict(outcome.data),
        terminal=terminal,
    )


# ── license ─────────────────────────────────────────────────────────────────────────
def activate(client: PolarisKeyClient, key: Optional[str], *, terminal: Any = None) -> CommandResult:
    """Activate this device with a licence ``key`` and pull the first documents. With no key
    and an interactive terminal, the kit asks for it (masked entry, UI-KITS §4.3)."""
    from ..ui.terminal import flows

    t = terminal_for(client, "activate", terminal=terminal)
    return result_of(flows.activate(client, t, key), terminal)


def enroll(client: PolarisKeyClient, platform: Optional[str] = None, *, terminal: Any = None) -> CommandResult:
    """Obtain a licence with no key and no sign-in, when the product offers a free tier.

    ``platform`` only selects the failure hint; it defaults to ``sys.platform``."""
    from ..ui.terminal import flows
    from ..ui.terminal.text import Span

    t = terminal_for(client, "enroll", terminal=terminal)
    out = flows.enroll(client, t)
    # Keyless enrolment needs a machine anchor, which Linux reads only from the machine-id files
    # (WIRE-CONTRACT-V3 §6.1 rule 2); most container images ship none.
    if out.data.get("kind") == "fingerprint-required" and (platform or sys.platform).startswith("linux"):
        hint = t.kit.body([Span(LINUX_NO_MACHINE_ID_HINT, (), None, "data:diagnostic")])
        out.lines = out.lines[:-1] + hint + out.lines[-1:]
    res = result_of(out, terminal)
    if out.data.get("kind") == "fingerprint-required" and (platform or sys.platform).startswith("linux"):
        res.lines.append(LINUX_NO_MACHINE_ID_HINT)
    return res


def deactivate(client: PolarisKeyClient, *, terminal: Any = None) -> CommandResult:
    """Deauthorize this device and wipe the local token + cache."""
    from ..ui.terminal import flows

    t = terminal_for(client, "deactivate", terminal=terminal)
    return result_of(flows.deactivate(client, t), terminal)


def status(client: PolarisKeyClient, *, terminal: Any = None) -> CommandResult:
    """The gate status as the terminal kit draws it: the account summary when licensed, the
    grace line offline, the blocked state with its fix, or the activation prompt.

    The exit code reflects whether the gate currently permits running — which for a
    product with License disabled is 0 on ``not-applicable``, not a failure. A degraded token
    store is named under the summary (and in ``--json`` as ``tokenStore``).
    """
    from ..ui.terminal import flows

    t = terminal_for(client, "status", terminal=terminal)
    # `getattr`: a host's test double need not implement it.
    store_status = getattr(client, "store_status", None)
    store = store_status() if callable(store_status) else None
    line = format_store_status(store) if isinstance(store, StoreStatus) and store.degraded is not None else None
    out = flows.status(client, t, store_line=line)
    if isinstance(store, StoreStatus):
        out.data["tokenStore"] = {
            "backend": store.backend,
            "degraded": None if store.degraded is None else {"reason": store.degraded.reason, "detail": store.degraded.detail},
        }
    return result_of(out, terminal)


def format_store_status(store: StoreStatus) -> str:
    """One line naming the token store, e.g. ``Token store: keyring`` or
    ``Token store: file (degraded: keyring-unavailable: <detail>)``."""
    if store.degraded is None:
        return f"Token store: {store.backend}"
    detail = f": {store.degraded.detail}" if store.degraded.detail else ""
    return f"Token store: {store.backend} (degraded: {store.degraded.reason}{detail})"


# ── devices ─────────────────────────────────────────────────────────────────────────
def register(client: PolarisKeyClient, *, terminal: Any = None) -> CommandResult:
    """``POST /<p>/devices/register`` — the keyless device mint (§6).

    The provisioning verb for a product whose registration policy is ``open``, and the
    only one a config-only product has. A ``requires-license`` product answers
    ``registration_closed``, which is reported as-is rather than being retried against
    ``activate``: the two are different operator intents and quietly substituting one
    would hide a misconfigured policy.
    """
    from ..ui.terminal import flows

    t = terminal_for(client, "register", terminal=terminal)
    return result_of(flows.register(client, t), terminal)


# ── config ──────────────────────────────────────────────────────────────────────────
def config(
    client: PolarisKeyClient, key: str, fallback: Optional[str] = None, *, terminal: Any = None
) -> CommandResult:
    """Resolve a single layered-config ``key`` and show its value and source."""
    from ..ui.terminal import flows

    t = terminal_for(client, "config", terminal=terminal)
    return result_of(flows.config(client, t, [key], fallback=fallback), terminal)


# ── core ────────────────────────────────────────────────────────────────────────────
def import_bundle(client: PolarisKeyClient, jws: str, *, terminal: Any = None) -> CommandResult:
    """Import an offline activation bundle (§7).

    All-or-nothing: a rejection leaves the install exactly as it was, and the message
    names the STEP that refused — "get a bundle minted for THIS machine" is a different
    operator action from "the trust manifest inside it was rejected".
    """
    from ..ui.terminal import flows

    t = terminal_for(client, "import-bundle", terminal=terminal)
    return result_of(flows.import_bundle(client, t, jws), terminal)


def read_bundle_file(path: str) -> str:
    """Read a ``.pkeybundle`` off disk, stripped. Raises ``OSError``/``ValueError``."""
    with open(path, "r", encoding="utf-8") as f:
        jws = f.read().strip()
    if not jws:
        raise ValueError(f"{path} is empty")
    return jws

