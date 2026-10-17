"""The gate for a host CLI's own commands (the ``gate`` rows of the ``cli`` family in
``conformance/corpus/v2/ui-matrix.json``, plans/UK-51.md; the Node kit's ``cli/gate.ts``).

``require_license`` runs the host's command only on a usable license that holds the entitlement. A
person at a terminal is taken through the kit's activate flow first and the command then runs;
anything else is a refusal, a triangle with the command that fixes it, and exit 4
(``EXIT.license_required``, as ``gh`` exits for "requires authentication"). With ``--json`` the
refusal is the result line on stdout, ``license_required`` or ``not_entitled``::

    @app.command()
    @require_license(entitlement="export.pdf")
    def export(): ...

A refusal ends the command with ``SystemExit(4)``, which argparse, click and typer all pass through.
"""

from __future__ import annotations

import functools
import sys
from dataclasses import dataclass
from typing import IO, Any, Callable, Dict, List, Optional, Sequence, Tuple, TypeVar

from ..ui.terminal.exit import EXIT

__all__ = ["require_license", "require_entitlement", "run_gate", "bind_gate", "GateTarget"]

F = TypeVar("F", bound=Callable[..., Any])

#: The gate statuses a host's command runs on (with the entitlement held).
USABLE = ("ok", "grace", "not-applicable")
#: What an interactive run resolves inline: activating another key fixes them.
INLINE_FLOW = ("needs-activation", "expired", "revoked")
_KNOWN = ("expired", "revoked", "needs-activation", "version-too-old", "version-too-new", "channel-not-entitled")
#: Each fix verb and the catalog key that labels it.
FIX_COPY = {
    "activate": "welcome.useKey",
    "login": "welcome.signIn",
    "update apply": "status.update",
    "status": "cli.verb.status",
}


@dataclass
class GateTarget:
    """What a mount tells the gate: how to build the client and what to call things."""

    #: Builds the client (the caller closes it).
    client: Optional[Callable[[], Any]]
    #: Whether the gate closes the client it built (not one the host handed in).
    owns_client: bool
    #: What a person types before a verb (``tidewater``, or ``tidewater license`` under a namespace).
    prog: str
    #: The verb ids the mount offers: a fix for a verb that is not mounted is left out.
    mounted: Optional[Sequence[str]] = None
    theme: Any = None


_latest: Optional[GateTarget] = None


def bind_gate(target: GateTarget) -> None:
    """Called by a mount: the gate finds its client and names from the last mount."""
    global _latest
    _latest = target


def _refusal(status: str, usable: bool, mounted: Optional[Sequence[str]]) -> Tuple[str, str, str, List[str]]:
    """``(error, title_key, message_key, fix verbs)`` for a status the command cannot run on."""
    not_entitled = usable or status == "channel-not-entitled"
    if usable:
        title, message = "core.codes.not_entitled.title", "core.codes.not_entitled.message"
    else:
        state = status if status in _KNOWN else "revoked"
        title, message = f"core.gate.{state}.title", f"core.gate.{state}.message"
    if not_entitled:
        verbs = ["status"]
    elif status.startswith("version-"):
        verbs = ["update apply"]
    else:
        verbs = ["activate", "login"]
    return (
        "not_entitled" if not_entitled else "license_required",
        title,
        message,
        [v for v in verbs if mounted is None or v in mounted],
    )


def run_gate(
    client: Any,
    *,
    command: str,
    entitlement: Optional[str] = None,
    json: bool = False,
    no_color: bool = False,
    ascii: bool = False,
    prog: str = "polaris-key",
    mounted: Optional[Sequence[str]] = None,
    theme: Any = None,
    terminal: Any = None,
    env: Optional[Dict[str, str]] = None,
    stdout: Optional[IO[str]] = None,
    stderr: Optional[IO[str]] = None,
    stdin: Optional[IO[str]] = None,
) -> Optional[int]:
    """Check the license for a host command. ``None`` when the command may run, else the exit code
    to end with (4 for a refusal; the flow's own code when the inline flow failed or was cancelled).
    Never raises for a license problem."""
    from ..ui.terminal import flows
    from ..ui.terminal.flows import Terminal

    def make(verb: str) -> Any:
        if terminal is not None:
            terminal.verb = verb
            return terminal
        t = Terminal.create(
            product=getattr(client, "product", None),
            client=client,
            theme=theme,
            prog=prog,
            verb=verb,
            json=json,
            no_color=no_color,
            ascii=ascii,
            env=env,
            stdout=stdout,
            stdin=stdin,
        )
        if stderr is not None:
            t.err = stderr
        return t

    def check() -> Tuple[str, bool, bool]:
        status = str(client.status().status)
        usable = status in USABLE
        entitled = entitlement is None or bool(client.license.is_entitled(entitlement))
        return status, usable, entitled

    status, usable, entitled = check()
    if usable and entitled:
        return None
    t = make(command)
    # A license that is not usable may be one sync away from it (an expired document, a renewal).
    if not usable:
        try:
            client.sync()
        except Exception:
            pass
        status, usable, entitled = check()
        if usable and entitled:
            return None
    if not usable and t.env.interactive and status in INLINE_FLOW:
        at = make("activate")
        out = flows.activate(client, at, None)
        at.finish(out)
        if out.code != EXIT.ok:
            return out.code
        status, usable, entitled = check()
        if usable and entitled:
            return None
        t = make(command)
    out = refusal_outcome(t, command, status, usable, mounted)
    t.finish(out)
    return EXIT.license_required


def refusal_outcome(t: Any, command: str, status: str, usable: bool, mounted: Optional[Sequence[str]] = None) -> Any:
    """The refusal for ``command`` on ``status``: a triangle, the title and message, and the commands
    that fix it, for stderr; under ``--json`` the result's fields only. Exit 4."""
    from ..ui.terminal import screens
    from ..ui.terminal.flows import Outcome

    error, title_key, message_key, fixes = _refusal(status, usable, mounted)
    k = t.kit
    if t.env.json:
        return Outcome(EXIT.license_required, [], {"error": error})
    lines = [k.header(command)] + ([k.rail()] if k.decor else []) + k.step("warn", [k.t(title_key, "strong")]) + k.body([k.t(message_key)])
    if fixes:
        lines += screens._gap(k) + screens._fixes(k, [(v, FIX_COPY[v]) for v in fixes])
    lines += k.end()
    return Outcome(EXIT.license_required, lines, {"error": error}, stream="stderr")


def _flags(args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """The ``--json``, ``--no-color`` and ``--ascii`` the host's command was given: from an argparse
    namespace it takes, or the click/typer context it runs in."""
    found: Dict[str, Any] = {}
    for a in args:
        if hasattr(a, "__dict__") and not callable(a):
            found.update({k: v for k, v in vars(a).items() if k in ("json", "no_color", "ascii")})
    found.update({k: v for k, v in kwargs.items() if k in ("json", "no_color", "ascii")})
    try:
        import click

        ctx = click.get_current_context(silent=True)
        if ctx is not None:
            found.update({k: v for k, v in ctx.params.items() if k in ("json", "no_color", "ascii") and k not in found})
    except ImportError:  # pragma: no cover
        pass
    return found


def require_license(
    handler: Optional[F] = None,
    *,
    entitlement: Optional[str] = None,
    client: Any = None,
    prog: Optional[str] = None,
    theme: Any = None,
    exit: Optional[Callable[[int], Any]] = None,
) -> Any:
    """Wrap a host command so it runs only on a usable license (and the entitlement, when given).
    A refusal prints the fix, ends with exit 4 and does not call the command. Use it bare
    (``@require_license``) or with options (``@require_license(entitlement="export.pdf")``).

    The client is the one the mount was given (``client=`` or ``config=``); pass ``client`` for a
    host that mounts nothing. ``exit`` replaces ``sys.exit`` for a host that ends its own way."""

    def wrap(fn: F) -> F:
        @functools.wraps(fn)
        def gated(*args: Any, **kwargs: Any) -> Any:
            target = _latest
            if client is None and (target is None or target.client is None):
                raise RuntimeError(
                    "require_license: mount the kit commands with client= or config= first, or pass client=."
                )
            flags = _flags(args, kwargs)
            own = client is None and target is not None and target.owns_client
            c = client if client is not None else target.client()  # type: ignore[union-attr]
            try:
                code = run_gate(
                    c,
                    command=fn.__name__.replace("_", "-"),
                    entitlement=entitlement,
                    json=bool(flags.get("json")),
                    no_color=bool(flags.get("no_color")),
                    ascii=bool(flags.get("ascii")),
                    prog=prog or (target.prog if target else None) or str(getattr(c, "product", None) or "polaris-key"),
                    mounted=target.mounted if target else None,
                    theme=theme or (target.theme if target else None),
                )
            finally:
                if own:
                    c.close()
            if code is None:
                return fn(*args, **kwargs)
            (exit or sys.exit)(code)
            return None

        return gated  # type: ignore[return-value]

    return wrap(handler) if handler is not None else wrap


def require_entitlement(entitlement: str, **options: Any) -> Any:
    """``require_license(entitlement=...)``: the license must also grant ``entitlement``."""
    return require_license(entitlement=entitlement, **options)
