"""The CLI's full verb set (SDK parity pass §2.1 / §2.3, SP-P12; restyled by UK-13), framework-agnostic.

Each verb is a function ``(client, ns) -> CommandResult`` over a plain namespace of parsed values,
described once in :data:`VERBS`. The argparse, click and typer front ends build every command from
that table, so the three can never disagree. Every verb draws through the terminal kit
(``polaris_key.ui.terminal``) and takes the kit's common flags: ``--json`` (one JSON object per
state, the last one ``"event": "result"``; never prompts), ``--no-color`` and ``--ascii``.

==================  =======================================================================
``activate``        the key from ``--key-stdin``, ``--key-file``, ``$POLARIS_KEY_ACTIVATION_KEY``
                    or masked entry (the positional still works and warns)
``enroll``          a license with no key and no sign-in
``deactivate``      release this device's seat and wipe local credentials
``status``          the account summary, the grace line, or the blocked state and its fix
``register``        the keyless device mint
``sign-in``         sign in in the browser, or with a code when headless (``--device-code``);
                    ``login`` is the same verb
``sign-out``        release this device's seat and forget the identity (``--yes``); ``logout``
``devices``         ``list`` (default) · ``rename <id> <label>`` · ``deauthorize <id>``
``config``          ``list`` · ``get <key>`` · ``set <key> <value>`` · ``reset <key>`` (and the
                    v3 shorthand ``config <key>``)
``secret``          ``secret <key>``: whether a managed secret is present (never printed)
``mint``            ``mint <recipe>``: an edge-minted token's expiry (never printed)
``update``          ``check`` (default) · ``download --to <path>`` · ``apply``, with progress
``changelog``       the published releases, newest first
``packs``           ``status`` (default) · ``ensure <pack…>`` with progress
``boot``            the one-call boot, a live line per stage
``import-bundle``   import an offline activation bundle (a path, or ``-`` for stdin)
``offline-request`` the request code for an offline activation bundle, with a QR
``doctor``          base URL, discovery, services, store, outlet and every ``supports()`` answer
==================  =======================================================================

Values are parsed from strings: ``config set`` reads its value as JSON when it is one
(``true``, ``3``, ``["a"]``) and as a string otherwise.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from ..core.caps import Unsupported
from . import core
from .core import CommandResult, result_of

__all__ = ["Opt", "Verb", "VERBS", "VERB_NAMES", "UI_OPTS", "run"]


@dataclass(frozen=True)
class Opt:
    """One option: ``kind`` is ``flag``, ``str`` or ``int``."""

    name: str
    kind: str = "str"
    help: str = ""
    default: Any = None


@dataclass(frozen=True)
class Verb:
    name: str
    group: str
    help: str
    run: Callable[[Any, Dict[str, Any]], CommandResult]
    #: Free positional words (the action and its arguments), or none.
    words: bool = False
    opts: Tuple[Opt, ...] = field(default_factory=tuple)
    #: One optional positional with its own name (``activate``'s ``key``, ``import-bundle``'s
    #: ``bundle``), kept under that name for hosts that read the parsed arguments.
    arg: Optional[str] = None


#: The terminal kit's flags, on every verb.
UI_OPTS: Tuple[Opt, ...] = (
    Opt("json", "flag", "Machine-readable output: one JSON object per state, never a prompt."),
    Opt("no-color", "flag", "Plain text, no colour (also NO_COLOR=1)."),
    Opt("ascii", "flag", "ASCII symbols only."),
)


def _term(client: Any, ns: Dict[str, Any], name: str) -> Any:
    return core.terminal_for(client, name, terminal=ns.get("_term"))


def _done(out: Any, ns: Dict[str, Any]) -> CommandResult:
    return result_of(out, ns.get("_term"))


def _flows() -> Any:
    from ..ui.terminal import flows

    return flows


class _NoPrompt:
    """A stdin that is no terminal, so ``resolve_activation_key`` never prompts with getpass: the
    kit's masked entry asks instead."""

    def readline(self) -> str:
        return sys.stdin.readline()

    def isatty(self) -> bool:
        return False


# ── license ──────────────────────────────────────────────────────────────────────────
def activate(client: Any, ns: Dict[str, Any]) -> CommandResult:
    words = list(ns.get("words") or [])
    t = _term(client, ns, "activate")
    key: Optional[str]
    try:
        key = core.resolve_activation_key(
            words[0] if words else None,
            key_file=ns.get("key_file"),
            key_stdin=bool(ns.get("key_stdin")),
            stdin=_NoPrompt(),
        )
    except ValueError as e:
        if not t.env.interactive:
            return _done(_flows().usage(t, f"activate --key-stdin  ({e})"), ns)
        key = None  # masked entry (UI-KITS §4.3)
    except OSError as e:
        return _done(_flows().usage(t, f"activate --key-file <path>  ({e})"), ns)
    return _done(_flows().activate(client, t, key), ns)


def enroll(client: Any, ns: Dict[str, Any]) -> CommandResult:
    return core.enroll(client, terminal=ns.get("_term"))


def deactivate(client: Any, ns: Dict[str, Any]) -> CommandResult:
    return core.deactivate(client, terminal=ns.get("_term"))


def status(client: Any, ns: Dict[str, Any]) -> CommandResult:
    return core.status(client, terminal=ns.get("_term"))


def register(client: Any, ns: Dict[str, Any]) -> CommandResult:
    return core.register(client, terminal=ns.get("_term"))


# ── identity ─────────────────────────────────────────────────────────────────────────
def sign_in(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, ns.get("_verb") or "sign-in")
    out = _flows().sign_in(
        client, t, device_name=ns.get("device_name"), attach=bool(ns.get("attach")), browser=bool(ns.get("browser"))
    )
    return _done(out, ns)


def sign_out(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, ns.get("_verb") or "sign-out")
    return _done(_flows().sign_out(client, t, yes=bool(ns.get("yes"))), ns)


# ── devices ──────────────────────────────────────────────────────────────────────────
def devices(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "devices")
    return _done(_flows().devices(client, t, list(ns.get("words") or []), yes=bool(ns.get("yes"))), ns)


# ── config ───────────────────────────────────────────────────────────────────────────
def config(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "config")
    return _done(_flows().config(client, t, list(ns.get("words") or []), fallback=ns.get("fallback")), ns)


def secret(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "secret")
    return _done(_flows().secret(client, t, list(ns.get("words") or [])), ns)


def mint(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "mint")
    return _done(_flows().mint(client, t, list(ns.get("words") or [])), ns)


# ── release / update ─────────────────────────────────────────────────────────────────
def update(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "update")
    out = _flows().update(client, t, list(ns.get("words") or []), channel=ns.get("channel"), to=ns.get("to"))
    return _done(out, ns)


def changelog(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "changelog")
    return _done(_flows().changelog(client, t, limit=ns.get("limit")), ns)


def packs(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "packs")
    return _done(_flows().packs(client, t, list(ns.get("words") or [])), ns)


# ── core ─────────────────────────────────────────────────────────────────────────────
def boot(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "boot")
    return _done(_flows().boot(client, t, yes=bool(ns.get("yes"))), ns)


def import_bundle(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "import-bundle")
    words = list(ns.get("words") or [])
    if len(words) != 1:
        return _done(_flows().usage(t, "import-bundle <file | ->"), ns)
    try:
        jws = sys.stdin.read().strip() if words[0] == "-" else core.read_bundle_file(words[0])
    except (ValueError, OSError) as e:
        return _done(_flows().usage(t, f"import-bundle <file | ->  ({e})"), ns)
    if not jws:
        return _done(_flows().usage(t, "import-bundle <file | ->  (no bundle supplied on stdin)"), ns)
    return core.import_bundle(client, jws, terminal=ns.get("_term"))


def offline_request(client: Any, ns: Dict[str, Any]) -> CommandResult:
    t = _term(client, ns, "offline-request")
    if ns.get("no_qr"):
        t.kit.env = t.kit.env.but(height=0)
    return _done(_flows().offline_request(client, t), ns)


def doctor(client: Any, ns: Dict[str, Any]) -> CommandResult:
    from ..constants_generated import FEATURE_VALUES
    from ..ui.terminal import screens
    from ..ui.terminal.flows import Outcome

    t = _term(client, ns, "doctor")
    rows: List[Tuple[str, str]] = [
        ("Product", f"{client.product}  version {client.core.version}  channel {client.core.channel}"),
        ("Base URL", str(client.core.base_url)),
        ("Device", str(client.core.device_id)),
    ]
    d = client.try_discover() if not client.core.local_only else None
    rows.append(("Discovery", str(getattr(d, "kind", "skipped"))))
    on = [s for s, v in client.capabilities().items() if v.get("enabled")]
    rows.append(("Services", ", ".join(on) or "none"))
    store = client.store_status()
    if store is not None:
        rows.append(("", core.format_store_status(store)))
    rows.append(("Outlet", str(client.outlet_id() or "unknown")))
    gate = client.status().status
    rows.append(("Gate", str(gate)))
    rows.append(("Supports:", ""))
    supports: Dict[str, Any] = {}
    for f in FEATURE_VALUES:
        s = client.supports(f)
        ok = not isinstance(s, Unsupported)
        supports[f] = True if ok else s.reason
        rows.append(("", f"  {f}: " + ("yes" if ok else f"no ({s.reason})")))
    data = {
        "product": client.product,
        "version": client.core.version,
        "channel": client.core.channel,
        "baseUrl": client.core.base_url,
        "device": client.core.device_id,
        "discovery": getattr(d, "kind", "skipped"),
        "services": on,
        "outlet": client.outlet_id(),
        "gate": gate,
        "supports": supports,
    }
    return _done(Outcome(0, screens.diagnostic(t.kit, "doctor", rows), data), ns)


_KEY_SOURCE = (
    Opt("key-file", "str", "Read the license key from a file."),
    Opt("key-stdin", "flag", "Read the license key from stdin."),
)
_SIGN_IN = (
    Opt("device-code", "flag", "Use a code instead of this computer's browser (automatic over SSH)."),
    Opt("browser", "flag", "Open the sign-in page in the system browser, even over SSH or in CI."),
    Opt("device-name", "str", "A name for this device on the account."),
    Opt("attach", "flag", "Offer to attach this device's free license to the account."),
    Opt("no-qr", "flag", "Accepted for compatibility; sign-in shows no QR in a terminal."),
)
_YES = (Opt("yes", "flag", "Do not ask for confirmation."),)

#: Every verb. ``login`` and ``logout`` are ``sign-in`` and ``sign-out`` (SIGN-IN.md §4.15).
VERBS: Tuple[Verb, ...] = (
    Verb("activate", "license", "Add a license key (a masked prompt, stdin or a file).", activate,
         opts=_KEY_SOURCE, arg="key"),
    Verb("enroll", "license", "Get a license with no key and no sign-in.", enroll),
    Verb("deactivate", "license", "Release this device's seat and wipe local credentials.", deactivate),
    Verb("status", "license", "License, devices and offline time.", status),
    Verb("sign-in", "identity", "Sign in in your browser, or with a code.", sign_in, opts=_SIGN_IN),
    Verb("login", "identity", "Same as sign-in.", sign_in, opts=_SIGN_IN),
    Verb("sign-out", "identity", "Sign out on this device.", sign_out, opts=_YES),
    Verb("logout", "identity", "Same as sign-out.", sign_out, opts=_YES),
    Verb("register", "devices", "Register this device with no key.", register),
    Verb("devices", "devices", "list | rename <id> <label> | deauthorize <id>", devices, words=True, opts=_YES),
    Verb("config", "config", "list | get <key> | set <key> <value> | reset <key>", config, words=True,
         opts=(Opt("fallback", "str", "Value if the key is unset (get)."),)),
    Verb("secret", "config", "Whether a managed secret is present (never printed).", secret, words=True),
    Verb("mint", "config", "Mint an edge token through a recipe (never printed).", mint, words=True),
    Verb("update", "update", "check | download --to <path> | apply", update, words=True,
         opts=(Opt("channel", "str", "The channel to check."), Opt("to", "str", "Where to download the build."))),
    Verb("changelog", "release", "The published releases, newest first.", changelog,
         opts=(Opt("limit", "int", "Show at most this many."),)),
    Verb("packs", "update", "status | ensure <pack…>", packs, words=True),
    Verb("boot", "core", "Run the one-call boot, a live line per stage.", boot,
         opts=(Opt("yes", "flag", "Download required content without asking."),)),
    Verb("import-bundle", "core", "Import an offline activation file (a path, or -).", import_bundle,
         arg="bundle"),
    Verb("offline-request", "core", "The request code for an offline activation bundle.", offline_request,
         opts=(Opt("no-qr", "flag", "Do not draw the QR code."),)),
    Verb("doctor", "core", "Diagnostics: discovery, services, store and supports.", doctor),
)

VERB_NAMES = tuple(v.name for v in VERBS)


def option_dest(name: str) -> str:
    return name.replace("-", "_")


def namespace(verb: Verb, words: Sequence[str], values: Dict[str, Any]) -> Dict[str, Any]:
    ns = {option_dest(o.name): values.get(option_dest(o.name), o.default) for o in verb.opts + UI_OPTS}
    ns["words"] = list(words or [])
    ns["_verb"] = verb.name
    return ns


def run(
    factory: "core.ClientFactory",
    opts: "core.ClientOptions",
    verb: Verb,
    ns: Dict[str, Any],
    *,
    theme: Any = None,
    prog: str = "polaris-key",
) -> CommandResult:
    """Build a client, run ``verb`` through the terminal kit with the flags in ``ns``, close the
    client. The result's :meth:`~CommandResult.emit` draws it, or prints its JSON."""
    from ..ui.terminal.flows import Terminal

    try:
        client = factory(opts)
    except Exception:
        if not ns.get("json"):
            raise
        term = Terminal.create(product=opts.product, verb=verb.name, json=True)
        return CommandResult(1, [], terminal=term, data={"error": "internal"})
    try:
        term = Terminal.create(
            product=opts.product,
            client=client,
            theme=theme,
            prog=prog,
            verb=verb.name,
            json=bool(ns.get("json")),
            no_color=bool(ns.get("no_color")),
            ascii=bool(ns.get("ascii")),
            device_code=bool(ns.get("device_code")),
        )
        ns = dict(ns)
        ns["_term"] = term
        try:
            result = verb.run(client, ns)
        except KeyboardInterrupt:
            return CommandResult(130, [], terminal=term if term.env.json else None, data={"error": "interrupted"})
        except Exception:
            if not term.env.json:
                raise
            # --json always ends with a result line, whatever went wrong.
            return CommandResult(1, [], terminal=term, data={"error": "internal"})
        if result.terminal is None:
            result.terminal = term
        return result
    finally:
        client.close()
